"""The body of a provision_agent job: set up a new Hermes profile for an Emperor agent on this host.

``python -m emperor_hostd.provision <spec file>`` runs inside the job's transient unit (started by
the daemon through ``systemd-run`` and ``emperor_hostd.jobwrap``). The spec file (0600, written by
the daemon) holds the validated arguments, the job id and the agent's token; it is read and
deleted first.

Steps (each prints a ``==> `` line, which Emperor shows as progress):

1. The profile must be free or already this agent's: its .env names the agent, or our ownership
   marker does (a setup that died half way). That makes Retry an idempotent rerun. Anything else
   stops here (exit 10) and is never touched.
2. The model provider's API key must already be on this host. It is looked up in the profile itself
   (a rerun), then ~/.hermes/.env, then the other profiles by name, and ONLY that one line is
   copied into the new profile's .env. Keys never travel through Emperor (exit 11 when none).
3. The ownership marker is written, then ``hermes profile create <p> --clone-from default``
   (config.yaml, SOUL.md and skills from the default home). Hermes v0.22.4 clones the source's .env
   too: right away every EMPEROR_CLAW_* and credential line of it is dropped, so an agent identity
   in the default home can never leak into the new profile. A profile we just created that still
   names another agent is deleted again.
4. The .env (0600): EMPEROR_CLAW_API_URL from hostd.env ONLY (never from Emperor's command), the
   token, AGENT_ID, AGENT_NAME and the one provider key; other settings are kept.
5. ``hermes -p <p> config set model.provider|model.default`` (the keys and provider names of the
   managed Docker runtime, integrations/hermes/entrypoint.sh). The cloned model.base_url and
   model.api_key are checked with ``config get`` and removed; the setup fails closed when the
   endpoint is not the one the provider needs.
6. ``emperor-hermes install --profile <p> --gateway <g> --non-interactive --yes [--skip-browser]
   [--max-parallel N]``: plugin, units, gateway and bridge.
7. Wait until the bridge writes ``emperor/health.json`` with ``registered: true`` (120 s; 300 s on
   ARM or under 6 GB of RAM). When it does not, a standalone profile's units are stopped and
   disabled (nothing keeps retrying with a token Emperor is about to revoke); Retry starts them
   again with a new token.

Exit codes: 0 online; 10 profile taken by another agent; 11 no API key; 12 not registered in time;
13 profile create/config failed; 14 hostd.env missing or invalid; anything else is the installer's.
Children run with argv lists (no shell) and without PYTHONPATH. Values start with a letter or digit
(validated), so none can be read as an option. Nothing secret is ever printed.
"""
from __future__ import annotations

import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Optional, Sequence

from emperor_bridge.config import read_env_file

from .commands import (HERMES_PROFILE_RE, LINE_BREAKING_RE, RESERVED_PROFILE_NAMES, SECRET_ENV_KEY_RE, CommandRefused, drop_marker,
                       find_provider_key, no_key_message, profile_agent_id, profile_belongs_to, validate, write_marker)
from .config import HostdConfigError, HostPaths, load_hostd_config
from .inventory import meminfo

EXIT_PROFILE_CONFLICT = 10
EXIT_NO_KEY = 11
EXIT_NOT_REGISTERED = 12
EXIT_HERMES = 13
EXIT_CONFIG = 14

REGISTER_TIMEOUT_SEC = 120.0
#: Slow machines (a Raspberry Pi) get longer before a setup counts as failed.
REGISTER_TIMEOUT_SLOW_SEC = 300.0
REGISTER_POLL_SEC = 2.0

#: Emperor provider id -> (Hermes provider, base_url or None). Same mapping as entrypoint.sh:
#: Hermes has no "openai" provider plugin (OpenAI goes through "custom" with a base_url) and names
#: Google/Grok "gemini"/"xai".
HERMES_PROVIDER: dict[str, tuple[str, Optional[str]]] = {
    "openai": ("custom", "https://api.openai.com/v1"),
    "anthropic": ("anthropic", None),
    "google": ("gemini", None),
    "openrouter": ("openrouter", None),
    "grok": ("xai", None),
    "deepseek": ("deepseek", None),
}

