"""Contract-harness plugin: report what a plugin tool can see inside a gateway turn."""
from __future__ import annotations

import json
import os
import threading
from typing import Any, Dict

WATCHED = ("HERMES_SESSION_ID", "HERMES_SESSION_PLATFORM", "HERMES_SESSION_KEY", "HERMES_SESSION_MESSAGE_ID",
           "HERMES_HOME", "EMPEROR_CLAW_API_TOKEN", "EMPEROR_CLAW_API_URL", "EMPEROR_CLAW_TURN_THREAD_ID",
           "EMPEROR_CLAW_TURN_MESSAGE_ID", "EMPEROR_PROBE_DOTENV", "HERMES_EPHEMERAL_SYSTEM_PROMPT")


def envprobe_dump(args: Dict[str, Any], **kwargs: Any) -> str:
    out: Dict[str, Any] = {"thread": threading.current_thread().name, "pid": os.getpid(),
                           "kwargs_keys": sorted(kwargs)}
    out["os_environ"] = {k: os.environ.get(k) for k in WATCHED}
    try:
        from gateway.session_context import get_session_env
        out["session_env"] = {k: get_session_env(k) for k in WATCHED}
    except Exception as exc:  # pragma: no cover - diagnostic
        out["session_env_error"] = repr(exc)
    try:
        from agent.session_client_env import bound_client_env
        bound = bound_client_env()
        out["bound_client_env"] = dict(bound) if bound else bound
    except Exception as exc:  # pragma: no cover - diagnostic
        out["bound_client_env_error"] = repr(exc)
    try:
        from agent.session_client_env import toolchain_environ
        tc = toolchain_environ()
        out["toolchain_environ"] = {k: tc.get(k) for k in WATCHED if k in tc}
    except Exception as exc:  # pragma: no cover - diagnostic
        out["toolchain_environ_error"] = repr(exc)
    try:
        from gateway.session_cli_turn import _cli_turn
        turn = _cli_turn.get(None)
        out["cli_turn"] = None if turn is None else {"admission_id": turn[0], "keys": sorted(turn[1] or {}),
                                                     "turn_author": (turn[1] or {}).get("turn_author")}
    except Exception as exc:  # pragma: no cover - diagnostic
        out["cli_turn_error"] = repr(exc)
    return json.dumps(out)


def register(ctx: Any) -> None:
    ctx.register_tool(
        "envprobe_dump", "envprobe",
        {"description": "Report the environment visible to a plugin tool.",
         "parameters": {"type": "object", "properties": {}, "required": []}},
        envprobe_dump, description="Dump plugin-visible environment",
    )
