"""Deterministic fake OpenAI-compatible provider for the Hermes gateway contract harness.

Wraps Hermes' own ``tests/fakes/fake_llm_provider.FakeLLMServer`` (pinned v0.22.4 checkout)
with a stateless responder driven by markers in the latest user message, so the probe can
steer every turn without a control channel:

    [[tool:read]]       read_file(/etc/hostname), then a short text answer
    [[tool:envprobe]]   envprobe_dump() (harness plugin), then a short text answer
    [[tool:emperor]]    emperor_health() (Emperor plugin), then a short text answer
    [[tool:danger]]     terminal("rm -rf /tmp/spike-approval-target") -> approval prompt
    [[tool:three]]      read_file, envprobe_dump, read_file in three model calls, then text
    [[tool:thenhang]]   read_file, then hang the follow-up model call (kill the gateway mid-turn)
    [[tool:clarify]]    clarify(one question, two choices), then echo the tool result (R-2)
    [[tool:steer]]      terminal("sleep 4"), then report whether a STEER- text reached the model (R-3)
    [[tool:ack]]        emperor_send_message(acknowledge=true), then a short text answer (turn-file test)
    [[hangonce:KEY]]    hang the first request carrying KEY, answer later ones (auto-retry tests)
    [[hang]]            accept the request and never answer (interrupt during a model call)
    [[drop]]            stream a few characters, then drop the socket (provider fault)
    [[slow:N]]          stream ~N seconds of text (interrupt / queue tests)
    [[reason]]          answer with reasoning_content (show_reasoning test)
    anything else       "pong: <first 40 chars of the user text>"

Every request (main and auxiliary) is appended to $FAKE_LLM_LOG as one JSON line with the
Authorization header and the last user message, so the probe can assert what the model saw.

Run with the Hermes venv python and PYTHONPATH=$HERMES_REPO:
    python fake_llm.py 8765
"""
from __future__ import annotations

import json
import os
import re
import sys
import threading
from http.server import ThreadingHTTPServer

from tests.fakes.fake_llm_provider import DropMidStream, FakeLLMServer, Hang, Text, ToolCall, _handler_for

LOG_PATH = os.environ.get("FAKE_LLM_LOG", "/tmp/fake_llm_requests.jsonl")
_log_lock = threading.Lock()


def _content_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(part.get("text", "") for part in content if isinstance(part, dict))
    return ""


def _log(record: dict, kind: str, decision: str) -> None:
    messages = record["body"].get("messages") or []
    last_user = next((_content_text(m.get("content")) for m in reversed(messages) if m.get("role") == "user"), "")
    system = next((_content_text(m.get("content")) for m in messages if m.get("role") == "system"), "")
    entry = {
        "t": record["t"], "kind": kind, "decision": decision, "auth": record["auth"],
        "last_role": messages[-1].get("role") if messages else None,
        "last_user": last_user[:4000], "n_messages": len(messages),
        "user_history": [_content_text(m.get("content"))[:200] for m in messages if m.get("role") == "user"],
        "user_history_len": [len(_content_text(m.get("content"))) for m in messages if m.get("role") == "user"],
        "prompt_chars": sum(len(_content_text(m.get("content"))) for m in messages),
        "system_tail": system[-600:], "tools": [t.get("function", {}).get("name") for t in record["body"].get("tools") or []],
        "stream": bool(record["body"].get("stream")),
    }
    with _log_lock, open(LOG_PATH, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry) + "\n")


# Aux calls (compression summaries, title generation) sleep this long when the file exists:
# lets the probe submit a prompt while a compress is still running.
SLOW_AUX_FLAG = os.environ.get("FAKE_LLM_SLOW_AUX_FLAG", "/tmp/fake_llm_slow_aux")
THREE_TOOLS = (("read_file", {"path": "/etc/hostname"}), ("envprobe_dump", {}), ("read_file", {"path": "/etc/os-release"}))


# After a SIGKILL Hermes prepends "[System note: ...]" to the next user message;
# echo the operator's text, not the note, so checks can match the reply.
_SYSTEM_NOTE = re.compile(r"^\s*\[System note:.*?\]\s*", re.DOTALL)


def _echo(user: str) -> Text:
    return Text("pong: " + _SYSTEM_NOTE.sub("", user, count=1).strip()[:40])


def _last_user_index(messages: list) -> int:
    return max((i for i, m in enumerate(messages) if m.get("role") == "user"), default=-1)


def _steer_probe(record: dict, messages: list) -> "Text | ToolCall":
    """R-3: once a [[tool:steer]] turn is running, say where (if anywhere) a steered text landed."""
    start = next(i for i, m in enumerate(messages) if m.get("role") == "user"
                 and "[[tool:steer]]" in _content_text(m.get("content")))
    after = messages[start + 1:]
    if not any(m.get("role") == "tool" for m in after) and not any(m.get("tool_calls") for m in after):
        _log(record, "main", "tool:steer")
        return ToolCall("terminal", {"command": "sleep 4"})
    hits = [{"role": m.get("role"), "index": start + i, "text": _content_text(m.get("content"))[:300]}
            for i, m in enumerate(messages[start:]) if "STEER-" in _content_text(m.get("content"))]
    decision = "steer:seen" if hits else "steer:not-seen"
    _log(record, "main", decision + ":" + json.dumps(hits)[:900])
    return Text(decision + (" in " + hits[0]["role"] if hits else ""))