#: The .env keys this job owns (rewritten on every run).
OWNED_KEYS = ("EMPEROR_CLAW_API_URL", "EMPEROR_CLAW_API_TOKEN", "EMPEROR_CLAW_AGENT_ID", "EMPEROR_CLAW_AGENT_NAME")

Runner = Callable[[Sequence[str]], int]
#: argv -> (exit code, stdout + stderr): for `hermes config get`.
Capture = Callable[[Sequence[str]], tuple[int, str]]


class ProvisionError(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


def step(text: str) -> None:
    print(f"==> {text}", flush=True)


def say(text: str) -> None:
    print(f"  {text}", flush=True)


def child_env() -> dict[str, str]:
    """The job's environment without the bundle on PYTHONPATH (Hermes and the installer bring their own)."""
    env = {k: v for k, v in os.environ.items() if k not in ("PYTHONPATH", "PYTHONUNBUFFERED")}
    env["HOSTD_PROGRESS"] = "1"
    return env


def default_runner(argv: Sequence[str]) -> int:
    """Run argv (no shell), its output going to ours (the job log)."""
    sys.stdout.flush()
    try:
        return subprocess.call(list(argv), env=child_env(), stdin=subprocess.DEVNULL)
    except OSError as exc:
        print(f"  cannot run {argv[0]}: {exc}", flush=True)
        return 127


def default_capture(argv: Sequence[str]) -> tuple[int, str]:
    try:
        proc = subprocess.run(list(argv), env=child_env(), stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60, check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        return 127, str(exc)
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def env_value(value: str) -> str:
    """A double-quoted .env value that read_env_file (and the installer's env_get) reads back as one
    value. Anything that could end a line is refused, never escaped."""
    if LINE_BREAKING_RE.search(value) or '"' in value or "\\" in value:
        raise ProvisionError(EXIT_CONFIG, "a value for the profile .env contains a quote, backslash or line break; refused")
    return f'"{value}"'


_QUOTED_START = re.compile(r"""^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=\s*(["'])""")


def env_entries(text: str) -> list[tuple[Optional[str], list[str]]]:
    """A .env file as (key or None, its lines): a quoted value that spans lines stays one entry,
    so dropping the key drops its continuation lines too."""
    lines = text.splitlines()
    entries: list[tuple[Optional[str], list[str]]] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        key = _line_key(line)
        block = [line]
        match = _QUOTED_START.match(line) if key else None
        if match:
            quote = match.group(1)
            rest = line[match.end():]
            if not _closes(rest, quote):
                while i + 1 < len(lines):
                    i += 1
                    block.append(lines[i])
                    if _closes(lines[i], quote):
                        break
        entries.append((key, block))
        i += 1
    return entries


def _closes(text: str, quote: str) -> bool:
    escaped = False
    for ch in text:
        if escaped:
            escaped = False
        elif ch == "\\" and quote == '"':
            escaped = True
        elif ch == quote:
            return True
    return False


def _line_key(line: str) -> Optional[str]:
    text = line.strip()
    if not text or text.startswith("#") or "=" not in text:
        return None
    key = text.split("=", 1)[0].strip()
    if key.startswith("export "):
        key = key[len("export "):].strip()
    return key


def scrub_env(existing: str, also_drop: Sequence[str] = ()) -> list[str]:
    """The lines of a .env without any EMPEROR_CLAW_* key, any credential-looking key (and their
    multi-line values), and `also_drop`; comments and other settings are kept."""
    kept: list[str] = []
    for key, block in env_entries(existing):
        if key and (key.startswith("EMPEROR_CLAW_") or key in OWNED_KEYS or key in also_drop or SECRET_ENV_KEY_RE.search(key)):
            continue
        kept.extend(block)
    while kept and not kept[-1].strip():
        kept.pop()
    return kept


def compose_env(existing: str, url: str, token: str, agent_id: str, agent_name: str, key_name: str, key_value: str) -> str:
    """The profile .env: what was there (settings, comments) minus every credential-looking line and
    every key this job owns, plus the agent's identity and the ONE provider key."""
    kept = scrub_env(existing, (key_name,))
    ours = [
        "# Emperor agent identity: written by emperor-hostd (provision_agent). Keep this file private.",
        f"EMPEROR_CLAW_API_URL={env_value(url)}",
        f"EMPEROR_CLAW_API_TOKEN={env_value(token)}",
        f"EMPEROR_CLAW_AGENT_ID={env_value(agent_id)}",
        f"EMPEROR_CLAW_AGENT_NAME={env_value(agent_name)}",
        f"{key_name}={env_value(key_value)}",
    ]
    return "\n".join([*kept, *([""] if kept else []), *ours]) + "\n"


def write_private(path: Path, text: str) -> None:
    """Atomic write, mode 0600 from the first byte."""
    tmp = path.with_name(path.name + ".hostd-tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    os.chmod(str(tmp), 0o600)
    os.replace(tmp, path)


def hermes_launcher(paths: HostPaths) -> str:
    """The pinned Hermes launcher emperor-hermes recorded in host.env, else ~/.local/bin/hermes."""
    recorded = read_env_file(paths.host_env).get("HERMES_LAUNCHER", "").strip()
    if recorded and Path(recorded).is_file():
        return recorded
    local = paths.home / ".local" / "bin" / "hermes"
    return str(local) if local.exists() else "hermes"


def register_timeout_for_this_host() -> float:
    """120 s; 300 s on ARM (a Raspberry Pi) or with less than 6 GB of RAM."""
    machine = platform.machine().lower()
    total = meminfo().get("MemTotal")
    if machine.startswith(("aarch64", "arm")) or (total is not None and total < 6 * 1024):
        return REGISTER_TIMEOUT_SLOW_SEC
    return REGISTER_TIMEOUT_SEC


class Provisioner:
    def __init__(self, paths: HostPaths, spec: dict[str, Any], run: Runner = default_runner,
                 sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.monotonic,
                 register_timeout: Optional[float] = None, capture: Capture = default_capture) -> None:
        spec = dict(spec)
        job_id = spec.pop("jobId", None)
        self.job_id = job_id if isinstance(job_id, str) and re.fullmatch(r"[0-9a-f-]{36}", job_id) else "unknown"
        self.paths = paths
        self.args = validate("provision_agent", spec)
        self.run_cmd = run
        self.capture = capture
        self.sleep = sleep
        self.clock = clock
        self.register_timeout = register_timeout if register_timeout is not None else register_timeout_for_this_host()

    @property
    def profile(self) -> str:
        return self.args["profile"]

    @property
    def home(self) -> Path:
        return self.paths.profile_home(self.profile)

    def check_profile(self) -> bool:
        """True when the profile already exists for this agent (a rerun, or a setup that died half way)."""
        profile = self.profile
        if not HERMES_PROFILE_RE.match(profile) or profile in RESERVED_PROFILE_NAMES:
            raise ProvisionError(EXIT_PROFILE_CONFLICT, f"{profile} is not a profile name Hermes accepts")
        if not self.home.exists():
            return False
        if not profile_belongs_to(self.paths, profile, self.args["agentId"]):
            owner = profile_agent_id(self.paths, profile)
            raise ProvisionError(EXIT_PROFILE_CONFLICT, f"profile {profile} already exists on this host for "
                                 + ("another agent" if owner else "something else (no agent id in its .env)") + "; nothing was changed")
        return True

    def hermes(self, *args: str) -> int:
        return self.run_cmd([hermes_launcher(self.paths), "-p", self.profile, *args])

    def config_get(self, key: str) -> Optional[str]:
        """A config value of the profile, None when it is not set. Raises when Hermes cannot say."""
        code, out = self.capture([hermes_launcher(self.paths), "-p", self.profile, "config", "get", key, "--json"])
        if code != 0:
            if "not set" in out.lower():
                return None
            raise ProvisionError(EXIT_HERMES, f"hermes config get {key} failed (exit {code})")
        text = out.strip().splitlines()[0] if out.strip() else ""
        try:
            value = json.loads(text)
        except ValueError:
            value = text
        return None if value in (None, "") else str(value)

    def ensure_unset(self, key: str) -> None:
        if self.config_get(key) is None:
            return
        code = self.hermes("config", "unset", key)
        if code != 0 or self.config_get(key) is not None:
            raise ProvisionError(EXIT_HERMES, f"the cloned {key} could not be removed (exit {code}); the profile is not used")

    def configure_model(self) -> None:
        provider, base_url = HERMES_PROVIDER[self.args["llmProvider"]]
        if self.hermes("config", "set", "model.provider", provider) != 0:
            raise ProvisionError(EXIT_HERMES, f"hermes config set model.provider {provider} failed")
        if base_url:
            if self.hermes("config", "set", "model.base_url", base_url) != 0:
                raise ProvisionError(EXIT_HERMES, "hermes config set model.base_url failed")
        else:
            # A clone of a custom-endpoint home must not send this provider's key anywhere else.
            self.ensure_unset("model.base_url")
        current = self.config_get("model.base_url")
        if (current or None) != base_url:
            raise ProvisionError(EXIT_HERMES, "the profile's model endpoint is not the provider's; refusing to use it")
        # A key in config.yaml would override the one in .env (and may belong to someone else).
        self.ensure_unset("model.api_key")
        model = self.args.get("model")
        if model:
            if self.hermes("config", "set", "model.default", model) != 0:
                raise ProvisionError(EXIT_HERMES, f"hermes config set model.default {model} failed")
            say(f"model: {provider} / {model}")
        else:
            say(f"model: {provider} (the profile's default model)")

    def installer_argv(self) -> list[str]:
        argv = ["/bin/bash", str(self.paths.installer), "install", "--profile", self.profile, "--gateway", self.args["gateway"],
                "--non-interactive", "--yes"]
        if self.args.get("skipBrowser"):
            argv.append("--skip-browser")
        if self.args.get("maxParallel"):
            argv += ["--max-parallel", str(self.args["maxParallel"])]
        return argv

    def wait_registered(self) -> None:
        health = self.home / "emperor" / "health.json"
        deadline = self.clock() + self.register_timeout
        last_error = None
        while True:
            try:
                data = json.loads(health.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                data = None
            if isinstance(data, dict):
                if data.get("registered") is True:
                    return
                last_error = data.get("lastError") or last_error
            if self.clock() >= deadline:
                hint = f" (last error: {str(last_error)[:200]})" if last_error else ""
                raise ProvisionError(EXIT_NOT_REGISTERED, f"{self.profile} did not register with Emperor within "
                                     f"{int(self.register_timeout)} s{hint}; its services were stopped. "
                                     f"Retry starts them with a new token (details: emperor-hermes status --profile {self.profile})")
            self.sleep(REGISTER_POLL_SEC)

    def stop_units(self) -> None:
        """After a failed registration: nothing keeps retrying with a token that is being revoked.
        A shared gateway/bridge serves other agents and is left alone."""
        record = read_env_file(self.paths.records_dir / f"{self.profile}.env")
        if record.get("topology") == "shared" or self.args["gateway"] == "shared":
            say("shared gateway: left running for the other agents")
            return
        code = self.run_cmd(["systemctl", "--user", "disable", "--now",
                             f"emperor-hermes-bridge@{self.profile}.service", f"emperor-hermes-gateway@{self.profile}.service"])
        say("its bridge and gateway were stopped" if code == 0 else f"could not stop its units (exit {code})")

    def strip_cloned_env(self) -> None:
        """Drop every EMPEROR_CLAW_* and credential line the clone copied from the default home."""
        env_path = self.home / ".env"
        try:
            existing = env_path.read_text(encoding="utf-8")
        except OSError:
            existing = ""
        kept = scrub_env(existing)
        write_private(env_path, ("\n".join(kept) + "\n") if kept else "")

    def create_profile(self) -> None:
        step(f"Creating Hermes profile {self.profile}")
        write_marker(self.paths, self.profile, self.job_id, self.args["agentId"])
        code = self.run_cmd([hermes_launcher(self.paths), "profile", "create", self.profile, "--clone-from", "default"])
        if not self.home.is_dir():
            drop_marker(self.paths, self.profile)
            raise ProvisionError(EXIT_HERMES, f"hermes profile create {self.profile} failed (exit {code})")
        self.strip_cloned_env()
        # Whatever the clone brought, the profile now names no agent; anything else is not ours.
        if profile_agent_id(self.paths, self.profile) not in (None, ""):
            shutil.rmtree(self.home, ignore_errors=True)
            drop_marker(self.paths, self.profile)
            raise ProvisionError(EXIT_PROFILE_CONFLICT, f"profile {self.profile} named another agent right after it was created; deleted again")
        if code != 0:
            raise ProvisionError(EXIT_HERMES, f"hermes profile create {self.profile} failed (exit {code}); Retry finishes it")

    def run(self) -> int:
        try:
            try:
                config = load_hostd_config(self.paths.hostd_env)
            except HostdConfigError as exc:
                raise ProvisionError(EXIT_CONFIG, str(exc))
            step(f"Checking profile {self.profile}")
            rerun = self.check_profile()
            say("it already belongs to this agent: setting it up again" if rerun else "free")

            step(f"Looking for a {self.args['llmProvider']} API key on this host")
            found = find_provider_key(self.paths, self.args["llmProvider"], self.profile)
            if not found:
                raise ProvisionError(EXIT_NO_KEY, no_key_message(self.args["llmProvider"]))
            key_name, key_value, where = found
            say(f"using {key_name} from {where} (copied on this host only)")

            if not rerun:
                self.create_profile()

            step(f"Writing the agent's settings ({self.profile}/.env)")
            env_path = self.home / ".env"
            try:
                existing = env_path.read_text(encoding="utf-8")
            except OSError:
                existing = ""
            write_private(env_path, compose_env(existing, config.emperor_url, self.args["apiToken"], self.args["agentId"],
                                                self.args["agentName"], key_name, key_value))
            say(f"Emperor: {config.emperor_url}")

            step("Setting the model")
            self.configure_model()

            # A health.json from an earlier attempt must not count as this one registering.
            try:
                (self.home / "emperor" / "health.json").unlink()
            except OSError:
                pass
            step(f"Installing {self.profile} ({self.args['gateway']} gateway)")
            code = self.run_cmd(self.installer_argv())
            if code != 0:
                print(f"error: emperor-hermes install failed (exit {code}); details: ~/.local/share/emperor-hermes/emperor-hermes.log",
                      flush=True)
                return code if 0 < code < 256 else 1

            step(f"Waiting for {self.args['agentName']} to come online (up to {int(self.register_timeout)} s)")
            try:
                self.wait_registered()
            except ProvisionError:
                self.stop_units()
                raise
            step(f"Online: {self.args['agentName']} runs as profile {self.profile}")
            return 0
        except ProvisionError as exc:
            print(f"error: {exc}", flush=True)
            return exc.code
        except CommandRefused as exc:
            print(f"error: {exc}", flush=True)
            return EXIT_PROFILE_CONFLICT


def load_spec(path: Path) -> dict[str, Any]:
    """Read the spec and delete it at once: the token it holds lives on only in the profile .env."""
    try:
        text = path.read_text(encoding="utf-8")
    finally:
        try:
            path.unlink()
        except OSError:
            pass
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError("spec is not an object")
    return data


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        print("usage: python -m emperor_hostd.provision <spec file>", file=sys.stderr)
        return 64
    try:
        spec = load_spec(Path(argv[0]))
    except (OSError, ValueError) as exc:
        print(f"error: cannot read the job spec ({type(exc).__name__})", flush=True)
        return EXIT_CONFIG
    try:
        provisioner = Provisioner(HostPaths.from_env(), spec)
    except CommandRefused as exc:
        print(f"error: {exc}", flush=True)
        return EXIT_PROFILE_CONFLICT
    return provisioner.run()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
