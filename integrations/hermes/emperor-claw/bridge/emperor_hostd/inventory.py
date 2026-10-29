"""What runs on this host: the hello and inventory frames.

Read-only. Provider NAMES only (from ``*_API_KEY`` keys that have a value); every value read from
an ``.env`` file that looks like a credential is added to the redactor, so it can never leave the
host inside another field (a bridge's lastError, a log line).
"""
from __future__ import annotations

import json
import os
import platform
import re
import shutil
import socket
import subprocess
from pathlib import Path
from typing import Any, Callable, Optional, Sequence

from emperor_bridge.config import host_fingerprint, read_env_file

from .config import HostPaths, url_origin
from .protocol import Redactor
from .version import HOSTD_VERSION, HOST_PROTOCOL

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
PROFILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")

#: Emperor's provider ids by key name (src/lib/hermes-provisioning.ts PROVIDER_ENV_VAR).
PROVIDER_BY_KEY = {
    "OPENAI_API_KEY": "openai",
    "ANTHROPIC_API_KEY": "anthropic",
    "GOOGLE_API_KEY": "google",
    "GEMINI_API_KEY": "google",
    "OPENROUTER_API_KEY": "openrouter",
    "GROK_API_KEY": "grok",
    "XAI_API_KEY": "grok",
    "DEEPSEEK_API_KEY": "deepseek",
}

Runner = Callable[[Sequence[str]], "subprocess.CompletedProcess[str]"]


