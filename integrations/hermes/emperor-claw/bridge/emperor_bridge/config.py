"""Configuration (design 5.7, D8): host-level values from the unit environment, per-agent values
from each profile's own ``.env``.

The bridge reads ``<profile_home>/.env`` itself (no systemd ``EnvironmentFile``), which is what
lets one process host several agents (shared topology, D21). Lookup order for a per-agent value:
the profile ``.env``, then the process environment, then the default. Credentials
(``EMPEROR_CLAW_API_TOKEN``, ``EMPEROR_CLAW_AGENT_ID``, ...) never fall back to the process
environment when a process hosts more than one agent: one agent must never borrow another's token.
"""
from __future__ import annotations

import os
import socket
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

from .gateway.discovery import resolve_target
from .interfaces import ProfileTarget, Topology

DEFAULT_API_URL = "https://emperorclaw.malecu.eu"
DEFAULT_TOOLSETS = ("emperor-claw", "web", "terminal", "code_execution")
CREDENTIAL_KEYS = frozenset({"EMPEROR_CLAW_API_URL", "EMPEROR_CLAW_API_TOKEN", "EMPEROR_CLAW_AGENT_ID",
                             "EMPEROR_CLAW_AGENT_NAME", "EMPEROR_CLAW_RUNTIME_ID"})
FALSE_WORDS = frozenset({"0", "off", "false", "no"})


class ConfigError(ValueError):
    """The configuration cannot start a bridge (missing profile, token, ...)."""


def read_env_file(path: Path) -> dict[str, str]:
    """Parse a dotenv file: ``KEY=value``, optional ``export``, quotes stripped, comments skipped."""
    values: dict[str, str] = {}
    try:
        raw = Path(path).read_text(encoding="utf-8")
    except OSError:
        return values
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1].replace("\\'", "'").replace('\\"', '"').replace("\\\\", "\\")
        values[key] = value
    return values


def host_fingerprint(paths: Sequence[str] = ("/etc/machine-id", "/var/lib/dbus/machine-id")) -> Optional[str]:
    """sha256 hex of the machine id (the server's shared-host check); None when there is none."""
    import hashlib
    for candidate in paths:
        try:
            text = Path(candidate).read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if text:
            return hashlib.sha256(text.encode("utf-8")).hexdigest()
    return None


def _split_list(value: str) -> tuple[str, ...]:
    return tuple(part.strip() for part in value.replace(";", ",").split(",") if part.strip())


@dataclass(frozen=True)
class HostConfig:
    """Process-level settings: which profiles, which topology, which interpreter/checkout."""

    profiles: tuple[str, ...]
    topology: Topology
    hermes_root: Path
    hermes_python: str
    hermes_checkout: Path
    hostname: str
    env: Mapping[str, str] = field(default_factory=dict)
    log_level: str = "INFO"

    @classmethod
    def from_env(cls, env: Optional[Mapping[str, str]] = None, profiles: Optional[str] = None) -> "HostConfig":
        env = dict(os.environ if env is None else env)
        raw = profiles or env.get("EMPEROR_HERMES_PROFILES") or env.get("HERMES_PROFILE") \
            or env.get("EMPEROR_CLAW_HERMES_PROFILE") or ""
        names = _split_list(raw)
        if not names:
            raise ConfigError("no profile: set HERMES_PROFILE or pass --profiles a,b")
        if len(set(names)) != len(names):
            raise ConfigError(f"duplicate profile in {raw!r}")
        try:
            topology = Topology((env.get("EMPEROR_CLAW_HERMES_GATEWAY") or "standalone").strip().lower())
        except ValueError as exc:
            raise ConfigError("EMPEROR_CLAW_HERMES_GATEWAY must be standalone, shared or managed") from exc
        if topology is Topology.MANAGED and len(names) > 1:
            raise ConfigError("managed mode hosts exactly one agent (one container = one agent)")
        home = Path(env.get("HOME") or Path.home())
        hermes_root = Path(env.get("EMPEROR_HERMES_ROOT") or home / ".hermes")
        default_python = home / ".local" / "share" / "emperor-hermes" / "python"
        return cls(profiles=names, topology=topology, hermes_root=hermes_root,
                   hermes_python=env.get("HERMES_PYTHON") or (str(default_python) if default_python.exists()
                                                              else "python3"),
                   hermes_checkout=Path(env.get("HERMES_CHECKOUT") or hermes_root / "hermes-agent"),
                   hostname=socket.gethostname(), env=env,
                   log_level=env.get("EMPEROR_CLAW_LOG_LEVEL", "INFO"))

    def target(self, profile: str) -> ProfileTarget:
        return resolve_target(profile, self.topology, self.hermes_root)


