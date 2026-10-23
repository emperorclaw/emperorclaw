"""Bridge release identity. Bump together with plugin.yaml and the Hermes image label."""

BRIDGE_VERSION = "0.9.2"
BRIDGE_PROTOCOL = 1
"""Wire generation of the bridge <-> Emperor contract (run events, run-usage 2, register v2)."""

USER_AGENT = f"emperor-hermes-bridge/{BRIDGE_VERSION}"

BRIDGE_CAPABILITIES = ("hermes-agent", "thread-reply", "emperor-tools", "rich-replies", "run-events",
                       "coalesced-replies", "gateway-ws")
