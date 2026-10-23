"""Bridge 0.9 contract suite (design 0.9 §9.1): ``python -m emperor_bridge`` against real Hermes
v0.22.4 gateways, the fake model (fake_llm.py) and the fake Emperor API (emperor_echo.py).

Runs inside the contract image after run_contract.sh started the fakes (CONTRACT_SUITE=bridge|all).
Each scenario sets up its own profiles, gateways and bridge process, drives Emperor messages through
``/__fake/*`` and asserts only what is observable from outside the bridge: Emperor API calls, the
fake model's request log, the bridge state file, turn files and the gateway.

Entry points used (design §5.1, §5.7, §7): ``python -m emperor_bridge run [--profiles a,b]`` with
``HERMES_PROFILE``, ``EMPEROR_CLAW_HERMES_GATEWAY=standalone|shared|managed``, ``HERMES_PYTHON``,
``HERMES_CHECKOUT``; ``python -m emperor_bridge healthcheck``; state v2 at
``<profile_home>/emperor/bridge-state.json``; turn files at ``<profile_home>/emperor/turns/``.
While the package is missing every scenario is SKIPPED with the reason (exit 0), unless
``BRIDGE_CONTRACT_REQUIRE=1`` (CI), which turns a skip into a failure.

Env: BRIDGE_ONLY=name,name (subset), BRIDGE_PATH (default /opt/emperor-claw-plugin/bridge),
HERMES_PY, HERMES_REPO, FAKE_LLM_URL, EMPEROR_ECHO_URL, PROBE_RESULTS_DIR.
Report: $PROBE_RESULTS_DIR/bridge-report.json, logs under $PROBE_RESULTS_DIR/bridge/.
"""
from __future__ import annotations

import ctypes
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

RESULTS = Path(os.environ.get("PROBE_RESULTS_DIR", "/results"))
LOGS = RESULTS / "bridge"
BRIDGE_PATH = Path(os.environ.get("BRIDGE_PATH", "/opt/emperor-claw-plugin/bridge"))
PLUGIN_SRC = Path(os.environ.get("EMPEROR_PLUGIN_SRC", "/opt/emperor-claw-plugin"))
HERMES_PY = os.environ.get("HERMES_PY", "python3")
HERMES_REPO = os.environ.get("HERMES_REPO", str(Path.home() / ".hermes" / "hermes-agent"))
HERMES = os.environ.get("HERMES_BIN", "hermes")
HERMES_HOME = Path.home() / ".hermes"
FAKE_LLM_URL = os.environ.get("FAKE_LLM_URL", "http://127.0.0.1:8765/v1")
EMPEROR_URL = os.environ.get("EMPEROR_ECHO_URL", "http://127.0.0.1:8799")
FAKE_LLM_LOG = Path(os.environ.get("FAKE_LLM_LOG", RESULTS / "fake_llm_requests.jsonl"))
SLOW_AUX_FLAG = Path(os.environ.get("FAKE_LLM_SLOW_AUX_FLAG", "/tmp/fake_llm_slow_aux"))
REQUIRE = os.environ.get("BRIDGE_CONTRACT_REQUIRE") == "1"
ONLY = {s.strip() for s in os.environ.get("BRIDGE_ONLY", "").split(",") if s.strip()}
PINNED_VERSION = "0.22.4"
PASSTHROUGH = ["EMPEROR_THREAD_ID", "EMPEROR_THREAD_TYPE", "EMPEROR_SESSION_GEN", "EMPEROR_AGENT_ID",
               "EMPEROR_PROFILE_HOME"]
REPORT: Dict[str, Any] = {"meta": {}, "scenarios": {}}


class Skip(Exception):
    """The scenario cannot run yet (a workstream has not landed); the message says which."""


def log(*a: Any) -> None:
    print("[bridge-contract]", *a, flush=True)


def now() -> float:
    return time.monotonic()


def wait_for(pred: Callable[[], Any], timeout: float, what: str, interval: float = 0.2) -> Any:
    deadline = now() + timeout
    while True:
        value = pred()
        if value:
            return value
        if now() >= deadline:
            raise AssertionError(f"timed out after {timeout:.0f}s waiting for {what}")
        time.sleep(interval)


def read_jsonl(path: Path) -> List[dict]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text(errors="replace").splitlines():
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    return out


# ── fake Emperor client ──────────────────────────────────────────────────────────────────────


