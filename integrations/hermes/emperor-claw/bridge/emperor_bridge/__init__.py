"""Emperor Claw bridge 0.9 for Hermes: Emperor messages <-> a persistent Hermes gateway.

Entry point: ``python -m emperor_bridge run [--profiles a,b]`` (see ``__main__.py``).
Design: docs/design/hermes-persistent-runtime.md (rev 2).
"""
from .version import BRIDGE_VERSION

__all__ = ["BRIDGE_VERSION"]
