"""Emperor's contract probe for the Hermes v0.22.4 persistent gateway (``hermes-gateway-v1``).

Runs inside the contract image (see README.md). It owns the gateway process so it can restart it,
talks to it exactly as the Emperor bridge would (control socket -> ticket -> WebSocket JSON-RPC),
and writes ``$PROBE_RESULTS_DIR/probe-report.json`` with evidence for every scenario plus latency
figures. Exit code 0 = every required check passed.

Dependencies: stdlib + ``websockets==15.0.1``. Never uses a real model key: the profile routes to
the loopback fake provider (fake_llm.py).
"""
from __future__ import annotations

import asyncio
import json
import os
import signal
import socket
import sqlite3
import statistics
import subprocess
import sys
import time
import traceback
import uuid
from pathlib import Path
from typing import Any, Callable

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

PROFILE = os.environ.get("HERMES_PROBE_PROFILE", "spike")
HOME = Path(os.environ.get("HERMES_PROBE_HOME", f"/home/hermes/.hermes/profiles/{PROFILE}"))
RESULTS = Path(os.environ.get("PROBE_RESULTS_DIR", "/results"))
FAKE_LOG = Path(os.environ.get("FAKE_LLM_LOG", RESULTS / "fake_llm_requests.jsonl"))
ECHO_LOG = Path(os.environ.get("EMPEROR_ECHO_LOG", RESULTS / "emperor_echo_requests.jsonl"))
ECHO_URL = os.environ.get("EMPEROR_ECHO_URL", "http://127.0.0.1:8799")
HERMES = os.environ.get("HERMES_BIN", "hermes")
WS_PROTOCOL = "hermes-gateway-v1"
TICKET_PREFIX = "hermes-gateway-ticket."
LATENCY_RUNS = int(os.environ.get("PROBE_LATENCY_RUNS", "10"))
APPROVAL_TIMEOUT = float(os.environ.get("PROBE_APPROVAL_TIMEOUT", "20"))
FIXTURES = Path(os.environ.get("PROBE_FIXTURES_DIR", RESULTS / "fixtures"))
SLOW_AUX_FLAG = Path(os.environ.get("FAKE_LLM_SLOW_AUX_FLAG", "/tmp/fake_llm_slow_aux"))

REPORT: dict[str, Any] = {"meta": {}, "latency_ms": {}, "scenarios": {}}


def now() -> float:
    return time.monotonic()


def ms(seconds: float) -> float:
    return round(seconds * 1000, 1)


def summarize(samples: list[float]) -> dict[str, Any]:
    if not samples:
        return {}
    s = sorted(samples)
    return {"n": len(s), "min": ms(s[0]), "p50": ms(statistics.median(s)),
            "p90": ms(s[min(len(s) - 1, int(round(0.9 * (len(s) - 1))))]), "max": ms(s[-1])}


def log(*args: Any) -> None:
    print("[probe]", *args, flush=True)


# ── control socket ────────────────────────────────────────────────────────────────────────────


def control(verb: str, params: dict | None = None, timeout: float = 5.0) -> dict:
    path = HOME / "gateway.sock"
    redirect = HOME / "gateway.sock.path"
    if redirect.exists():
        path = Path(redirect.read_text().strip())
    req: dict[str, Any] = {"protocol": 1, "verb": verb, "id": 1}
    if params is not None:
        req["params"] = params
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        sock.connect(str(path))
        sock.sendall(json.dumps(req).encode() + b"\n")
        data = bytearray()
        while not data.endswith(b"\n"):
            chunk = sock.recv(65536)
            if not chunk:
                break
            data.extend(chunk)
    return json.loads(bytes(data))


def identify() -> dict:
    return control("identify")


def ready(ident: dict) -> bool:
    r = ident.get("result") or {}
    return (ident.get("ok") and r.get("state") == "ready" and r.get("runtime_protocol") == 1
            and "session-authority-v1" in (r.get("capabilities") or []) and (r.get("authority_epoch") or 0) > 0
            and str(r.get("api_origin", "")).startswith("http://127.0.0.1:"))


def ticket(ident: dict, **extra: Any) -> dict:
    r = ident["result"]
    profile_id = next(p["profile_id"] for p in r["served_profiles"] if p["home"] == str(HOME))
    params = {"profile_id": profile_id, "instance_id": r["instance_id"], "purpose": "interactive", **extra}
    return control("session-ticket", params)


# ── gateway process ───────────────────────────────────────────────────────────────────────────


class Gateway:
    def __init__(self) -> None:
        self.proc: subprocess.Popen | None = None
        self.runs = 0
        self.env = dict(os.environ)
        # Process env the plugin may read (compared later against .env and client_env).
        self.env.update(EMPEROR_CLAW_API_TOKEN="proc-token", EMPEROR_CLAW_API_URL=ECHO_URL,
                        EMPEROR_PROBE_DOTENV="from-process-env")
        for k in ("PYTHONPATH", "VIRTUAL_ENV"):
            self.env.pop(k, None)

    def start(self, extra_env: dict[str, str] | None = None) -> dict:
        self.runs += 1
        logf = open(RESULTS / f"gateway-run{self.runs}.log", "w")
        t0 = now()
        self.proc = subprocess.Popen([HERMES, "-p", PROFILE, "gateway", "run", "--external-supervisor"],
                                     stdout=logf, stderr=subprocess.STDOUT, env={**self.env, **(extra_env or {})},
                                     start_new_session=True)
        deadline = t0 + 120
        last: Any = None
        while now() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"gateway exited early rc={self.proc.returncode}; see gateway-run{self.runs}.log")
            try:
                last = identify()
                if ready(last):
                    return {"identify": last, "spawn_to_ready_s": round(now() - t0, 3)}
            except (OSError, ValueError) as exc:
                last = repr(exc)
            time.sleep(0.05)
        raise RuntimeError(f"gateway not ready in 120 s: {last}")

    def stop(self, sig: int = signal.SIGTERM, timeout: float = 90) -> dict:
        assert self.proc is not None
        t0 = now()
        self.proc.send_signal(sig)
        try:
            rc = self.proc.wait(timeout)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            rc = self.proc.wait(10)
        return {"signal": int(sig), "rc": rc, "stop_s": round(now() - t0, 3)}


# ── WebSocket JSON-RPC client ─────────────────────────────────────────────────────────────────


class RpcError(Exception):
    def __init__(self, error: dict) -> None:
        super().__init__(error.get("message"))
        self.error = error


class Recorder:
    """Raw wire frames (both directions) for one fixture file: one JSON object per line."""

    def __init__(self, name: str, note: str) -> None:
        self.name = name
        self.t0 = now()
        self.lines: list[dict] = [{"dir": "meta", "t_ms": 0.0, "fixture": name, "note": note,
                                   "hermes": "v0.22.4", "protocol": WS_PROTOCOL}]

    def add(self, direction: str, frame: Any) -> None:
        self.lines.append({"dir": direction, "t_ms": ms(now() - self.t0), "frame": frame})

    def meta(self, **kw: Any) -> None:
        self.lines.append({"dir": "meta", "t_ms": ms(now() - self.t0), **kw})

    def write(self) -> str:
        FIXTURES.mkdir(parents=True, exist_ok=True)
        path = FIXTURES / f"{self.name}.jsonl"
        path.write_text("".join(json.dumps(line, ensure_ascii=False) + "\n" for line in self.lines))
        return str(path)


class Conn:
    def __init__(self, ws: Any, timings: dict, recorder: Recorder | None = None) -> None:
        self.ws = ws
        self.timings = timings
        self.recorder = recorder
        self.pending: dict[int, asyncio.Future] = {}
        self.seq = 0
        self.events: list[tuple[float, dict]] = []
        self.server_requests: list[dict] = []
        self.new = asyncio.Event()
        self.closed: Any = None
        self.reader = asyncio.create_task(self._read())

    async def _read(self) -> None:
        try:
            async for raw in self.ws:
                frame = json.loads(raw)
                t = now()
                if self.recorder is not None:
                    self.recorder.add("in", frame)
                fid = frame.get("id")
                if "method" not in frame and fid in self.pending:
                    fut = self.pending.pop(fid)
                    if not fut.done():
                        fut.set_result(frame)
                elif frame.get("method") == "event":
                    self.events.append((t, frame["params"]))
                    self.new.set()
                elif "method" in frame:
                    self.server_requests.append(frame)
        except ConnectionClosed as exc:
            self.closed = {"code": exc.rcvd.code if exc.rcvd else None,
                           "reason": exc.rcvd.reason if exc.rcvd else None}
        finally:
            for fut in self.pending.values():
                if not fut.done():
                    fut.set_exception(ConnectionError("closed"))
            self.new.set()

    async def call(self, method: str, _timeout: float = 30, **params: Any) -> tuple[dict, float]:
        """Raw frame + round-trip seconds."""
        self.seq += 1
        rid = self.seq
        fut = asyncio.get_running_loop().create_future()
        self.pending[rid] = fut
        t0 = now()
        out = {"jsonrpc": "2.0", "id": rid, "method": method, "params": params}
        if self.recorder is not None:
            self.recorder.add("out", out)
        await self.ws.send(json.dumps(out))
        frame = await asyncio.wait_for(fut, _timeout)
        return frame, now() - t0

    async def rpc(self, method: str, _timeout: float = 30, **params: Any) -> Any:
        frame, _ = await self.call(method, _timeout, **params)
        if "error" in frame:
            raise RpcError(frame["error"])
        return frame.get("result")

    async def wait_event(self, pred: Callable[[dict], bool], timeout: float = 30, start: int = 0) -> tuple[float, dict]:
        deadline = now() + timeout
        idx = start
        while True:
            while idx < len(self.events):
                t, ev = self.events[idx]
                idx += 1
                if pred(ev):
                    return t, ev
            if self.closed is not None and idx >= len(self.events):
                raise ConnectionError(f"socket closed while waiting: {self.closed}")
            remaining = deadline - now()
            if remaining <= 0:
                raise TimeoutError("event wait timed out")
            self.new.clear()
            try:
                await asyncio.wait_for(self.new.wait(), remaining)
            except asyncio.TimeoutError:
                pass

    def session_events(self, sid: str, admission: str | None = None) -> list[dict]:
        return [ev for _, ev in self.events if ev.get("session_id") == sid
                and (admission is None or ev.get("admission_id") == admission
                     or (ev.get("payload") or {}).get("admission_id") == admission)]

    async def close(self) -> None:
        await self.ws.close()
        try:
            await asyncio.wait_for(self.reader, 5)
        except Exception:
            pass


async def open_conn(origin: str | None = None, reuse_ticket: str | None = None,
                    recorder: Recorder | None = None) -> Conn:
    timings: dict[str, float] = {}
    t0 = now()
    ident = identify()
    timings["identify_s"] = now() - t0
    t1 = now()
    if reuse_ticket is None:
        grant = ticket(ident)
        if not grant.get("ok"):
            raise RuntimeError(f"ticket refused: {grant}")
        tk = grant["result"]["ticket"]
    else:
        tk = reuse_ticket
    timings["ticket_s"] = now() - t1
    url = ident["result"]["api_origin"].replace("http:", "ws:") + "/api/ws"
    t2 = now()
    kwargs: dict[str, Any] = {"subprotocols": [WS_PROTOCOL, TICKET_PREFIX + tk], "open_timeout": 10,
                              "max_size": 8 * 1024 * 1024, "proxy": None}
    if origin:
        kwargs["origin"] = origin
    ws = await connect(url, **kwargs)
    timings["ws_open_s"] = now() - t2
    if ws.subprotocol != WS_PROTOCOL:
        raise RuntimeError(f"subprotocol mismatch: {ws.subprotocol}")
    if recorder is not None:
        recorder.meta(event="connected", api_origin=ident["result"]["api_origin"],
                      instance_id=ident["result"]["instance_id"], authority_epoch=ident["result"]["authority_epoch"])
    conn = Conn(ws, timings, recorder)
    conn.ticket = tk  # type: ignore[attr-defined]
    t_ready, ev = await conn.wait_event(lambda e: e.get("type") == "gateway.ready", 10)
    timings["ws_open_to_ready_s"] = t_ready - t2
    timings["total_connect_s"] = t_ready - t0
    conn.ready_payload = ev.get("payload")  # type: ignore[attr-defined]
    return conn