def fake(path: str, body: Optional[dict] = None) -> Any:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(EMPEROR_URL + path, data=data, method="POST" if body is not None else "GET",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as res:
        return json.loads(res.read() or b"null")


def state() -> dict:
    return fake("/__fake/state")


def inject(agent_id: str, text: str, thread_id: Optional[str] = None, **extra: Any) -> dict:
    return fake("/__fake/messages", {"agentId": agent_id, "text": text, "threadId": thread_id or str(uuid.uuid4()),
                                     **extra})


def reply_thread(r: dict) -> Optional[str]:
    return r.get("threadId") or r.get("thread_id")


def replies_to(msg_id: str, st: Optional[dict] = None) -> List[dict]:
    st = st or state()
    return [r for r in st["replies"] if r.get("replyToMessageId") == msg_id
            or msg_id in (r.get("alsoResolvesMessageIds") or [])]


def final_replies_to(msg_id: str, st: Optional[dict] = None) -> List[dict]:
    """Replies that answer the message (acknowledgements from the plugin excluded)."""
    return [r for r in replies_to(msg_id, st) if not (r.get("acknowledge") or r.get("ack"))]


def run_for(msg_id: str, st: Optional[dict] = None) -> Optional[dict]:
    st = st or state()
    for run in st["runs"].values():
        trig = run.get("triggerMessageId") or run.get("trigger_message_id")
        if trig == msg_id or msg_id in (run.get("messageIds") or []):
            return run
    return None


def events_of(run: Optional[dict], st: Optional[dict] = None) -> List[dict]:
    if not run:
        return []
    st = st or state()
    return st["events"].get(run["id"], [])


def kinds(evs: List[dict]) -> List[str]:
    return [e.get("kind") for e in evs]


def run_status(run: Optional[dict]) -> Optional[str]:
    return (run or {}).get("status")


def llm_rows_since(n0: int) -> List[dict]:
    return read_jsonl(FAKE_LLM_LOG)[n0:]


def llm_count() -> int:
    return len(read_jsonl(FAKE_LLM_LOG))


# ── profiles, gateways, bridge processes ─────────────────────────────────────────────────────


class Profile:
    def __init__(self, name: str, *, standalone: bool = True, drain: int = 45, extra_cfg: str = "") -> None:
        self.name = name
        self.home = HERMES_HOME / "profiles" / name
        self.agent_id = f"agent-{name}-{uuid.uuid4().hex[:6]}"
        self.token = f"tok-{name}-{uuid.uuid4().hex[:10]}"
        self.standalone = standalone
        self.drain = drain
        self.extra_cfg = extra_cfg

    def setup(self) -> "Profile":
        if self.home.exists():
            shutil.rmtree(self.home)
        subprocess.run([HERMES, "profile", "create", self.name], capture_output=True, text=True, timeout=120)
        (self.home / "plugins").mkdir(parents=True, exist_ok=True)
        passthrough = "".join(f"    - {k}\n" for k in PASSTHROUGH)
        (self.home / "config.yaml").write_text(
            "model:\n  provider: custom\n"
            f"  base_url: {FAKE_LLM_URL}\n  default: fake-model\n  context_length: 128000\n  key_env: FAKE_MODEL_KEY\n"
            "agent:\n  api_max_retries: 1\n  reasoning_effort: none\n"
            f"  restart_drain_timeout: {self.drain}\n"
            f"gateway:\n  standalone: {'true' if self.standalone else 'false'}\n  unmanaged_idle_exit_seconds: 0\n"
            "approvals:\n  timeout: 60\n"
            "auxiliary:\n  title_generation:\n    enabled: false\n"
            "tools:\n  tool_search:\n    enabled: off\n"
            f"terminal:\n  client_env_passthrough:\n{passthrough}"
            "telemetry:\n  shared_metrics:\n    enabled: false\n    send: false\n" + self.extra_cfg)
        self.write_env()
        dst = self.home / "plugins" / "emperor-claw"
        shutil.copytree(PLUGIN_SRC, dst, ignore=shutil.ignore_patterns("__pycache__", "bridge"))
        subprocess.run([HERMES, "-p", self.name, "plugins", "enable", "emperor-claw"], capture_output=True,
                       timeout=120, stdin=subprocess.DEVNULL)
        fake("/__fake/agents", {"agents": [{"token": self.token, "agentId": self.agent_id, "name": self.name}]})
        return self

    def write_env(self, **override: str) -> None:
        values = {"FAKE_MODEL_KEY": "sk-fake", "EMPEROR_CLAW_API_URL": EMPEROR_URL,
                  "EMPEROR_CLAW_API_TOKEN": self.token, "EMPEROR_CLAW_AGENT_ID": self.agent_id,
                  "EMPEROR_CLAW_AGENT_NAME": self.name, "MCP_EMPERORCLAW_API_KEY": self.token, **override}
        path = self.home / ".env"
        path.write_text("".join(f"{k}={v}\n" for k, v in values.items()))
        path.chmod(0o600)

    @property
    def state_path(self) -> Path:
        return self.home / "emperor" / "bridge-state.json"

    def bridge_state(self) -> dict:
        try:
            return json.loads(self.state_path.read_text())
        except (OSError, ValueError):
            return {}


def control(home: Path, verb: str, params: Optional[dict] = None, timeout: float = 5.0) -> dict:
    path = home / "gateway.sock"
    redirect = home / "gateway.sock.path"
    if redirect.exists():
        path = Path(redirect.read_text().strip())
    req: Dict[str, Any] = {"protocol": 1, "verb": verb, "id": 1}
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


def identify(home: Path) -> Optional[dict]:
    try:
        r = control(home, "identify")
    except (OSError, ValueError):
        return None
    res = r.get("result") or {}
    return res if r.get("ok") and res.get("state") == "ready" else None


def clean_env() -> Dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k not in ("PYTHONPATH", "VIRTUAL_ENV")}
    for k in list(env):  # the bridge must read each profile's .env itself (D8), never the process env
        if k.startswith("EMPEROR_CLAW_"):
            env.pop(k)
    return env


class Gateway:
    """A gateway this suite owns (standalone: one profile; shared: the default home)."""

    def __init__(self, label: str, profile: Optional[Profile] = None) -> None:
        self.label = label
        self.profile = profile
        self.home = profile.home if profile else HERMES_HOME
        self.proc: Optional[subprocess.Popen] = None
        self.starts = 0

    def start(self, timeout: float = 120) -> dict:
        self.starts += 1
        cmd = [HERMES] + (["-p", self.profile.name] if self.profile else []) + ["gateway", "run", "--replace"]
        logf = open(LOGS / f"{self.label}-gateway-{self.starts}.log", "w")
        # HERMES_TEST_ISOLATION=1 (§9.1): Hermes raises on contract violations instead of logging.
        # It also refuses any state.db under ~/.hermes ("live-system guard"); this container's
        # ~/.hermes is disposable, so that one guard is bypassed explicitly.
        env = {**clean_env(), "HERMES_TEST_ISOLATION": "1", "HERMES_STATE_DB_GUARD_BYPASS": "1"}
        self.proc = subprocess.Popen(cmd, stdout=logf, stderr=subprocess.STDOUT, env=env, start_new_session=True)
        ident = wait_for(lambda: self.proc.poll() is None and identify(self.home) or
                         (self.proc.poll() is not None and {"exited": self.proc.returncode}),
                         timeout, f"{self.label} gateway ready")
        if "exited" in ident:
            raise AssertionError(f"{self.label} gateway exited rc={ident['exited']} before ready")
        return ident

    def stop(self, sig: int = signal.SIGTERM, timeout: float = 90) -> Optional[int]:
        if not self.proc or self.proc.poll() is not None:
            return None
        self.proc.send_signal(sig)
        try:
            return self.proc.wait(timeout)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            return self.proc.wait(10)


