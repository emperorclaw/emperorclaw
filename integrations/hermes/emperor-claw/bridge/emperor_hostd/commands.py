"""The command allowlist (server twin: src/lib/runtime-hosts/commands.ts).

Arguments are validated again here (the server is not trusted blindly) and turned into argv
lists. Nothing is ever passed to a shell or interpolated into a command string; the profile must
be one emperor-hermes manages (an active record), and its topology comes from that record, not
from the server.

0.22 runs restart_agent, refresh_inventory, provision_agent and remove_agent (and says so in
hello, so Emperor never queues a command an older daemon does not know). The validators of the
later commands (and of ``disconnect``: revoking the host in Emperor, or ``emperor-hermes host
disconnect`` locally, are the ways to cut a host off) exist so their shapes are pinned, but
:func:`plan` refuses them.

provision_agent: the agent's token is minted by Emperor when the job is sent and arrives only in
the command frame. It is handed to the job in a 0600 spec file the job deletes on start, never in
argv, the environment, the job record or a log. The Emperor URL the new profile talks to comes
from hostd.env only, and the model provider's API key is copied on this host, from a file on this
host: it never travels through Emperor (emperor_hostd.provision).

remove_agent: runs ``emperor-hermes remove --purge`` only when the profile's own .env names the
same agent.

Shared gateway safety: Emperor never says how a profile runs. The local record does, and a shared
gateway restart (every agent on the host) ALWAYS waits for idle unless Emperor sends an explicit
``force: true``, which it only does when an admin ticked "restart now even if busy".
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

from emperor_bridge.config import read_env_file

from .config import HostPaths
from .protocol import SECRET_KEY_RE as SECRET_ENV_KEY_RE

PROFILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
SEMVER_RE = re.compile(r"^\d{1,4}\.\d{1,4}\.\d{1,6}$")
#: A model id: never starting with "-" (it is a positional value of `hermes config set`).
MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
AGENT_TOKEN_RE = re.compile(r"^ec_[0-9a-f]{48}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

ALL_COMMANDS = ("provision_agent", "update_runtime", "restart_agent", "remove_agent", "rotate_agent_token",
                "refresh_inventory", "disconnect")
ENABLED_COMMANDS = frozenset({"restart_agent", "refresh_inventory", "provision_agent", "remove_agent"})
#: Commands that run a process (through systemd-run); the others are answered in-process.
PROCESS_COMMANDS = frozenset({"restart_agent", "provision_agent", "remove_agent"})
#: A Hermes profile id (hermes_constants.PROFILE_ID_RE in v0.22.4): stricter than PROFILE_RE,
#: which also accepts the names of profiles made by hand. New profiles must satisfy it.
HERMES_PROFILE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
#: Names Hermes refuses for a profile (profiles._RESERVED_NAMES) or that shadow a hermes subcommand.
RESERVED_PROFILE_NAMES = frozenset({
    "hermes", "default", "test", "tmp", "root", "sudo",
    "chat", "model", "gateway", "setup", "whatsapp", "login", "logout", "status", "cron", "doctor", "dump", "config",
    "pairing", "skills", "tools", "mcp", "connectors", "sessions", "insights", "version", "update", "uninstall", "profile",
    "plugins", "honcho", "acp",
})
#: Emperor's provider ids -> the key names they may be stored under, in order of preference
#: (src/lib/hermes-provisioning.ts PROVIDER_ENV_VAR; Hermes itself reads GEMINI_/XAI_ too).
PROVIDER_KEY_NAMES: dict[str, tuple[str, ...]] = {
    "openai": ("OPENAI_API_KEY",),
    "anthropic": ("ANTHROPIC_API_KEY",),
    "google": ("GOOGLE_API_KEY", "GEMINI_API_KEY"),
    "openrouter": ("OPENROUTER_API_KEY",),
    "grok": ("XAI_API_KEY", "GROK_API_KEY"),
    "deepseek": ("DEEPSEEK_API_KEY",),
}
#: restart-gateway --when-idle waits at most this long, inside the 300 s job deadline.
WHEN_IDLE_TIMEOUT_SEC = 240


class CommandRefused(ValueError):
    """The command or its arguments are not acceptable; ``code`` goes into the ack reason."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.detail = detail


#: Characters that end a line for str.splitlines() (and so for read_env_file) or are controls.
LINE_BREAKING_RE = re.compile("[\x00-\x1f\x7f\x85\u2028\u2029]")