# ── helpers ───────────────────────────────────────────────────────────────────────────────────


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def is_complete_for(admission: str) -> Callable[[dict], bool]:
    return lambda ev: ev.get("type") == "message.complete" and (
        (ev.get("payload") or {}).get("admission_id") == admission or ev.get("admission_id") == admission)


async def submit_and_wait(conn: Conn, sid: str, text: str, timeout: float = 60, **extra: Any) -> dict:
    """Submit one prompt; return receipt, complete event and timings (all relative to send)."""
    start_idx = len(conn.events)
    sub_id = extra.pop("submission_id", None) or f"emp-msg-{uuid.uuid4().hex[:12]}"
    t_send = now()
    frame, rtt = await conn.call("prompt.submit", session_id=sid, submission_id=sub_id, text=text, **extra)
    if "error" in frame:
        raise RpcError(frame["error"])
    receipt = frame["result"]
    adm = receipt["admission_id"]
    t_done, done = await conn.wait_event(is_complete_for(adm), timeout, start_idx)
    mine = [(t, ev) for t, ev in conn.events[start_idx:] if ev.get("session_id") == sid]
    first = mine[0][0] if mine else None
    first_delta = next((t for t, ev in mine if ev.get("type") == "message.delta"
                        and (ev.get("payload") or {}).get("text")), None)
    msg_start = next((t for t, ev in mine if ev.get("type") == "message.start"), None)
    return {
        "submission_id": sub_id, "receipt": receipt, "admission_id": adm, "complete": done,
        "submit_rtt_s": rtt, "first_event_s": (first - t_send) if first else None,
        "message_start_s": (msg_start - t_send) if msg_start else None,
        "first_delta_s": (first_delta - t_send) if first_delta else None,
        "turn_end_s": t_done - t_send,
        "event_types": [ev.get("type") for t, ev in mine if t <= t_done],
    }


# PROBE_ONLY=27,28,29 runs only those scenarios (by number prefix or full name). Most scenarios
# before 27 share state (STATE), so subsets are for iterating on self-contained ones.
ONLY = {p.strip() for p in os.environ.get("PROBE_ONLY", "").split(",") if p.strip()}


def scenario(name: str, required: bool = True):
    def deco(fn):
        async def run(*a, **k):
            if ONLY and name.split("_", 1)[0] not in ONLY and name not in ONLY:
                return
            log("──", name)
            entry: dict[str, Any] = {"ok": False, "required": required, "evidence": {}, "notes": []}
            REPORT["scenarios"][name] = entry
            t0 = now()
            try:
                await fn(entry, *a, **k)
                entry["ok"] = entry.get("ok_override", True) if "ok_override" in entry else True
            except Exception as exc:
                entry["error"] = f"{type(exc).__name__}: {exc}"
                entry["traceback"] = traceback.format_exc()[-3000:]
                log("   FAILED:", entry["error"])
            entry.pop("ok_override", None)
            entry["duration_s"] = round(now() - t0, 3)
            log("  ", "ok" if entry["ok"] else "FAIL", f"({entry['duration_s']} s)")
        return run
    return deco


def check(entry: dict, cond: bool, label: str) -> None:
    entry.setdefault("checks", {})[label] = bool(cond)
    if not cond:
        raise AssertionError(label)


def soft(entry: dict, cond: bool, label: str) -> None:
    entry.setdefault("checks", {})[label] = bool(cond)


def slim_event(ev: dict, max_text: int = 400) -> dict:
    out = json.loads(json.dumps(ev))
    payload = out.get("payload")
    if isinstance(payload, dict):
        for k, v in list(payload.items()):
            if isinstance(v, str) and len(v) > max_text:
                payload[k] = v[:max_text] + f"…(+{len(v) - max_text})"
            if k == "messages" and isinstance(v, list):
                payload[k] = f"<{len(v)} messages>"
    return out


# ── scenarios ─────────────────────────────────────────────────────────────────────────────────

STATE: dict[str, Any] = {}


@scenario("01_identify_and_ticket")
async def s_identify(entry: dict, gw: Gateway) -> None:
    ident = identify()
    entry["evidence"]["identify"] = ident
    check(entry, ready(ident), "identify reports ready with session-authority-v1")
    r = ident["result"]
    sp = r["served_profiles"]
    entry["evidence"]["served_profiles"] = sp
    check(entry, sp and sp[0]["profile_id"] == str(HOME), "profile_id == absolute profile home")
    grant = ticket(ident)
    entry["evidence"]["ticket_grant"] = {**grant, "result": {**grant["result"], "ticket": "<redacted>"}}
    check(entry, grant.get("ok") and grant["result"]["expires_in_seconds"] == 30, "ticket minted, 30 s TTL")
    host = ticket(ident, scope="host")
    entry["evidence"]["ticket_scope_host"] = {"ok": host.get("ok"), "error": host.get("error")}
    bad = ticket(ident, scope="galaxy")
    entry["evidence"]["ticket_scope_invalid"] = {"ok": bad.get("ok"), "error": bad.get("error"), "code": bad.get("code")}
    stale = control("session-ticket", {"profile_id": str(HOME), "instance_id": "not-the-instance", "purpose": "interactive"})
    entry["evidence"]["ticket_stale_instance"] = {k: stale.get(k) for k in ("ok", "error", "code")}
    check(entry, not stale.get("ok"), "stale instance_id refused")
    STATE["identify"] = ident


@scenario("02_ws_auth_negative_controls")
async def s_ws_negative(entry: dict) -> None:
    ident = identify()
    url = ident["result"]["api_origin"].replace("http:", "ws:") + "/api/ws"
    results: dict[str, Any] = {}

    async def attempt(label: str, protocols: list[str] | None, origin: str | None = None) -> None:
        try:
            kw: dict[str, Any] = {"open_timeout": 10, "proxy": None}
            if protocols:
                kw["subprotocols"] = protocols
            if origin:
                kw["origin"] = origin
            ws = await connect(url, **kw)
            try:
                raw = await asyncio.wait_for(ws.recv(), 5)
                results[label] = {"accepted": True, "first_frame": json.loads(raw).get("params", {}).get("type")}
            except ConnectionClosed as exc:
                results[label] = {"accepted": "then-closed", "close_code": exc.rcvd.code if exc.rcvd else None,
                                  "reason": exc.rcvd.reason if exc.rcvd else None}
            finally:
                await ws.close()
        except InvalidStatus as exc:
            results[label] = {"accepted": False, "http_status": exc.response.status_code}
        except ConnectionClosed as exc:
            results[label] = {"accepted": False, "close_code": exc.rcvd.code if exc.rcvd else None}
        except Exception as exc:
            results[label] = {"accepted": False, "error": f"{type(exc).__name__}: {exc}"}

    await attempt("no_ticket", [WS_PROTOCOL])
    await attempt("forged_ticket", [WS_PROTOCOL, TICKET_PREFIX + "forged"])
    grant = ticket(ident)["result"]["ticket"]
    await attempt("origin_header", [WS_PROTOCOL, TICKET_PREFIX + grant], origin="http://evil.example")
    # Single-use: a fresh ticket works once, then is refused.
    grant2 = ticket(ident)["result"]["ticket"]
    await attempt("fresh_ticket_first_use", [WS_PROTOCOL, TICKET_PREFIX + grant2])
    await attempt("fresh_ticket_reuse", [WS_PROTOCOL, TICKET_PREFIX + grant2])
    grant3 = ticket(ident)["result"]["ticket"]
    await asyncio.sleep(31)
    await attempt("ticket_after_31s", [WS_PROTOCOL, TICKET_PREFIX + grant3])
    entry["evidence"] = results
    check(entry, results["fresh_ticket_first_use"].get("accepted") is True, "fresh ticket accepted")
    for label in ("no_ticket", "forged_ticket", "origin_header", "fresh_ticket_reuse", "ticket_after_31s"):
        check(entry, results[label].get("accepted") is not True, f"{label} refused")


@scenario("03_connect_describe_ping_latency")
async def s_connect(entry: dict) -> None:
    samples: dict[str, list[float]] = {}
    for _ in range(LATENCY_RUNS):
        conn = await open_conn()
        for k, v in conn.timings.items():
            samples.setdefault(k, []).append(v)
        _, rtt = await conn.call("gateway.ping")
        samples.setdefault("gateway.ping_rtt_s", []).append(rtt)
        _, rtt = await conn.call("ping")
        samples.setdefault("ping_rtt_s", []).append(rtt)
        await conn.close()
    conn = await open_conn()
    entry["evidence"]["gateway.ready"] = {k: v for k, v in conn.ready_payload.items() if k != "skin"}
    desc = await conn.rpc("runtime.describe")
    entry["evidence"]["runtime.describe"] = {k: v for k, v in desc.items() if k != "skin"}
    entry["evidence"]["gateway.ping"] = await conn.rpc("gateway.ping")
    entry["evidence"]["ping"] = await conn.rpc("ping")
    await conn.close()
    check(entry, "tool" in desc["session_create"]["sources"], "source 'tool' advertised")
    check(entry, "emperor" not in desc["session_create"]["sources"], "source 'emperor' not advertised")
    REPORT["latency_ms"]["connect"] = {k: summarize(v) for k, v in samples.items()}


@scenario("04_session_create_idempotency")
async def s_create(entry: dict) -> None:
    conn = await open_conn()
    STATE["thread_a"] = rid = f"emperor-thread-{uuid.uuid4().hex[:8]}"
    client_env = {
        "HERMES_EPHEMERAL_SYSTEM_PROMPT": "You are Probe, an Emperor Claw agent. EPHEMERAL-MARKER-7f3.",
        "EMPEROR_CLAW_TURN_THREAD_ID": "thread-A",
        "EMPEROR_CLAW_API_TOKEN": "client-env-token",
        "EMPEROR_PROBE_UNLISTED": "not-in-passthrough",
        "EMPEROR_THREAD_ID": "thread-A", "EMPEROR_THREAD_TYPE": "direct", "EMPEROR_SESSION_GEN": "3",
        "HERMES_PROBE_PREFIXED": "hermes-prefixed-value",
        "OPENAI_API_KEY": "sk-should-be-filtered",
    }
    params = dict(request_id=rid, source="tool", cwd=str(HOME / "workspace"), client_env=client_env)
    STATE["create_params_a"] = params
    frame, rtt = await conn.call("session.create", **params)
    check(entry, "result" in frame, f"session.create ok: {frame.get('error')}")
    snap = frame["result"]
    sid = snap["session_id"]
    STATE["sid_a"] = sid
    entry["evidence"]["create_result"] = {k: v for k, v in snap.items() if k not in ("messages",)}
    samples = [rtt]
    frame2, rtt2 = await conn.call("session.create", **params)
    samples.append(rtt2)
    check(entry, frame2.get("result", {}).get("session_id") == sid, "same request_id -> same session_id")
    conflict, _ = await conn.call("session.create", **{**params, "cwd": "/tmp"})
    entry["evidence"]["conflicting_repeat"] = conflict.get("error") or {"unexpected_result": conflict.get("result", {}).get("session_id")}
    bad_source, _ = await conn.call("session.create", request_id=rid + "-x", source="emperor")
    entry["evidence"]["source_emperor"] = bad_source.get("error")
    check(entry, "error" in bad_source, "source 'emperor' refused")
    unknown_key, _ = await conn.call("session.create", request_id=rid + "-y", source="tool", bogus=1)
    entry["evidence"]["unknown_param"] = unknown_key.get("error")
    for i in range(LATENCY_RUNS):
        _, r = await conn.call("session.create", request_id=f"{rid}-lat-{i}", source="tool")
        samples.append(r)
    REPORT["latency_ms"]["session.create_rtt"] = summarize(samples)
    info = await conn.rpc("session.info", session_id=sid)
    entry["evidence"]["session.info"] = {k: (v if k != "system_prompt" else (v or "")[-300:]) for k, v in info.items()}
    soft(entry, "EPHEMERAL-MARKER-7f3" in json.dumps(info), "ephemeral system prompt visible in session.info")
    lst = await conn.rpc("session.list", scope="live", limit=50)
    entry["evidence"]["tool_session_in_live_list"] = any(r["session_id"] == sid for r in lst["sessions"])
    lst2 = await conn.rpc("session.list", scope="stored", limit=50, include_hidden=True)
    entry["evidence"]["tool_session_in_stored_list"] = any(r["session_id"] == sid for r in lst2["sessions"])
    await conn.close()