class Bridge:
    def __init__(self, label: str, profiles: List[Profile], topology: str = "standalone",
                 env: Optional[Dict[str, str]] = None) -> None:
        self.label = label
        self.profiles = profiles
        self.topology = topology
        self.env = env or {}
        self.proc: Optional[subprocess.Popen] = None
        self.starts = 0

    @property
    def log_path(self) -> Path:
        return LOGS / f"{self.label}-bridge-{self.starts}.log"

    def start(self) -> "Bridge":
        self.starts += 1
        env = {**clean_env(), "PYTHONPATH": str(BRIDGE_PATH), "HERMES_PYTHON": HERMES_PY,
               "HERMES_CHECKOUT": HERMES_REPO, "EMPEROR_CLAW_HERMES_GATEWAY": self.topology,
               "HERMES_PROFILE": self.profiles[0].name, "EMPEROR_CLAW_HERMES_EVENT_FLUSH_MS": "200",
               "PYTHONUNBUFFERED": "1",
               "EMPEROR_CLAW_HERMES_TOOLSETS": "emperor-claw,web,terminal,code_execution,file", **self.env}
        cmd = [HERMES_PY, "-m", "emperor_bridge", "run"]
        if len(self.profiles) > 1:
            cmd += ["--profiles", ",".join(p.name for p in self.profiles)]
        self.proc = subprocess.Popen(cmd, stdout=open(self.log_path, "w"), stderr=subprocess.STDOUT, env=env,
                                     start_new_session=True)
        return self

    def wait_registered(self, timeout: float = 60) -> List[dict]:
        ids = {p.agent_id for p in self.profiles}
        return wait_for(lambda: self._alive() and (lambda regs: regs if {r["agentId"] for r in regs} >= ids else None)(
            [r for r in state()["registers"] if r["agentId"] in ids]), timeout, f"{self.label} bridge registration")

    def _alive(self) -> bool:
        if self.proc and self.proc.poll() is not None:
            raise AssertionError(f"{self.label} bridge exited rc={self.proc.returncode}: {self.tail()}")
        return True

    def tail(self, n: int = 1500) -> str:
        try:
            return self.log_path.read_text(errors="replace")[-n:]
        except OSError:
            return ""

    def log_text(self) -> str:
        return "".join(p.read_text(errors="replace") for p in sorted(LOGS.glob(f"{self.label}-bridge-*.log")))

    def stop(self, sig: int = signal.SIGTERM, timeout: float = 60) -> Optional[int]:
        if not self.proc or self.proc.poll() is not None:
            return self.proc.returncode if self.proc else None
        self.proc.send_signal(sig)
        try:
            return self.proc.wait(timeout)
        except subprocess.TimeoutExpired:
            os.killpg(self.proc.pid, signal.SIGKILL)
            self.proc.wait(10)
            return None


def drop_tcp_connections(pid: int, port: int) -> int:
    """Shut down every TCP socket ``pid`` holds to 127.0.0.1:``port`` (a WiFi-drop stand-in).

    Uses pidfd_getfd(2) to borrow the bridge's sockets (the bridge is our child, so ptrace access is
    allowed) and shutdown(2) them, which closes the connection for both ends without touching the
    gateway. Returns how many were dropped; raises Skip where the syscall is not permitted."""
    inodes = set()
    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            for line in Path(f"/proc/{pid}/net/{Path(table).name}").read_text().splitlines()[1:]:
                f = line.split()
                if int(f[2].split(":")[1], 16) == port and f[3] == "01":  # remote port, ESTABLISHED
                    inodes.add(f[9])
        except OSError:
            pass
    libc = ctypes.CDLL(None, use_errno=True)
    pidfd = os.pidfd_open(pid)
    dropped = 0
    try:
        for fd_link in Path(f"/proc/{pid}/fd").iterdir():
            try:
                target = os.readlink(fd_link)
            except OSError:
                continue
            m = re.match(r"socket:\[(\d+)\]", target)
            if not m or m.group(1) not in inodes:
                continue
            local = libc.syscall(438, pidfd, int(fd_link.name), 0)  # SYS_pidfd_getfd (x86_64 and arm64)
            if local < 0:
                raise Skip(f"pidfd_getfd not permitted here (errno {ctypes.get_errno()})")
            s = socket.socket(fileno=local)
            try:
                s.shutdown(socket.SHUT_RDWR)
                dropped += 1
            finally:
                s.close()
    finally:
        os.close(pidfd)
    return dropped


# ── scenario plumbing ────────────────────────────────────────────────────────────────────────

SCENARIOS: List[tuple] = []
CLEANUP: List[Callable[[], Any]] = []


def scenario(name: str, required: bool = True):
    def deco(fn):
        SCENARIOS.append((name, required, fn))
        return fn
    return deco


def check(entry: dict, cond: Any, label: str) -> None:
    entry.setdefault("checks", {})[label] = bool(cond)
    if not cond:
        raise AssertionError(label)


def soft(entry: dict, cond: Any, label: str) -> None:
    entry.setdefault("checks", {})[label] = bool(cond)


def standalone_stack(entry: dict, label: str, n_profiles: int = 1, bridge_env: Optional[Dict[str, str]] = None,
                     drain: int = 45) -> tuple:
    """Profiles + one standalone gateway each + one bridge hosting all of them, registered."""
    profiles = [Profile(f"bc-{label[:10]}-{i}", drain=drain).setup() for i in range(n_profiles)]
    gateways = [Gateway(f"{label}-{i}", p) for i, p in enumerate(profiles)]
    for g in gateways:
        g.start()
        CLEANUP.append(g.stop)
    bridge = Bridge(label, profiles, "standalone", bridge_env).start()
    CLEANUP.append(bridge.stop)
    entry["evidence"]["register"] = bridge.wait_registered()
    return profiles, gateways, bridge


def turn(profile: Profile, text: str, thread_id: Optional[str] = None, timeout: float = 45, **extra: Any) -> dict:
    msg = inject(profile.agent_id, text, thread_id, **extra)
    rep = wait_for(lambda: final_replies_to(msg["id"]), timeout, f"reply to {text[:30]!r}")
    run = wait_for(lambda: (lambda r: r if run_status(r) not in (None, "running") else None)(run_for(msg["id"])),
                   20, f"run settled for {text[:30]!r}")
    return {"msg": msg, "replies": rep, "run": run, "events": events_of(run)}


# ── scenarios (design §9.1) ─────────────────────────────────────────────────────────────────


@scenario("identify_ticket_connect")
def s_identify(entry: dict) -> None:
    profiles, gws, bridge = standalone_stack(entry, "identify")
    reg = entry["evidence"]["register"][-1]
    check(entry, str(reg.get("hermesVersion")) == PINNED_VERSION, "register reports hermesVersion == identify.code_version")
    check(entry, reg.get("gatewayTopology") == "standalone", "register reports gatewayTopology standalone")
    check(entry, str(reg.get("bridgeVersion", "")).startswith("0.9"), "register reports bridge 0.9.x")
    r = turn(profiles[0], "hello")
    check(entry, r["replies"][0]["text"].startswith("pong: hello"), "first turn answered through the gateway")
    hc = subprocess.run([HERMES_PY, "-m", "emperor_bridge", "healthcheck"], capture_output=True, text=True, timeout=30,
                        env={**clean_env(), "PYTHONPATH": str(BRIDGE_PATH), "HERMES_PROFILE": profiles[0].name})
    entry["evidence"]["healthcheck"] = {"rc": hc.returncode, "out": (hc.stdout + hc.stderr)[-500:]}
    check(entry, hc.returncode == 0, "python -m emperor_bridge healthcheck exits 0 while healthy")


