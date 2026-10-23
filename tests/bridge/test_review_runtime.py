"""Review fixes in the AgentRuntime: H2 (recovery in the background, no duplicate copy, no leaked
reservation, retry ordering), H3 (no spin, no rewrite of state for repeats), M1 (conflict -> -rN,
abandoned runs finished), M2 (stop clears the retry entry), M4 (health on its own task), M5
(compaction off the slot), M7 (hasMore loop, nextSince cursor), LOW-1 (standby never answers) and
the gateway-restart quick retry. Every wait is a condition wait, never a fixed sleep."""
from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_multi_agent import Fleet, batch_for, result  # noqa: E402

from emperor_bridge import intake, recovery  # noqa: E402
from emperor_bridge.interfaces import (AdmissionConflict, GatewayUnavailable, SessionPolicy, ThreadSession,  # noqa: E402
                                       Turn, TurnOutcome)
from emperor_bridge.scheduler import InboundMessage  # noqa: E402

TIMEOUT = 10.0


def message(mid, thread="t1", created="2026-10-22T10:00:00.000Z"):
    return {"id": mid, "threadId": thread, "threadType": "direct", "targetAgentId": "agent-a", "senderType": "human",
            "senderName": "Jose", "text": f"text {mid}", "createdAt": created, "deliveryState": "queued"}


async def wait_until(predicate, timeout: float = TIMEOUT, what: str = "condition"):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out waiting for {what}")
        await asyncio.sleep(0.005)


async def stop(rt, tasks):
    rt._stopping = True
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


