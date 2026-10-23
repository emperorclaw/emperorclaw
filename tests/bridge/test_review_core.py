"""Review fixes in the bridge core: H1 (retry attempt kept on re-dispatch), H4 (run id per agent),
M1 (admission conflicts), M3 (long-poll executor), M7 (paging), M8 (retired sessions archived),
LOW-2 (background task references), LOW-3 (cursor timestamps), LOW-4 (run-id conflict dropped),
M2 (retry ledger bounds) and M6 (plugin credential fallback)."""
from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import os
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
BRIDGE_DIR = REPO / "integrations" / "hermes" / "emperor-claw" / "bridge"
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

from emperor_bridge.emperor_api import ApiError, EmperorClient, bound_retries, mark_inflight  # noqa: E402
from emperor_bridge.emperor_api import schedule_retry  # noqa: E402
from emperor_bridge.gateway.sessions import MAX_ARCHIVE_ATTEMPTS, MAX_RETIRED, SessionManager  # noqa: E402
from emperor_bridge.intake import IDLE_BACKOFF_MAX_S, POLL_PAUSE_S, next_sleep  # noqa: E402
from emperor_bridge.interfaces import (AdmissionConflict, AgentIdentity, ProfileTarget, RpcError, RunNotFound,  # noqa: E402
                                       SchedulerConfig, SessionPolicy, ThreadSession, Turn, run_id_for)
from emperor_bridge.scheduler import InboundMessage, Scheduler, TurnBatch  # noqa: E402
from emperor_bridge.state import BridgeState, utc_now_iso  # noqa: E402
from emperor_bridge.turns import TurnRunner  # noqa: E402


def run(coro):
    return asyncio.run(coro)


class Channel:
    def __init__(self, handler=None):
        self.calls: list[tuple[str, dict]] = []
        self.handler = handler

    async def call(self, method, params=None, *, timeout=30.0):
        self.calls.append((method, dict(params or {})))
        if self.handler:
            return await self.handler(method, dict(params or {}))
        return {}


class FakeLink:
    def __init__(self, turns=None, maintenance=None):
        self.turns, self.maintenance = turns or Channel(), maintenance or Channel()
        self.identity, self.connected = None, True

    def add_event_listener(self, listener): pass
    def add_reconnect_listener(self, listener): pass
    def seed_cursor(self, *a): pass
    def hold_session(self, sid): pass
    def release_session(self, sid): pass
    def inject_events(self, events): pass


class H1RetryAttemptTests(unittest.TestCase):
    def test_resubmitted_batch_keeps_its_retry_suffix(self):
        seen: list[TurnBatch] = []

        async def go():
            async def dispatch(batch):
                seen.append(batch)
            sched = Scheduler(dispatch, SchedulerConfig(max_parallel_turns=2))
            sched.submit_batch(TurnBatch("t1", (InboundMessage("m1", "t1"),), attempt=1))
            await sched.drain(2)
            sched2 = Scheduler(dispatch)
            sched2.submit(InboundMessage("m2", "t2"))
            await sched2.drain(2)

        run(go())
        self.assertEqual(seen[0].submission_id, "emp-m1-r1")
        self.assertEqual(seen[1].submission_id, "emp-m2", "a fresh message starts at attempt 0")

    def test_reserved_thread_is_not_dispatched_until_released(self):
        seen: list[str] = []

        async def go():
            async def dispatch(batch):
                seen.append(batch.thread_id)
            sched = Scheduler(dispatch)
            sched.reserve("t1")
            sched.submit(InboundMessage("m1", "t1"))
            sched.submit_batch(TurnBatch("t1", (InboundMessage("m0", "t1"),), attempt=1))
            await asyncio.sleep(0.05)
            self.assertEqual(seen, [])
            self.assertTrue(sched.is_busy("t1"))
            sched.release("t1")
            await sched.drain(2)

        run(go())
        self.assertEqual(seen, ["t1"])


class H4RunIdTests(unittest.TestCase):
    def test_run_id_includes_the_agent(self):
        policy = SessionPolicy(system_prompt="x")
        a = Turn(thread_id="t", trigger_id="m", text="", api_text="", policy=policy, agent_id="agent-a")
        b = Turn(thread_id="t", trigger_id="m", text="", api_text="", policy=policy, agent_id="agent-b")
        self.assertNotEqual(a.run_id, b.run_id)
        self.assertEqual(a.run_id, run_id_for("emp-m", "agent-a"))
        self.assertEqual(a.submission_id, b.submission_id, "the Hermes submission id is unchanged")
        self.assertNotEqual(run_id_for("emp-m-r1", "agent-a"), a.run_id)


