"""Hermes -> Emperor event mapping (section 4.3), redaction, throttles and the batching sink."""
from __future__ import annotations

import asyncio
import json
import sys
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_sessions import fixture_events  # noqa: E402

from emperor_bridge.events import EventMapper, EventSink, map_frame, redact  # noqa: E402
from emperor_bridge.interfaces import (EmperorEvent, EmperorUnavailable, EventSinkConfig, GatewayEvent,  # noqa: E402
                                       RunGone, RunNotFound)

RUN_ID = "0b6f4a1e-5d6c-4e1a-9f3c-2a1b3c4d5e6f"


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def ev(type_: str, payload: dict[str, Any], seq: int = 1, **env: Any) -> GatewayEvent:
    return GatewayEvent.from_params({"type": type_, "payload": payload, "seq": seq, "replay_epoch": "ep",
                                     "session_id": "s", "admission_id": "a", **env})


def map_fixture(name: str) -> tuple[EventMapper, list[EmperorEvent]]:
    clock = Clock()
    mapper = EventMapper(clock=clock)
    mapper.submitted_at = clock.now
    out: list[EmperorEvent] = []
    for params in fixture_events(name):
        clock.now += 0.01
        out.extend(map_frame(params, mapper))
    out.extend(mapper.finish())
    return mapper, out


class FixtureMappingTest(unittest.TestCase):
    def test_normal_turn_kinds(self) -> None:
        mapper, out = map_fixture("normal_turn")
        kinds = [e.kind for e in out]
        self.assertEqual(kinds, ["turn.started", "reasoning", "usage"])
        usage = out[-1].data
        self.assertEqual(usage["input"], 100)
        self.assertEqual(usage["contextMax"], 128000)
        self.assertEqual(usage["cacheRead"], 0)
        self.assertEqual(mapper.steps, 1)
        self.assertIsNotNone(mapper.first_token_at)

    def test_not_forwarded_types(self) -> None:
        _, out = map_fixture("compress")
        kinds = {e.kind for e in out}
        self.assertTrue(kinds <= {"turn.started", "reasoning", "usage", "notice"})

    def test_tool_turn(self) -> None:
        mapper, out = map_fixture("tool_turn_three_tools")
        kinds = [e.kind for e in out]
        self.assertEqual(kinds.count("tool.start"), 3)
        self.assertEqual(kinds.count("tool.end"), 3)
        self.assertNotIn("tool.prepare", kinds)
        self.assertEqual(mapper.tool_calls, 3)
        self.assertTrue(mapper.saw_tool)
        end = next(e for e in out if e.kind == "tool.end")
        self.assertEqual((end.status, end.duration_ms, end.summary), ("ok", 56, "hostname"))
        self.assertIsNone(end.data)  # no preview for successful tools

    def test_reasoning_turn(self) -> None:
        _, out = map_fixture("reasoning_turn")
        reasoning = [e for e in out if e.kind == "reasoning"]
        self.assertEqual(len(reasoning), 1)
        self.assertEqual(reasoning[0].summary, "fake chain of thought about the question")

    def test_event_ids_are_stable_per_hermes_seq(self) -> None:
        _, first = map_fixture("tool_turn_three_tools")
        _, second = map_fixture("tool_turn_three_tools")
        self.assertEqual([e.to_wire(RUN_ID, i)["id"] for i, e in enumerate(first)],
                         [e.to_wire(RUN_ID, i)["id"] for i, e in enumerate(second)])


class ThrottleAndShapeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = Clock()
        self.mapper = EventMapper(clock=self.clock)

    def test_tool_prepare_only_when_start_is_late(self) -> None:
        self.assertEqual(self.mapper.map(ev("tool.generating", {"name": "terminal"})), [])
        self.clock.now += 2.5
        out = self.mapper.tick()
        self.assertEqual([e.kind for e in out], ["tool.prepare"])
        self.assertEqual(out[0].tool_name, "terminal")

    def test_tool_error_preview_redacted(self) -> None:
        out = self.mapper.map(ev("tool.complete", {
            "tool_id": "c1", "name": "terminal", "context": "curl api", "is_error": True, "duration_s": 1.2346,
            "result": json.dumps({"error": "401 for Bearer abcdefghijklmnopqrstuvwxyz0123\nsecond line"})}))
        end = out[0]
        self.assertEqual((end.status, end.duration_ms), ("error", 1235))
        self.assertIn("[redacted]", end.data["preview"])
        self.assertNotIn("abcdefghijklmnop", end.data["preview"])
        self.assertNotIn("second line", end.data["preview"])

    def test_usage_one_per_five_seconds_plus_last(self) -> None:
        kinds = []
        for i in range(5):
            kinds += [e.kind for e in self.mapper.map(ev("session.usage", {"usage": {"input": i}}, seq=i + 1))]
            self.clock.now += 1
        self.assertEqual(kinds, ["usage"])
        last = self.mapper.finish()
        self.assertEqual(last[0].data["input"], 4)

    def test_notice_throttle_releases_on_tick(self) -> None:
        out = self.mapper.map(ev("agent.print", {"text": "retrying"}, seq=1))
        out += self.mapper.map(ev("agent.print", {"text": "retrying again"}, seq=2))
        self.assertEqual([e.summary for e in out], ["retrying"])
        self.clock.now += 2.1
        self.assertEqual([e.summary for e in self.mapper.tick()], ["retrying again"])

    def test_approval_and_clarify_and_status(self) -> None:
        out = self.mapper.map(ev("approval.request", {"prompt_id": "p", "command": "rm -rf build"}))
        out += self.mapper.map(ev("clarify.request", {"prompt_id": "q", "question": "Which repo?"}, seq=2))
        out += self.mapper.map(ev("status.update", {"kind": "compacting", "text": "Compacting"}, seq=3))
        self.assertEqual([e.kind for e in out], ["approval.auto", "clarify.auto", "status"])
        self.assertEqual(out[2].data, {"kind": "compacting"})

    def test_subagent_and_unknown_types(self) -> None:
        out = self.mapper.map(ev("subagent.start", {"name": "researcher"}))
        out += self.mapper.map(ev("subagent.complete", {"name": "researcher", "duration_s": 2}, seq=2))
        out += self.mapper.map(ev("some.future.event", {}, seq=3))
        self.assertEqual([e.kind for e in out], ["subagent.start", "subagent.end"])
        self.assertEqual(out[1].duration_ms, 2000)

    def test_redact(self) -> None:
        text = "key sk-proj-abcdefghijklmnop123 and password=hunter22 at postgres://u:pw@db/x"
        clean = redact(text, 500)
        for secret in ("abcdefghijklmnop", "hunter22", ":pw@"):
            self.assertNotIn(secret, clean)
        self.assertEqual(len(redact("x" * 900, 120)), 120)
        self.assertIsNone(redact("   ", 10))

    def test_wire_shape(self) -> None:
        event = self.mapper.bridge_event("turn.completed", status="ok", duration_ms=5, data={"steps": 2, "x": None})
        wire = event.to_wire(RUN_ID, 7)
        self.assertEqual(set(wire), {"id", "seq", "ts", "kind", "status", "durationMs", "data"})
        self.assertEqual(wire["data"], {"steps": 2})
        self.assertTrue(wire["ts"].endswith("Z"))


