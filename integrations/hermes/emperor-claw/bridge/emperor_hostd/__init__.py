"""emperor-hermes-hostd: the runtime host daemon (Emperor Claw 0.21).

One per machine. Keeps a websocket to Emperor (``/api/hosts/ws``) with the host token from
``~/.config/emperor-hermes/hostd.env``, reports what runs here (resources, provider NAMES, Hermes
profiles and their agents) and runs a few allowlisted jobs (0.21: restart an agent's bridge or
gateway) through ``systemd-run --user``, never a shell.

Entry point: ``python -m emperor_hostd run`` on the Hermes venv interpreter (stdlib + websockets).
"""
from .version import HOSTD_VERSION

__all__ = ["HOSTD_VERSION"]
