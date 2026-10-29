"""The command allowlist (server twin: src/lib/runtime-hosts/commands.ts).

Arguments are validated again here (the server is not trusted blindly) and turned into argv
lists. Nothing is ever passed to a shell or interpolated into a command string; the profile must
be one emperor-hermes manages (an active record), and its topology comes from that record, not
from the server.

0.21 runs restart_agent and refresh_inventory. The validators of the later commands (and of
``disconnect``: revoking the host in Emperor, or ``emperor-hermes host disconnect`` locally, are
the ways to cut a host off) exist so their shapes are pinned, but :func:`plan` refuses them.

Shared gateway safety: Emperor never says how a profile runs. The local record does, and a shared
gateway restart (every agent on the host) ALWAYS waits for idle unless Emperor sends an explicit
``force: true``, which it only does when an admin ticked "restart now even if busy".
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

from emperor_bridge.config import read_env_file

from .config import HostPaths

PROFILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
SEMVER_RE = re.compile(r"^\d{1,4}\.\d{1,4}\.\d{1,6}$")
MODEL_RE = re.compile(r"^[A-Za-z0-9._:/-]{1,128}$")
AGENT_TOKEN_RE = re.compile(r"^ec_[0-9a-f]{48}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

ALL_COMMANDS = ("provision_agent", "update_runtime", "restart_agent", "remove_agent", "rotate_agent_token",
                "refresh_inventory", "disconnect")
ENABLED_COMMANDS = frozenset({"restart_agent", "refresh_inventory"})
#: Commands that run a process (through systemd-run); the others are answered in-process.
PROCESS_COMMANDS = frozenset({"restart_agent"})
#: restart-gateway --when-idle waits at most this long, inside the 300 s job deadline.
WHEN_IDLE_TIMEOUT_SEC = 240


class CommandRefused(ValueError):
    """The command or its arguments are not acceptable; ``code`` goes into the ack reason."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.detail = detail


def safe_env_value(value: str) -> bool:
    return not re.search(r"[\"\\$`\n\r]", value)


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
        if not isinstance(name, str) or not name.strip() or len(name) > 80 or not safe_env_value(name):
            raise CommandRefused("invalid_args", "agentName is not a safe name")
        if not isinstance(args.get("apiToken"), str) or not AGENT_TOKEN_RE.match(args["apiToken"]):
            raise CommandRefused("invalid_args", "apiToken has the wrong shape")
        if args.get("gateway") not in ("standalone", "shared"):
            raise CommandRefused("invalid_args", "gateway must be standalone or shared")
        if not isinstance(args.get("llmProvider"), str) or not re.match(r"^[a-z0-9_-]{1,40}$", args["llmProvider"]):
            raise CommandRefused("invalid_args", "llmProvider is not valid")
        if "model" in args and (not isinstance(args["model"], str) or not MODEL_RE.match(args["model"])):
            raise CommandRefused("invalid_args", "model is not valid")
        max_parallel = args.get("maxParallel", 1)
        if not isinstance(max_parallel, int) or isinstance(max_parallel, bool) or not 1 <= max_parallel <= 8:
            raise CommandRefused("invalid_args", "maxParallel must be 1-8")
        return {**args, "profile": profile, "maxParallel": max_parallel, "skipBrowser": bool(args.get("skipBrowser", False))}
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
        return {"profile": profile, "agentId": args["agentId"], "purge": bool(args.get("purge", False))}
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
