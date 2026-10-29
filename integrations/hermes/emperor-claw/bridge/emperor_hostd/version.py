"""Daemon identity. The daemon ships in the bridge bundle, so it carries the bridge version."""
from emperor_bridge.version import BRIDGE_VERSION

HOSTD_VERSION = BRIDGE_VERSION
HOST_PROTOCOL = 1
USER_AGENT = f"emperor-hermes-hostd/{HOSTD_VERSION}"