@scenario("create_idempotent")
def s_create_idempotent(entry: dict) -> None:
    profiles, _, _ = standalone_stack(entry, "createidem")
    p = profiles[0]
    thread = str(uuid.uuid4())
    turn(p, "one", thread)
    first = p.bridge_state().get("threads", {}).get(thread, {})
    turn(p, "two", thread)
    second = p.bridge_state().get("threads", {}).get(thread, {})
    entry["evidence"]["thread_state"] = {k: second.get(k) for k in ("generation", "sessionId", "policyHash")}
    check(entry, first.get("sessionId") and first.get("sessionId") == second.get("sessionId"),
          "same thread -> same Hermes session")
    rid = (second.get("createParams") or {}).get("request_id", "")
    check(entry, rid == f"emperor/{p.agent_id}/{thread}/g{second.get('generation')}",
          "request_id = emperor/<agentId>/<threadId>/g<generation> (D4)")
    check(entry, (second.get("createParams") or {}).get("source") == "tool", "createParams.source == tool")


@scenario("simple_turn")
def s_simple(entry: dict) -> None:
    profiles, _, _ = standalone_stack(entry, "simple")
    t0 = time.time()
    r = turn(profiles[0], "ping simple")
    reply, run, evs = r["replies"][0], r["run"], r["events"]
    entry["evidence"].update(reply={k: reply.get(k) for k in ("text", "idempotencyKey", "replyToMessageId")},
                             run=run, event_kinds=kinds(evs), reply_after_s=round(time.time() - t0, 2))
    check(entry, len(r["replies"]) == 1, "exactly one reply")
    check(entry, reply.get("idempotencyKey") == f"emp-{r['msg']['id']}", "reply Idempotency-Key = emp-<messageId> (D5)")
    check(entry, run_status(run) in ("completed", "succeeded"), "run finished completed")
    check(entry, "turn.started" in kinds(evs) and "turn.completed" in kinds(evs), "turn.started + turn.completed events")
    check(entry, run.get("model") == "fake-model", "ledger model from prompt.receipt.result (D16)")
    check(entry, (run.get("apiCalls") or 0) >= 1, "ledger apiCalls from receipt result")
    check(entry, "text_response" in str(run.get("exitReason")), "ledger exitReason = turn_exit_reason")
    seqs = [e.get("seq") for e in evs]
    check(entry, seqs == sorted(set(seqs)), "event seq strictly increasing, no duplicates")
    soft(entry, time.time() - t0 < 5, "reply within 5 s on the fake model")


@scenario("tool_events")
def s_tools(entry: dict) -> None:
    profiles, _, _ = standalone_stack(entry, "tools")
    r = turn(profiles[0], "[[tool:read]] read the hostname")
    evs = r["events"]
    start = next((e for e in evs if e.get("kind") == "tool.start"), None)
    end = next((e for e in evs if e.get("kind") == "tool.end"), None)
    entry["evidence"].update(tool_start=start, tool_end=end)
    check(entry, start and start.get("toolName") == "read_file", "tool.start with toolName read_file")
    check(entry, end and end.get("status") == "ok" and isinstance(end.get("durationMs"), int), "tool.end ok with durationMs")
    check(entry, not any("args" in (e.get("data") or {}) for e in evs), "no tool args stored (§4.3)")
    check(entry, all(len(str(e.get("summary") or "")) <= 500 for e in evs), "summaries capped")


@scenario("plugin_ack_via_turn_file")
def s_ack(entry: dict) -> None:
    profiles, _, _ = standalone_stack(entry, "ack")
    p = profiles[0]
    thread = str(uuid.uuid4())
    msg = inject(p.agent_id, "[[tool:ack]] take a while", thread)
    acks = wait_for(lambda: [r for r in replies_to(msg["id"]) if (r.get("acknowledge") or r.get("ack"))] or
                    [r for r in state()["replies"] if (r.get("acknowledge") or r.get("ack")) and reply_thread(r) == thread],
                    45, "plugin acknowledgement")
    ack = acks[0]
    entry["evidence"]["ack"] = ack
    check(entry, ack.get("replyToMessageId") == msg["id"], "plugin ack replies to the triggering message (turn file)")
    check(entry, reply_thread(ack) == thread, "plugin ack lands in the triggering thread")
    log_rows = [x for x in read_jsonl(RESULTS / "emperor_echo_requests.jsonl")
                if x["path"].startswith("/api/mcp/messages/send") and ('"ack"' in x["body"] or "acknowledge" in x["body"])]
    check(entry, log_rows and log_rows[-1]["authorization"] == f"Bearer {p.token}",
          "plugin used the profile .env token (per-session credentials, D8)")
    wait_for(lambda: final_replies_to(msg["id"]), 45, "final reply")
    wait_for(lambda: not (p.home / "emperor" / "turns" / f"{thread}.json").exists(), 10, "turn file deleted after settle")


@scenario("reasoning_on")
def s_reasoning(entry: dict) -> None:
    profiles, _, _ = standalone_stack(entry, "reason")
    r = turn(profiles[0], "[[reason]] think first")
    rs = [e for e in r["events"] if e.get("kind") == "reasoning"]
    entry["evidence"]["reasoning_events"] = rs
    check(entry, rs and "fake chain of thought" in json.dumps(rs), "reasoning event forwarded (show_reasoning on, D12)")


@scenario("interrupt")
def s_interrupt(entry: dict) -> None:
    profiles, _, _ = standalone_stack(entry, "interrupt")
    p = profiles[0]
    msg = inject(p.agent_id, "[[slow:30]] long answer")
    wait_for(lambda: "turn.started" in kinds(events_of(run_for(msg["id"]))), 30, "turn.started")
    t0 = now()
    fake("/__fake/control", {"agentId": p.agent_id, "action": "stop", "messageId": msg["id"]})
    run = wait_for(lambda: (lambda r: r if run_status(r) not in (None, "running") else None)(run_for(msg["id"])),
                   15, "run settled after stop")
    entry["evidence"].update(run=run, stop_to_settled_s=round(now() - t0, 2), events=kinds(events_of(run)))
    check(entry, run_status(run) == "cancelled", "stop -> run cancelled (D10)")
    check(entry, now() - t0 < 3 + 2, "cancelled within ~3 s (+2 s poll slack)")
    check(entry, "turn.interrupted" in kinds(events_of(run)), "turn.interrupted event")
    r2 = turn(p, "after stop", msg["threadId"])
    check(entry, r2["replies"][0]["text"].startswith("pong: after stop"), "thread usable after a stop")


@scenario("parallel_threads")
def s_parallel(entry: dict) -> None:
    profiles, _, _ = standalone_stack(entry, "parallel", bridge_env={"EMPEROR_CLAW_HERMES_MAX_PARALLEL_TURNS": "3"})
    p = profiles[0]
    msgs = [inject(p.agent_id, f"[[slow:4]] thread {i}") for i in range(3)]
    for m in msgs:
        wait_for(lambda m=m: final_replies_to(m["id"]), 60, "parallel reply")
    st = state()
    windows = []
    for m in msgs:
        evs = events_of(run_for(m["id"], st), st)
        ts = {e["kind"]: e["ts"] for e in evs if e.get("kind") in ("turn.started", "turn.completed")}
        windows.append((ts.get("turn.started"), ts.get("turn.completed")))
    entry["evidence"]["windows"] = windows
    overlap = all(w[0] and w[1] for w in windows) and max(w[0] for w in windows) < min(w[1] for w in windows)
    check(entry, overlap, "three threads ran concurrently (cap 3)")