@scenario("05_trivial_turn_latency_and_receipt")
async def s_turns(entry: dict) -> None:
    conn = await open_conn()
    sid = STATE["sid_a"]
    await conn.rpc("session.resume", session_id=sid)
    runs = []
    for i in range(LATENCY_RUNS):
        runs.append(await submit_and_wait(conn, sid, f"hello {i}"))
    first = runs[0]
    entry["evidence"]["first_turn_event_types"] = first["event_types"]
    entry["evidence"]["submit_receipt"] = first["receipt"]
    entry["evidence"]["message.complete"] = slim_event(first["complete"])
    c = first["complete"]["payload"]
    check(entry, c.get("outcome") == "completed" and c.get("status") == "complete", "turn completed")
    check(entry, (c.get("text") or "").startswith("pong: hello 0"), "final text from fake model")
    rec = await conn.rpc("prompt.receipt", session_id=sid, admission_id=first["admission_id"], include_result=True)
    entry["evidence"]["prompt.receipt_include_result"] = rec
    check(entry, rec.get("status") == "terminal", "receipt terminal")
    soft(entry, bool(rec.get("usage")), "receipt carries usage")
    usage_events = [slim_event(ev) for ev in conn.session_events(sid) if ev.get("type") == "session.usage"]
    entry["evidence"]["session.usage_last"] = usage_events[-1] if usage_events else None
    entry["evidence"]["usage_has_cost_fields"] = bool(usage_events) and any(
        k in json.dumps(usage_events[-1]) for k in ("cost_usd", "cost_status"))
    # Idempotent resubmit.
    frame, _ = await conn.call("prompt.submit", session_id=sid, submission_id=first["submission_id"], text="hello 0")
    entry["evidence"]["resubmit_same_submission_id"] = frame.get("result") or frame.get("error")
    check(entry, frame.get("result", {}).get("admission_id") == first["admission_id"], "exact resubmit returns same admission")
    frame, _ = await conn.call("prompt.submit", session_id=sid, submission_id=first["submission_id"], text="different")
    entry["evidence"]["resubmit_conflicting_text"] = frame.get("error") or frame.get("result")
    check(entry, "error" in frame, "conflicting resubmit refused")
    stats = await conn.rpc("session.stats", session_id=sid)
    entry["evidence"]["session.stats"] = stats
    REPORT["latency_ms"]["trivial_turn"] = {
        "submit_rtt": summarize([r["submit_rtt_s"] for r in runs]),
        "first_event": summarize([r["first_event_s"] for r in runs if r["first_event_s"] is not None]),
        "message_start": summarize([r["message_start_s"] for r in runs if r["message_start_s"] is not None]),
        "first_delta": summarize([r["first_delta_s"] for r in runs if r["first_delta_s"] is not None]),
        "turn_end": summarize([r["turn_end_s"] for r in runs]),
    }
    await conn.close()


@scenario("06_show_reasoning")
async def s_reasoning(entry: dict) -> None:
    conn = await open_conn()
    sid = STATE["sid_a"]
    await conn.rpc("session.resume", session_id=sid)
    before = await conn.rpc("config.get", session_id=sid, key="show_reasoning")
    entry["evidence"]["config.get_before"] = before
    r_off = await submit_and_wait(conn, sid, "[[reason]] off")
    entry["evidence"]["events_with_flag_default"] = sorted(set(r_off["event_types"]))
    setr = await conn.rpc("config.set", session_id=sid, key="show_reasoning", value="on")
    entry["evidence"]["config.set"] = setr
    r_on = await submit_and_wait(conn, sid, "[[reason]] on")
    entry["evidence"]["events_with_flag_on"] = sorted(set(r_on["event_types"]))
    check(entry, "reasoning.delta" in r_on["event_types"] or "reasoning.available" in r_on["event_types"],
          "reasoning events after show_reasoning=on")
    entry["evidence"]["message.complete_reasoning_field"] = (r_on["complete"]["payload"] or {}).get("reasoning")
    await conn.close()
    # Does the flag survive a detach/re-attach on the same gateway?
    conn = await open_conn()
    await conn.rpc("session.resume", session_id=sid)
    entry["evidence"]["config.get_after_reattach"] = await conn.rpc("config.get", session_id=sid, key="show_reasoning")
    await conn.close()


@scenario("07_api_text_vs_text_and_turn_author")
async def s_api_text(entry: dict) -> None:
    conn = await open_conn()
    sid = STATE["sid_a"]
    await conn.rpc("session.resume", session_id=sid)
    human = "Human visible question 42"
    api = "[EMPEROR TURN CONTEXT thread=A message=m-42]\n" + human
    n0 = len(read_jsonl(FAKE_LOG))
    r = await submit_and_wait(conn, sid, human, api_text=api,
                              turn_author={"id": "user-9", "name": "Jose", "is_bot": False, "origin": "emperor:m-42"})
    seen = [e for e in read_jsonl(FAKE_LOG)[n0:] if e["kind"] == "main"]
    entry["evidence"]["model_saw_last_user"] = seen[-1]["last_user"] if seen else None
    entry["evidence"]["system_prompt_tail"] = seen[-1]["system_tail"] if seen else None
    check(entry, bool(seen) and seen[-1]["last_user"].startswith(api), "model received api_text")
    soft(entry, bool(seen) and "plugin hook output" in seen[-1]["last_user"], "pre_llm_call hook context appended to the user message")
    # S-12: is the api_text replayed in later turns' history, or the persisted text?
    n1 = len(read_jsonl(FAKE_LOG))
    await submit_and_wait(conn, sid, "follow-up turn")
    later = [e for e in read_jsonl(FAKE_LOG)[n1:] if e["kind"] == "main"]
    entry["evidence"]["next_turn_n_messages"] = later[-1]["n_messages"] if later else None
    hist = later[-1]["user_history"] if later else []
    entry["evidence"]["next_turn_user_history_tail"] = hist[-3:]
    entry["evidence"]["next_turn_user_history_lengths"] = later[-1].get("user_history_len") if later else None
    replayed = any("EMPEROR TURN CONTEXT" in h for h in hist[:-1])
    entry["evidence"]["api_text_replayed_in_later_history"] = replayed
    soft(entry, bool(seen) and "EPHEMERAL-MARKER-7f3" in seen[-1]["system_tail"], "ephemeral system prompt reached model")
    snap = await conn.rpc("session.resume", session_id=sid)
    users = [m for m in snap["messages"] if m.get("role") == "user" and m.get("content") == human]
    row = users[-1] if users else None
    if row and isinstance(row.get("api_content"), str):
        row = {**row, "api_content": row["api_content"][:300] + f"...(len {len(row['api_content'])})"}
    entry["evidence"]["persisted_user_row"] = row
    check(entry, bool(users), "transcript content == text (human message)")
    soft(entry, bool(users) and "EMPEROR TURN CONTEXT" in str(users[-1].get("api_content")), "api_text persisted as api_content")
    entry["evidence"]["complete_persisted_turn"] = (r["complete"]["payload"] or {}).get("persisted_turn")
    await conn.close()


@scenario("08_tool_events_and_plugin_env")
async def s_tools(entry: dict) -> None:
    conn = await open_conn()
    sid = STATE["sid_a"]
    await conn.rpc("session.resume", session_id=sid)
    r = await submit_and_wait(conn, sid, "[[tool:read]] read the hostname")
    evs = conn.session_events(sid, r["admission_id"])
    tstart = next((slim_event(e) for e in evs if e.get("type") == "tool.start"), None)
    tdone = next((slim_event(e) for e in evs if e.get("type") == "tool.complete"), None)
    entry["evidence"]["read_file_event_types"] = r["event_types"]
    entry["evidence"]["tool.start"] = tstart
    entry["evidence"]["tool.complete"] = tdone
    check(entry, tstart is not None and tdone is not None, "tool.start + tool.complete emitted")

    r2 = await submit_and_wait(conn, sid, "[[tool:envprobe]] dump env")
    probe = next((e for e in conn.session_events(sid, r2["admission_id"]) if e.get("type") == "tool.complete"), None)
    entry["evidence"]["envprobe_tool.complete_raw_result_type"] = type((probe or {}).get("payload", {}).get("result")).__name__
    dump = _tool_json(probe)
    entry["evidence"]["envprobe"] = dump
    STATE["envprobe_a"] = dump
    check(entry, dump is not None, "envprobe tool ran")
    hsid = (dump.get("session_env") or {}).get("HERMES_SESSION_ID")
    entry["evidence"]["HERMES_SESSION_ID_vs_logical"] = {"tool_saw": hsid, "logical_session_id": sid}
    soft(entry, hsid == sid, "HERMES_SESSION_ID == logical session id")

    n0 = len(read_jsonl(ECHO_LOG))
    r3 = await submit_and_wait(conn, sid, "[[tool:emperor]] health")
    em = next((e for e in conn.session_events(sid, r3["admission_id"]) if e.get("type") == "tool.complete"), None)
    entry["evidence"]["emperor_health_tool.complete"] = slim_event(em) if em else None
    entry["evidence"]["emperor_echo_requests"] = read_jsonl(ECHO_LOG)[n0:]
    await conn.close()


def _tool_json(ev: dict | None) -> dict | None:
    if not ev:
        return None
    res = (ev.get("payload") or {}).get("result")
    if isinstance(res, dict):
        res = res.get("output") or res.get("result") or json.dumps(res)
    try:
        return json.loads(res)
    except Exception:
        return {"raw": res}


@scenario("09_interrupt_mid_turn")
async def s_interrupt(entry: dict) -> None:
    conn = await open_conn()
    sid = STATE["sid_a"]
    await conn.rpc("session.resume", session_id=sid)
    start_idx = len(conn.events)
    receipt = await conn.rpc("prompt.submit", session_id=sid, submission_id=f"emp-{uuid.uuid4().hex[:8]}",
                             text="[[slow:15]] long answer")
    adm = receipt["admission_id"]
    _, delta = await conn.wait_event(lambda e: e.get("type") == "message.delta" and e.get("session_id") == sid
                                     and (e.get("payload") or {}).get("text"), 30, start_idx)
    gen = delta.get("execution_generation")
    entry["evidence"]["running_generation"] = gen
    t0 = now()
    handle = await conn.rpc("session.interrupt", session_id=sid, execution_generation=gen)
    entry["evidence"]["session.interrupt_result"] = handle
    t_done, done = await conn.wait_event(is_complete_for(adm), 30, start_idx)
    entry["evidence"]["message.complete"] = slim_event(done)
    REPORT["latency_ms"]["interrupt_to_complete"] = ms(t_done - t0)
    p = done["payload"]
    check(entry, p.get("status") == "interrupted" or p.get("outcome") in ("cancelled", "interrupted"),
          "turn settled as interrupted")
    stale, _ = await conn.call("session.interrupt", session_id=sid, execution_generation=0)
    entry["evidence"]["interrupt_stale_generation"] = stale.get("error") or stale.get("result")
    rec = await conn.rpc("prompt.receipt", session_id=sid, admission_id=adm, include_result=True)
    entry["evidence"]["receipt_after_interrupt"] = rec
    # Session still usable.
    r = await submit_and_wait(conn, sid, "after interrupt")
    check(entry, r["complete"]["payload"].get("outcome") == "completed", "next turn completes")
    await conn.close()


