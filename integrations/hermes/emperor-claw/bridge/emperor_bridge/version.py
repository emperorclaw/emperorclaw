"""Bridge release identity. Bump together with plugin.yaml and the Hermes image label."""

BRIDGE_VERSION = "0.33.0"
BRIDGE_PROTOCOL = 1
"""Wire generation of the bridge <-> Emperor contract (run events, run-usage 2, register v2)."""

USER_AGENT = f"emperor-hermes-bridge/{BRIDGE_VERSION}"

BRIDGE_CAPABILITIES = ("hermes-agent", "thread-reply", "emperor-tools", "rich-replies", "run-events",
                       "coalesced-replies", "gateway-ws", "thread-kill-v1")
"""Static capabilities. `thread-kill-v1`: a kill with `runtimeControl.scope == "thread"` stops only
that thread (controls.py); without it Emperor sends agent-wide kills. Registration also reports
`max-parallel-turns: <n>` (health.registration_body), the real limit the chat UI shows."""
MAX_PARALLEL_TURNS_CAPABILITY = "max-parallel-turns"