@scenario("coalesce")
def s_coalesce(entry: dict) -> None:
    profiles, _, _ = standalone_stack(entry, "coalesce")
    p = profiles[0]
    thread = str(uuid.uuid4())
    first = inject(p.agent_id, "[[slow:4]] first", thread)
    wait_for(lambda: "turn.started" in kinds(events_of(run_for(first["id"]))), 30, "first turn started")
    second = inject(p.agent_id, "second", thread)
    third = inject(p.agent_id, "third", thread)
    wait_for(lambda: final_replies_to(third["id"]), 60, "reply covering the follow-ups")
    time.sleep(2)
    st = state()
    thread_replies = [r for r in st["replies"] if reply_thread(r) == thread and not (r.get("acknowledge") or r.get("ack"))]
    covering = final_replies_to(third["id"], st)
    entry["evidence"].update(replies=[{k: r.get(k) for k in ("text", "replyToMessageId", "alsoResolvesMessageIds",
                                                              "idempotencyKey")} for r in thread_replies])
    check(entry, len(thread_replies) == 2, "two replies for three messages (follow-ups coalesced)")
    check(entry, second["id"] in (covering[0].get("alsoResolvesMessageIds") or []) or
          covering[0].get("replyToMessageId") == second["id"], "coalesced reply resolves the middle message")
    check(entry, covering[0].get("idempotencyKey") == f"emp-{third['id']}", "coalesced submission id = last message id (D5)")


@scenario("ws_drop_replay")
def s_ws_drop(entry: dict) -> None:
    profiles, gws, bridge = standalone_stack(entry, "wsdrop")
    p = profiles[0]
    msg = inject(p.agent_id, "[[slow:8]] survive a drop")
    wait_for(lambda: "turn.started" in kinds(events_of(run_for(msg["id"]))), 30, "turn.started")
    port = int(identify(p.home)["api_origin"].rsplit(":", 1)[1].split("/")[0])
    dropped = drop_tcp_connections(bridge.proc.pid, port)
    entry["evidence"]["sockets_dropped"] = dropped
    check(entry, dropped >= 1, "dropped the bridge's gateway sockets")
    wait_for(lambda: final_replies_to(msg["id"]), 60, "reply after the drop")
    time.sleep(2)
    st = state()
    run = run_for(msg["id"], st)
    evs = events_of(run, st)
    entry["evidence"].update(run_status=run_status(run), kinds=kinds(evs))
    check(entry, len(final_replies_to(msg["id"], st)) == 1, "exactly one reply (no duplicate after replay)")
    check(entry, run_status(run) in ("completed", "succeeded"), "turn kept running in Hermes and completed")
    check(entry, "turn.completed" in kinds(evs), "turn.completed recovered via session.events.since (D14)")


@scenario("gateway_restart_unknown")
def s_restart_unknown(entry: dict) -> None:
    """Tool-free turn lost to a gateway SIGKILL: resolve_unknown, then one automatic retry (-r1)."""
    profiles, gws, bridge = standalone_stack(entry, "restartunk")
    p, gw = profiles[0], gws[0]
    key = uuid.uuid4().hex[:8]
    msg = inject(p.agent_id, f"[[hangonce:{key}]] retry me")
    wait_for(lambda: "turn.started" in kinds(events_of(run_for(msg["id"]))), 30, "turn.started")
    time.sleep(1)
    gw.stop(signal.SIGKILL)
    gw.start()
    reps = wait_for(lambda: final_replies_to(msg["id"]), 90, "reply after the automatic retry")
    entry["evidence"]["replies"] = [{k: r.get(k) for k in ("text", "idempotencyKey")} for r in reps]
    check(entry, len(reps) == 1, "exactly one reply")
    check(entry, str(reps[0].get("idempotencyKey", "")).endswith("-r1"), "the retry used submission id -r1 (D15)")
    check(entry, "resolve_unknown" in bridge.log_text() or "unknown" in bridge.log_text(),
          "bridge took the restart path (logged)")


@scenario("sigkill_resolve_unknown")
def s_sigkill_tool(entry: dict) -> None:
    """A turn that already ran a tool is never auto-retried: restart notice + run failed, FIFO unpaused."""
    profiles, gws, bridge = standalone_stack(entry, "sigkilltool")
    p, gw = profiles[0], gws[0]
    thread = str(uuid.uuid4())
    # A unique marker: the probe suite shares the fake model's log and sends its own "then die".
    marker = f"then die {uuid.uuid4().hex[:8]}"
    msg = inject(p.agent_id, f"[[tool:thenhang]] {marker}", thread)
    wait_for(lambda: "tool.end" in kinds(events_of(run_for(msg["id"]))), 30, "tool.end before the kill")
    time.sleep(1)
    gw.stop(signal.SIGKILL)
    gw.start()
    run = wait_for(lambda: (lambda r: r if run_status(r) not in (None, "running") else None)(run_for(msg["id"])),
                   60, "run settled after restart")
    entry["evidence"]["run"] = run
    check(entry, run_status(run) == "failed", "run failed (no auto-retry after a tool)")
    check(entry, "runtime_restart" in json.dumps(run), "failure reason runtime_restart")
    check(entry, sum(1 for x in read_jsonl(FAKE_LLM_LOG) if marker in x.get("last_user", "")
                     and x.get("decision") == "thenhang:tool") == 1, "the model call was not repeated")
    r2 = turn(p, "next after kill", thread, timeout=60)
    check(entry, "pong: next after kill" in r2["replies"][0]["text"],
          "next message in the thread runs (prompt.resolve_unknown unpaused the FIFO)")


@scenario("emperor_outage")
def s_outage(entry: dict) -> None:
    profiles, _, _ = standalone_stack(entry, "outage")
    p = profiles[0]
    msg = inject(p.agent_id, "[[slow:3]] during an outage")
    wait_for(lambda: "turn.started" in kinds(events_of(run_for(msg["id"]))), 30, "turn.started")
    fake("/__fake/outage", {"on": True, "status": 503})
    try:
        time.sleep(8)
        check(entry, not final_replies_to(msg["id"]), "nothing delivered during the outage")
    finally:
        fake("/__fake/outage", {"on": False})
    wait_for(lambda: final_replies_to(msg["id"]), 60, "reply after the outage")
    time.sleep(3)
    st = state()
    run = run_for(msg["id"], st)
    evs = events_of(run, st)
    seqs = [e.get("seq") for e in evs]
    entry["evidence"].update(run_status=run_status(run), seqs=seqs, refusals=st["counters"].get("outage_refusals"))
    check(entry, len(final_replies_to(msg["id"], st)) == 1, "reply delivered exactly once from the spool/outbox")
    check(entry, run_status(run) in ("completed", "succeeded"), "ledger finished after the outage")
    check(entry, seqs == list(range(seqs[0], seqs[0] + len(seqs))) if seqs else False, "no event gaps after the outage")