@scenario("10_queue_while_busy_and_cancel")
async def s_queue(entry: dict) -> None:
    conn = await open_conn()
    sid = STATE["sid_a"]
    await conn.rpc("session.resume", session_id=sid)
    start_idx = len(conn.events)
    r1 = await conn.rpc("prompt.submit", session_id=sid, submission_id=f"q1-{uuid.uuid4().hex[:6]}", text="[[slow:3]] first")
    await conn.wait_event(lambda e: e.get("type") == "message.start" and e.get("session_id") == sid, 20, start_idx)
    r2 = await conn.rpc("prompt.submit", session_id=sid, submission_id=f"q2-{uuid.uuid4().hex[:6]}", text="second while busy")
    r3 = await conn.rpc("prompt.submit", session_id=sid, submission_id=f"q3-{uuid.uuid4().hex[:6]}", text="third gets cancelled")
    entry["evidence"]["receipts"] = {"first": r1, "second_while_busy": r2, "third": r3}
    check(entry, r2["status"] == "queued", "second submit while busy is queued, not refused")
    cancel = await conn.rpc("prompt.cancel", session_id=sid, admission_id=r3["admission_id"])
    entry["evidence"]["prompt.cancel_queued"] = cancel
    t1, c1 = await conn.wait_event(is_complete_for(r1["admission_id"]), 30, start_idx)
    t2, c2 = await conn.wait_event(is_complete_for(r2["admission_id"]), 30, start_idx)
    entry["evidence"]["order"] = {"first_complete_before_second": t1 <= t2,
                                  "second_text": c2["payload"].get("text")}
    check(entry, t1 <= t2 and c2["payload"].get("outcome") == "completed", "FIFO order preserved")
    c3 = [e for e in conn.session_events(sid) if is_complete_for(r3["admission_id"])(e)]
    entry["evidence"]["cancelled_queued_complete_event"] = slim_event(c3[0]) if c3 else None
    infos = [slim_event(e) for e in conn.session_events(sid) if e.get("type") == "session.info"]
    entry["evidence"]["session.info_pending_samples"] = [i.get("payload", {}).get("pending") for i in infos[:3]]
    await conn.close()


@scenario("11_compress")
async def s_compress(entry: dict) -> None:
    conn = await open_conn()
    sid = STATE["sid_a"]
    snap = await conn.rpc("session.resume", session_id=sid)
    entry["evidence"]["before"] = {"revision": snap["revision"], "execution_generation": snap["execution_generation"],
                                   "message_count": snap["message_count"], "stored_session_id": snap["stored_session_id"]}
    t0 = now()
    frame, _ = await conn.call("session.mutate", _timeout=660, session_id=sid, request_id=f"compress-{uuid.uuid4().hex[:6]}",
                               expected_revision=snap["revision"], expected_generation=snap["execution_generation"],
                               operation="compress", payload={"focus": "probe"})
    REPORT["latency_ms"]["compress_rtt_fake_model"] = ms(now() - t0)
    entry["evidence"]["mutate_compress"] = frame.get("result") or frame.get("error")
    check(entry, "result" in frame, "compress accepted")
    snap2 = await conn.rpc("session.resume", session_id=sid)
    entry["evidence"]["after"] = {"session_id": snap2["session_id"], "stored_session_id": snap2["stored_session_id"],
                                  "revision": snap2["revision"], "message_count": snap2["message_count"]}
    r = await submit_and_wait(conn, sid, "[[tool:envprobe]] after compress")
    dump = _tool_json(next((e for e in conn.session_events(sid, r["admission_id"]) if e.get("type") == "tool.complete"), None))
    hsid = ((dump or {}).get("session_env") or {}).get("HERMES_SESSION_ID")
    entry["evidence"]["HERMES_SESSION_ID_after_compress"] = {"tool_saw": hsid, "logical": sid,
                                                             "stored_session_id": snap2["stored_session_id"],
                                                             "os_environ": ((dump or {}).get("os_environ") or {}).get("HERMES_SESSION_ID")}
    stats = await conn.rpc("session.stats", session_id=sid)
    entry["evidence"]["compression_count"] = stats.get("compression_count")
    await conn.close()


@scenario("12_replay_after_disconnect")
async def s_replay(entry: dict) -> None:
    conn = await open_conn()
    sid = STATE["sid_a"]
    snap = await conn.rpc("session.resume", session_id=sid)
    start_idx = len(conn.events)
    receipt = await conn.rpc("prompt.submit", session_id=sid, submission_id=f"rp-{uuid.uuid4().hex[:6]}", text="[[slow:4]] replay me")
    adm = receipt["admission_id"]
    # Read a few deltas, then drop the socket mid-turn.
    seen = 0
    last_seq = snap["last_sequence"]
    replay_epoch = snap["replay_epoch"]
    while seen < 5:
        _, ev = await conn.wait_event(lambda e: e.get("session_id") == sid, 20, start_idx)
        start_idx = next(i for i, (_, e) in enumerate(conn.events) if e is ev) + 1
        last_seq = ev.get("seq", last_seq)
        if ev.get("type") == "message.delta":
            seen += 1
    await conn.close()
    t_disc = now()
    entry["evidence"]["disconnected_at_seq"] = last_seq
    await asyncio.sleep(5)  # turn finishes while nobody is attached
    conn = await open_conn()
    snap2 = await conn.rpc("session.resume", session_id=sid)
    entry["evidence"]["resume_after"] = {"running": snap2["running"], "last_sequence": snap2["last_sequence"],
                                         "replay_epoch_same": snap2["replay_epoch"] == replay_epoch}
    t0 = now()
    since = await conn.rpc("session.events.since", session_id=sid, last_sequence=last_seq, replay_epoch=replay_epoch)
    REPORT["latency_ms"]["events.since_rtt"] = ms(now() - t0)
    types = [e.get("type") for e in since["events"]]
    entry["evidence"]["events.since"] = {k: v for k, v in since.items() if k != "events"}
    entry["evidence"]["replayed_types_histogram"] = {t: types.count(t) for t in sorted(set(types))}
    got_complete = any(is_complete_for(adm)(e) for e in since["events"])
    check(entry, got_complete or since.get("snapshot_required"), "replay contains message.complete (or asks for snapshot)")
    entry["evidence"]["replay_contains_complete"] = got_complete
    seqs = [e.get("seq") for e in since["events"]]
    soft(entry, seqs == sorted(seqs) and (not seqs or seqs[0] == last_seq + 1), "replay is gapless from last_sequence+1")
    rec = await conn.rpc("prompt.receipt", session_id=sid, admission_id=adm, include_result=True)
    entry["evidence"]["receipt_after_reconnect"] = {k: rec.get(k) for k in ("status", "outcome")}
    entry["evidence"]["disconnect_to_replayed_s"] = round(now() - t_disc, 3)
    # Wrong epoch.
    wrong = await conn.rpc("session.events.since", session_id=sid, last_sequence=last_seq, replay_epoch="bogus-epoch")
    entry["evidence"]["events.since_wrong_epoch"] = {k: v for k, v in wrong.items() if k != "events"}
    STATE["replay_epoch_before_restart"] = snap2["replay_epoch"]
    STATE["last_seq_before_restart"] = snap2["last_sequence"]
    await conn.close()


@scenario("13_parallel_sessions")
async def s_parallel(entry: dict) -> None:
    conn = await open_conn()
    a = STATE["sid_a"]
    await conn.rpc("session.resume", session_id=a)
    snap_b = await conn.rpc("session.create", request_id=f"emperor-thread-B-{uuid.uuid4().hex[:6]}", source="tool",
                            client_env={"EMPEROR_CLAW_TURN_THREAD_ID": "thread-B"})
    b = snap_b["session_id"]
    STATE["sid_b"] = b
    start_idx = len(conn.events)
    t0 = now()
    ra, rb = await asyncio.gather(
        conn.rpc("prompt.submit", session_id=a, submission_id=f"pa-{uuid.uuid4().hex[:6]}", text="[[slow:3]] A"),
        conn.rpc("prompt.submit", session_id=b, submission_id=f"pb-{uuid.uuid4().hex[:6]}", text="[[slow:3]] B"))
    ta, _ = await conn.wait_event(is_complete_for(ra["admission_id"]), 30, start_idx)
    tb, _ = await conn.wait_event(is_complete_for(rb["admission_id"]), 30, start_idx)
    starts = {sid: next(t for t, e in conn.events[start_idx:] if e.get("type") == "message.start" and e.get("session_id") == sid)
              for sid in (a, b)}
    overlap = max(starts.values()) < min(ta, tb)
    entry["evidence"]["wall_s_two_3s_turns"] = round(max(ta, tb) - t0, 3)
    entry["evidence"]["overlapping_execution"] = overlap
    check(entry, overlap, "two sessions execute concurrently on one gateway")
    # Concurrent envprobe: does each tool see its own session id?
    start_idx = len(conn.events)
    pa, pb = await asyncio.gather(
        conn.rpc("prompt.submit", session_id=a, submission_id=f"ea-{uuid.uuid4().hex[:6]}", text="[[tool:envprobe]] A"),
        conn.rpc("prompt.submit", session_id=b, submission_id=f"eb-{uuid.uuid4().hex[:6]}", text="[[tool:envprobe]] B"))
    await conn.wait_event(is_complete_for(pa["admission_id"]), 30, start_idx)
    await conn.wait_event(is_complete_for(pb["admission_id"]), 30, start_idx)
    da = _tool_json(next((e for e in conn.session_events(a, pa["admission_id"]) if e.get("type") == "tool.complete"), None))
    db = _tool_json(next((e for e in conn.session_events(b, pb["admission_id"]) if e.get("type") == "tool.complete"), None))
    entry["evidence"]["envprobe_concurrent"] = {
        "A": {"logical": a, "session_env": (da or {}).get("session_env", {}).get("HERMES_SESSION_ID"),
              "os_environ": (da or {}).get("os_environ", {}).get("HERMES_SESSION_ID"),
              "bound_client_env": (da or {}).get("bound_client_env")},
        "B": {"logical": b, "session_env": (db or {}).get("session_env", {}).get("HERMES_SESSION_ID"),
              "os_environ": (db or {}).get("os_environ", {}).get("HERMES_SESSION_ID"),
              "bound_client_env": (db or {}).get("bound_client_env")},
    }
    await conn.close()


@scenario("14_approval_without_viewer", required=False)
async def s_approval(entry: dict) -> None:
    Path("/tmp/spike-approval-target").mkdir(exist_ok=True)
    conn = await open_conn()
    snap = await conn.rpc("session.create", request_id=f"approval-{uuid.uuid4().hex[:6]}", source="tool")
    sid = snap["session_id"]
    start_idx = len(conn.events)
    receipt = await conn.rpc("prompt.submit", session_id=sid, submission_id=f"ap-{uuid.uuid4().hex[:6]}", text="[[tool:danger]] clean up")
    adm = receipt["admission_id"]
    try:
        _, req = await conn.wait_event(lambda e: e.get("type") == "approval.request" and e.get("session_id") == sid, 30, start_idx)
        entry["evidence"]["approval.request"] = slim_event(req)
    except TimeoutError:
        entry["evidence"]["approval.request"] = None
        entry["evidence"]["events_seen"] = [e.get("type") for e in conn.session_events(sid)]
    t_req = now()
    await conn.close()  # no viewer attached from here on
    deadline = t_req + APPROVAL_TIMEOUT + 60
    settled = None
    while now() < deadline:
        await asyncio.sleep(2)
        c2 = await open_conn()
        rec = await c2.rpc("prompt.receipt", session_id=sid, admission_id=adm, include_result=True)
        if rec["status"] == "terminal":
            settled = rec
            snap2 = await c2.rpc("session.resume", session_id=sid)
            entry["evidence"]["prompts_after"] = snap2["prompts"]
            tool_rows = [m for m in snap2["messages"] if m.get("role") == "tool"]
            entry["evidence"]["tool_row_after_timeout"] = tool_rows[-1] if tool_rows else None
            await c2.close()
            break
        await c2.close()
    entry["evidence"]["configured_approvals_timeout_s"] = APPROVAL_TIMEOUT
    entry["evidence"]["settled_after_s"] = round(now() - t_req, 1) if settled else None
    entry["evidence"]["receipt"] = settled
    entry["evidence"]["target_still_exists"] = Path("/tmp/spike-approval-target").exists()
    check(entry, settled is not None, "turn settles without a viewer (approval times out)")