class Store:
    def __init__(self, turns=None):
        self.turns = dict(turns or {})

    def get_turn(self, sid): return self.turns.get(sid)
    def put_turn(self, sid, rec): self.turns[sid] = rec
    def drop_turn(self, sid): self.turns.pop(sid, None)
    def open_turns(self): return dict(self.turns)
    async def save(self): pass


class FakeSessions:
    def add_resync_listener(self, listener): pass
    def mark_active(self, thread_id, active): pass
    def invalidate(self, thread_id): pass
    def persist(self, rec): pass

    async def ensure(self, thread_id, policy):
        return ThreadSession(thread_id=thread_id, generation=1, create_params={"request_id": "r"}, policy_hash="h",
                             session_id="local-1")


class Sink:
    def __init__(self): self.opened, self.closed = [], []
    def open_run(self, run_id, header, *, next_seq=0): self.opened.append(run_id)
    def emit(self, run_id, event): pass
    def next_seq(self, run_id): return 0
    def dropped(self, run_id): return 0
    async def flush(self, run_id=None): pass
    def close_run(self, run_id): self.closed.append(run_id)


class M1AdmissionConflictTests(unittest.TestCase):
    def runner(self, store, link):
        with tempfile.TemporaryDirectory() as tmp:
            agent = AgentIdentity("a1", "A", "rt", "0.9.0", ProfileTarget("p", Path(tmp), Path(tmp)))
            return TurnRunner(link, FakeSessions(), store, Sink(), agent=agent), Path(tmp)

    def turn(self):
        return Turn(thread_id="t1", trigger_id="m1", text="hi", api_text="hi", policy=SessionPolicy(system_prompt="x"),
                    message_ids=("m1",), agent_id="a1")

    def test_settled_record_for_the_submission_raises_conflict_before_any_submit(self):
        link = FakeLink()
        runner, _ = self.runner(Store({"emp-m1": {"status": "settled"}}), link)
        with self.assertRaises(AdmissionConflict):
            run(runner.run(self.turn()))
        self.assertEqual(link.turns.calls, [])

    def test_admission_conflict_from_the_gateway_is_typed(self):
        async def handler(method, params):
            raise RpcError(4001, "conflict", {"reason": "admission_conflict"})
        with tempfile.TemporaryDirectory() as tmp:
            agent = AgentIdentity("a1", "A", "rt", "0.9.0", ProfileTarget("p", Path(tmp), Path(tmp)))
            store = Store()
            runner = TurnRunner(FakeLink(turns=Channel(handler)), FakeSessions(), store, Sink(), agent=agent)
            with self.assertRaises(AdmissionConflict):
                run(runner.run(self.turn()))
            self.assertEqual(store.turns, {}, "a refused submit leaves no turn record")


class M2RetryBoundsTests(unittest.TestCase):
    def test_old_entries_are_dropped_and_the_count_capped(self):
        data: dict[str, Any] = {}
        mark_inflight(data, "old", now=0)
        for i in range(10):
            mark_inflight(data, f"m{i}", now=100_000 + i)
        self.assertTrue(bound_retries(data, now=100_100, max_age_s=86_400, cap=5))
        self.assertNotIn("old", data["retries"])
        self.assertEqual(sorted(data["retries"]), [f"m{i}" for i in range(5, 10)], "the newest entries are kept")
        self.assertFalse(bound_retries(data, now=100_100, max_age_s=86_400, cap=5))


class M3LongPollExecutorTests(unittest.TestCase):
    def test_state_save_completes_while_the_long_poll_is_blocked(self):
        release = threading.Event()

        def opener(req, timeout):
            release.wait(10)
            raise OSError("closed")

        async def go():
            loop = asyncio.get_running_loop()
            loop.set_default_executor(ThreadPoolExecutor(max_workers=1))  # the small executor saves share
            client = EmperorClient("http://emperor.test", "tok", agent_id="a1", opener=opener)
            with tempfile.TemporaryDirectory() as tmp:
                state = BridgeState.load(Path(tmp) / "s.json")
                polls = [asyncio.create_task(client.sync(None, [])) for _ in range(2)]
                await asyncio.sleep(0.1)
                await asyncio.wait_for(state.save(), 3)  # never waits behind the long-polls
                self.assertTrue((Path(tmp) / "s.json").exists())
                release.set()
                await asyncio.gather(*polls, return_exceptions=True)
            client.close()

        run(go())