class _Lookup:
    def __init__(self, dotenv: Mapping[str, str], env: Mapping[str, str], isolate_credentials: bool) -> None:
        self.dotenv = dotenv
        self.env = env
        self.isolate = isolate_credentials

    def get(self, key: str, default: str = "") -> str:
        if key in self.dotenv:
            return self.dotenv[key].strip()
        if self.isolate and key in CREDENTIAL_KEYS:
            return default
        value = self.env.get(key)
        return value.strip() if isinstance(value, str) else default

    def number(self, key: str, default: float, minimum: Optional[float] = None) -> float:
        try:
            value = float(self.get(key) or default)
        except ValueError:
            value = float(default)
        return max(minimum, value) if minimum is not None else value

    def integer(self, key: str, default: int, minimum: Optional[int] = None) -> int:
        return int(self.number(key, default, minimum))

    def flag(self, key: str, default: bool) -> bool:
        raw = self.get(key)
        return default if not raw else raw.lower() not in FALSE_WORDS


@dataclass(frozen=True)
class AgentConfig:
    """Everything one AgentRuntime needs. Built by ``from_profile``; immutable afterwards."""

    target: ProfileTarget
    api_url: str
    api_token: str
    agent_id: str
    agent_name: str
    agent_role: str
    agent_instructions: str
    runtime_id: str
    hostname: str
    toolsets: tuple[str, ...] = DEFAULT_TOOLSETS
    cwd: str = ""
    max_parallel_turns: int = 3
    followup_mode: str = "coalesce"
    compact_after_tokens: int = 60000
    turn_timeout_s: int = 0
    turn_idle_timeout_s: float = 900.0
    event_flush_ms: int = 500
    allow_duplicate_runtime: bool = False
    ack_first: bool = True
    rich_replies: bool = True
    context_mode: str = "full"
    lean_revalidate_s: float = 600.0
    capability_refresh_s: float = 600.0
    loop_guard_max_turns: int = 3
    retry_base_s: int = 15
    retry_max_s: int = 300
    max_retry_attempts: int = 3
    max_environment_wait_s: int = 86400
    transport_attempts: int = 6
    transport_backoff_s: float = 0.5
    transport_backoff_max_s: float = 3.0
    transport_budget_s: float = 25.0
    outbox_retry_base_s: int = 15
    outbox_retry_max_s: int = 900
    outbox_max_attempts: int = 8
    doctrine_resource_id: str = ""
    operating_guide_path: str = ""
    shared_resource_max_chars: int = 6000
    max_chars_per_resource: Optional[int] = None
    llm_provider: str = ""
    llm_model: str = ""
    legacy_state_path: Optional[Path] = None
    legacy_outbox_dir: Optional[Path] = None
    hermes_python: str = "python3"
    hermes_checkout: Path = Path(".")
    dotenv_keys: tuple[str, ...] = ()

    @property
    def profile_name(self) -> str:
        return self.target.profile_name

    @property
    def profile_home(self) -> Path:
        return self.target.profile_home

    @property
    def topology(self) -> Topology:
        return self.target.topology

    @property
    def emperor_dir(self) -> Path:
        return self.profile_home / "emperor"

    @property
    def outbox_dir(self) -> Path:
        return self.emperor_dir / "outbox"

    @property
    def health_path(self) -> Path:
        return self.emperor_dir / "health.json"

    @classmethod
    def from_profile(cls, profile: str, host: HostConfig, *, dotenv: Optional[Mapping[str, str]] = None) -> "AgentConfig":
        target = host.target(profile)
        values = read_env_file(target.profile_home / ".env") if dotenv is None else dict(dotenv)
        get = _Lookup(values, host.env, isolate_credentials=len(host.profiles) > 1)
        token = get.get("EMPEROR_CLAW_API_TOKEN")
        if not token:
            raise ConfigError(f"profile {profile}: EMPEROR_CLAW_API_TOKEN missing in {target.profile_home / '.env'}")
        legacy_state = get.get("EMPEROR_CLAW_HERMES_STATE_PATH")
        legacy_outbox = get.get("EMPEROR_CLAW_HERMES_OUTBOX_DIR")
        if not legacy_outbox and legacy_state:
            legacy_outbox = str(Path(legacy_state).with_suffix("")) + "-outbox"
        per_resource = get.integer("EMPEROR_CLAW_SHARED_RESOURCE_MAX_CHARS_PER_RESOURCE", 0, 0)
        return cls(
            target=target,
            api_url=(get.get("EMPEROR_CLAW_API_URL") or DEFAULT_API_URL).rstrip("/"),
            api_token=token,
            agent_id=get.get("EMPEROR_CLAW_AGENT_ID"),
            agent_name=get.get("EMPEROR_CLAW_AGENT_NAME") or profile or "Hermes",
            agent_role=get.get("EMPEROR_CLAW_AGENT_ROLE") or "operator",
            agent_instructions=get.get("EMPEROR_CLAW_AGENT_INSTRUCTIONS"),
            runtime_id=get.get("EMPEROR_CLAW_RUNTIME_ID"),
            hostname=host.hostname,
            toolsets=_split_list(get.get("EMPEROR_CLAW_HERMES_TOOLSETS")) or DEFAULT_TOOLSETS,
            cwd=get.get("EMPEROR_CLAW_HERMES_CWD") or str(Path(host.env.get("HOME") or Path.home())),
            max_parallel_turns=get.integer("EMPEROR_CLAW_HERMES_MAX_PARALLEL_TURNS", 3, 1),
            followup_mode=(get.get("EMPEROR_CLAW_HERMES_FOLLOWUP") or "coalesce").lower(),
            compact_after_tokens=get.integer("EMPEROR_CLAW_HERMES_COMPACT_AFTER_TOKENS", 60000, 0),
            turn_timeout_s=get.integer("EMPEROR_CLAW_HERMES_TURN_TIMEOUT_SECONDS", 0, 0),
            turn_idle_timeout_s=get.number("EMPEROR_CLAW_HERMES_TURN_IDLE_TIMEOUT_SECONDS", 900, 0),
            event_flush_ms=get.integer("EMPEROR_CLAW_HERMES_EVENT_FLUSH_MS", 500, 50),
            allow_duplicate_runtime=get.flag("EMPEROR_CLAW_ALLOW_DUPLICATE_RUNTIME", False),
            ack_first=get.flag("EMPEROR_CLAW_HERMES_ACK_FIRST", True),
            rich_replies=get.flag("EMPEROR_CLAW_RICH_REPLIES", True),
            context_mode=(get.get("EMPEROR_CLAW_CONTEXT_MODE") or "full").lower(),
            lean_revalidate_s=get.number("EMPEROR_CLAW_LEAN_REVALIDATE_SECONDS", 600, 0),
            capability_refresh_s=get.number("EMPEROR_CLAW_CAPABILITY_REFRESH_SECONDS", 600, 0),
            loop_guard_max_turns=get.integer("EMPEROR_CLAW_LOOP_GUARD_MAX_TURNS", 3, 1),
            retry_base_s=get.integer("EMPEROR_CLAW_HERMES_RETRY_BASE_SECONDS", 15, 1),
            retry_max_s=get.integer("EMPEROR_CLAW_HERMES_RETRY_MAX_SECONDS", 300, 1),
            max_retry_attempts=get.integer("EMPEROR_CLAW_HERMES_MAX_RETRY_ATTEMPTS", 3, 1),
            max_environment_wait_s=get.integer("EMPEROR_CLAW_HERMES_MAX_ENVIRONMENT_WAIT_SECONDS", 86400, 60),
            transport_attempts=get.integer("EMPEROR_CLAW_HERMES_TRANSPORT_ATTEMPTS", 6, 1),
            transport_backoff_s=get.number("EMPEROR_CLAW_HERMES_TRANSPORT_BACKOFF_SECONDS", 0.5, 0),
            transport_backoff_max_s=get.number("EMPEROR_CLAW_HERMES_TRANSPORT_BACKOFF_MAX_SECONDS", 3, 0),
            transport_budget_s=get.number("EMPEROR_CLAW_HERMES_TRANSPORT_TOTAL_BUDGET_SECONDS", 25, 0.5),
            outbox_retry_base_s=get.integer("EMPEROR_CLAW_HERMES_OUTBOX_RETRY_BASE_SECONDS", 15, 1),
            outbox_retry_max_s=get.integer("EMPEROR_CLAW_HERMES_OUTBOX_RETRY_MAX_SECONDS", 900, 1),
            outbox_max_attempts=get.integer("EMPEROR_CLAW_HERMES_OUTBOX_MAX_ATTEMPTS", 8, 1),
            doctrine_resource_id=get.get("EMPEROR_CLAW_DOCTRINE_RESOURCE_ID"),
            operating_guide_path=get.get("EMPEROR_CLAW_OPERATING_GUIDE_PATH"),
            shared_resource_max_chars=get.integer("EMPEROR_CLAW_SHARED_RESOURCE_MAX_CHARS", 6000, 0),
            max_chars_per_resource=per_resource or None,
            llm_provider=get.get("EMPEROR_CLAW_LLM_PROVIDER"),
            llm_model=get.get("EMPEROR_CLAW_RUNTIME_MODEL") or get.get("EMPEROR_CLAW_LLM_MODEL"),
            # Only an explicit path is imported: the 0.3 default file may belong to another agent.
            legacy_state_path=Path(legacy_state).expanduser() if legacy_state else None,
            legacy_outbox_dir=Path(legacy_outbox).expanduser() if legacy_outbox else None,
            hermes_python=host.hermes_python,
            hermes_checkout=host.hermes_checkout,
            dotenv_keys=tuple(sorted(values)),
        )


def load_agent_configs(host: HostConfig, logger: Any) -> list[AgentConfig]:
    """One AgentConfig per profile; deleted 0.3 variables are warned about once per process."""
    from .log import warn_deleted_env
    warned: set[str] = set()
    configs = []
    for profile in host.profiles:
        dotenv_path = host.target(profile).profile_home / ".env"
        dotenv = read_env_file(dotenv_path)
        warn_deleted_env([(str(dotenv_path), dotenv)], logger, warned)
        configs.append(AgentConfig.from_profile(profile, host, dotenv=dotenv))
    warn_deleted_env([("process environment", host.env)], logger, warned)
    return configs