@scenario("post_reply_compaction")
def s_compaction(entry: dict) -> None:
    profiles, _, _ = standalone_stack(entry, "compact", bridge_env={"EMPEROR_CLAW_HERMES_COMPACT_AFTER_TOKENS": "50"})
    p = profiles[0]
    thread = str(uuid.uuid4())
    for i in range(3):
        turn(p, f"fill context {i} " + "x" * 400, thread)
    n0 = llm_count()
    r = turn(p, "trigger compaction", thread)
    t_reply = r["replies"][0]["t"]
    aux = wait_for(lambda: [x for x in llm_rows_since(n0) if x.get("kind") == "aux"], 30, "compression aux call")
    st = state()
    comp = [e for evs in st["events"].values() for e in evs if str(e.get("kind", "")).startswith("compaction.")]
    entry["evidence"].update(compaction_events=comp, reply_at=t_reply)
    check(entry, aux, "compress ran after the reply (aux summary call)")
    check(entry, {"compaction.start", "compaction.end"} <= set(kinds(comp)), "compaction.start/end events")
    r2 = turn(p, "after compaction", thread)
    check(entry, r2["replies"][0]["text"].startswith("pong: after compaction"), "thread usable after compaction")


@scenario("compress_on_maintenance_socket")
def s_compress_socket(entry: dict) -> None:
    profiles, _, bridge = standalone_stack(entry, "maintsock", bridge_env={"EMPEROR_CLAW_HERMES_COMPACT_AFTER_TOKENS": "50"})
    p = profiles[0]
    thread = str(uuid.uuid4())
    for i in range(4):  # keep_last 6 (D13): compress needs more than 6 messages
        turn(p, f"warm {i} " + "y" * 400, thread)
    SLOW_AUX_FLAG.write_text("4")
    try:
        n0 = llm_count()
        turn(p, "trigger slow compress", thread)
        wait_for(lambda: [x for x in llm_rows_since(n0) if x.get("kind") == "aux"], 30, "slow compress started")
        r = turn(p, "submitted during compress", thread, timeout=60)
    finally:
        SLOW_AUX_FLAG.unlink(missing_ok=True)
    spans = [float(m.group(1)) for m in re.finditer(r"prompt\.submit[^\n]*?ws=turns[^\n]*?(?:ms|dur_ms)=(\d+(?:\.\d+)?)",
                                                    bridge.log_text())]
    entry["evidence"].update(submit_rpc_ms=spans[-5:], reply=r["replies"][0]["text"])
    check(entry, r["replies"][0]["text"].startswith("pong: submitted during compress"), "submit during compress answered")
    check(entry, spans, "timing log has prompt.submit spans tagged ws=turns (§5.8)")
    check(entry, spans[-1] < 100, "prompt.submit RPC < 100 ms while compress runs on the maintenance socket (D9)")


@scenario("create_replay_identical")
def s_replay_identical(entry: dict) -> None:
    profiles, _, bridge = standalone_stack(entry, "replayid")
    p = profiles[0]
    thread = str(uuid.uuid4())
    turn(p, "before bridge restart", thread)
    before = p.bridge_state()["threads"][thread]
    bridge.stop()
    bridge.start()
    bridge.wait_registered()
    turn(p, "after bridge restart", thread)
    after = p.bridge_state()["threads"][thread]
    entry["evidence"].update(before={k: before.get(k) for k in ("generation", "sessionId", "policyHash")},
                             after={k: after.get(k) for k in ("generation", "sessionId", "policyHash")})
    check(entry, before["sessionId"] == after["sessionId"] and before["generation"] == after["generation"],
          "same session and generation after a bridge restart")
    check(entry, before.get("createParams") == after.get("createParams"), "createParams replayed byte-identically")
    check(entry, "invalid_params" not in bridge.log_text(), "no invalid_params from session.create")


@scenario("sigterm_queued_runs_after_restart")
def s_sigterm_queue(entry: dict) -> None:
    profiles, gws, bridge = standalone_stack(entry, "sigtermq", drain=0)
    p, gw = profiles[0], gws[0]
    thread = str(uuid.uuid4())
    key = uuid.uuid4().hex[:8]
    first = inject(p.agent_id, f"[[hangonce:{key}]] interrupted by restart", thread)
    wait_for(lambda: "turn.started" in kinds(events_of(run_for(first["id"]))), 30, "turn.started")
    # Hermes makes the first model call ~0.5 s after turn.started; stop only once the
    # fake is holding it, or the -r1 retry becomes the call that hangs.
    wait_for(lambda: any(x.get("decision") == f"hangonce:{key}:hang" for x in read_jsonl(FAKE_LLM_LOG)),
             30, "the first model call is in flight")
    queued = [inject(p.agent_id, f"queued {i}", str(uuid.uuid4())) for i in range(2)]
    gw.stop(signal.SIGTERM)
    gw.start()
    for m in [first] + queued:
        wait_for(lambda m=m: final_replies_to(m["id"]), 90, f"reply to {m['id']}")
    time.sleep(2)
    st = state()
    counts = {m["id"]: len(final_replies_to(m["id"], st)) for m in [first] + queued}
    entry["evidence"]["reply_counts"] = counts
    check(entry, all(c == 1 for c in counts.values()), "every message answered exactly once after a SIGTERM restart")
    check(entry, str(final_replies_to(first["id"], st)[0].get("idempotencyKey")).endswith("-r1"),
          "the interrupted tool-free turn retried once (-r1)")


@scenario("api_text_delta_size")
def s_delta(entry: dict) -> None:
    profiles, _, _ = standalone_stack(entry, "delta")
    p = profiles[0]
    thread = str(uuid.uuid4())
    for i in range(4):
        turn(p, f"delta-check-{i}", thread)
    rows = [x for x in read_jsonl(FAKE_LLM_LOG) if "delta-check-3" in x.get("last_user", "") and x.get("kind") == "main"]
    lens = rows[-1].get("user_history_len", []) if rows else []
    entry["evidence"].update(user_row_lengths=lens)
    check(entry, len(lens) >= 4, "the model saw the replayed history")
    check(entry, all(n <= 1024 for n in lens[1:]), "every replayed user row after the first is <= 1 kB (D6)")
    check(entry, len(rows[-1].get("last_user", "")) <= 400 + len("delta-check-3") + 64, "api_text delta <= 400 chars + message")


