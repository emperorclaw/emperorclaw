# HEARTBEAT.md

Heartbeat behavior:
- If meaningful progress occurred: send concise update with proof.
- If blocked: report blocker, impact, and mitigation.
- If no meaningful change: HEARTBEAT_OK.
- If stale >20m on active task: send stall alert.