def clean_env(paths: HostPaths) -> dict[str, str]:
    """The environment of every child process: no credentials, only what systemctl needs."""
    env = {
        "PATH": f"{paths.home}/.local/bin:/usr/local/bin:/usr/bin:/bin",
        "HOME": str(paths.home),
        "LANG": "C.UTF-8",
    }
    for key in ("XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "USER", "LOGNAME"):
        if os.environ.get(key):
            env[key] = os.environ[key]
    return env


def default_runner(paths: HostPaths) -> Runner:
    def run(argv: Sequence[str]) -> "subprocess.CompletedProcess[str]":
        try:
            return subprocess.run(list(argv), capture_output=True, text=True, timeout=15, env=clean_env(paths), check=False)
        except (OSError, subprocess.SubprocessError) as exc:
            return subprocess.CompletedProcess(list(argv), 127, "", str(exc))
    return run


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def installer_versions(paths: HostPaths) -> tuple[Optional[str], Optional[str]]:
    """(EMPEROR_HERMES_VERSION, HERMES_REF) baked into the installed emperor-hermes."""
    text = _read_text(paths.installer)
    ver = re.search(r'^readonly EMPEROR_HERMES_VERSION="([^"]+)"', text, re.M)
    ref = re.search(r'^readonly HERMES_REF="([^"]+)"', text, re.M)
    return (ver.group(1) if ver else None, ref.group(1) if ref else None)


def bridge_version(paths: HostPaths) -> Optional[str]:
    value = _read_text(paths.bridge_current / "VERSION").strip()
    return value or None


def os_name() -> str:
    text = _read_text(Path("/etc/os-release"))
    pretty = re.search(r'^PRETTY_NAME="?([^"\n]+)"?', text, re.M)
    return (pretty.group(1) if pretty else platform.system() or "unknown")[:80]


def build_hello(paths: HostPaths, jobs: list[dict[str, Any]], fingerprint: Optional[str] = None) -> dict[str, Any]:
    installer, hermes = installer_versions(paths)
    return {
        "type": "hello",
        "protocol": HOST_PROTOCOL,
        "hostdVersion": HOSTD_VERSION,
        "installerVersion": installer,
        "bridgeVersion": bridge_version(paths),
        "hermesVersion": hermes,
        "hostFingerprint": fingerprint or host_fingerprint() or "",
        "hostname": socket.gethostname()[:255],
        "os": os_name(),
        "arch": platform.machine()[:40] or None,
        "jobs": jobs,
    }


def meminfo() -> dict[str, int]:
    out: dict[str, int] = {}
    for line in _read_text(Path("/proc/meminfo")).splitlines():
        key, _, rest = line.partition(":")
        parts = rest.split()
        if key in ("MemTotal", "MemAvailable") and parts and parts[0].isdigit():
            out[key] = int(parts[0]) // 1024
    return out


def load1() -> Optional[float]:
    try:
        return round(os.getloadavg()[0], 2)
    except (OSError, AttributeError):
        return None


def resources(paths: HostPaths) -> dict[str, Any]:
    mem = meminfo()
    try:
        disk = shutil.disk_usage(str(paths.home)).free // (1024 * 1024)
    except OSError:
        disk = None
    return {"cpus": os.cpu_count(), "memTotalMiB": mem.get("MemTotal"), "memAvailMiB": mem.get("MemAvailable"),
            "diskFreeMiB": disk, "load1": load1()}


def heartbeat(active_job_id: Optional[str]) -> dict[str, Any]:
    return {"type": "heartbeat", "memAvailMiB": meminfo().get("MemAvailable"), "load1": load1(), "activeJobId": active_job_id}


def browser_available(paths: HostPaths) -> bool:
    for name in ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable"):
        if shutil.which(name):
            return True
    cache = paths.home / ".cache" / "ms-playwright"
    try:
        return cache.is_dir() and any(cache.iterdir())
    except OSError:
        return False


def linger_enabled() -> Optional[bool]:
    user = os.environ.get("USER") or os.environ.get("LOGNAME")
    if not user:
        return None
    return Path("/var/lib/systemd/linger", user).exists()


def _managed_records(paths: HostPaths) -> dict[str, dict[str, str]]:
    records: dict[str, dict[str, str]] = {}
    try:
        files = sorted(paths.records_dir.glob("*.env"))
    except OSError:
        files = []
    for f in files:
        name = f.name[:-4]
        if PROFILE_RE.match(name):
            records[name] = read_env_file(f)
    return records


def legacy_profiles(paths: HostPaths) -> list[str]:
    """Profiles served by a 0.3 unit (emperor-hermes-bridge-<name>.service) still in the unit dir."""
    found: list[str] = []
    try:
        files = sorted(paths.unit_dir.glob("emperor-hermes-bridge-*.service"))
    except OSError:
        files = []
    for f in files:
        if "@" in f.name or f.name == "emperor-hermes-bridge-shared.service":
            continue
        text = _read_text(f)
        match = re.search(r"HERMES_PROFILE=([A-Za-z0-9][A-Za-z0-9_.-]{0,63})", text)
        name = match.group(1) if match else f.name[len("emperor-hermes-bridge-"):-len(".service")]
        if PROFILE_RE.match(name) and name not in found:
            found.append(name)
    return found


def _unit_states(run: Runner, units: list[str]) -> dict[str, str]:
    if not units:
        return {}
    proc = run(["systemctl", "--user", "is-active", *units])
    states = (proc.stdout or "").split()
    return {unit: (states[i] if i < len(states) else "unknown") for i, unit in enumerate(units)}


def _health(paths: HostPaths, profile: str) -> dict[str, Any]:
    try:
        data = json.loads(_read_text(paths.profile_home(profile) / "emperor" / "health.json") or "{}")
    except ValueError:
        data = {}
    return data if isinstance(data, dict) else {}


def build_inventory(paths: HostPaths, emperor_origin: str, redactor: Redactor, run: Optional[Runner] = None) -> dict[str, Any]:
    run = run or default_runner(paths)
    providers: set[str] = set()

    def note_env(values: dict[str, str]) -> None:
        redactor.add_env(values)
        for key, value in values.items():
            if not value.strip() or not key.endswith("_API_KEY"):
                continue
            # LLM providers Emperor knows only (a FIRECRAWL_API_KEY is a tool, not a model provider).
            name = PROVIDER_BY_KEY.get(key)
            if name:
                providers.add(name)

    note_env(read_env_file(paths.hermes_root / ".env"))
    records = _managed_records(paths)
    legacy = [p for p in legacy_profiles(paths) if records.get(p, {}).get("status") != "active"]
    names = list(records) + [p for p in legacy if p not in records]

    units: list[str] = []
    for name in names:
        if records.get(name, {}).get("topology") == "standalone":
            units += [f"emperor-hermes-gateway@{name}.service", f"emperor-hermes-bridge@{name}.service"]
    shared = any(r.get("topology") == "shared" for r in records.values())
    if shared:
        units += ["emperor-hermes-gateway-shared.service", "emperor-hermes-bridge-shared.service"]
    states = _unit_states(run, units)

    profiles: list[dict[str, Any]] = []
    for name in names[:64]:
        record = records.get(name, {})
        env = read_env_file(paths.profile_home(name) / ".env")
        note_env(env)
        agent_id = env.get("EMPEROR_CLAW_AGENT_ID", "").strip().lower()
        topology = record.get("topology") or "unknown"
        if topology == "standalone":
            gateway = states.get(f"emperor-hermes-gateway@{name}.service", "unknown")
            bridge = states.get(f"emperor-hermes-bridge@{name}.service", "unknown")
        elif topology == "shared":
            gateway = states.get("emperor-hermes-gateway-shared.service", "unknown")
            bridge = states.get("emperor-hermes-bridge-shared.service", "unknown")
        else:
            gateway = bridge = "unknown"
        health = _health(paths, name)
        last_error = health.get("lastError")
        profiles.append({
            "profile": name,
            "agentId": agent_id if UUID_RE.match(agent_id) else None,
            "sameEmperor": bool(emperor_origin) and url_origin(env.get("EMPEROR_CLAW_API_URL", "")) == emperor_origin,
            "topology": topology if topology in ("standalone", "shared") else "unknown",
            "status": (record.get("status") or ("legacy" if name in legacy else "unknown"))[:40],
            "gateway": gateway[:40],
            "bridge": bridge[:40],
            "bridgeVersion": (str(health.get("bridgeVersion"))[:40] if health.get("bridgeVersion") else None),
            "health": {
                "registered": health.get("registered") if isinstance(health.get("registered"), bool) else None,
                "lastError": redactor.text(str(last_error))[:500] if last_error else None,
            },
            "legacy": name in legacy,
        })

    systemd_user = run(["systemctl", "--user", "show-environment"]).returncode == 0
    return {
        "type": "inventory",
        "resources": resources(paths),
        "capabilities": {"browser": browser_available(paths), "linger": linger_enabled(), "systemdUser": systemd_user},
        "llmProviders": sorted(providers)[:32],
        "profiles": profiles,
    }