@scenario("no_hook_output")
def s_no_hook(entry: dict) -> None:
    profiles, _, _ = standalone_stack(entry, "nohook")
    p = profiles[0]
    n0 = llm_count()
    turn(p, "is there a hook")
    hook_dir = p.home / "hook_outputs"
    entry["evidence"]["hook_outputs"] = sorted(str(x) for x in hook_dir.rglob("*"))[:10] if hook_dir.exists() else []
    check(entry, not entry["evidence"]["hook_outputs"], "no hook_outputs written (D22)")
    rows = [x for x in llm_rows_since(n0) if x.get("kind") == "main"]
    check(entry, rows and len(rows[-1].get("last_user", "")) < 1024, "no operating guide appended to the user message")


@scenario("graceful_stop_drain")
def s_drain_bridge(entry: dict) -> None:
    """R-4 at bridge level: a turn that finishes inside the drain is delivered from prompt.receipt."""
    profiles, gws, bridge = standalone_stack(entry, "drain", drain=30)
    p, gw = profiles[0], gws[0]
    msg = inject(p.agent_id, "[[slow:5]] finish while draining")
    wait_for(lambda: "turn.started" in kinds(events_of(run_for(msg["id"]))), 30, "turn.started")
    t0 = now()
    rc = gw.stop(signal.SIGTERM, timeout=90)
    entry["evidence"]["gateway_stop"] = {"rc": rc, "stop_s": round(now() - t0, 1)}
    gw.start()
    reps = wait_for(lambda: final_replies_to(msg["id"]), 60, "reply delivered after the drained restart")
    run = wait_for(lambda: (lambda r: r if run_status(r) not in (None, "running") else None)(run_for(msg["id"])), 20, "run")
    entry["evidence"].update(run=run, reply=reps[0].get("text"))
    check(entry, len(reps) == 1 and reps[0]["text"].startswith("s"), "the drained turn's own answer is delivered once")
    check(entry, run_status(run) in ("completed", "succeeded"), "run completed (not runtime_restart)")


@scenario("steer_followup", required=False)
def s_steer_bridge(entry: dict) -> None:
    """R-3: steer stays off by default; a follow-up never becomes an out-of-band steer."""
    profiles, _, _ = standalone_stack(entry, "steer")
    p = profiles[0]
    thread = str(uuid.uuid4())
    n0 = llm_count()
    first = inject(p.agent_id, "[[tool:steer]] long tool", thread)
    wait_for(lambda: "tool.start" in kinds(events_of(run_for(first["id"]))), 30, "tool.start")
    follow = inject(p.agent_id, "STEER-follow-up please", thread)
    wait_for(lambda: final_replies_to(follow["id"]), 60, "follow-up answered")
    rows = llm_rows_since(n0)
    check(entry, not any("OUT-OF-BAND USER MESSAGE" in json.dumps(x) for x in rows),
          "follow-up was not sent with session.steer (EMPEROR_CLAW_HERMES_FOLLOWUP=coalesce)")


@scenario("clarify_auto")
def s_clarify_bridge(entry: dict) -> None:
    """R-2: production toolsets never offer clarify; with it enabled the bridge auto-answers."""
    profiles, _, _ = standalone_stack(entry, "clarify", bridge_env={
        "EMPEROR_CLAW_HERMES_TOOLSETS": "emperor-claw,web,terminal,code_execution,clarify"})
    p = profiles[0]
    n0 = llm_count()
    t0 = now()
    r = turn(p, "[[tool:clarify]] pick for me", timeout=30)
    saw = [x.get("decision", "") for x in llm_rows_since(n0) if str(x.get("decision", "")).startswith("clarify:")]
    entry["evidence"].update(model_saw=saw, events=kinds(r["events"]), elapsed_s=round(now() - t0, 1))
    check(entry, "clarify.auto" in kinds(r["events"]), "clarify.auto event")
    check(entry, saw and '"answered"' in saw[-1], "the model received an answered clarify")
    check(entry, now() - t0 < 15, "turn not blocked on the clarify timeout")


@scenario("managed_supervisor")
def s_managed(entry: dict) -> None:
    if not (BRIDGE_PATH / "emperor_bridge" / "supervisor.py").exists():
        raise Skip("emperor_bridge/supervisor.py (W6) not present yet")
    p = Profile("bc-managed").setup()
    bridge = Bridge("managed", [p], "managed").start()
    CLEANUP.append(bridge.stop)
    bridge.wait_registered(timeout=150)
    ident = wait_for(lambda: identify(p.home), 120, "supervised gateway ready")
    reg = state()["registers"][-1]
    check(entry, reg.get("gatewayTopology") == "managed", "register reports gatewayTopology managed")
    turn(p, "managed hello")
    old_pid = ident.get("pid")
    out = subprocess.run(["pkill", "-KILL", "-f", "--", f"-p {p.name} gateway run"], capture_output=True)
    entry["evidence"]["pkill_rc"] = out.returncode
    new = wait_for(lambda: (lambda i: i if i and i.get("instance_id") != ident.get("instance_id") else None)(identify(p.home)),
                   60, "supervisor restarted the gateway")
    entry["evidence"]["instances"] = [ident.get("instance_id"), new.get("instance_id"), old_pid]
    r = turn(p, "after supervised restart", timeout=60)
    check(entry, r["replies"], "turns work after the supervisor restart")
    t0 = now()
    rc = bridge.stop(signal.SIGTERM, timeout=75)
    entry["evidence"]["stop"] = {"rc": rc, "stop_s": round(now() - t0, 1)}
    check(entry, rc == 0, "bridge exits 0 on SIGTERM after stopping its gateway")
    check(entry, identify(p.home) is None, "no gateway left behind")


@scenario("goal_evaluate")
def s_goal(entry: dict) -> None:
    adapter = BRIDGE_PATH / "hermes_goal_adapter.py"
    if not adapter.exists():
        raise Skip("hermes_goal_adapter.py removed: D18 hidden-turn fallback chosen (covered by W4 unit tests)")
    p = Profile("bc-goal").setup()
    env = {**clean_env(), "HERMES_HOME": str(p.home), "PYTHONPATH": HERMES_REPO, "FAKE_MODEL_KEY": "sk-fake"}
    sid = f"contract-goal-{uuid.uuid4().hex[:8]}"
    out = {}
    for payload in ({"action": "start", "objective": "Write one haiku", "maxTurns": 3},
                    {"action": "evaluate", "response": "Here is the haiku: loopback sockets hum"}):
        proc = subprocess.run([HERMES_PY, str(adapter)], input=json.dumps({"sessionId": sid, **payload}),
                              capture_output=True, text=True, env=env, cwd=HERMES_REPO, timeout=120)
        out[payload["action"]] = {"rc": proc.returncode, "stdout": proc.stdout[-600:], "stderr": proc.stderr[-800:]}
    entry["evidence"] = out
    check(entry, out["start"]["rc"] == 0, "goal start")
    check(entry, out["evaluate"]["rc"] == 0 and '"status"' in out["evaluate"]["stdout"]
          and "unavailable" not in out["evaluate"]["stdout"], "goal evaluate returns a decision (R-6)")