class ScriptedEmperor:
    def __init__(self, script: list[Any]) -> None:
        self.script = script
        self.calls: list[dict[str, Any]] = []

    async def post_run_events(self, run_id, events, run_header=None):
        self.calls.append({"run": run_header, "events": list(events)})
        step = self.script.pop(0) if self.script else None
        if isinstance(step, Exception):
            raise step
        return {"accepted": len(events)}

    async def ack_control_command(self, command_id: str) -> None:
        pass


class EventSinkTest(unittest.IsolatedAsyncioTestCase):
    def _events(self, n: int, kind: str = "notice") -> list[EmperorEvent]:
        return [EmperorEvent(kind=kind, ts="2026-10-22T00:00:00.000Z", source_key=f"k{i}", summary=str(i))
                for i in range(n)]

    async def test_header_first_batch_then_batches_of_fifty(self) -> None:
        emperor = ScriptedEmperor([])
        sink = EventSink(emperor, EventSinkConfig(batch_max=50))
        sink.open_run(RUN_ID, {"id": RUN_ID})
        for e in self._events(120):
            sink.emit(RUN_ID, e)
        self.assertTrue(await sink.flush())
        self.assertEqual([len(c["events"]) for c in emperor.calls], [50, 50, 20])
        self.assertEqual(emperor.calls[0]["run"], {"id": RUN_ID})
        self.assertIsNone(emperor.calls[1]["run"])
        self.assertEqual(emperor.calls[2]["events"][-1]["seq"], 119)

    async def test_run_not_found_resends_with_header(self) -> None:
        emperor = ScriptedEmperor([None, RunNotFound("409")])
        sink = EventSink(emperor)
        sink.open_run(RUN_ID, {"id": RUN_ID})
        sink.emit(RUN_ID, self._events(1)[0])
        await sink.flush()
        sink.emit(RUN_ID, self._events(1)[0])
        await sink.flush()
        self.assertEqual([c["run"] is not None for c in emperor.calls], [True, False, True])

    async def test_unavailable_keeps_events_and_gone_drops(self) -> None:
        emperor = ScriptedEmperor([EmperorUnavailable("down")])
        sink = EventSink(emperor)
        sink.open_run(RUN_ID, {"id": RUN_ID})
        sink.emit(RUN_ID, self._events(1)[0])
        self.assertFalse(await sink.flush())
        self.assertEqual(sink.pending_count(), 1)
        emperor.script = [RunGone("410")]
        self.assertTrue(await sink.flush())
        self.assertEqual(sink.pending_count(), 0)
        sink.emit(RUN_ID, self._events(1)[0])  # ignored once gone
        self.assertEqual(sink.pending_count(), 0)

    async def test_spool_cap_drops_droppable_first(self) -> None:
        sink = EventSink(ScriptedEmperor([]), EventSinkConfig(spool_cap=10))
        sink.open_run(RUN_ID, {"id": RUN_ID})
        for e in self._events(5, "tool.start") + self._events(8, "reasoning"):
            sink.emit(RUN_ID, e)
        self.assertEqual(sink.pending_count(), 10)
        self.assertEqual(sink.dropped(RUN_ID), 3)
        kinds = [k for k, _ in sink._runs[RUN_ID].pending]
        self.assertEqual(kinds.count("tool.start"), 5)

    async def test_close_run_after_flush(self) -> None:
        sink = EventSink(ScriptedEmperor([]))
        sink.open_run(RUN_ID, {"id": RUN_ID})
        sink.emit(RUN_ID, self._events(1)[0])
        sink.close_run(RUN_ID)
        await sink.flush()
        self.assertNotIn(RUN_ID, sink._runs)

    async def test_background_loop_flushes(self) -> None:
        emperor = ScriptedEmperor([])
        sink = EventSink(emperor, EventSinkConfig(flush_ms=10))
        await sink.start()
        sink.open_run(RUN_ID, {"id": RUN_ID})
        sink.emit(RUN_ID, self._events(1)[0])
        await asyncio.sleep(0.1)
        await sink.stop()
        self.assertEqual(len(emperor.calls), 1)


if __name__ == "__main__":
    unittest.main()