@scenario("15_dotenv_rotation_without_restart")
async def s_dotenv(entry: dict) -> None:
    conn = await open_conn()
    sid = STATE["sid_a"]
    await conn.rpc("session.resume", session_id=sid)
    env_path = HOME / ".env"
    original = env_path.read_text()
    env_path.write_text("FAKE_MODEL_KEY=sk-fake-rotated\nEMPEROR_PROBE_DOTENV=dotenv-v2\nEMPEROR_CLAW_API_TOKEN=dotenv-token\n")
    try:
        n0 = len(read_jsonl(FAKE_LOG))
        r = await submit_and_wait(conn, sid, "[[tool:envprobe]] after rotation")
        dump = _tool_json(next((e for e in conn.session_events(sid, r["admission_id"]) if e.get("type") == "tool.complete"), None))
        auths = sorted({e["auth"] for e in read_jsonl(FAKE_LOG)[n0:]})
        entry["evidence"]["model_auth_headers_after_rotation"] = auths
        entry["evidence"]["plugin_view_after_rotation"] = {
            "os_environ": {k: (dump or {}).get("os_environ", {}).get(k) for k in ("EMPEROR_PROBE_DOTENV", "EMPEROR_CLAW_API_TOKEN")},
            "session_env": {k: (dump or {}).get("session_env", {}).get(k) for k in ("EMPEROR_PROBE_DOTENV", "EMPEROR_CLAW_API_TOKEN")}}
        n1 = len(read_jsonl(ECHO_LOG))
        await submit_and_wait(conn, sid, "[[tool:emperor]] health after rotation")
        entry["evidence"]["emperor_plugin_bearer_after_rotation"] = [e["authorization"] for e in read_jsonl(ECHO_LOG)[n1:]]
        # A brand-new session after rotation.
        snap = await conn.rpc("session.create", request_id=f"rot-{uuid.uuid4().hex[:6]}", source="tool")
        n2 = len(read_jsonl(FAKE_LOG))
        await submit_and_wait(conn, snap["session_id"], "new session after rotation")
        entry["evidence"]["model_auth_new_session_after_rotation"] = sorted({e["auth"] for e in read_jsonl(FAKE_LOG)[n2:]})
    finally:
        env_path.write_text(original)
    await conn.close()


@scenario("16_gateway_restart_persistence")
async def s_restart(entry: dict, gw: Gateway) -> None:
    sid = STATE["sid_a"]
    old = identify()["result"]
    # A turn in flight across the restart.
    conn = await open_conn()
    await conn.rpc("session.resume", session_id=sid)
    start_idx = len(conn.events)
    inflight = await conn.rpc("prompt.submit", session_id=sid, submission_id=f"rs-{uuid.uuid4().hex[:6]}", text="[[slow:20]] across restart")
    queued = await conn.rpc("prompt.submit", session_id=sid, submission_id=f"rq-{uuid.uuid4().hex[:6]}", text="queued behind restart")
    await conn.wait_event(lambda e: e.get("type") == "message.delta" and e.get("session_id") == sid, 20, start_idx)
    stop = gw.stop(signal.SIGTERM)
    entry["evidence"]["stop"] = stop
    entry["evidence"]["events_seen_by_viewer_during_stop"] = [
        slim_event(e) for e in conn.session_events(sid) if e.get("type") in ("message.complete", "error", "session.info")][-3:]
    entry["evidence"]["viewer_close"] = conn.closed
    await conn.close()
    started = gw.start()
    new = started["identify"]["result"]
    REPORT["latency_ms"]["gateway_restart_spawn_to_ready"] = ms(started["spawn_to_ready_s"])
    entry["evidence"]["identity_change"] = {
        "instance_id_changed": old["instance_id"] != new["instance_id"],
        "authority_epoch": [old["authority_epoch"], new["authority_epoch"]],
        "api_origin_changed": old["api_origin"] != new["api_origin"]}
    conn = await open_conn()
    again = await conn.rpc("session.create", **STATE["create_params_a"])
    check(entry, again["session_id"] == sid, "request_id idempotent after restart (same session_id)")
    snap = await conn.rpc("session.resume", session_id=sid)
    entry["evidence"]["resume_after_restart"] = {
        "message_count": snap["message_count"], "running": snap["running"],
        "replay_epoch_changed": snap["replay_epoch"] != STATE.get("replay_epoch_before_restart"),
        "last_sequence": snap["last_sequence"], "pending": snap["pending"], "prompts": snap["prompts"]}
    check(entry, snap["message_count"] > 0, "transcript survived restart")
    rec_in = await conn.rpc("prompt.receipt", session_id=sid, admission_id=inflight["admission_id"], include_result=True)
    rec_q = await conn.rpc("prompt.receipt", session_id=sid, admission_id=queued["admission_id"], include_result=True)
    entry["evidence"]["inflight_receipt_after_restart"] = rec_in
    entry["evidence"]["queued_receipt_after_restart"] = rec_q
    if rec_in.get("status") == "unknown":
        res = await conn.rpc("prompt.resolve_unknown", session_id=sid, admission_id=inflight["admission_id"],
                             execution_generation=rec_in.get("execution_generation") or snap["execution_generation"])
        entry["evidence"]["resolve_unknown"] = res
    try:
        _, qdone = await conn.wait_event(is_complete_for(queued["admission_id"]), 30)
        entry["evidence"]["queued_admission_ran_after_restart"] = slim_event(qdone)
    except (TimeoutError, ConnectionError):
        rec_q2 = await conn.rpc("prompt.receipt", session_id=sid, admission_id=queued["admission_id"])
        entry["evidence"]["queued_admission_ran_after_restart"] = {"not_seen_live": True, "receipt": rec_q2}
    since = await conn.rpc("session.events.since", session_id=sid, last_sequence=STATE.get("last_seq_before_restart", 0),
                           replay_epoch=STATE.get("replay_epoch_before_restart") or "")
    entry["evidence"]["events.since_old_epoch"] = {k: v for k, v in since.items() if k != "events"}
    entry["evidence"]["show_reasoning_after_restart"] = await conn.rpc("config.get", session_id=sid, key="show_reasoning")
    old_sub, _ = await conn.call("prompt.submit", session_id=sid, submission_id=STATE.get("first_submission", "none"), text="x")
    r = await submit_and_wait(conn, sid, "after restart")
    check(entry, r["complete"]["payload"].get("outcome") == "completed", "new turn completes after restart")
    dump_turn = await submit_and_wait(conn, sid, "[[tool:envprobe]] after restart")
    dump = _tool_json(next((e for e in conn.session_events(sid, dump_turn["admission_id"]) if e.get("type") == "tool.complete"), None))
    entry["evidence"]["bound_client_env_after_restart"] = (dump or {}).get("bound_client_env")
    await conn.close()


@scenario("17_legacy_rows_adoption", required=False)
async def s_legacy(entry: dict, gw: Gateway) -> None:
    """Simulate rows a pre-authority Hermes (v0.21.x CLI) wrote: insert into state.db directly."""
    db_path = HOME / "state.db"
    con = sqlite3.connect(db_path)
    cols = [r[1] for r in con.execute("PRAGMA table_info(sessions)")]
    mcols = [r[1] for r in con.execute("PRAGMA table_info(messages)")]
    entry["evidence"]["sessions_columns"] = cols
    entry["evidence"]["messages_columns"] = mcols
    rows = {}
    for source in ("emperor", "cli"):
        legacy_id = f"20261001_120000_{source}{uuid.uuid4().hex[:4]}"
        values = {"id": legacy_id, "source": source, "started_at": time.time() - 86400}
        if "model" in cols:
            values["model"] = "deepseek-chat"
        if "title" in cols:
            values["title"] = f"legacy {source}"
        keys = [k for k in values if k in cols]
        con.execute(f"INSERT INTO sessions ({','.join(keys)}) VALUES ({','.join('?' * len(keys))})", [values[k] for k in keys])
        for role, content in (("user", f"legacy question from {source}"), ("assistant", "legacy answer")):
            mv = {"session_id": legacy_id, "role": role, "content": content, "timestamp": time.time() - 86000}
            mk = [k for k in mv if k in mcols]
            con.execute(f"INSERT INTO messages ({','.join(mk)}) VALUES ({','.join('?' * len(mk))})", [mv[k] for k in mk])
        rows[source] = legacy_id
    con.commit()
    con.close()
    conn = await open_conn()
    for source, legacy_id in rows.items():
        frame, _ = await conn.call("session.resume", session_id=legacy_id)
        res = frame.get("result")
        out: dict[str, Any] = {"resume": frame.get("error") or {k: res.get(k) for k in ("session_id", "stored_session_id", "message_count")}}
        if res:
            info = await conn.rpc("session.info", session_id=res["session_id"])
            out["info"] = {k: info.get(k) for k in ("source", "model", "provider", "toolsets", "cwd", "lazy")}
            try:
                r = await submit_and_wait(conn, res["session_id"], f"continue legacy {source}", timeout=30)
                out["turn_outcome"] = r["complete"]["payload"].get("outcome")
                seen = [e for e in read_jsonl(FAKE_LOG) if e["kind"] == "main"][-1]
                out["model_saw_n_messages"] = seen["n_messages"]
            except Exception as exc:
                out["turn_error"] = repr(exc)
        else:
            imp, _ = await conn.call("session.mutate", session_id=STATE["sid_b"], request_id=f"imp-{uuid.uuid4().hex[:6]}",
                                     expected_revision=0, operation="import", payload={"sessions": [legacy_id]})
            out["mutate_import_attempt"] = imp.get("error") or imp.get("result")
        entry["evidence"][f"source_{source}"] = out
    await conn.close()


async def s_cli_fallback(entry_name: str = "18_cli_fallback_chat_q") -> None:
    @scenario(entry_name)
    async def inner(entry: dict) -> None:
        pid_before = identify()["result"]["pid"]
        base = [HERMES, "-p", PROFILE, "chat", "-Q", "--format", "stream-json", "--toolsets", "emperor-claw"]
        env = dict(os.environ)
        env.update(EMPEROR_CLAW_API_TOKEN="cli-token", EMPEROR_CLAW_API_URL=ECHO_URL)

        def run(cmd: list[str]) -> dict:
            t0 = now()
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=180, env=env, stdin=subprocess.DEVNULL)
            return {"cmd": " ".join(cmd[1:]), "rc": p.returncode, "wall_s": round(now() - t0, 3),
                    "stdout_tail": p.stdout[-1500:], "stderr_tail": p.stderr[-1500:]}

        fresh = run(base + ["--source", "tool", "-q", "hello from cli"])
        entry["evidence"]["fresh_source_tool"] = fresh
        check(entry, fresh["rc"] == 0, "chat -q --source tool exits 0")
        session = None
        for line in (fresh["stderr_tail"] + "\n" + fresh["stdout_tail"]).splitlines():
            if line.startswith("Session: "):
                session = line.split(": ", 1)[1].strip()
            else:
                try:
                    obj = json.loads(line)
                    session = session or obj.get("session_id")
                except Exception:
                    pass
        entry["evidence"]["cli_session_id"] = session
        if session:
            resumed = run(base[:3] + ["chat", "--resume", session] + base[4:] + ["--source", "tool", "-q", "second turn"])
            entry["evidence"]["resume_source_tool"] = resumed
            check(entry, resumed["rc"] == 0, "chat --resume -q --source tool exits 0")
        entry["evidence"]["source_emperor"] = run(base + ["--source", "emperor", "-q", "hello"])
        check(entry, entry["evidence"]["source_emperor"]["rc"] != 0, "--source emperor fails")
        entry["evidence"]["resume_unknown_id"] = run(base[:3] + ["chat", "--resume", "does-not-exist"] + base[4:] + ["--source", "tool", "-q", "x"])
        entry["evidence"]["gateway_pid_unchanged"] = identify()["result"]["pid"] == pid_before
    await inner()


# ── W0 additions: fixtures (S-20), compress under load (S-17), finite (S-16), goals (S-13), env (S-15) ──


