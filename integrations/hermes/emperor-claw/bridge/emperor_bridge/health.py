"""Bridge health: ``<profile_home>/emperor/health.json`` (read by ``emperor-hermes status``) and the
``python -m emperor_bridge healthcheck`` probe (Docker HEALTHCHECK, contract tests, operators).

health.json keys: bridgeVersion, registered, duplicateRuntime, sharedHostOk, gatewayTopology,
gatewayReady, hermesVersion, runtimeId, agentId, standby, inFlight, queued, lastError, updatedAt.

The probe is healthy when the gateway answers ``identify`` with ``state == ready`` (managed mode:
through ``supervisor.healthcheck()``, which also reads the supervisor's status file) and the
bridge's health.json is fresh (written within ``STALE_AFTER_S``) and not marked fatal. Docker runs
the probe with the container's create-time environment only, so the profile also comes from the
supervisor status file when ``HERMES_PROFILE`` is not set.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Callable, Mapping, Optional

from . import supervisor
from .interfaces import GatewayIdentity, Topology
from .version import BRIDGE_CAPABILITIES, BRIDGE_PROTOCOL, BRIDGE_VERSION

STALE_AFTER_S = 180.0
HEALTH_FILENAME = "health.json"


def registration_body(*, runtime_id: str, agent_id: str, hostname: str, topology: Topology,
                      identity: Optional[GatewayIdentity], started_at: float,
                      fingerprint: Optional[str]) -> dict[str, Any]:
    """POST /runtime/register body (register v2: bridge/Hermes versions, topology, host fingerprint)."""
    body = {"runtimeId": runtime_id, "name": f"Hermes on {hostname}", "hostname": hostname,
            "gatewayVersion": "hermes-agent", "agentId": agent_id, "capabilitiesJson": list(BRIDGE_CAPABILITIES),
            "bridgeVersion": BRIDGE_VERSION, "bridgeProtocol": BRIDGE_PROTOCOL,
            "hermesVersion": identity.code_version if identity else None,
            "hermesCodeSha": identity.code_sha if identity else None, "transport": "gateway-ws",
            "deployMode": "managed" if topology is Topology.MANAGED else "remote",
            "gatewayTopology": topology.value, "hostFingerprint": fingerprint,
            "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started_at))}
    return {k: v for k, v in body.items() if v is not None}


def standby_reason(response: Mapping[str, Any], *, allow_duplicate: bool, topology: Topology) -> Optional[str]:
    """Why this runtime must not dispatch (D19 duplicate runtime, D21 sharedHostOk), or None."""
    duplicate = response.get("duplicateRuntime")
    if duplicate and not allow_duplicate:
        other = duplicate.get("runtimeId") if isinstance(duplicate, Mapping) else duplicate
        return f"duplicate runtime {other} is live for this agent"
    if topology is Topology.SHARED and response.get("sharedHostOk") is False:
        return "sharedHostOk=false: agents on this shared gateway belong to different companies"
    return None


def health_path(profile_home: Path) -> Path:
    return Path(profile_home) / "emperor" / HEALTH_FILENAME


def write_health(path: Path, values: Mapping[str, Any], now: Optional[float] = None) -> dict[str, Any]:
    """Atomic write; never raises (health is advisory)."""
    data = {"bridgeVersion": BRIDGE_VERSION, **values, "updatedAt": time.time() if now is None else now}
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(data, indent=1, default=str), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        pass
    return data


def read_health(path: Path) -> Optional[dict[str, Any]]:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def evaluate_health(data: Optional[Mapping[str, Any]], now: Optional[float] = None,
                    stale_after_s: float = STALE_AFTER_S) -> tuple[bool, str]:
    """Bridge half of the probe, pure."""
    if not data:
        return False, "bridge health.json missing (bridge not started yet?)"
    age = (time.time() if now is None else now) - float(data.get("updatedAt") or 0)
    if age > stale_after_s:
        return False, f"bridge health.json is stale ({age:.0f} s old)"
    if data.get("fatal"):
        return False, f"bridge fatal: {data.get('lastError')}"
    if data.get("duplicateRuntime"):
        return True, "bridge in standby (another runtime is live for this agent)"
    return True, f"bridge {data.get('bridgeVersion')} registered={data.get('registered')}"


def _profile_home(env: Mapping[str, str], status: Optional[Mapping[str, Any]]) -> Optional[Path]:
    profile = (env.get("HERMES_PROFILE") or "").split(",")[0].strip()
    root = Path(env.get("EMPEROR_HERMES_ROOT") or Path(env.get("HOME") or Path.home()) / ".hermes")
    if profile:
        return root if profile == "default" else root / "profiles" / profile
    if status and status.get("profileHome"):
        return Path(str(status["profileHome"]))
    return None


def healthcheck(env: Optional[Mapping[str, str]] = None, *, now: Optional[float] = None,
                identify: Callable[[Path], dict] = supervisor.identify_sync) -> tuple[bool, str]:
    env = dict(os.environ if env is None else env)
    status_file = supervisor.default_status_path(env)
    status = supervisor.read_status(status_file)
    home = _profile_home(env, status)
    if home is None:
        return False, "no profile: set HERMES_PROFILE"
    data = read_health(health_path(home))
    topology = (env.get("EMPEROR_CLAW_HERMES_GATEWAY") or (data or {}).get("gatewayTopology") or
                ("managed" if status else "standalone"))
    if topology == "managed" or (status and topology != "shared"):
        gateway_ok, gateway_msg = supervisor.healthcheck(status_file, identify=identify)
    else:
        control = Path(env.get("EMPEROR_HERMES_ROOT") or Path(env.get("HOME") or Path.home()) / ".hermes") \
            if topology == "shared" else home
        try:
            result = (identify(control) or {}).get("result") or {}
        except (OSError, ValueError) as exc:
            return False, f"gateway identify failed: {exc}"
        gateway_ok = result.get("state") == "ready"
        gateway_msg = f"gateway {'ready' if gateway_ok else 'not ready'} version={result.get('code_version')}"
    bridge_ok, bridge_msg = evaluate_health(data, now)
    return gateway_ok and bridge_ok, f"{gateway_msg}; {bridge_msg}"


def main() -> int:
    ok, message = healthcheck()
    print(("healthy: " if ok else "unhealthy: ") + message, flush=True)
    return 0 if ok else 1