class Harness(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.fleet = Fleet(self.tmp.name, {"a": "tok"})

    def tearDown(self):
        self.tmp.cleanup()

    async def runtime(self):
        rt = self.fleet.runtime("a")
        await rt.prepare()
        rt.context.set_capabilities(frozenset({"run-events: 1"}), "")
        self.ran = []

        async def fake_run(turn):
            self.ran.append(turn)
            return result()

        rt.runner.run = fake_run
        return rt

    def turn_for(self, rt, mid="m0"):
        return Turn(thread_id="t1", trigger_id=mid, text="", api_text="", policy=SessionPolicy(system_prompt="x"),
                    message_ids=(mid,), agent_id=rt.identity.agent_id)


def open_turn(rt, mid="m0"):
    rt.state.put_turn(f"emp-{mid}", {"threadId": "t1", "status": "running", "messageIds": [mid],
                                     "admissionId": "adm", "triggerId": mid})


class H2RecoveryTests(Harness):
    def test_a_recovery_that_never_settles_does_not_block_the_agent(self):
        async def go():
            rt = await self.runtime()
            open_turn(rt)
            hang = asyncio.Event()

            async def recover(records):
                await hang.wait()
                return []

            rt.runner.recover = recover
            syncs = []

            async def sync(since, retry_ids, known_ids=()):
                syncs.append(time.monotonic())
                return {"messages": []}

            rt.client.sync = sync
            rt._health_interval_s = 0.02
            tasks = [asyncio.create_task(recovery.recover(rt)), asyncio.create_task(intake.sync_loop(rt)),
                     asyncio.create_task(rt._health_loop())]
            await wait_until(lambda: rt.scheduler.is_busy("t1"), what="t1 reserved")
            rt.scheduler.submit(InboundMessage("m1", "t1", raw=message("m1")))
            rt.scheduler.submit(InboundMessage("m2", "t2", raw=message("m2", "t2")))
            await wait_until(lambda: len(syncs) >= 2 and self.ran, what="sync loop + other thread")
            self.assertEqual([t.thread_id for t in self.ran], ["t2"], "only the other thread ran")
            health_before = json.loads(rt.cfg.health_path.read_text())["updatedAt"]
            hang.set()
            await wait_until(lambda: "t1" in [t.thread_id for t in self.ran], what="queued follow-up after recovery")
            await wait_until(lambda: json.loads(rt.cfg.health_path.read_text())["updatedAt"] > health_before,
                             what="health refresh")
            await stop(rt, tasks)

        asyncio.run(go())

    def test_recovered_messages_are_accepted_before_the_first_await(self):
        async def go():
            rt = await self.runtime()
            open_turn(rt)
            hang = asyncio.Event()

            async def recover(records):
                await hang.wait()
                return []

            rt.runner.recover = recover
            task = asyncio.create_task(recovery.recover(rt))
            await asyncio.sleep(0)  # recovery ran up to its first await (the state save)
            outcome = await intake.intake(rt, message("m0"))
            queued = rt.scheduler.queued_count()
            hang.set()
            await asyncio.wait_for(task, TIMEOUT)
            return outcome, queued

        outcome, queued = asyncio.run(go())
        self.assertEqual(outcome, "repeat", "a sync during recovery sees the message as already accepted")
        self.assertEqual(queued, 0, "no second copy is queued")

    def test_reservations_are_released_when_recovery_fails(self):
        async def go():
            rt = await self.runtime()
            open_turn(rt)

            async def broken_save():
                raise OSError("disk full")
            rt.state.save = broken_save
            with self.assertRaises(OSError):
                await recovery.recover(rt)
            return rt

        rt = asyncio.run(go())
        self.assertFalse(rt.scheduler.is_busy("t1"))

    def test_retry_follow_up_is_queued_before_the_thread_is_released(self):
        async def go():
            rt = await self.runtime()
            open_turn(rt)
            from emperor_bridge.interfaces import RecoveredTurn
            lost = result(TurnOutcome.FAILED, retry_advised=True, error_code="runtime_restart")
            later_queued = asyncio.Event()

            async def recover(records):
                await later_queued.wait()
                return [RecoveredTurn("emp-m0", records["emp-m0"], lost)]
            rt.runner.recover = recover
            task = asyncio.create_task(recovery.recover(rt))
            await wait_until(lambda: rt.scheduler.is_busy("t1"), what="t1 reserved")
            rt.scheduler.submit(InboundMessage("later", "t1", raw=message("later")))
            later_queued.set()
            await asyncio.wait_for(task, TIMEOUT)
            await wait_until(lambda: self.ran, what="the recovered thread runs")
            return self.ran[0]

        turn = asyncio.run(go())
        self.assertEqual(turn.message_ids, ("m0", "later"), "the retried message comes first, the newer one after")
        self.assertTrue(turn.submission_id.endswith("-r1"), "the D15 retry keeps its -r1 attempt")

    def test_never_admitted_dispatch_is_rerun_with_its_attempt(self):
        async def go():
            rt = await self.runtime()
            rt.state.data["dispatches"]["emp-m0-r1"] = {"threadId": "t1", "attempt": 1, "messages": [message("m0")]}
            await recovery.recover(rt)
            await rt.scheduler.drain(TIMEOUT)

        asyncio.run(go())
        self.assertEqual(self.ran[0].submission_id, "emp-m0-r1")


class H3IntakeTests(Harness):
    def not_due(self, rt):
        rt.state.data.setdefault("retries", {})["m9"] = {"attempts": 1, "nextRetryAt": time.time() + 3600,
                                                         "firstAttemptAt": 1}

    def test_repeats_mark_nothing_dirty(self):
        async def go():
            rt = await self.runtime()
            self.not_due(rt)
            rt.state.data["lastSeenAt"] = "2026-10-22T11:00:00.000Z"
            await rt.state.save()
            outcomes = []
            for _ in range(5):
                outcomes.append(await intake.intake(rt, message("m9")))
                self.assertFalse(rt.state._dirty, "a repeat never rewrites state")
            return outcomes

        self.assertEqual(asyncio.run(go()), ["repeat"] * 5)

    def test_sync_loop_sleeps_between_passes_of_repeats(self):
        async def go():
            rt = await self.runtime()
            self.not_due(rt)
            calls, pauses = [], []
            real_sleep = asyncio.sleep

            async def sync(since, retry_ids, known_ids=()):
                calls.append(retry_ids)
                return {"messages": [message("m9")]}

            async def recording_sleep(seconds):
                pauses.append(seconds)
                await real_sleep(0)
            rt.client.sync = sync
            task = asyncio.create_task(intake.sync_loop(rt, sleep=recording_sleep))
            await wait_until(lambda: len(pauses) >= 4, what="four passes")
            await stop(rt, [task])
            return calls, pauses

        calls, pauses = asyncio.run(go())
        self.assertEqual(pauses[:4], [1.0, 2.0, 4.0, intake.IDLE_BACKOFF_MAX_S], "backs off instead of spinning")
        self.assertTrue(all("m9" not in ids for ids in calls), "a not-due retry is not asked for")

    def test_cursor_compares_instants_not_strings(self):
        async def go():
            rt = await self.runtime()
            rt.state.data["lastSeenAt"] = "2026-10-22T10:00:00.500Z"
            await intake.intake(rt, {**message("old"), "createdAt": "2026-10-22T10:00:00Z", "targetAgentId": "x"})
            return rt.state.data["lastSeenAt"]

        self.assertEqual(asyncio.run(go()), "2026-10-22T10:00:00.500Z")


class M7PagingTests(Harness):
    def test_pages_are_fetched_back_to_back_while_has_more(self):
        async def go():
            rt = await self.runtime()
            pages = [{"messages": [message("p1", "t1", "2026-10-22T10:00:01.000Z")], "hasMore": True},
                     {"messages": [message("p2", "t2", "2026-10-22T10:00:02.000Z")], "hasMore": False}]
            stamps, pauses = [], []
            real_sleep = asyncio.sleep

            async def sync(since, retry_ids, known_ids=()):
                stamps.append(since)
                return pages.pop(0) if pages else {"messages": []}

            async def recording_sleep(seconds):
                pauses.append(seconds)
                await real_sleep(0)
            rt.client.sync = sync
            task = asyncio.create_task(intake.sync_loop(rt, sleep=recording_sleep))
            await wait_until(lambda: len(stamps) >= 3, what="three syncs")
            await stop(rt, [task])
            return pauses

        self.assertEqual(asyncio.run(go())[0], 0.0, "no pause after a page with hasMore")

    def test_an_answered_page_moves_the_cursor_to_next_since(self):
        async def go():
            rt = await self.runtime()
            rt.state.data["lastSeenAt"] = "2026-10-22T10:00:00.000Z"
            seen = []

            async def sync(since, retry_ids, known_ids=()):
                seen.append(since)
                if len(seen) == 1:
                    return {"messages": [], "hasMore": True, "nextSince": "2026-10-22T10:05:00.000Z"}
                return {"messages": []}
            rt.client.sync = sync
            task = asyncio.create_task(intake.sync_loop(rt))
            await wait_until(lambda: len(seen) >= 2, what="second page")
            await stop(rt, [task])
            return seen

        self.assertEqual(asyncio.run(go())[1], "2026-10-22T10:05:00.000Z")


class M1ConflictTests(Harness):
    def test_conflict_resubmits_with_the_next_attempt_and_finishes_the_abandoned_run(self):
        async def go():
            rt = await self.runtime()

            async def conflict(turn):
                raise AdmissionConflict("taken")
            rt.runner.run = conflict
            rt.state.put_turn("emp-m0", {"status": "settled"})
            follow = await rt._dispatch_batch(batch_for("hi"))
            return follow, rt

        follow, rt = asyncio.run(go())
        self.assertEqual(follow.submission_id, "emp-m0-r1")
        self.assertIsNone(rt.state.get_turn("emp-m0"), "the stale settled record is dropped")
        self.assertEqual(rt.client.sent, [], "no failure notice")
        self.assertEqual(rt.client.patches()[-1][2]["status"], "cancelled")

    def test_given_up_never_admitted_turn_finishes_its_run_as_failed(self):
        async def go():
            rt = await self.runtime()

            async def refused(turn):
                raise ValueError("invalid_params")
            rt.runner.run = refused
            for _ in range(rt.cfg.max_retry_attempts):
                await rt._dispatch_batch(batch_for("hi"))
            return rt

        rt = asyncio.run(go())
        patches = [p[2] for p in rt.client.patches()]
        self.assertEqual(len(patches), 1, "only the give-up finishes the run (a retry reuses it)")
        self.assertEqual(patches[0]["status"], "failed")


class GatewayRestartDeferTests(Harness):
    def test_a_turn_refused_by_a_restarting_gateway_is_retried_within_seconds(self):
        async def go():
            rt = await self.runtime()

            async def down(turn):
                raise GatewayUnavailable("ws=turns closed")
            rt.runner.run = down
            before = time.time()
            await rt._dispatch_batch(batch_for("hi"))
            return rt.state.data["retries"]["m0"]["nextRetryAt"] - before

        self.assertLess(asyncio.run(go()), 5, "not the 45 s Emperor-outage curve")


class M2StopTests(Harness):
    def test_stopping_a_queued_message_clears_its_retry_entry(self):
        async def go():
            rt = await self.runtime()
            rt.scheduler.pause()
            await intake.intake(rt, message("m1"))
            self.assertIn("m1", rt.state.data["retries"])
            await rt._stop_message("m1")
            return rt

        rt = asyncio.run(go())
        self.assertNotIn("m1", rt.state.data["retries"])
        self.assertNotIn("m1", rt._accepted)


class M4HealthTests(Harness):
    def test_health_is_written_while_housekeeping_hangs(self):
        async def go():
            rt = await self.runtime()
            hang = asyncio.Event()

            async def stuck(*a, **k):
                await hang.wait()
            rt.outbox.flush = stuck
            rt._health_interval_s = 0.02
            rt.write_health()
            first = json.loads(rt.cfg.health_path.read_text())["updatedAt"]
            tasks = [asyncio.create_task(rt._housekeeping_loop()), asyncio.create_task(rt._health_loop())]
            await wait_until(lambda: json.loads(rt.cfg.health_path.read_text())["updatedAt"] > first + 0.03,
                             what="health refresh during a stuck housekeeping")
            hang.set()
            await stop(rt, tasks)

        asyncio.run(go())


class M5CompactionTests(Harness):
    def test_the_slot_is_free_while_compaction_runs_and_the_run_closes_after(self):
        async def go():
            rt = await self.runtime()
            rec = ThreadSession("t1", 1, {"request_id": "r"}, "h", session_id="local-1")
            rt.sessions.get = lambda thread_id: rec
            started, release = asyncio.Event(), asyncio.Event()
            closed = []
            original_close = rt.sink.close_run
            rt.sink.close_run = lambda run_id: (closed.append(run_id), original_close(run_id))

            async def compact(session, *, context_used=None, run_id=None):
                started.set()
                await release.wait()
            rt.compactor.maybe_compact = compact
            await asyncio.wait_for(rt._dispatch_batch(batch_for("first")), TIMEOUT)
            await asyncio.wait_for(started.wait(), TIMEOUT)
            self.assertEqual(closed, [], "the run stays open for the compaction events")
            rt.scheduler.submit(InboundMessage("f1", "t1", raw=message("f1")))
            await wait_until(lambda: any("f1" in t.message_ids for t in self.ran), what="follow-up during compaction")
            release.set()
            await wait_until(lambda: len(closed) == 2, what="both runs closed")

        asyncio.run(go())


class Low1StandbyTests(Harness):
    def test_standby_parks_replies_and_posts_no_notices(self):
        async def go():
            rt = await self.runtime()
            rt.standby_reason = "duplicate runtime other"
            await rt._settle(batch_for("hi"), self.turn_for(rt), [message("m0")], result())
            failed = result(TurnOutcome.FAILED, final_text="", error_code="runtime_restart")
            await rt._settle(batch_for("x"), self.turn_for(rt, "m5"), [message("m5")], failed)
            return rt

        rt = asyncio.run(go())
        self.assertEqual(rt.client.sent, [])
        self.assertTrue(rt.outbox.has_parked("m0"))
        self.assertFalse(any(s.get("execution_state") == "cancelled" for s in rt.client.statuses))


class SameMillisecondCoalesceTests(Harness):
    """v0.9.0 release contract `coalesce`: `second` and `third` were created in the same millisecond
    while `first` ran. The bridge set its cursor to `second`'s createdAt and the fake Emperor used a
    strict `createdAt > since`, so `third` was never returned. The real server (and now the fake)
    re-returns the cursor's millisecond (10 ms slack) and the bridge reports the ids it holds."""

    def test_a_same_millisecond_follow_up_is_picked_up_and_coalesced(self):
        from emperor_bridge.emperor_api import parse_iso

        async def go():
            rt = await self.runtime()
            store = [message("first", created="2026-10-23T10:12:08.671Z")]
            release = asyncio.Event()

            async def run_turn(turn):
                self.ran.append(turn)
                if "first" in turn.message_ids:
                    await release.wait()
                return result()
            rt.runner.run = run_turn
            asked_known = []

            async def sync(since, retry_ids, known_ids=()):
                asked_known.append(list(known_ids))
                cursor = (parse_iso(since) or 0) - 0.010  # the server's cursor slack
                await asyncio.sleep(0)
                return {"messages": [m for m in store if parse_iso(m["createdAt"]) > cursor or m["id"] in retry_ids]}

            async def fast_sleep(_seconds):
                await asyncio.sleep(0.001)
            rt.client.sync = sync
            rt.state.data["lastSeenAt"] = "2026-10-23T10:12:00.000Z"
            task = asyncio.create_task(intake.sync_loop(rt, sleep=fast_sleep))
            await wait_until(lambda: self.ran, what="first running")
            store.append(message("second", created="2026-10-23T10:12:09.480Z"))
            await wait_until(lambda: "second" in rt._accepted, what="second accepted")
            store.append(message("third", created="2026-10-23T10:12:09.480Z"))  # same millisecond
            await wait_until(lambda: "third" in rt._accepted, what="third accepted")
            release.set()
            await wait_until(lambda: len(self.ran) >= 2, what="follow-up turn")
            await stop(rt, [task])
            return self.ran[1], asked_known

        follow_up, asked_known = asyncio.run(go())
        self.assertEqual(follow_up.message_ids, ("second", "third"), "the follow-ups are coalesced")
        self.assertEqual(follow_up.submission_id, "emp-third")
        self.assertTrue(any("first" in ids for ids in asked_known), "the running message is reported as known")


if __name__ == "__main__":
    unittest.main()