@scenario("shared_gateway_two_profiles")
def s_shared(entry: dict) -> None:
    """R-1 items 3-5 in Docker: one default-home gateway, two profiles, per-session credentials."""
    a = Profile("bc-shared-a", standalone=False).setup()
    b = Profile("bc-shared-b", standalone=False).setup()
    default_cfg = HERMES_HOME / "config.yaml"
    saved = default_cfg.read_text() if default_cfg.exists() else None
    # `config set`, not an appended block: the default config already has a `gateway:` mapping.
    for key, value in (("gateway.multiplex_profiles", "true"), ("gateway.unmanaged_idle_exit_seconds", "0")):
        subprocess.run([HERMES, "config", "set", key, value], capture_output=True, timeout=60, stdin=subprocess.DEVNULL)
    CLEANUP.append(lambda: default_cfg.write_text(saved) if saved is not None else default_cfg.unlink(missing_ok=True))
    gw = Gateway("shared")
    ident = gw.start()
    CLEANUP.append(gw.stop)
    served = {Path(x.get("home", "")).name for x in ident.get("served_profiles", [])}
    entry["evidence"]["served_profiles"] = sorted(served)
    check(entry, {a.name, b.name} <= served, "shared gateway serves both profiles")
    bridge = Bridge("shared", [a, b], "shared").start()
    CLEANUP.append(bridge.stop)
    regs = bridge.wait_registered()
    check(entry, all(r.get("gatewayTopology") == "shared" for r in regs), "both agents register as shared")
    n0 = len(read_jsonl(RESULTS / "emperor_echo_requests.jsonl"))
    ma = inject(a.agent_id, "[[tool:emperor]] health a")
    mb = inject(b.agent_id, "[[tool:emperor]] health b")
    for m in (ma, mb):
        wait_for(lambda m=m: final_replies_to(m["id"]), 60, "shared reply")
    health = [x["authorization"] for x in read_jsonl(RESULTS / "emperor_echo_requests.jsonl")[n0:]
              if x["path"].startswith("/api/mcp/runtime/health")]
    entry["evidence"]["health_bearers"] = health
    check(entry, sorted(health) == sorted([f"Bearer {a.token}", f"Bearer {b.token}"]),
          "each agent's tool call carried its own token (plugin per-session .env, D8)")
    st = state()
    for p, m in ((a, ma), (b, mb)):
        rep = final_replies_to(m["id"], st)[0]
        check(entry, rep["agentId"] == p.agent_id, f"{p.name} reply attributed to its own agent")


@scenario("multi_agent_bridge")
def s_multi(entry: dict) -> None:
    profiles, _, bridge = standalone_stack(entry, "multi", n_profiles=2)
    msgs = [(p, inject(p.agent_id, f"hello from {p.name}")) for p in profiles]
    st = None
    for p, m in msgs:
        wait_for(lambda m=m: final_replies_to(m["id"]), 45, f"{p.name} reply")
    st = state()
    for p, m in msgs:
        rep = final_replies_to(m["id"], st)[0]
        check(entry, rep["agentId"] == p.agent_id, f"{p.name} answered by its own AgentRuntime")
    check(entry, bridge.proc.poll() is None, "one bridge process hosts both agents")


# ── main ─────────────────────────────────────────────────────────────────────────────────────


def preflight() -> Optional[str]:
    pkg = BRIDGE_PATH / "emperor_bridge"
    missing = [str(pkg / f) for f in ("__init__.py", "__main__.py", "main.py") if not (pkg / f).exists()]
    if missing:
        return ("bridge 0.9 package not present yet (W3/W4): missing " + ", ".join(missing) +
                ". Expected entry point: python -m emperor_bridge run [--profiles a,b] (design §5.1).")
    probe = subprocess.run([HERMES_PY, "-c", "import emperor_bridge.main"], capture_output=True, text=True,
                           env={**clean_env(), "PYTHONPATH": str(BRIDGE_PATH)}, timeout=60)
    if probe.returncode != 0:
        return "emperor_bridge does not import on the Hermes venv python: " + probe.stderr.strip()[-600:]
    return None


def main() -> int:
    LOGS.mkdir(parents=True, exist_ok=True)
    REPORT["meta"] = {"started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "bridge_path": str(BRIDGE_PATH),
                      "hermes_python": HERMES_PY, "require": REQUIRE}
    blocked = preflight()
    REPORT["meta"]["preflight"] = blocked or "ok"
    if blocked:
        log("SKIP ALL:", blocked)
    for name, required, fn in SCENARIOS:
        if ONLY and name not in ONLY:
            continue
        entry: Dict[str, Any] = {"ok": False, "required": required, "evidence": {}}
        REPORT["scenarios"][name] = entry
        log("──", name)
        t0 = now()
        try:
            if blocked:
                raise Skip(blocked)
            fake("/__fake/reset", {})
            fn(entry)
            entry["ok"] = True
        except Skip as exc:
            entry["skipped"] = str(exc)
        except Exception as exc:
            entry["error"] = f"{type(exc).__name__}: {exc}"
            entry["traceback"] = traceback.format_exc()[-3000:]
            log("   FAILED:", entry["error"])
        finally:
            while CLEANUP:
                try:
                    CLEANUP.pop()()
                except Exception as exc:  # cleanup must never mask the verdict
                    log("   cleanup error:", repr(exc))
        entry["duration_s"] = round(now() - t0, 2)
        log("  ", "skipped" if "skipped" in entry else "ok" if entry["ok"] else "FAIL", f"({entry['duration_s']} s)")
    out = RESULTS / "bridge-report.json"
    out.write_text(json.dumps(REPORT, indent=2, default=str))
    failed = [n for n, s in REPORT["scenarios"].items() if s["required"] and not s["ok"] and "skipped" not in s]
    skipped = [n for n, s in REPORT["scenarios"].items() if "skipped" in s]
    log("report:", out)
    log("required failures:", failed or "none")
    log("skipped:", len(skipped), "(BRIDGE_CONTRACT_REQUIRE=1 makes a skip a failure)" if skipped else "")
    if failed or (REQUIRE and skipped):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
