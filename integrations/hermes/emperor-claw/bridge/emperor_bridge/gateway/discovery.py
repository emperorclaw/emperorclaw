"""Gateway discovery over the UNIX control socket: `identify` (D1 checks) and session tickets.

Standalone/managed: `<profile_home>/gateway.sock`. Shared (D21): the default home's socket
(`~/.hermes/gateway.sock`) and the ticket carries this profile's `profile_id` from
`served_profiles`. A long home path is redirected through `<home>/gateway.sock.path` (P§1.4).
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import stat
import struct
import sys
from pathlib import Path
from typing import Any, Callable, Mapping, Optional
from urllib.parse import urlparse

from ..interfaces import (GATEWAY_KIND, GatewayIdentity, GatewayIncompatible, GatewayUnavailable,
                          HERMES_CODE_VERSION, ProfileNotServed, ProfileTarget, RUNTIME_PROTOCOL,
                          SESSION_AUTHORITY_CAPABILITY, Topology)

ControlTransport = Callable[[Path, Mapping[str, Any], float], Mapping[str, Any]]
"""(socket_path, request, timeout) -> parsed response. Blocking; run in a worker thread."""


def resolve_target(profile_name: str, topology: Topology | str = Topology.STANDALONE,
                   hermes_root: Optional[Path] = None) -> ProfileTarget:
    """Profile home `<root>/profiles/<name>` (the default profile is the root itself)."""
    topo = Topology(topology)
    root = Path(hermes_root or Path.home() / ".hermes")
    home = root if profile_name in ("", "default") else root / "profiles" / profile_name
    control = root if topo is Topology.SHARED else home
    return ProfileTarget(profile_name=profile_name or "default", profile_home=home,
                         control_home=control, topology=topo)


def control_socket_path(control_home: Path) -> Path:
    redirect = Path(control_home) / "gateway.sock.path"
    try:
        target = redirect.read_text(encoding="utf-8").strip()
    except OSError:
        target = ""
    return Path(target) if target else Path(control_home) / "gateway.sock"


def check_socket_security(sock_path: Path, control_home: Path) -> None:
    """Same checks as Hermes' own client: home not world-writable, socket ours and 0600."""
    if not hasattr(os, "getuid"):
        return
    try:
        home_st = os.stat(control_home)
        sock_st = os.stat(sock_path)
    except FileNotFoundError as exc:
        raise GatewayUnavailable(f"gateway control socket missing: {sock_path}") from exc
    if home_st.st_mode & stat.S_IWOTH:
        raise GatewayIncompatible(f"{control_home} is writable by others")
    if sock_st.st_uid != os.getuid():
        raise GatewayIncompatible(f"{sock_path} is owned by uid {sock_st.st_uid}, not ours")
    if sock_st.st_mode & 0o077:
        raise GatewayIncompatible(f"{sock_path} mode {oct(sock_st.st_mode & 0o777)} is not 0600")


def unix_control_transport(path: Path, request: Mapping[str, Any], timeout: float) -> Mapping[str, Any]:
    """One JSON line in, one JSON line out, then the server closes (P§1.4)."""
    family = getattr(socket, "AF_UNIX", None)
    if family is None:
        raise GatewayUnavailable("UNIX sockets are not available on this platform")
    with socket.socket(family, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        try:
            sock.connect(str(path))
        except OSError as exc:
            raise GatewayUnavailable(f"control socket connect failed: {exc}") from exc
        _check_peer_uid(sock)
        sock.sendall(json.dumps(request).encode("utf-8") + b"\n")
        data = bytearray()
        while not data.endswith(b"\n"):
            chunk = sock.recv(65536)
            if not chunk:
                break
            data.extend(chunk)
    try:
        parsed = json.loads(bytes(data))
    except ValueError as exc:
        raise GatewayUnavailable(f"control socket answered garbage: {bytes(data)[:200]!r}") from exc
    if not isinstance(parsed, Mapping):
        raise GatewayUnavailable("control socket answered a non-object")
    return parsed


def _check_peer_uid(sock: socket.socket) -> None:
    peercred = getattr(socket, "SO_PEERCRED", None)
    if peercred is None or not sys.platform.startswith("linux"):
        return
    raw = sock.getsockopt(socket.SOL_SOCKET, peercred, struct.calcsize("3i"))
    _pid, uid, _gid = struct.unpack("3i", raw)
    if uid != os.getuid():
        raise GatewayIncompatible(f"gateway peer uid {uid} is not ours")


def validate_identify(response: Mapping[str, Any], target: ProfileTarget,
                      expected_code_version: str = HERMES_CODE_VERSION) -> GatewayIdentity:
    """Apply D1 and resolve the profile_id for the target. Raises on any failure.

    `GatewayUnavailable` = retry later (starting, draining, profile not yet served).
    `GatewayIncompatible` = never dispatch against this gateway.
    """
    if not response.get("ok"):
        raise GatewayUnavailable(f"identify refused: {response.get('error')}")
    r = response.get("result") or {}
    state = r.get("state")
    if state != "ready":  # starting/draining gateways do not publish capabilities or profiles yet
        raise GatewayUnavailable(f"gateway state={state!r} ({r.get('drain_reason') or 'not ready'})")
    if r.get("kind") != GATEWAY_KIND:
        raise GatewayIncompatible(f"identify.kind={r.get('kind')!r}, expected {GATEWAY_KIND!r}")
    if r.get("runtime_protocol") != RUNTIME_PROTOCOL:
        raise GatewayIncompatible(f"runtime_protocol={r.get('runtime_protocol')!r}")
    capabilities = tuple(r.get("capabilities") or ())
    if SESSION_AUTHORITY_CAPABILITY not in capabilities:
        raise GatewayIncompatible("gateway lacks session-authority-v1")
    if expected_code_version and r.get("code_version") != expected_code_version:
        raise GatewayIncompatible(f"code_version={r.get('code_version')!r}, pinned {expected_code_version!r}")
    epoch = int(r.get("authority_epoch") or 0)
    if epoch <= 0:
        raise GatewayUnavailable("authority_epoch is not positive yet")
    origin = str(r.get("api_origin") or "")
    parsed = urlparse(origin)
    if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "::1", "localhost") or not parsed.port:
        raise GatewayIncompatible(f"api_origin {origin!r} is not a loopback http origin")
    profile_id = _profile_id_for(r, target)
    return GatewayIdentity(instance_id=str(r.get("instance_id") or ""), authority_epoch=epoch,
                           api_origin=origin, code_version=str(r.get("code_version") or ""),
                           code_sha=str(r.get("code_sha") or ""), profile_id=profile_id,
                           hermes_home=str(r.get("hermes_home") or ""), pid=r.get("pid"),
                           state=str(state), capabilities=capabilities)