def responder(record: dict):
    messages = record["body"].get("messages") or []
    last = messages[-1] if messages else {}
    ui = _last_user_index(messages)
    user = _content_text(messages[ui].get("content")) if ui >= 0 else ""
    steer_turn = any("[[tool:steer]]" in _content_text(m.get("content")) for m in messages if m.get("role") == "user")
    if steer_turn and ("[[tool:steer]]" in user or "STEER-" in user or last.get("role") == "tool"):
        return _steer_probe(record, messages)
    if last.get("role") == "tool":
        if "[[tool:clarify]]" in user:
            result = _content_text(last.get("content"))
            _log(record, "main", "clarify:result:" + result[:600])
            return Text("clarify said: " + result[:300])
        if "[[tool:three]]" in user:
            done = sum(1 for m in messages[ui + 1:] if m.get("role") == "tool")
            if done < len(THREE_TOOLS):
                _log(record, "main", f"tool:three:{done + 1}")
                name, args = THREE_TOOLS[done]
                return ToolCall(name, args, text=f"step {done + 1}")
        if "[[tool:thenhang]]" in user:
            _log(record, "main", "thenhang:hang")
            return Hang(120)
        _log(record, "main", "after-tool")
        return Text("tool finished")
    if "[[tool:three]]" in user:
        _log(record, "main", "tool:three:1")
        name, args = THREE_TOOLS[0]
        return ToolCall(name, args, text="step 1")
    if "[[tool:thenhang]]" in user:
        _log(record, "main", "thenhang:tool")
        return ToolCall("read_file", {"path": "/etc/hostname"})
    if "[[hang]]" in user:
        _log(record, "main", "hang")
        return Hang(120)
    if "[[drop]]" in user:
        _log(record, "main", "drop")
        return DropMidStream("partial answer that never finishes", 12)
    if "[[tool:read]]" in user:
        _log(record, "main", "tool:read")
        return ToolCall("read_file", {"path": "/etc/hostname"})
    if "[[tool:envprobe]]" in user:
        _log(record, "main", "tool:envprobe")
        return ToolCall("envprobe_dump", {})
    if "[[tool:emperor]]" in user:
        _log(record, "main", "tool:emperor")
        return ToolCall("emperor_health", {})
    once = re.search(r"\[\[hangonce:([A-Za-z0-9_-]+)\]\]", user)
    if once:
        flag = os.path.join(os.path.dirname(SLOW_AUX_FLAG) or "/tmp", f"fake_llm_once_{once.group(1)}")
        if not os.path.exists(flag):
            open(flag, "w").close()
            _log(record, "main", f"hangonce:{once.group(1)}:hang")
            return Hang(120)
        _log(record, "main", f"hangonce:{once.group(1)}:answer")
        return _echo(user)
    if "[[tool:ack]]" in user:
        _log(record, "main", "tool:ack")
        return ToolCall("emperor_send_message", {"text": "On it.", "acknowledge": True})
    if "[[tool:clarify]]" in user:
        _log(record, "main", "tool:clarify")
        return ToolCall("clarify", {"questions": [{"question": "Which colour should the report use?",
                                                   "choices": ["blue", "red"]}]})
    if "[[tool:danger]]" in user:
        _log(record, "main", "tool:danger")
        return ToolCall("terminal", {"command": "rm -rf /tmp/spike-approval-target"})
    slow = re.search(r"\[\[slow:(\d+(?:\.\d+)?)\]\]", user)
    if slow:
        seconds = float(slow.group(1))
        chunks = max(1, int(seconds / 0.1))
        _log(record, "main", f"slow:{seconds}")
        return Text("s" * chunks, chunk_chars=1, delay_per_chunk=0.1)
    if "[[reason]]" in user:
        _log(record, "main", "reason")
        return Text("reasoned answer", reasoning="fake chain of thought about the question")
    _log(record, "main", "pong")
    return _echo(user)


def aux(record: dict):
    _log(record, "aux", "aux")
    try:
        delay = float(open(SLOW_AUX_FLAG).read().strip() or "0")
    except (OSError, ValueError):
        delay = 0.0
    if delay > 0:
        import time
        time.sleep(delay)
    body = json.dumps(record["body"].get("messages") or [])
    if '"verdict"' in body or '\\"verdict\\"' in body:
        return Text('{"verdict": "continue", "reason": "fake judge: keep going"}')
    return Text("Fake summary of the earlier conversation.")


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    srv = FakeLLMServer(responder, aux=aux)
    srv._server = ThreadingHTTPServer(("127.0.0.1", port), _handler_for(srv))
    srv._server.daemon_threads = True
    print(f"fake provider on {srv.base_url}", flush=True)
    srv._server.serve_forever()


if __name__ == "__main__":
    main()