def safe_env_value(value: str) -> bool:
    """Text that stays one value in a .env file: no quote, backslash, $, backtick, control
    character or anything str.splitlines() breaks a line at (VT, FF, FS/GS/RS, NEL, LS, PS)."""
    return not re.search(r"[\"\\$`]", value) and not LINE_BREAKING_RE.search(value)


def _only(args: Mapping[str, Any], allowed: Sequence[str]) -> None:
    extra = sorted(set(args) - set(allowed))
    if extra:
        raise CommandRefused("invalid_args", f"unexpected argument(s): {', '.join(extra)}")


def _profile(value: Any) -> str:
    if not isinstance(value, str) or not PROFILE_RE.match(value):
        raise CommandRefused("invalid_args", "profile is not a valid profile name")
    return value


def validate(command: str, args: Any) -> dict[str, Any]:
    """Normalized arguments, or CommandRefused."""
    if command not in ALL_COMMANDS:
        raise CommandRefused("unknown_command", str(command)[:40])
    if args is None:
        args = {}
    if not isinstance(args, Mapping):
        raise CommandRefused("invalid_args", "args must be an object")
    if command == "restart_agent":
        _only(args, ("profile", "target", "force"))
        profile = _profile(args.get("profile"))
        target = args.get("target", "bridge")
        if target not in ("bridge", "gateway"):
            raise CommandRefused("invalid_args", "target must be bridge or gateway")
        force = args.get("force", False)
        if not isinstance(force, bool):
            raise CommandRefused("invalid_args", "force must be a boolean")
        return {"profile": profile, "target": target, "force": force}
    if command in ("refresh_inventory", "disconnect"):
        _only(args, ())
        return {}
    if command == "provision_agent":
        _only(args, ("profile", "agentId", "agentName", "apiToken", "gateway", "llmProvider", "model", "maxParallel", "skipBrowser"))
        profile = _profile(args.get("profile"))
        if not isinstance(args.get("agentId"), str) or not UUID_RE.match(args["agentId"]):
            raise CommandRefused("invalid_args", "agentId must be a uuid")
        name = args.get("agentName")
        if not isinstance(name, str) or not name.strip() or len(name) > 80 or not safe_env_value(name) or name != name.strip():
            raise CommandRefused("invalid_args", "agentName is not a safe name")
        if not isinstance(args.get("apiToken"), str) or not AGENT_TOKEN_RE.match(args["apiToken"]):
            raise CommandRefused("invalid_args", "apiToken has the wrong shape")
        if args.get("gateway") not in ("standalone", "shared"):
            raise CommandRefused("invalid_args", "gateway must be standalone or shared")
        if not isinstance(args.get("llmProvider"), str) or not re.match(r"^[a-z0-9_-]{1,40}$", args["llmProvider"]):
            raise CommandRefused("invalid_args", "llmProvider is not valid")
        if args["llmProvider"] not in PROVIDER_KEY_NAMES:
            raise CommandRefused("invalid_args", f"llmProvider {args['llmProvider']} is not supported on a host")
        if "model" in args and (not isinstance(args["model"], str) or not MODEL_RE.match(args["model"])):
            raise CommandRefused("invalid_args", "model is not valid")
        max_parallel = args.get("maxParallel")
        if max_parallel is not None and (not isinstance(max_parallel, int) or isinstance(max_parallel, bool) or not 1 <= max_parallel <= 8):
            raise CommandRefused("invalid_args", "maxParallel must be 1-8")
        skip_browser = args.get("skipBrowser", False)
        if not isinstance(skip_browser, bool):
            raise CommandRefused("invalid_args", "skipBrowser must be a boolean")
        out = {k: args[k] for k in ("agentName", "apiToken", "gateway", "llmProvider") }
        out.update({"profile": profile, "agentId": args["agentId"].lower(), "skipBrowser": skip_browser})
        if "model" in args:
            out["model"] = args["model"]
        if max_parallel is not None:
            out["maxParallel"] = max_parallel
        return out
    if command == "update_runtime":
        _only(args, ("version", "expectedSha256", "restartGateways"))
        if not isinstance(args.get("version"), str) or not SEMVER_RE.match(args["version"]):
            raise CommandRefused("invalid_args", "version must be x.y.z")
        sha = args.get("expectedSha256")
        if sha is not None and (not isinstance(sha, str) or not SHA256_RE.match(sha)):
            raise CommandRefused("invalid_args", "expectedSha256 must be a sha256 hex digest")
        return {"version": args["version"], "expectedSha256": sha, "restartGateways": bool(args.get("restartGateways", False))}
    if command == "remove_agent":
        _only(args, ("profile", "agentId", "purge"))
        profile = _profile(args.get("profile"))
        if not isinstance(args.get("agentId"), str) or not UUID_RE.match(args["agentId"]):
            raise CommandRefused("invalid_args", "agentId must be a uuid")
        purge = args.get("purge", False)
        if not isinstance(purge, bool):
            raise CommandRefused("invalid_args", "purge must be a boolean")
        return {"profile": profile, "agentId": args["agentId"].lower(), "purge": purge}
    # rotate_agent_token
    _only(args, ("profile", "agentId", "apiToken"))
    profile = _profile(args.get("profile"))
    if not isinstance(args.get("agentId"), str) or not UUID_RE.match(args["agentId"]):
        raise CommandRefused("invalid_args", "agentId must be a uuid")
    if not isinstance(args.get("apiToken"), str) or not AGENT_TOKEN_RE.match(args["apiToken"]):
        raise CommandRefused("invalid_args", "apiToken has the wrong shape")
    return {"profile": profile, "agentId": args["agentId"], "apiToken": args["apiToken"]}