def _profile_id_for(result: Mapping[str, Any], target: ProfileTarget) -> str:
    wanted = _norm(target.profile_home)
    for entry in result.get("served_profiles") or ():
        if isinstance(entry, Mapping) and _norm(entry.get("home")) == wanted:
            return str(entry.get("profile_id") or entry.get("home"))
    if target.topology is Topology.SHARED or not result.get("served_profiles"):
        raise ProfileNotServed(f"shared gateway does not serve {target.profile_home} (run `hermes gateway rescan`)")
    raise GatewayIncompatible(f"gateway at {target.control_home} does not serve {target.profile_home}")


def _norm(value: Any) -> str:
    return str(value or "").replace("\\", "/").rstrip("/")


class GatewayDiscovery:
    """identify + session-ticket for one ProfileTarget. Stateless apart from its config."""

    def __init__(self, target: ProfileTarget, *, transport: Optional[ControlTransport] = None,
                 expected_code_version: str = HERMES_CODE_VERSION, timeout_s: float = 5.0,
                 check_security: bool = True) -> None:
        self.target = target
        self._transport = transport or unix_control_transport
        self._expected = expected_code_version
        self._timeout = timeout_s
        self._check_security = check_security and transport is None

    async def _request(self, verb: str, params: Optional[Mapping[str, Any]] = None) -> Mapping[str, Any]:
        path = control_socket_path(self.target.control_home)
        if self._check_security:
            check_socket_security(path, self.target.control_home)
        request: dict[str, Any] = {"protocol": 1, "verb": verb, "id": 1}
        if params is not None:
            request["params"] = dict(params)
        try:
            return await asyncio.to_thread(self._transport, path, request, self._timeout)
        except (OSError, socket.timeout) as exc:
            raise GatewayUnavailable(f"control socket {verb} failed: {exc}") from exc

    async def identify(self) -> GatewayIdentity:
        return validate_identify(await self._request("identify"), self.target, self._expected)

    async def mint_ticket(self, identity: GatewayIdentity) -> str:
        """Single-use, 30 s ticket. `stale runtime instance` means re-identify."""
        response = await self._request("session-ticket", {
            "profile_id": identity.profile_id, "instance_id": identity.instance_id,
            "purpose": "interactive"})
        if not response.get("ok"):
            raise GatewayUnavailable(f"ticket refused: {response.get('error')}")
        ticket = (response.get("result") or {}).get("ticket")
        if not ticket:
            raise GatewayUnavailable("ticket response without a ticket")
        return str(ticket)


async def identify(control_home: Path, target: Optional[ProfileTarget] = None) -> GatewayIdentity:
    """Doc signature (section 5.1). `target` defaults to a standalone profile at control_home."""
    tgt = target or ProfileTarget(Path(control_home).name, Path(control_home), Path(control_home))
    return await GatewayDiscovery(tgt).identify()


async def mint_ticket(control_home: Path, ident: GatewayIdentity, profile_id: str) -> str:
    tgt = ProfileTarget(Path(control_home).name, Path(control_home), Path(control_home))
    ident = GatewayIdentity(**{**ident.__dict__, "profile_id": profile_id})
    return await GatewayDiscovery(tgt).mint_ticket(ident)