def rss_kib(pid: int) -> dict:
    """RSS of the gateway process and its descendants, from /proc (KiB)."""
    def children(p: int) -> list[int]:
        out = []
        for d in Path("/proc").iterdir():
            if d.name.isdigit():
                try:
                    ppid = int((d / "stat").read_text().rsplit(")", 1)[1].split()[1])
                except Exception:
                    continue
                if ppid == p:
                    out.append(int(d.name))
        return out

    def rss(p: int) -> int:
        try:
            for line in Path(f"/proc/{p}/status").read_text().splitlines():
                if line.startswith("VmRSS:"):
                    return int(line.split()[1])
        except OSError:
            pass
        return 0

    tree, todo = [], [pid]
    while todo:
        p = todo.pop()
        tree.append(p)
        todo.extend(children(p))
    return {"gateway_pid_kib": rss(pid), "tree_kib": sum(rss(p) for p in tree), "tree_pids": len(tree)}


async def _fixture_session(conn: Conn, label: str) -> str:
    snap = await conn.rpc("session.create", request_id=f"emperor/probe-agent/{label}/g1-{uuid.uuid4().hex[:6]}",
                          source="tool", yolo=True,
                          client_env={"HERMES_EPHEMERAL_SYSTEM_PROMPT": "You are Probe, an Emperor Claw agent.",
                                      "EMPEROR_THREAD_ID": label, "EMPEROR_THREAD_TYPE": "direct",
                                      "EMPEROR_SESSION_GEN": "1"})
    sid = snap["session_id"]
    await conn.rpc("config.set", session_id=sid, key="show_reasoning", value="on")
    return sid


@scenario("19_fixtures_turns")
async def s_fixtures(entry: dict) -> None:
    written = {}
    # normal turn
    rec = Recorder("normal_turn", "session.create (tool, yolo) + show_reasoning on + one trivial turn + receipt")
    conn = await open_conn(recorder=rec)
    sid = await _fixture_session(conn, "fx-normal")
    r = await submit_and_wait(conn, sid, "hello fixture", api_text="[ctx thread=fx-normal]\nhello fixture",
                              turn_author={"id": "user-1", "name": "Jose", "is_bot": False, "origin": "emperor"})
    await conn.rpc("prompt.receipt", session_id=sid, admission_id=r["admission_id"], include_result=True)
    await conn.close()
    written["normal_turn"] = rec.write()
    # reasoning turn
    rec = Recorder("reasoning_turn", "show_reasoning on + provider reasoning_content")
    conn = await open_conn(recorder=rec)
    sid = await _fixture_session(conn, "fx-reason")
    await submit_and_wait(conn, sid, "[[reason]] think")
    await conn.close()
    written["reasoning_turn"] = rec.write()
    # three-tool turn
    rec = Recorder("tool_turn_three_tools", "read_file -> envprobe_dump -> read_file, then text")
    conn = await open_conn(recorder=rec)
    sid = await _fixture_session(conn, "fx-tools")
    r = await submit_and_wait(conn, sid, "[[tool:three]] use three tools")
    starts = [e for e in conn.session_events(sid, r["admission_id"]) if e.get("type") == "tool.start"]
    entry["evidence"]["three_tool_names"] = [e["payload"].get("name") for e in starts]
    check(entry, len(starts) == 3, "three tool.start events")
    await conn.rpc("prompt.receipt", session_id=sid, admission_id=r["admission_id"], include_result=True)
    await conn.close()
    written["tool_turn_three_tools"] = rec.write()
    # interrupt while streaming
    rec = Recorder("interrupted_turn_streaming", "session.interrupt while message.delta streams")
    conn = await open_conn(recorder=rec)
    sid = await _fixture_session(conn, "fx-int")
    rcpt = await conn.rpc("prompt.submit", session_id=sid, submission_id="emp-fx-int", text="[[slow:15]] stream")
    _, d = await conn.wait_event(lambda e: e.get("type") == "message.delta" and (e.get("payload") or {}).get("text"), 20)
    await conn.rpc("session.interrupt", session_id=sid, execution_generation=d["execution_generation"])
    await conn.wait_event(is_complete_for(rcpt["admission_id"]), 30)
    await conn.rpc("prompt.receipt", session_id=sid, admission_id=rcpt["admission_id"], include_result=True)
    await conn.close()
    written["interrupted_turn_streaming"] = rec.write()
    # interrupt while the provider hangs
    rec = Recorder("interrupted_turn_hang", "session.interrupt while the model call hangs (fake Hang)")
    conn = await open_conn(recorder=rec)
    sid = await _fixture_session(conn, "fx-hang")
    rcpt = await conn.rpc("prompt.submit", session_id=sid, submission_id="emp-fx-hang", text="[[hang]] wait forever")
    _, st = await conn.wait_event(lambda e: e.get("type") == "message.start", 20)
    await asyncio.sleep(1.0)
    t0 = now()
    await conn.rpc("session.interrupt", session_id=sid, execution_generation=st["execution_generation"])
    _, done = await conn.wait_event(is_complete_for(rcpt["admission_id"]), 60)
    REPORT["latency_ms"]["interrupt_during_hang_to_complete"] = ms(now() - t0)
    entry["evidence"]["hang_interrupt_complete"] = {k: done["payload"].get(k) for k in ("status", "outcome", "warning", "failure_reason")}
    await conn.close()
    written["interrupted_turn_hang"] = rec.write()
    # provider drops mid-stream
    rec = Recorder("provider_drop_mid_stream", "fake DropMidStream (api_max_retries: 1)")
    conn = await open_conn(recorder=rec)
    sid = await _fixture_session(conn, "fx-drop")
    r = await submit_and_wait(conn, sid, "[[drop]] fail please", timeout=120)
    entry["evidence"]["drop_complete"] = {k: r["complete"]["payload"].get(k) for k in ("status", "outcome", "warning", "failure_reason", "error_surface", "text")}
    await conn.rpc("prompt.receipt", session_id=sid, admission_id=r["admission_id"], include_result=True)
    await conn.close()
    written["provider_drop_mid_stream"] = rec.write()
    entry["evidence"]["fixtures"] = written


@scenario("20_compress_under_load_fixture")
async def s_compress_load(entry: dict) -> None:
    rec = Recorder("compress", "4 turns, then session.mutate compress {partial, keep_last:6} with a 3 s summary "
                              "call; a prompt.submit is sent while the compress runs")
    conn = await open_conn(recorder=rec)
    sid = await _fixture_session(conn, "fx-compress")
    for i in range(4):
        await submit_and_wait(conn, sid, f"history turn {i}")
    snap = await conn.rpc("session.resume", session_id=sid)
    SLOW_AUX_FLAG.write_text("3")
    try:
        t0 = now()
        compress = asyncio.create_task(conn.call("session.mutate", _timeout=660, session_id=sid,
                                                 request_id=f"compress-{uuid.uuid4().hex[:6]}",
                                                 expected_revision=snap["revision"],
                                                 expected_generation=snap["execution_generation"],
                                                 operation="compress", payload={"partial": True, "keep_last": 6}))
        await asyncio.sleep(1.0)
        # Another session on a SECOND connection while the compress RPC is outstanding.
        other = await open_conn()
        osid = await _fixture_session(other, "fx-compress-other")
        _, ortt = await other.call("prompt.submit", session_id=osid, submission_id=f"o-{uuid.uuid4().hex[:6]}",
                                   text="other session during compress")
        entry["evidence"]["other_session_second_conn_submit_rtt_ms"] = ms(ortt)
        await other.close()
        rec.meta(event="submit_during_compress")
        sub_frame, sub_rtt = await conn.call("prompt.submit", session_id=sid, submission_id=f"mid-{uuid.uuid4().hex[:6]}",
                                             text="submitted during compress")
        entry["evidence"]["submit_during_compress"] = {"rtt_ms": ms(sub_rtt), "frame": sub_frame.get("result") or sub_frame.get("error")}
        frame, _ = await compress
        REPORT["latency_ms"]["compress_partial_keep6_with_3s_summary"] = ms(now() - t0)
        entry["evidence"]["compress_result"] = frame.get("result") or frame.get("error")
        if "result" in sub_frame:
            adm = sub_frame["result"]["admission_id"]
            t_done, done = await conn.wait_event(is_complete_for(adm), 60)
            entry["evidence"]["mid_compress_turn"] = {"outcome": done["payload"].get("outcome"),
                                                      "completed_after_compress_start_ms": ms(t_done - t0)}
        # A compress requested while a turn is running.
        rcpt = await conn.rpc("prompt.submit", session_id=sid, submission_id=f"busy-{uuid.uuid4().hex[:6]}", text="[[slow:3]] busy")
        await conn.wait_event(lambda e: e.get("type") == "message.start" and e.get("admission_id") == rcpt["admission_id"], 20)
        snap2 = await conn.rpc("session.resume", session_id=sid)
        busy, _ = await conn.call("session.mutate", _timeout=660, session_id=sid, request_id=f"cbusy-{uuid.uuid4().hex[:6]}",
                                  expected_revision=snap2["revision"], expected_generation=snap2["execution_generation"],
                                  operation="compress", payload={})
        entry["evidence"]["compress_while_turn_running"] = busy.get("error") or busy.get("result")
        await conn.wait_event(is_complete_for(rcpt["admission_id"]), 30)
    finally:
        SLOW_AUX_FLAG.unlink(missing_ok=True)
    await conn.close()
    entry["evidence"]["fixture"] = rec.write()


@scenario("21_reconnect_replay_fixture")
async def s_replay_fixture(entry: dict) -> None:
    rec = Recorder("reconnect_replay", "turn streams, socket closed mid-turn, new ticket + resume + events.since")
    conn = await open_conn(recorder=rec)
    sid = await _fixture_session(conn, "fx-replay")
    snap = await conn.rpc("session.resume", session_id=sid)
    rcpt = await conn.rpc("prompt.submit", session_id=sid, submission_id="emp-fx-replay", text="[[slow:3]] replay")
    last_seq = snap["last_sequence"]
    deltas = 0
    idx = 0
    while deltas < 3:
        _, ev = await conn.wait_event(lambda e: e.get("session_id") == sid, 20, idx)
        idx = next(i for i, (_, e) in enumerate(conn.events) if e is ev) + 1
        last_seq = ev.get("seq", last_seq)
        deltas += ev.get("type") == "message.delta"
    rec.meta(event="disconnect", last_seen_seq=last_seq)
    await conn.close()
    await asyncio.sleep(4)
    conn = await open_conn(recorder=rec)
    snap2 = await conn.rpc("session.resume", session_id=sid)
    await conn.rpc("config.set", session_id=sid, key="show_reasoning", value="on")
    since = await conn.rpc("session.events.since", session_id=sid, last_sequence=last_seq, replay_epoch=snap["replay_epoch"])
    await conn.rpc("prompt.receipt", session_id=sid, admission_id=rcpt["admission_id"], include_result=True)
    entry["evidence"]["replayed"] = {"count": since.get("count"), "first_seq": (since["events"] or [{}])[0].get("seq"),
                                     "expected_first_seq": last_seq + 1, "snapshot_required": since.get("snapshot_required"),
                                     "truncated": since.get("truncated"), "resume_last_sequence": snap2["last_sequence"],
                                     "complete_in_replay": any(is_complete_for(rcpt["admission_id"])(e) for e in since["events"])}
    await conn.close()
    entry["evidence"]["fixture"] = rec.write()