class M7PagingSleepTests(unittest.TestCase):
    def test_has_more_fetches_the_next_page_at_once(self):
        self.assertEqual(next_sleep(["dispatch"], has_more=True, elapsed_s=0.1, backoff_s=2.0), (0.0, POLL_PAUSE_S))

    def test_a_page_of_repeats_never_loops_on_has_more(self):
        pause, _ = next_sleep(["repeat"], has_more=True, elapsed_s=0.1, backoff_s=POLL_PAUSE_S)
        self.assertGreater(pause, 0)


class M8RetiredSessionTests(unittest.TestCase):
    def manager(self, tmp, maintenance=None, turns=None):
        state = BridgeState.load(Path(tmp) / "s.json")
        link = FakeLink(turns=turns, maintenance=maintenance)
        return SessionManager(link, state, agent_id="a1", profile_home=Path(tmp)), state, link

    def test_bumped_generation_is_archived_not_deleted(self):
        async def maint(method, params):
            return {"revision": 4, "execution_generation": 2} if method == "session.resume" else {"ok": True}

        async def go():
            with tempfile.TemporaryDirectory() as tmp:
                mgr, state, link = self.manager(tmp, maintenance=Channel(maint))
                state.put_thread(ThreadSession("t1", 1, {"request_id": "r"}, "h", session_id="local-old"))
                mgr.bump_generation("t1", "kill")
                self.assertEqual(await mgr.close_retired(), 1)
                mgr.bump_generation("t1", "kill again")  # same session: never archived twice
                self.assertEqual(mgr.retired(), [])
                return link.maintenance.calls, mgr.retired()

        calls, left = run(go())
        mutate = [p for m, p in calls if m == "session.mutate"][0]
        self.assertEqual((mutate["operation"], mutate["payload"], mutate["expected_revision"]),
                         ("archive", {"archived": True}, 4))
        self.assertEqual(left, [])

    def test_a_session_with_a_turn_in_flight_is_left_alone_and_the_queue_is_bounded(self):
        async def go():
            with tempfile.TemporaryDirectory() as tmp:
                mgr, state, link = self.manager(tmp)
                for i in range(MAX_RETIRED + 20):
                    state.put_thread(ThreadSession(f"t{i}", 1, {"request_id": "r"}, "h", session_id=f"s{i}"))
                    mgr.bump_generation(f"t{i}", "kill")
                self.assertEqual(len(mgr.retired()), MAX_RETIRED)
                mgr._by_session["s219"] = "t219"
                mgr.mark_active("t219", True)
                await mgr.close_retired()
                return mgr.retired()

        self.assertEqual(run(go()), ["s219"])

    def test_policy_refresh_retires_the_previous_generation(self):
        async def turns(method, params):
            return {"session_id": "local-new", "revision": 1, "execution_generation": 0}

        async def go():
            with tempfile.TemporaryDirectory() as tmp:
                mgr, state, link = self.manager(tmp, turns=Channel(turns))
                await mgr.ensure("t1", SessionPolicy(system_prompt="v1"))
                rec = mgr.get("t1")
                rec.session_id = "local-old"
                await mgr.ensure("t1", SessionPolicy(system_prompt="v2", urgent=True))
                await asyncio.sleep(0.05)
                return [p for m, p in link.maintenance.calls if m == "session.mutate"]

        mutates = run(go())
        self.assertEqual([m["session_id"] for m in mutates], ["local-old"])


class Low2BackgroundTaskTests(unittest.TestCase):
    def test_background_tasks_are_referenced_and_failures_logged(self):
        async def go():
            with tempfile.TemporaryDirectory() as tmp:
                mgr = SessionManager(FakeLink(), BridgeState.load(Path(tmp) / "s.json"), agent_id="a",
                                     profile_home=Path(tmp))

                async def boom():
                    raise RuntimeError("resync broke")
                with self.assertLogs("emperor_bridge.sessions", level="WARNING") as logs:
                    task = mgr._spawn(boom())
                    self.assertIn(task, mgr._background)
                    await asyncio.sleep(0.01)
                self.assertNotIn(task, mgr._background)
                return logs.output

        self.assertIn("resync broke", run(go())[0])


class Low3TimestampTests(unittest.TestCase):
    def test_iso_timestamps_carry_milliseconds(self):
        self.assertRegex(utc_now_iso(0), r"^1970-01-01T00:00:00\.000Z$")
        self.assertRegex(utc_now_iso(1.5), r"\.500Z$")


