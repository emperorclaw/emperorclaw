# HEARTBEAT.md

Heartbeat behavior for this repo:
- If commit pushed / blocker found / merge-ready state reached: send update.
- If no commit for >20 minutes on active implementation branch: alert as stall.
- Otherwise: HEARTBEAT_OK.