def profile_record(paths: HostPaths, profile: str) -> dict[str, str]:
    """The installer's record of a profile (status, topology, ...); {} when it has none."""
    return read_env_file(paths.records_dir / f"{profile}.env")


@dataclass(frozen=True)
class Plan:
    command: str
    args: dict[str, Any]
    argv: Optional[list[str]]  # None: answered in-process (no systemd-run)
    summary: str
    #: The systemd units the job restarts (reported in the result: a shared unit serves every agent).
    units: tuple[str, ...] = ()
    #: Run ``python -m <module> <spec file>`` (the daemon's own python and package) instead of argv.
    module: Optional[str] = None
    #: What the module reads from its 0600 spec file (may hold a token: never stored elsewhere).
    secret_spec: Optional[dict[str, Any]] = field(default=None, repr=False)
    #: sha256 of the agent token a provision writes (not a secret: Emperor stores the same hash).
    token_sha256: Optional[str] = None
    #: Readable reasons for the exit codes of a module job.
    exit_reasons: tuple[tuple[int, str], ...] = ()
    #: In-process removal of a profile the installer never recorded (see discard_profile).
    discard_profile: Optional[str] = None


#: Exit codes of emperor_hostd.provision (also listed in its docstring).
PROVISION_EXIT_REASONS = (
    (10, "the profile already exists for another agent"),
    (11, "no API key for the model provider on this host"),
    (12, "the agent did not register with Emperor in time (its services were stopped; Retry starts them with a new token)"),
    (13, "the Hermes profile could not be created or configured"),
    (14, "hostd.env is missing or invalid"),
)


def profile_agent_id(paths: HostPaths, profile: str) -> Optional[str]:
    """EMPEROR_CLAW_AGENT_ID of a profile's .env, lowercased; "" when it has none, None when no .env."""
    env_path = paths.profile_home(profile) / ".env"
    if not env_path.is_file():
        return None
    return read_env_file(env_path).get("EMPEROR_CLAW_AGENT_ID", "").strip().lower()


def key_source_files(paths: HostPaths, target: str) -> list[tuple[str, Path]]:
    """Where a provider key may be copied from, in order: the target profile itself (a rerun), the
    default home (~/.hermes/.env), then every other profile emperor-hermes knows, by name."""
    sources: list[tuple[str, Path]] = [(f"profile {target}", paths.profile_home(target) / ".env"),
                                       ("~/.hermes/.env", paths.hermes_root / ".env")]
    names: set[str] = set()
    try:
        for f in paths.records_dir.glob("*.env"):
            names.add(f.name[:-4])
    except OSError:
        pass
    try:
        for d in paths.profiles_root.iterdir():
            if d.is_dir() and (d / ".env").is_file():
                names.add(d.name)
    except OSError:
        pass
    for name in sorted(n for n in names if PROFILE_RE.match(n) and n != target):
        sources.append((f"profile {name}", paths.profile_home(name) / ".env"))
    return sources


def find_provider_key(paths: HostPaths, provider: str, target: str) -> Optional[tuple[str, str, str]]:
    """(key name, value, where) of the first non-empty key of this provider on the host, or None.
    The value never leaves this host: it is only copied into the new profile's .env."""
    names = PROVIDER_KEY_NAMES.get(provider, ())
    for label, path in key_source_files(paths, target):
        values = read_env_file(path)
        for name in names:
            value = values.get(name, "").strip()
            if value:
                return name, value, label
    return None


