"""Scheduler: per-thread single flight, coalescing, parallel cap, cancel, standby, retry, drain (D9)."""
from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from emperor_bridge.interfaces import SchedulerConfig  # noqa: E402
from emperor_bridge.scheduler import InboundMessage, Scheduler, TurnBatch  # noqa: E402


class Dispatcher:
    def __init__(self) -> None:
        self.batches: list[TurnBatch] = []
        self.gates: dict[str, asyncio.Event] = {}
        self.running = 0
        self.max_running = 0
        self.retry_once: set[str] = set()

    async def __call__(self, batch: TurnBatch):
        self.batches.append(batch)
        self.running += 1
        self.max_running = max(self.max_running, self.running)
        gate = self.gates.setdefault(batch.trigger.id, asyncio.Event())
        try:
            await gate.wait()
        finally:
            self.running -= 1
        if batch.trigger.id in self.retry_once and batch.attempt == 0:
            self.gates[batch.trigger.id] = asyncio.Event()
            self.gates[batch.trigger.id].set()
            return batch.retry()
        return None

    def release(self, message_id: str) -> None:
        self.gates.setdefault(message_id, asyncio.Event()).set()


def msg(mid: str, thread: str) -> InboundMessage:
    return InboundMessage(id=mid, thread_id=thread)


async def settle() -> None:
    for _ in range(5):
        await asyncio.sleep(0)


class SchedulerTest(unittest.IsolatedAsyncioTestCase):
    async def test_single_flight_and_coalescing(self) -> None:
        d = Dispatcher()
        s = Scheduler(d, SchedulerConfig(max_parallel_turns=3))
        s.submit(msg("m1", "t"))
        await settle()
        r2 = s.submit(msg("m2", "t"))
        r3 = s.submit(msg("m3", "t"))
        self.assertFalse(r2.coalesced)
        self.assertTrue(r3.coalesced)
        self.assertEqual(len(d.batches), 1)
        d.release("m1")
        await settle()
        self.assertEqual(d.batches[1].message_ids, ("m2", "m3"))
        self.assertEqual(d.batches[1].submission_id, "emp-m3")
        d.release("m3")
        self.assertTrue(await s.drain(1))

    async def test_parallel_cap(self) -> None:
        d = Dispatcher()
        s = Scheduler(d, SchedulerConfig(max_parallel_turns=2))
        for i in range(4):
            s.submit(msg(f"m{i}", f"t{i}"))
        await settle()
        self.assertEqual(d.running, 2)
        d.release("m0")
        await settle()
        self.assertEqual([b.thread_id for b in d.batches], ["t0", "t1", "t2"])
        for i in range(4):
            d.release(f"m{i}")
        self.assertTrue(await s.drain(1))
        self.assertEqual(d.max_running, 2)

    async def test_duplicate_and_cancel(self) -> None:
        d = Dispatcher()
        s = Scheduler(d, SchedulerConfig(max_parallel_turns=1))
        s.submit(msg("a", "t1"))
        self.assertFalse(s.submit(msg("a", "t1")).accepted)
        s.submit(msg("b", "t2"))
        self.assertTrue(s.cancel("b"))
        self.assertFalse(s.cancel("a"))  # already running
        d.release("a")
        self.assertTrue(await s.drain(1))
        self.assertEqual([b.thread_id for b in d.batches], ["t1"])

    async def test_standby_and_clear(self) -> None:
        d = Dispatcher()
        s = Scheduler(d)
        s.pause()
        s.submit(msg("a", "t1"))
        s.submit(msg("b", "t2"))
        await settle()
        self.assertEqual(d.batches, [])
        self.assertEqual([m.id for m in s.clear_pending()], ["a", "b"])
        s.submit(msg("c", "t3"))
        s.resume()
        await settle()
        self.assertEqual([b.trigger.id for b in d.batches], ["c"])
        d.release("c")
        self.assertTrue(await s.drain(1))

    async def test_retry_runs_in_same_slot(self) -> None:
        d = Dispatcher()
        d.retry_once.add("a")
        s = Scheduler(d)
        s.submit(msg("a", "t"))
        d.release("a")
        self.assertTrue(await s.drain(1))
        self.assertEqual([b.submission_id for b in d.batches], ["emp-a", "emp-a-r1"])

    async def test_drain_times_out_and_refuses_new_work(self) -> None:
        d = Dispatcher()
        s = Scheduler(d)
        s.submit(msg("a", "t"))
        await settle()
        self.assertFalse(await s.drain(0.05))
        self.assertFalse(s.submit(msg("b", "t")).accepted)
        d.release("a")

    async def test_dispatch_error_frees_the_thread(self) -> None:
        calls = []

        async def boom(batch: TurnBatch):
            calls.append(batch.trigger.id)
            raise RuntimeError("boom")

        s = Scheduler(boom)
        s.submit(msg("a", "t"))
        await settle()
        s.submit(msg("b", "t"))
        self.assertTrue(await s.drain(1))
        self.assertEqual(calls, ["a", "b"])


if __name__ == "__main__":
    unittest.main()