@scenario("22_gateway_kill9_mid_tool_fixture")
async def s_kill9(entry: dict, gw: Gateway) -> None:
    rec = Recorder("gateway_kill9_mid_turn", "tool ran, follow-up model call hangs, gateway SIGKILLed, restarted, "
                                             "receipt + resolve_unknown + queued admission")
    conn = await open_conn(recorder=rec)
    sid = await _fixture_session(conn, "fx-kill")
    rcpt = await conn.rpc("prompt.submit", session_id=sid, submission_id="emp-fx-kill", text="[[tool:thenhang]] then die")
    q = await conn.rpc("prompt.submit", session_id=sid, submission_id="emp-fx-kill-q", text="queued behind the killed turn")
    await conn.wait_event(lambda e: e.get("type") == "tool.complete", 20)
    await asyncio.sleep(1.0)
    rec.meta(event="sigkill_gateway")
    entry["evidence"]["stop"] = gw.stop(signal.SIGKILL)
    await conn.close()
    started = gw.start()
    REPORT["latency_ms"]["gateway_restart_after_sigkill_spawn_to_ready"] = ms(started["spawn_to_ready_s"])
    conn = await open_conn(recorder=rec)
    snap = await conn.rpc("session.resume", session_id=sid)
    entry["evidence"]["resume_after_kill"] = {"pending": snap["pending"], "running": snap["running"],
                                              "execution_generation": snap["execution_generation"]}
    receipt = await conn.rpc("prompt.receipt", session_id=sid, admission_id=rcpt["admission_id"], include_result=True)
    entry["evidence"]["killed_turn_receipt"] = receipt
    qr = await conn.rpc("prompt.receipt", session_id=sid, admission_id=q["admission_id"])
    entry["evidence"]["queued_receipt_after_kill"] = qr
    if receipt["status"] == "unknown":
        res = await conn.call("prompt.resolve_unknown", session_id=sid, admission_id=rcpt["admission_id"],
                              execution_generation=receipt["execution_generation"])
        entry["evidence"]["resolve_unknown"] = res[0].get("result") or res[0].get("error")
    try:
        _, done = await conn.wait_event(is_complete_for(q["admission_id"]), 30)
        entry["evidence"]["queued_after_resolve"] = {k: done["payload"].get(k) for k in ("status", "outcome")}
    except TimeoutError:
        entry["evidence"]["queued_after_resolve"] = await conn.rpc("prompt.receipt", session_id=sid, admission_id=q["admission_id"])
    await conn.close()
    entry["evidence"]["fixture"] = rec.write()


@scenario("23_finite_unattended", required=False)
async def s_finite(entry: dict) -> None:
    conn = await open_conn()
    snap = await conn.rpc("session.create", request_id=f"finite-{uuid.uuid4().hex[:6]}", source="tool")
    sid = snap["session_id"]
    Path("/tmp/spike-approval-target").mkdir(exist_ok=True)
    out = []
    for text in ("finite one", "[[tool:danger]] finite dangerous", "finite three"):
        try:
            r = await submit_and_wait(conn, sid, text, timeout=90, finite=True, unattended=True)
            out.append({"text": text, "outcome": r["complete"]["payload"].get("outcome"),
                        "status": r["complete"]["payload"].get("status"), "turn_end_ms": ms(r["turn_end_s"]),
                        "approval_events": [t for t in r["event_types"] if t.startswith("approval")]})
        except RpcError as exc:
            out.append({"text": text, "error": exc.error})
    entry["evidence"]["turns"] = out
    entry["evidence"]["danger_target_removed"] = not Path("/tmp/spike-approval-target").exists()
    snap2 = await conn.rpc("session.resume", session_id=sid)
    entry["evidence"]["session_still_open"] = {"message_count": snap2["message_count"], "running": snap2["running"]}
    # Same with yolo (D11 default) and no finite flags.
    Path("/tmp/spike-approval-target").mkdir(exist_ok=True)
    y = await conn.rpc("session.create", request_id=f"yolo-{uuid.uuid4().hex[:6]}", source="tool", yolo=True)
    r = await submit_and_wait(conn, y["session_id"], "[[tool:danger]] yolo dangerous", timeout=90)
    entry["evidence"]["yolo_danger"] = {"outcome": r["complete"]["payload"].get("outcome"),
                                        "approval_events": [t for t in r["event_types"] if t.startswith("approval")],
                                        "target_removed": not Path("/tmp/spike-approval-target").exists()}
    await conn.close()


@scenario("24_goal_adapter", required=False)
async def s_goals(entry: dict) -> None:
    py = os.environ.get("HERMES_PY")
    adapter = "/opt/emperor-claw-plugin/bridge/hermes_goal_adapter.py"
    env = {k: v for k, v in os.environ.items() if k not in ("PYTHONPATH", "VIRTUAL_ENV")}
    env.update(HERMES_HOME=str(HOME), PYTHONPATH=os.environ.get("HERMES_REPO", ""))
    sid = STATE["sid_a"]
    out = {}
    for payload in ({"action": "start", "objective": "Write one haiku about gateways", "maxTurns": 3},
                    {"action": "status"},
                    {"action": "evaluate", "response": "Here is the haiku: loopback sockets hum"},
                    {"action": "clear"}):
        t0 = now()
        # Same entry point as the bridge, plus a traceback on failure (the adapter hides it).
        wrapper = ("import json,sys,traceback;sys.path.insert(0,'/opt/emperor-claw-plugin/bridge');"
                   "import hermes_goal_adapter as a\n"
                   "try: print(json.dumps(a.dispatch(json.load(sys.stdin))))\n"
                   "except Exception: traceback.print_exc(); sys.exit(1)")
        p = subprocess.run([py, "-c", wrapper], input=json.dumps({"sessionId": sid, **payload}), capture_output=True,
                           text=True, env=env, timeout=120, cwd=os.environ.get("HERMES_REPO"))
        out[payload["action"]] = {"rc": p.returncode, "wall_ms": ms(now() - t0), "stdout": p.stdout[-800:], "stderr": p.stderr[-2500:]}
    entry["evidence"] = out
    check(entry, out["start"]["rc"] == 0, "goal start works against a gateway-owned logical session")


@scenario("25_runtime_environment", required=False)
async def s_env(entry: dict) -> None:
    py = os.environ.get("HERMES_PY", "")
    p = subprocess.run([py, "-c", "import sys,websockets;print(sys.version.split()[0]);print(websockets.__version__)"],
                       capture_output=True, text=True, timeout=30)
    entry["evidence"]["hermes_venv_python"] = py
    entry["evidence"]["python_and_websockets"] = p.stdout.split()
    entry["evidence"]["legacy_venv_path_exists"] = Path.home().joinpath(".hermes/hermes-agent/venv/bin/python").exists()
    pl = subprocess.run([HERMES, "-p", PROFILE, "plugins", "list"], capture_output=True, text=True, timeout=60)
    entry["evidence"]["plugins_list"] = pl.stdout[-2000:]
    mains = [e for e in read_jsonl(FAKE_LOG) if e["kind"] == "main"]
    tools = sorted(set(mains[-1]["tools"])) if mains else []
    entry["evidence"]["model_tool_count"] = len(tools)
    entry["evidence"]["model_tools"] = tools
    entry["evidence"]["emperor_tools_offered"] = [t for t in tools if t.startswith("emperor_")]
    entry["evidence"]["envprobe_offered"] = "envprobe_dump" in tools


@scenario("26_default_gateway_coexistence", required=False)
async def s_default_gw(entry: dict, gw: Gateway) -> None:
    """S-2: a default-profile gateway started while the standalone spike gateway runs."""
    env = {k: v for k, v in os.environ.items() if k not in ("PYTHONPATH", "VIRTUAL_ENV", "HERMES_HOME")}
    logf = open(RESULTS / "gateway-default.log", "w")
    proc = subprocess.Popen([HERMES, "gateway", "run", "--external-supervisor"], stdout=logf, stderr=subprocess.STDOUT,
                            env=env, start_new_session=True)
    default_home = Path.home() / ".hermes"
    ident = None
    t0 = now()
    while now() - t0 < 60 and proc.poll() is None:
        try:
            with socket.socket(socket.AF_UNIX) as sk:
                sk.settimeout(3)
                sk.connect(str(default_home / "gateway.sock"))
                sk.sendall(b'{"protocol":1,"verb":"identify","id":1}\n')
                ident = json.loads(sk.makefile().readline())
                if (ident.get("result") or {}).get("state") == "ready":
                    break
        except OSError:
            pass
        await asyncio.sleep(0.5)
    entry["evidence"]["default_gateway_rc_if_exited"] = proc.poll()
    entry["evidence"]["default_identify"] = {k: (ident.get("result") or {}).get(k) for k in ("state", "served_profiles", "parked_profiles")} if ident else None
    entry["evidence"]["spike_still_ready"] = ready(identify())
    # Restart the standalone spike gateway while the default one runs.
    gw.stop()
    try:
        started = gw.start()
        entry["evidence"]["spike_restart_with_default_running"] = {"ready": True, "spawn_to_ready_s": started["spawn_to_ready_s"]}
    except Exception as exc:
        entry["evidence"]["spike_restart_with_default_running"] = {"ready": False, "error": str(exc)[-500:]}
    if proc.poll() is None:
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(60)
        except subprocess.TimeoutExpired:
            proc.kill()
    entry["evidence"]["default_gateway_log_tail"] = (RESULTS / "gateway-default.log").read_text()[-1500:]
    if gw.proc is None or gw.proc.poll() is not None:
        gw.start()


# ── R-2 / R-3 / R-4 (W8): questions the 0.9 design leaves to the contract suite ──────────────

PROD_TOOLSETS = ["emperor-claw", "web", "terminal", "code_execution"]


async def _fresh_session(conn: Conn, label: str, **extra: Any) -> tuple[str, dict]:
    frame, _ = await conn.call("session.create", request_id=f"emperor/probe-agent/{label}/g1-{uuid.uuid4().hex[:6]}",
                               source="tool", yolo=True, **extra)
    if "error" in frame:
        raise RpcError(frame["error"])
    snap = frame["result"]
    await conn.rpc("config.set", session_id=snap["session_id"], key="show_reasoning", value="on")
    return snap["session_id"], snap


def _main_rows_since(n0: int) -> list[dict]:
    return [r for r in read_jsonl(FAKE_LOG)[n0:] if r.get("kind") == "main"]


@scenario("27_clarify_auto")
async def s_clarify(entry: dict) -> None:
    """R-2: what a clarify looks like to a headless client, and whether an automatic answer works."""
    conn = await open_conn()
    # (a) Is `clarify` offered to the model with the production toolsets (design §5.7)?
    try:
        prod_sid, _ = await _fresh_session(conn, "clarify-prod", toolsets=PROD_TOOLSETS)
        n0 = len(read_jsonl(FAKE_LOG))
        await submit_and_wait(conn, prod_sid, "which tools do you have")
        rows = _main_rows_since(n0)
        tools = rows[-1].get("tools", []) if rows else []
        entry["evidence"]["prod_toolsets_tools_offered"] = tools
        entry["evidence"]["prod_toolsets_offer_clarify"] = "clarify" in tools
        n1 = len(read_jsonl(FAKE_LOG))
        r = await submit_and_wait(conn, prod_sid, "[[tool:clarify]] ask anyway")
        entry["evidence"]["prod_toolsets_clarify_call"] = {
            "outcome": r["complete"]["payload"].get("outcome"),
            "clarify_request_seen": any(e.get("type") == "clarify.request" for e in conn.session_events(prod_sid)),
            "model_decisions": [x.get("decision", "")[:300] for x in _main_rows_since(n1)]}
    except RpcError as exc:
        entry["evidence"]["prod_toolsets_create_error"] = exc.error
    # (b) Default toolsets (profile config): clarify offered -> request -> automatic answer.
    sid, _ = await _fresh_session(conn, "clarify-default")
    n2 = len(read_jsonl(FAKE_LOG))
    start_idx = len(conn.events)
    t_sub = now()
    rcpt = await conn.rpc("prompt.submit", session_id=sid, submission_id=f"emp-cl-{uuid.uuid4().hex[:6]}",
                          text="[[tool:clarify]] pick a colour")
    adm = rcpt["admission_id"]
    t_req, req = await conn.wait_event(lambda e: (e.get("type") == "clarify.request" and e.get("session_id") == sid)
                                       or is_complete_for(adm)(e), 30, start_idx)
    rows = _main_rows_since(n2)
    entry["evidence"]["default_toolsets_offer_clarify"] = "clarify" in (rows[0].get("tools", []) if rows else [])
    entry["evidence"]["clarify.request"] = slim_event(req)
    check(entry, req.get("type") == "clarify.request", "clarify.request published to the attached viewer")
    REPORT["latency_ms"]["clarify_request_after_submit"] = ms(t_req - t_sub)
    payload = req.get("payload") or {}
    prompt_id = payload.get("prompt_id") or payload.get("id")
    gen = req.get("execution_generation") or payload.get("execution_generation")
    choices = payload.get("choices") or []
    answer = str(choices[0]) if choices else "blue"
    t_ans = now()
    resp, _ = await conn.call("clarify.respond", session_id=sid, execution_generation=gen, prompt_id=prompt_id,
                              answer=answer)
    entry["evidence"]["clarify.respond_params"] = {"prompt_id": prompt_id, "execution_generation": gen, "answer": answer}
    entry["evidence"]["clarify.respond"] = resp.get("result") or resp.get("error")
    check(entry, "result" in resp, "clarify.respond accepted")
    t_done, done = await conn.wait_event(is_complete_for(adm), 30, start_idx)
    entry["evidence"]["clarify.settled"] = next((slim_event(e) for e in conn.session_events(sid)
                                                  if e.get("type") == "clarify.settled"), None)
    entry["evidence"]["final_text"] = done["payload"].get("text")
    saw = [x.get("decision", "")[:600] for x in _main_rows_since(n2) if str(x.get("decision", "")).startswith("clarify:")]
    entry["evidence"]["model_saw"] = saw
    entry["evidence"]["server_requests"] = conn.server_requests[-3:]
    REPORT["latency_ms"]["clarify_respond_to_turn_complete"] = ms(t_done - t_ans)
    check(entry, done["payload"].get("outcome") == "completed", "turn completes after the automatic answer")
    check(entry, answer.split(" (")[0].lower() in json.dumps(saw).lower(),
          "the model received the automatic answer in the clarify tool result")
    await conn.close()