def no_key_message(provider: str) -> str:
    names = PROVIDER_KEY_NAMES.get(provider, ("<PROVIDER>_API_KEY",))
    return f"No {provider} API key on this host; add {names[0]}=... to ~/.hermes/.env and try again"


def restart_units(profile: str, target: str, topology: str) -> tuple[str, ...]:
    if topology == "shared":
        return (f"emperor-hermes-{target}-shared.service",)
    return (f"emperor-hermes-{target}@{profile}.service",)


def restart_argv(paths: HostPaths, profile: str, target: str, topology: str, when_idle: bool) -> list[str]:
    """The argv list of a restart. Unit names are built from a validated profile name only."""
    if target == "bridge":
        unit = "emperor-hermes-bridge-shared.service" if topology == "shared" else f"emperor-hermes-bridge@{profile}.service"
        return ["systemctl", "--user", "restart", unit]
    argv = ["/bin/bash", str(paths.installer), "restart-gateway"]
    argv += ["--shared"] if topology == "shared" else ["--profile", profile]
    if when_idle:
        argv += ["--when-idle", "--timeout", str(WHEN_IDLE_TIMEOUT_SEC)]
    return argv


def plan(paths: HostPaths, command: str, raw_args: Any) -> Plan:
    """Validate a command from Emperor and decide what runs. Raises CommandRefused."""
    if command in ALL_COMMANDS and command not in ENABLED_COMMANDS:
        raise CommandRefused("unsupported_command", f"{command} is not available in this daemon")
    args = validate(command, raw_args)
    if command == "refresh_inventory":
        return Plan(command, args, None, "inventory sent")
    if command == "provision_agent":
        return plan_provision(paths, args)
    if command == "remove_agent":
        return plan_remove(paths, args)

    profile = args["profile"]
    record = profile_record(paths, profile)
    if record.get("status") != "active":
        raise CommandRefused("unknown_profile", f"{profile} is not managed by emperor-hermes on this host")
    # The local record is authoritative: a shared profile's bridge/gateway is the shared one.
    topology = record.get("topology")
    if topology not in ("standalone", "shared"):
        raise CommandRefused("unknown_topology", f"{profile} has no recorded topology; run emperor-hermes install again")
    target = args["target"]
    # A shared gateway restart interrupts every agent: always wait for idle unless explicitly forced.
    when_idle = target == "gateway" and topology == "shared" and not args["force"]
    argv = restart_argv(paths, profile, target, topology, when_idle)
    units = restart_units(profile, target, topology)
    if topology == "shared":
        served = [p for p in read_env_file(paths.host_env).get("EMPEROR_HERMES_PROFILES", "").split(",") if p]
        who = f" (all agents: {', '.join(served)})" if served else " (all agents on this host)"
        summary = f"restart shared {target}{who}" + (" after they are idle" if when_idle else "")
    else:
        summary = f"restart {target} of {profile}"
    return Plan(command, {**args, "topology": topology, "whenIdle": when_idle}, argv, summary, units)


# ── profiles this daemon created ─────────────────────────────────────────────────────────────
#
# Before `hermes profile create`, a provision job records which agent the profile is being made
# for (~/.local/share/emperor-hermes/hostd-profiles/<p>.json, 0600). A job that dies half way
# leaves a profile whose .env may name no agent yet (or the default home's agent, copied by the
# clone): the marker is how a Retry reclaims it and a removal deletes it. A profile without our
# marker and without this agent's id in its .env is never touched.


def marker_path(paths: HostPaths, profile: str) -> Path:
    return paths.data_dir / "hostd-profiles" / f"{profile}.json"