class Low4RunIdConflictTests(unittest.TestCase):
    def client(self, status, body):
        import io
        import urllib.error

        def opener(req, timeout):
            raise urllib.error.HTTPError(req.full_url, status, "x", {}, io.BytesIO(body.encode()))
        return EmperorClient("http://emperor.test", "tok", agent_id="a1", opener=opener,
                             logger=logging.getLogger("test.low4"))

    def test_run_id_conflict_is_dropped_not_parked(self):
        with self.assertLogs("test.low4", level="ERROR"):
            with self.assertRaises(ApiError):
                run(self.client(409, '{"error":"Run id is already in use"}').post_run_events("r", [{"seq": 0}]))

    def test_run_not_found_still_asks_for_the_header(self):
        with self.assertRaises(RunNotFound):
            run(self.client(409, '{"error":"run_not_found"}').post_run_events("r", [{"seq": 0}]))


def load_plugin():
    spec = importlib.util.spec_from_file_location("hermes_plugin_review", REPO / "integrations/hermes/emperor-claw/__init__.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class M6PluginCredentialTests(unittest.TestCase):
    def setUp(self):
        self.plugin = load_plugin()
        self.tmp = tempfile.TemporaryDirectory()
        for name in ("a", "b"):
            folder = Path(self.tmp.name) / ".hermes" / "profiles" / name
            folder.mkdir(parents=True)
            (folder / ".env").write_text(f"EMPEROR_CLAW_API_TOKEN=tok-{name}\n")

    def tearDown(self):
        self.tmp.cleanup()

    def env(self, **extra):
        return {"HOME": self.tmp.name, "EMPEROR_CLAW_API_TOKEN": "process-token", **extra}

    def creds(self, env):
        with patch.dict(os.environ, env, clear=True), patch.object(self.plugin, "_bound_env", return_value={}):
            return self.plugin._creds()

    def test_shared_gateway_refuses_the_process_token(self):
        creds = self.creds(self.env(HERMES_HOME=str(Path(self.tmp.name) / ".hermes")))
        self.assertEqual(creds["token"], "")
        self.assertIn("refused", creds["source"])

    def test_standalone_profile_gateway_keeps_its_own_process_token(self):
        home = Path(self.tmp.name) / ".hermes" / "profiles" / "a"
        self.assertEqual(self.creds(self.env(HERMES_HOME=str(home)))["token"], "process-token")

    def test_explicit_gateway_topology_decides(self):
        root_home = str(Path(self.tmp.name) / ".hermes")
        self.assertEqual(self.creds(self.env(HERMES_HOME=root_home, EMPEROR_GATEWAY_TOPOLOGY="standalone"))["token"],
                         "process-token", "a default-home standalone gateway keeps its token")
        profile_home = str(Path(self.tmp.name) / ".hermes" / "profiles" / "a")
        self.assertEqual(self.creds(self.env(HERMES_HOME=profile_home, EMPEROR_GATEWAY_TOPOLOGY="shared"))["token"], "")
        self.assertEqual(self.creds(self.env(EMPEROR_GATEWAY_TOPOLOGY="shared",
                                             EMPEROR_ALLOW_PROCESS_CREDENTIALS="1"))["token"], "process-token")

    def test_units_and_supervisor_set_the_topology(self):
        units = REPO / "integrations" / "hermes" / "systemd"
        self.assertIn("EMPEROR_GATEWAY_TOPOLOGY=standalone", (units / "emperor-hermes-gateway@.service").read_text())
        self.assertIn("EMPEROR_GATEWAY_TOPOLOGY=shared", (units / "emperor-hermes-gateway-shared.service").read_text())
        from emperor_bridge.supervisor import SupervisorConfig
        with patch.dict(os.environ, {}, clear=True):
            env = SupervisorConfig(profile="p", profile_home=Path(self.tmp.name)).child_env()
        self.assertEqual(env["EMPEROR_GATEWAY_TOPOLOGY"], "standalone")

    def test_operator_opt_in_and_single_profile_hosts(self):
        self.assertEqual(self.creds(self.env(EMPEROR_ALLOW_PROCESS_CREDENTIALS="1"))["token"], "process-token")
        (Path(self.tmp.name) / ".hermes" / "profiles" / "b" / ".env").unlink()
        self.assertEqual(self.creds(self.env())["token"], "process-token")


class H3SleepPolicyTests(unittest.TestCase):
    def test_repeats_back_off_to_the_cap_and_reset_on_progress(self):
        backoff, pauses = POLL_PAUSE_S, []
        for _ in range(6):
            pause, backoff = next_sleep(["repeat", "repeat"], has_more=False, elapsed_s=0.05, backoff_s=backoff)
            pauses.append(pause)
        self.assertEqual(pauses[0], 1.0)
        self.assertEqual(pauses[-1], IDLE_BACKOFF_MAX_S)
        self.assertEqual(next_sleep(["repeat", "dispatch"], has_more=False, elapsed_s=0.05, backoff_s=backoff),
                         (POLL_PAUSE_S, POLL_PAUSE_S))

    def test_a_held_long_poll_resets_the_backoff(self):
        self.assertEqual(next_sleep(["repeat"], has_more=False, elapsed_s=25.0, backoff_s=4.0),
                         (POLL_PAUSE_S, POLL_PAUSE_S))


class Round2Tests(unittest.TestCase):
    def test_archive_gives_up_after_bounded_attempts(self):
        async def maint(method, params):
            raise RpcError(4001, "refused", {"reason": "permission_denied"})

        async def go():
            with tempfile.TemporaryDirectory() as tmp:
                state = BridgeState.load(Path(tmp) / "s.json")
                mgr = SessionManager(FakeLink(maintenance=Channel(maint)), state, agent_id="a", profile_home=Path(tmp))
                state.put_thread(ThreadSession("t1", 1, {"request_id": "r"}, "h", session_id="s1"))
                mgr.bump_generation("t1", "kill")
                for _ in range(MAX_ARCHIVE_ATTEMPTS - 1):
                    await mgr.close_retired()
                self.assertEqual(mgr.retired(), ["s1"], "still retried below the cap")
                await mgr.close_retired()
                return mgr.retired()

        self.assertEqual(run(go()), [])

    def test_cancel_and_clear_pending_forget_the_retry_attempt(self):
        async def go():
            seen = []

            async def dispatch(batch):
                seen.append(batch.submission_id)
            sched = Scheduler(dispatch)
            sched.pause()
            sched.submit_batch(TurnBatch("t1", (InboundMessage("m1", "t1"),), attempt=2))
            sched.cancel("m1")
            sched.submit_batch(TurnBatch("t2", (InboundMessage("m2", "t2"),), attempt=1))
            sched.clear_pending()
            sched.submit(InboundMessage("m3", "t1"))
            sched.submit(InboundMessage("m4", "t2"))
            sched.resume()
            await sched.drain(2)
            return sorted(seen)

        self.assertEqual(run(go()), ["emp-m3", "emp-m4"])

    def test_gateway_waits_are_short_and_outage_waits_keep_the_long_curve(self):
        data: dict[str, Any] = {}
        schedule_retry(data, "g", base_s=15, max_s=300, environment=True, now=0, wait_floor_s=2, wait_cap_s=30)
        self.assertEqual(data["retries"]["g"]["nextRetryAt"], 2)
        for _ in range(10):
            schedule_retry(data, "g", base_s=15, max_s=300, environment=True, now=0, wait_floor_s=2, wait_cap_s=30)
        self.assertEqual(data["retries"]["g"]["nextRetryAt"], 30)
        schedule_retry(data, "o", base_s=15, max_s=300, environment=True, now=0)
        self.assertEqual(data["retries"]["o"]["nextRetryAt"], 45)


class FakeEmperorSyncTests(unittest.TestCase):
    """The contract's fake Emperor must follow the real sync rules (release coalesce failure)."""

    def test_same_millisecond_messages_are_both_returned_and_known_ids_wait(self):
        import http.server
        import importlib.util as iu
        import urllib.request as ur
        spec = iu.spec_from_file_location("emperor_echo_fake", REPO / "tests/contract/hermes/emperor_echo.py")
        echo = iu.module_from_spec(spec)
        spec.loader.exec_module(echo)
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), echo.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_address[1]}"

        def call(path, body=None):
            data = None if body is None else json.dumps(body).encode()
            req = ur.Request(base + path, data=data, method="POST" if body is not None else "GET",
                             headers={"Content-Type": "application/json", "Authorization": "Bearer tok"})
            with ur.urlopen(req, timeout=10) as res:
                return json.loads(res.read() or b"null")
        try:
            call("/__fake/agents", {"agents": [{"token": "tok", "agentId": "ag"}]})
            stamp = "2026-10-23T10:12:09.480Z"
            ids = [call("/__fake/messages", {"agentId": "ag", "threadId": "t", "text": t, "extra": {"createdAt": stamp}})["id"]
                   for t in ("second", "third")]
            got = call(f"/api/mcp/messages/sync?agentId=ag&since={stamp}")["messages"]
            self.assertEqual(sorted(m["id"] for m in got), sorted(ids), "the cursor's millisecond is re-returned")
            started = time.monotonic()
            call(f"/api/mcp/messages/sync?agentId=ag&since={stamp}&knownIds={','.join(ids)}")
            self.assertGreaterEqual(time.monotonic() - started, echo.SYNC_WAIT_S * 0.8,
                                    "known rows alone do not end the long poll")
        finally:
            server.shutdown()


if __name__ == "__main__":
    unittest.main()