@scenario("28_steer_followup", required=False)
async def s_steer(entry: dict) -> None:
    """R-3: where a `session.steer` text lands, during a tool call and during a text-only stream."""
    conn = await open_conn()
    sid, _ = await _fresh_session(conn, "steer")
    # (a) Steer while a tool runs (terminal sleep 4).
    n0 = len(read_jsonl(FAKE_LOG))
    start_idx = len(conn.events)
    rcpt = await conn.rpc("prompt.submit", session_id=sid, submission_id=f"emp-st-{uuid.uuid4().hex[:6]}",
                          text="[[tool:steer]] start a slow command")
    _, ts = await conn.wait_event(lambda e: e.get("type") == "tool.start" and e.get("session_id") == sid, 30, start_idx)
    gen = ts.get("execution_generation")
    t0 = now()
    st, _ = await conn.call("session.steer", session_id=sid, execution_generation=gen, text="STEER-A also mention apples")
    entry["evidence"]["steer_during_tool_rpc"] = st.get("result") or st.get("error")
    entry["evidence"]["steer_during_tool_rpc_ms"] = ms(now() - t0)
    _, done = await conn.wait_event(is_complete_for(rcpt["admission_id"]), 60, start_idx)
    await asyncio.sleep(2)
    entry["evidence"]["during_tool_final_text"] = done["payload"].get("text")
    entry["evidence"]["during_tool_model_decisions"] = [x.get("decision", "")[:600] for x in _main_rows_since(n0)]
    entry["evidence"]["during_tool_extra_admissions"] = sorted(
        {str(e.get("admission_id")) for e in conn.session_events(sid) if e.get("type") == "message.start"}
        - {rcpt["admission_id"]})
    soft(entry, "steer:seen" in (done["payload"].get("text") or ""), "steer during a tool call reaches the same turn")
    # (b) Steer during a text-only stream (no tool boundary).
    n1 = len(read_jsonl(FAKE_LOG))
    start_idx = len(conn.events)
    rcpt2 = await conn.rpc("prompt.submit", session_id=sid, submission_id=f"emp-st2-{uuid.uuid4().hex[:6]}",
                           text="[[slow:4]] stream for a while")
    _, d = await conn.wait_event(lambda e: e.get("type") == "message.delta" and e.get("session_id") == sid
                                 and (e.get("payload") or {}).get("text"), 30, start_idx)
    st2, _ = await conn.call("session.steer", session_id=sid, execution_generation=d.get("execution_generation"),
                             text="STEER-B second thought")
    entry["evidence"]["steer_during_stream_rpc"] = st2.get("result") or st2.get("error")
    _, done2 = await conn.wait_event(is_complete_for(rcpt2["admission_id"]), 60, start_idx)
    await asyncio.sleep(4)
    rows = _main_rows_since(n1)
    entry["evidence"]["during_stream_final_text_tail"] = (done2["payload"].get("text") or "")[-120:]
    entry["evidence"]["during_stream_model_requests"] = [{"decision": x.get("decision", "")[:200],
                                                          "last_user": x.get("last_user", "")[:200]} for x in rows]
    entry["evidence"]["during_stream_steer_reached_model"] = any("STEER-B" in json.dumps(x) for x in rows)
    entry["evidence"]["during_stream_extra_admissions"] = sorted(
        {str(e.get("admission_id")) for e in conn.session_events(sid) if e.get("type") == "message.start"}
        - {rcpt["admission_id"], rcpt2["admission_id"]})
    # (c) Steer while idle.
    snap = await conn.rpc("session.resume", session_id=sid)
    st3, _ = await conn.call("session.steer", session_id=sid, execution_generation=snap.get("execution_generation") or 0,
                             text="STEER-C idle")
    entry["evidence"]["steer_while_idle"] = st3.get("result") or st3.get("error")
    await conn.close()


@scenario("29_graceful_stop_drain")
async def s_drain(entry: dict, gw: Gateway) -> None:
    """R-4: does `agent.restart_drain_timeout` let a running turn finish on a plain SIGTERM?"""
    # (label, drain seconds, text, also queue a second admission in the same session, stop budget s)
    variants = [("turn_shorter_than_drain", 45, "[[slow:6]] finish during the drain", False, 55),
                ("turn_longer_than_drain", 4, "[[slow:30]] outlive the drain", False, 55),
                ("short_turn_with_hermes_queue", 10, "[[slow:3]] finish, queue waits", True, 55)]
    try:
        for label, drain, text, with_queue, budget in variants:
            gw.stop()
            gw.start(extra_env={"HERMES_RESTART_DRAIN_TIMEOUT": str(drain)})
            conn = await open_conn()
            sid, _ = await _fresh_session(conn, f"drain-{label}")
            start_idx = len(conn.events)
            rcpt = await conn.rpc("prompt.submit", session_id=sid, submission_id=f"emp-dr-{uuid.uuid4().hex[:6]}",
                                  text=text)
            queued = None
            if with_queue:
                queued = await conn.rpc("prompt.submit", session_id=sid, submission_id=f"emp-drq-{uuid.uuid4().hex[:6]}",
                                        text="queued behind the draining turn")
            await conn.wait_event(lambda e: e.get("type") == "message.delta" and e.get("session_id") == sid
                                  and (e.get("payload") or {}).get("text"), 30, start_idx)
            t0 = now()
            assert gw.proc is not None
            gw.proc.send_signal(signal.SIGTERM)
            await asyncio.sleep(0.5)
            late: dict = {"error": "socket closed"}
            if conn.closed is None:
                try:
                    late, _ = await conn.call("prompt.submit", 5, session_id=sid,
                                              submission_id=f"emp-late-{uuid.uuid4().hex[:6]}",
                                              text="submitted during the drain")
                except Exception as exc:  # socket closing under us is an answer too
                    late = {"error": repr(exc)}
            complete = None
            try:
                t_c, complete = await conn.wait_event(is_complete_for(rcpt["admission_id"]), drain + 20, start_idx)
                complete_after: Any = ms(t_c - t0)
            except (TimeoutError, ConnectionError) as exc:
                complete_after = repr(exc)
            rc = await asyncio.to_thread(gw.proc.wait, drain + 60)
            stop_s = round(now() - t0, 3)
            shutdown_lines = [ln[:240] for f in sorted(HOME.glob("logs/**/*.log"))
                              for ln in f.read_text(errors="replace").splitlines()
                              if "Shutdown phase" in ln or "drain" in ln.lower()][-25:]
            viewer_close = conn.closed
            await conn.close()
            gw.start()
            conn = await open_conn()
            await conn.rpc("session.resume", session_id=sid)
            rec = await conn.rpc("prompt.receipt", session_id=sid, admission_id=rcpt["admission_id"], include_result=True)
            if rec.get("status") == "unknown":
                await conn.call("prompt.resolve_unknown", session_id=sid, admission_id=rcpt["admission_id"],
                                execution_generation=rec.get("execution_generation"))
            qrec = (await conn.rpc("prompt.receipt", session_id=sid, admission_id=queued["admission_id"])
                    if queued else {})
            await conn.close()
            result = rec.get("result") or {}
            entry["evidence"][label] = {
                "drain_s": drain, "stop_rc": rc, "stop_s": stop_s, "viewer_close": viewer_close,
                "live_complete_after_ms": complete_after,
                "live_complete": ({k: complete.get("payload", {}).get(k) for k in ("outcome", "status")}
                                  if complete else None),
                "submit_during_drain": late.get("error") or late.get("result"),
                "receipt": {k: rec.get(k) for k in ("status", "outcome")},
                "turn_exit_reason": result.get("turn_exit_reason"),
                "shutdown_log": shutdown_lines,
                "receipt_result_has_final_text": bool(result.get("final_response") or result.get("text")),
                "queued_receipt": {k: qrec.get(k) for k in ("status", "outcome")} if queued else None}
            check(entry, rec.get("status") == "terminal", f"{label}: receipt terminal after restart (never unknown)")
            # Recorded, not gated: see README "R-4" (the process lingers after a clean drain).
            soft(entry, stop_s < budget, f"{label}: gateway exits inside the {budget} s supervisor budget")
            wd = HOME / "logs" / "gateway-shutdown-watchdog.log"
            entry["evidence"][label]["watchdog_log_tail"] = wd.read_text(errors="replace")[-1500:] if wd.exists() else None
        short = entry["evidence"]["turn_shorter_than_drain"]
        entry["evidence"]["answer_drain_lets_turn_finish"] = short["receipt"].get("outcome") == "completed"
        check(entry, short["receipt"].get("outcome") == "completed",
              "R-4: a turn shorter than restart_drain_timeout completes on a plain SIGTERM")
        long = entry["evidence"]["turn_longer_than_drain"]
        check(entry, long["receipt"].get("outcome") == "interrupted",
              "R-4: a turn longer than restart_drain_timeout settles interrupted (D15 path)")
    finally:
        if gw.proc is not None and gw.proc.poll() is None:
            gw.stop()
        gw.start()


async def main() -> int:
    RESULTS.mkdir(parents=True, exist_ok=True)
    REPORT["meta"] = {"profile": PROFILE, "home": str(HOME), "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                      "websockets": __import__("websockets").__version__, "python": sys.version.split()[0]}
    gw = Gateway()
    started = gw.start()
    REPORT["meta"]["first_start"] = {"spawn_to_ready_s": started["spawn_to_ready_s"],
                                     "code_version": started["identify"]["result"].get("code_version"),
                                     "code_sha": started["identify"]["result"].get("code_sha")}
    REPORT["latency_ms"]["gateway_cold_spawn_to_ready"] = ms(started["spawn_to_ready_s"])
    await asyncio.sleep(3)
    REPORT["meta"]["rss_idle_after_start"] = rss_kib(gw.proc.pid)
    try:
        await s_identify(gw)
        await s_ws_negative()
        await s_connect()
        await s_create()
        await s_turns()
        await s_reasoning()
        await s_api_text()
        await s_tools()
        await s_interrupt()
        await s_queue()
        await s_compress()
        await s_replay()
        await s_parallel()
        await s_approval()
        await s_dotenv()
        await s_restart(gw)
        await s_legacy(gw)
        await s_fixtures()
        await s_compress_load()
        await s_replay_fixture()
        await s_kill9(gw)
        await s_finite()
        await s_goals()
        await s_env()
        REPORT["meta"]["rss_after_turns"] = rss_kib(gw.proc.pid)
        await s_cli_fallback()
        await s_default_gw(gw)
        await s_clarify()
        await s_steer()
        await s_drain(gw)
    finally:
        try:
            REPORT["meta"]["final_stop"] = gw.stop()
        except Exception as exc:
            REPORT["meta"]["final_stop"] = repr(exc)
        out = RESULTS / "probe-report.json"
        out.write_text(json.dumps(REPORT, indent=2, default=str))
        log("report:", out)
    failed = [n for n, s in REPORT["scenarios"].items() if s["required"] and not s["ok"]]
    log("required failures:", failed or "none")
    log("latency_ms:", json.dumps(REPORT["latency_ms"], indent=1))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