def read_marker(paths: HostPaths, profile: str) -> Optional[dict[str, Any]]:
    try:
        data = json.loads(marker_path(paths, profile).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and isinstance(data.get("agentId"), str) else None


def write_marker(paths: HostPaths, profile: str, job_id: str, agent_id: str) -> None:
    path = marker_path(paths, profile)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump({"profile": profile, "agentId": agent_id.lower(), "jobId": job_id, "createdAt": int(time.time())}, fh)
    os.replace(tmp, path)


def drop_marker(paths: HostPaths, profile: str) -> None:
    try:
        marker_path(paths, profile).unlink()
    except OSError:
        pass


def default_home_agent_id(paths: HostPaths) -> str:
    return read_env_file(paths.hermes_root / ".env").get("EMPEROR_CLAW_AGENT_ID", "").strip().lower()


def profile_belongs_to(paths: HostPaths, profile: str, agent_id: str) -> bool:
    """The profile is this agent's: its .env says so, or our marker says so and its .env names no
    other agent (none yet, or only the default home's id copied by the clone)."""
    agent_id = agent_id.lower()
    owner = profile_agent_id(paths, profile)
    if owner == agent_id:
        return True
    marker = read_marker(paths, profile)
    if not marker or marker.get("agentId", "").lower() != agent_id:
        return False
    return owner in (None, "") or owner == default_home_agent_id(paths)


def discard_profile(paths: HostPaths, profile: str, purge: bool = True) -> str:
    """Remove a profile this daemon created that the installer never recorded (a setup that died
    half way): deleted (purge) or archived like `emperor-hermes remove`. Returns what was done."""
    home = paths.profile_home(profile)
    done = "nothing to remove"
    if home.is_dir() and not home.is_symlink():
        if purge:
            shutil.rmtree(home)
            done = "deleted"
        else:
            dest = paths.hermes_root / "backups" / "emperor-hermes" / "removed" / f"{profile}-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}"
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(home), str(dest))
            done = f"archived to {dest}"
    drop_marker(paths, profile)
    return done


def plan_provision(paths: HostPaths, args: dict[str, Any]) -> Plan:
    """Checks that need no process (so a refusal is an immediate, readable ack): the profile name is
    one Hermes accepts, it is free or already this agent's (an idempotent rerun), and this host has
    a key for the provider. The job itself (emperor_hostd.provision) checks again."""
    profile = args["profile"]
    if not HERMES_PROFILE_RE.match(profile) or profile in RESERVED_PROFILE_NAMES:
        raise CommandRefused("invalid_args", f"{profile} is not a profile name Hermes accepts")
    home = paths.profile_home(profile)
    if home.exists() and not profile_belongs_to(paths, profile, args["agentId"]):
        owner = profile_agent_id(paths, profile)
        raise CommandRefused("profile_conflict", f"profile {profile} already exists on this host for "
                             + ("another agent" if owner else "something else (no agent id in its .env)"))
    if not find_provider_key(paths, args["llmProvider"], profile):
        raise CommandRefused("no_api_key", no_key_message(args["llmProvider"]))
    token = args["apiToken"]
    spec = {k: v for k, v in args.items()}
    public = {k: v for k, v in args.items() if k != "apiToken"}
    rerun = home.exists()
    summary = f"{'set up again' if rerun else 'set up'} {args['agentName']} as profile {profile} ({args['gateway']} gateway)"
    return Plan("provision_agent", public, [], summary, module="emperor_hostd.provision", secret_spec=spec,
                token_sha256=hashlib.sha256(token.encode("utf-8")).hexdigest(), exit_reasons=PROVISION_EXIT_REASONS)


def plan_remove(paths: HostPaths, args: dict[str, Any]) -> Plan:
    """``emperor-hermes remove --profile p --purge --yes``, only for the agent the profile names.
    Nothing left to remove (no record, no profile) is a success: the removal already happened."""
    profile = args["profile"]
    record = profile_record(paths, profile)
    home = paths.profile_home(profile)
    unrecorded = not record or record.get("status") == "removed"
    if unrecorded and not home.exists():
        return Plan("remove_agent", args, None, f"profile {profile} is not on this host (nothing to remove)", discard_profile=profile)
    if not profile_belongs_to(paths, profile, args["agentId"]):
        owner = profile_agent_id(paths, profile)
        raise CommandRefused("agent_mismatch", f"profile {profile} belongs to "
                             + ("another agent" if owner else "no agent Emperor can verify (no agent id in its .env)")
                             + "; not removed")
    if unrecorded:
        # A setup that died before emperor-hermes recorded it: no units, only the profile we made.
        if not read_marker(paths, profile):
            raise CommandRefused("unknown_profile", f"{profile} is not managed by emperor-hermes on this host; remove it by hand")
        return Plan("remove_agent", args, None, f"remove the unfinished profile {profile}", discard_profile=profile)
    argv = ["/bin/bash", str(paths.installer), "remove", "--profile", profile, "--yes", "--non-interactive"]
    if args["purge"]:
        argv.append("--purge")
    return Plan("remove_agent", args, argv, f"remove profile {profile}" + (" (deleted)" if args["purge"] else " (archived)"))
