"""Where things live on the host, and the daemon's own credentials (``hostd.env``).

``hostd.env`` (mode 0600, written by ``emperor-hermes host connect``)::

    EMPEROR_URL="https://emperor.example.com"
    HOST_ID="<uuid>"
    HOST_TOKEN="ech_<64 hex>"

The Emperor URL comes ONLY from this file: a job can never point the daemon (or an agent) at
another server. Plain http is refused unless the host part is ``localhost`` or a literal private
address (10/8, 172.16/12, 192.168/16, 127/8, ::1), or the file says ``INSECURE="1"`` (written by
``host connect --insecure``): the host token would otherwise cross the internet in clear text.
"""
from __future__ import annotations

import ipaddress
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Optional
from urllib.parse import urlparse

from emperor_bridge.config import read_env_file

HOST_TOKEN_RE = re.compile(r"^ech_[0-9a-f]{64}$")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


class HostdConfigError(ValueError):
    """hostd.env is missing or invalid: the daemon cannot start (exit 78, no restart loop)."""


@dataclass(frozen=True)
class HostPaths:
    """The emperor-hermes layout under one user's home (installer: integrations/hermes/install)."""

    home: Path

    @classmethod
    def from_env(cls, env: Optional[Mapping[str, str]] = None) -> "HostPaths":
        env = os.environ if env is None else env
        return cls(home=Path(env.get("HOME") or Path.home()))

    @property
    def hermes_root(self) -> Path:
        return self.home / ".hermes"

    @property
    def profiles_root(self) -> Path:
        return self.hermes_root / "profiles"

    @property
    def config_dir(self) -> Path:
        return self.home / ".config" / "emperor-hermes"

    @property
    def hostd_env(self) -> Path:
        return self.config_dir / "hostd.env"

    @property
    def host_env(self) -> Path:
        return self.config_dir / "host.env"

    @property
    def data_dir(self) -> Path:
        return self.home / ".local" / "share" / "emperor-hermes"

    @property
    def records_dir(self) -> Path:
        return self.data_dir / "profiles"

    @property
    def jobs_dir(self) -> Path:
        return self.data_dir / "jobs"

    @property
    def stable_python(self) -> Path:
        return self.data_dir / "python"

    @property
    def unit_dir(self) -> Path:
        return self.home / ".config" / "systemd" / "user"

    @property
    def bridge_current(self) -> Path:
        return self.hermes_root / "emperor-bridge" / "current"

    @property
    def installer(self) -> Path:
        """``~/.local/bin/emperor-hermes``, else the copy in the current bridge bundle."""
        local = self.home / ".local" / "bin" / "emperor-hermes"
        return local if local.is_file() else self.bridge_current / "emperor-hermes.sh"

    def profile_home(self, profile: str) -> Path:
        return self.profiles_root / profile


@dataclass(frozen=True)
class HostdConfig:
    emperor_url: str
    host_id: str
    host_token: str

    @property
    def origin(self) -> str:
        return url_origin(self.emperor_url) or ""

    @property
    def socket_url(self) -> str:
        parsed = urlparse(self.emperor_url)
        scheme = "wss" if parsed.scheme == "https" else "ws"
        return f"{scheme}://{parsed.netloc}/api/hosts/ws"


def url_origin(url: str) -> Optional[str]:
    """scheme://host[:port] of an http(s) URL, lowercased; None when it is not one."""
    try:
        parsed = urlparse((url or "").strip())
    except ValueError:
        return None
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return None
    default = 443 if parsed.scheme == "https" else 80
    try:
        port = parsed.port or default  # ValueError for a port that is not 0-65535
    except ValueError:
        return None
    host = parsed.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    return f"{parsed.scheme}://{host}" + ("" if port == default else f":{port}")


_PRIVATE_NETS = tuple(ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "::1/128"))


def private_http_host(host: str) -> bool:
    """True for ``localhost`` or a LITERAL private address (a name like 10.evil.com is not one)."""
    host = (host or "").strip("[]").lower()
    if host == "localhost":
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return any(address in net for net in _PRIVATE_NETS)


def url_allowed(url: str, insecure: bool = False) -> bool:
    """https always; http only to localhost / a literal private address, or when insecure was chosen."""
    parsed = urlparse(url)
    if parsed.scheme == "https":
        return True
    return parsed.scheme == "http" and (insecure or private_http_host(parsed.hostname or ""))


def load_hostd_config(path: Path) -> HostdConfig:
    if not path.is_file():
        raise HostdConfigError(f"{path} is missing: run `emperor-hermes host connect CODE` first")
    values = read_env_file(path)
    url = values.get("EMPEROR_URL", "").strip()
    host_id = values.get("HOST_ID", "").strip()
    token = values.get("HOST_TOKEN", "").strip()
    if not url_origin(url):
        raise HostdConfigError(f"EMPEROR_URL in {path} is not an http(s) URL with a valid port")
    if not url_allowed(url, values.get("INSECURE", "").strip() == "1"):
        raise HostdConfigError(f"EMPEROR_URL in {path} is plain http to a public address: use https, "
                               "or re-run `emperor-hermes host connect --insecure` if you accept the risk")
    if not UUID_RE.match(host_id):
        raise HostdConfigError(f"HOST_ID in {path} is not a uuid")
    if not HOST_TOKEN_RE.match(token):
        raise HostdConfigError(f"HOST_TOKEN in {path} has the wrong shape")
    return HostdConfig(emperor_url=url_origin(url) or url, host_id=host_id.lower(), host_token=token)


def file_mode_too_open(path: Path) -> bool:
    """True when group/others can read the file (it holds the host token)."""
    try:
        mode = path.stat().st_mode
    except OSError:
        return False
    return bool(mode & (stat.S_IRWXG | stat.S_IRWXO)) and os.name == "posix"
