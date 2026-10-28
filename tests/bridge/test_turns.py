"""TurnRunner driven end to end by the recorded gateway fixtures (D5, D10, D12, D14, D15, D16)."""
from __future__ import annotations

import asyncio
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_sessions import FixtureGateway, policy  # noqa: E402

from emperor_bridge import turn_context  # noqa: E402
from emperor_bridge.events import EventSink  # noqa: E402
from emperor_bridge.gateway.sessions import SessionManager  # noqa: E402
from emperor_bridge.interfaces import (AgentIdentity, EventSinkConfig, TurnAuthor, Turn, TurnConfig,  # noqa: E402
                                       TurnOutcome)
from emperor_bridge.state import BridgeState  # noqa: E402
from emperor_bridge.turns import TurnRunner  # noqa: E402


class FakeEmperor:
    def __init__(self) -> None:
        self.posts: list[dict[str, Any]] = []
        self.acks: list[str] = []

    async def post_run_events(self, run_id, events, run_header=None):
        self.posts.append({"run_id": run_id, "events": list(events), "run": run_header})
        return {"accepted": len(events)}

    async def ack_control_command(self, command_id: str) -> None:
        self.acks.append(command_id)

    def events(self, run_id: Optional[str] = None) -> list[dict[str, Any]]:
        return [e for p in self.posts if run_id in (None, p["run_id"]) for e in p["events"]]

    def kinds(self, run_id: Optional[str] = None) -> list[str]:
        return [e["kind"] for e in self.events(run_id)]


class Harness:
    def __init__(self, fixture: str, home: Path) -> None:
        self.home = home
        self.gw = FixtureGateway(fixture, home)
        self.link = self.gw.link()
        self.state = BridgeState.load(home / "emperor" / "bridge-state.json", agent_id="probe-agent")
        self.sessions = SessionManager(self.link, self.state, agent_id="probe-agent", profile_home=home)
        self.emperor = FakeEmperor()
        self.sink = EventSink(self.emperor, EventSinkConfig())
        agent = AgentIdentity(agent_id="probe-agent", agent_name="Probe", runtime_id="rt-1", bridge_version="0.9.0",
                              profile=self.gw.target)
        self.runner = TurnRunner(self.link, self.sessions, self.state, self.sink, agent=agent,
                                 config=TurnConfig(tick_s=0.02, rpc_timeout_s=5))
        self.turn_file_at_submit: Optional[dict] = None
        self.gw.hooks.append(self._hook)
        self.thread_id = ""

    def _hook(self, method: str, params: dict) -> None:
        if method == "prompt.submit" and self.thread_id and self.turn_file_at_submit is None:
            self.turn_file_at_submit = turn_context.read(self.home, self.thread_id)

    def turn(self, thread_id: str, message_id: str = "11111111-2222-3333-4444-555555555555", **kw: Any) -> Turn:
        self.thread_id = thread_id
        return Turn(thread_id=thread_id, trigger_id=message_id, text="hello fixture",
                    api_text="[emperor msg=11111111 from=Jose (human) at=10:00 UTC]\nhello fixture",
                    policy=policy(), message_ids=(message_id,),
                    author=TurnAuthor(id="user-1", name="Jose"), **kw)

    async def __aenter__(self) -> "Harness":
        await self.link.start()
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.link.close()

    async def wait_for(self, predicate, timeout: float = 5.0) -> None:
        deadline = asyncio.get_running_loop().time() + timeout
        while not predicate():
            if asyncio.get_running_loop().time() > deadline:
                raise AssertionError("condition not reached")
            await asyncio.sleep(0.01)


class TurnRunnerFixtureTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)

    async def asyncTearDown(self) -> None:
        self.tmp.cleanup()

    async def test_normal_turn(self) -> None:
        async with Harness("normal_turn", self.home) as h:
            turn = h.turn("fx-normal")
            result = await asyncio.wait_for(h.runner.run(turn), 10)
            await h.sink.flush()
        self.assertIs(result.outcome, TurnOutcome.COMPLETED)
        self.assertTrue(result.final_text.startswith("pong: [ctx thread=fx-normal]"))
        self.assertEqual(result.exit_reason, "text_response(finish_reason=stop)")
        u = result.usage
        self.assertEqual((u.input_tokens, u.output_tokens, u.api_calls, u.model, u.provider),
                         (100, 20, 1, "fake-model", "custom"))
        self.assertEqual(u.cost_status, "unknown")
        self.assertIsNone(u.cost_cents)
        self.assertEqual(result.admission_id, "ec10dd88fc254e51ab2afdc82923aa81")
        self.assertEqual(result.execution_generation, 1)
        self.assertIsNotNone(result.queue_ms)
        self.assertEqual(result.steps, 1)
        self.assertFalse(result.saw_tool)
        submit = h.gw.requests("prompt.submit")[0]["params"]
        self.assertEqual(submit["submission_id"], f"emp-{turn.trigger_id}")
        self.assertEqual(submit["text"], "hello fixture")
        self.assertTrue(submit["api_text"].endswith("hello fixture"))
        self.assertEqual(submit["turn_author"]["name"], "Jose")
        receipt = h.gw.requests("prompt.receipt")[0]["params"]
        self.assertTrue(receipt["include_result"])
        # the turn file existed at submit and is gone after the turn
        self.assertEqual(h.turn_file_at_submit["messageId"], turn.trigger_id)
        self.assertEqual(h.turn_file_at_submit["sessionGeneration"], "1")
        self.assertIsNone(turn_context.read(self.home, "fx-normal"))
        kinds = h.emperor.kinds(turn.run_id)
        self.assertEqual(kinds[0], "turn.queued")
        self.assertIn("turn.started", kinds)
        self.assertIn("usage", kinds)
        self.assertEqual(kinds.count("reasoning"), 1)  # reasoning.available, no deltas
        self.assertEqual(kinds[-1], "turn.completed")
        seqs = [e["seq"] for e in h.emperor.events(turn.run_id)]
        self.assertEqual(seqs, list(range(len(seqs))))
        self.assertEqual(h.emperor.posts[0]["run"]["id"], turn.run_id)
        self.assertEqual(h.emperor.posts[0]["run"]["triggerMessageId"], turn.trigger_id)
        terminal = h.emperor.events(turn.run_id)[-1]
        self.assertEqual(terminal["data"]["exitReason"], "text_response(finish_reason=stop)")
        record = h.state.get_turn(turn.submission_id)
        self.assertEqual(record["status"], "settled")
        self.assertEqual(record["nextEventSeq"], len(seqs))

    async def test_three_tool_turn(self) -> None:
        async with Harness("tool_turn_three_tools", self.home) as h:
            turn = h.turn("fx-tools")
            result = await asyncio.wait_for(h.runner.run(turn), 10)
            await h.sink.flush()
        self.assertIs(result.outcome, TurnOutcome.COMPLETED)
        self.assertEqual(result.tool_calls, 3)
        self.assertTrue(result.saw_tool)
        self.assertEqual(result.steps, 4)
        self.assertEqual(result.usage.api_calls, 4)
        events = h.emperor.events(turn.run_id)
        starts = [e for e in events if e["kind"] == "tool.start"]
        ends = [e for e in events if e["kind"] == "tool.end"]
        self.assertEqual([e["toolName"] for e in starts], ["read_file", "envprobe_dump", "read_file"])
        self.assertEqual([e.get("summary") for e in starts], ["hostname", None, "os-release"])
        self.assertEqual(ends[0]["durationMs"], 56)
        self.assertEqual(ends[0]["status"], "ok")
        self.assertEqual(ends[0]["toolCallId"], "call_fake_11")
        self.assertNotIn("tool.prepare", [e["kind"] for e in events])  # tool.start followed within 2 s
        for e in starts:
            self.assertNotIn("args", json.dumps(e))
        self.assertTrue(h.state.get_turn(turn.submission_id)["sawTool"])

    async def test_reasoning_deltas_coalesce(self) -> None:
        async with Harness("reasoning_turn", self.home) as h:
            turn = h.turn("fx-reason")
            result = await asyncio.wait_for(h.runner.run(turn), 10)
            await h.sink.flush()
        self.assertEqual(result.final_text, "reasoned answer")
        reasoning = [e for e in h.emperor.events(turn.run_id) if e["kind"] == "reasoning"]
        self.assertEqual(len(reasoning), 1)
        self.assertEqual(reasoning[0]["summary"], "fake chain of thought about the question")
        self.assertIsNotNone(result.first_token_ms)

    async def _interrupted(self, fixture: str, thread: str) -> tuple[Harness, Any, Turn]:
        h = Harness(fixture, self.home)
        async with h:
            turn = h.turn(thread)
            task = asyncio.create_task(h.runner.run(turn))
            await h.wait_for(lambda: h.runner._by_thread.get(thread) is not None
                             and h.runner._by_thread[thread].execution_generation is not None)
            self.assertTrue(await h.runner.interrupt(thread))
            result = await asyncio.wait_for(task, 10)
            await h.sink.flush()
        return h, result, turn

    async def test_interrupt_while_streaming(self) -> None:
        h, result, turn = await self._interrupted("interrupted_turn_streaming", "fx-int")
        interrupt = h.gw.requests("session.interrupt")[0]["params"]
        self.assertEqual(interrupt["execution_generation"], 1)  # from message.start (D10)
        self.assertIs(result.outcome, TurnOutcome.CANCELLED)
        self.assertIsNone(result.error_code)
        kinds = h.emperor.kinds(turn.run_id)
        self.assertEqual(kinds[-1], "turn.interrupted")
        notices = [e for e in h.emperor.events(turn.run_id) if e["kind"] == "notice"]
        self.assertIn("Interrupted during API call", notices[0]["summary"])

    async def test_interrupt_while_provider_hangs(self) -> None:
        h, result, turn = await self._interrupted("interrupted_turn_hang", "fx-hang")
        self.assertIs(result.outcome, TurnOutcome.CANCELLED)
        self.assertTrue(result.final_text.startswith("Operation interrupted"))

    async def test_provider_drop_recovers(self) -> None:
        async with Harness("provider_drop_mid_stream", self.home) as h:
            turn = h.turn("fx-drop")
            result = await asyncio.wait_for(h.runner.run(turn), 10)
            await h.sink.flush()
        self.assertIs(result.outcome, TurnOutcome.COMPLETED)
        notices = [e["summary"] for e in h.emperor.events(turn.run_id) if e["kind"] == "notice"]
        self.assertTrue(any("Response truncated" in n for n in notices))

    async def test_reconnect_replays_missed_events(self) -> None:
        async with Harness("reconnect_replay", self.home) as h:
            turn = h.turn("fx-replay")
            result = await asyncio.wait_for(h.runner.run(turn), 10)
            await h.sink.flush()
        self.assertIs(result.outcome, TurnOutcome.COMPLETED)
        self.assertEqual(h.link.reconnects, 1)
        since = h.gw.requests("session.events.since")[0]["params"]
        self.assertEqual(since["last_sequence"], 10)  # last seq seen before the drop
        self.assertEqual(since["replay_epoch"], "dea07176e12f4f0995492fec4bbf8811")
        self.assertEqual(h.gw.requests("session.resume")[0]["params"]["session_id"][:10], "local-1bad")
        self.assertFalse(result.restart_path)
        kinds = h.emperor.kinds(turn.run_id)
        self.assertEqual(kinds.count("turn.started"), 1)
        self.assertEqual(kinds[-1], "turn.completed")
        source_ids = [e["id"] for e in h.emperor.events(turn.run_id)]
        self.assertEqual(len(source_ids), len(set(source_ids)))

    async def test_events_buffered_before_admission_survive_slow_state_save(self) -> None:
        """Events that arrive before the prompt.submit answer must not be lost when the turn
        settles (here: reconnect + replay of message.complete) while the admission is being saved."""
        h = Harness("reconnect_replay", self.home)
        real_save, gated = h.state.save, []

        async def slow_save() -> None:
            tracker = h.runner._by_thread.get("fx-replay")
            if not gated and tracker is not None and tracker.admission_id is not None:
                gated.append(True)  # the save right after admission: hold it until the turn completes
                await h.wait_for(tracker.done.is_set)
            await real_save()

        h.state.save = slow_save  # type: ignore[method-assign]
        async with h:
            turn = h.turn("fx-replay")
            result = await asyncio.wait_for(h.runner.run(turn), 10)
            await h.sink.flush()
        self.assertTrue(gated)
        self.assertIs(result.outcome, TurnOutcome.COMPLETED)
        kinds = h.emperor.kinds(turn.run_id)
        self.assertEqual(kinds.count("turn.started"), 1)
        self.assertEqual(kinds.count("reasoning"), 1)  # thinking.delta seq 6-7, buffered too
        self.assertEqual(kinds[-1], "turn.completed")
        self.assertIsNotNone(result.queue_ms)

    async def test_gateway_sigkill_resolves_unknown_without_retry_after_tool(self) -> None:
        async with Harness("gateway_kill9_mid_turn", self.home) as h:
            turn = h.turn("fx-kill")
            task = asyncio.create_task(h.runner.run(turn))
            await h.wait_for(lambda: h.runner._by_thread.get("fx-kill") is not None
                             and h.runner._by_thread["fx-kill"].admission_id is not None)
            sid = h.runner._by_thread["fx-kill"].session.session_id
            # The recording queued a second admission behind the killed one; replay that request.
            await h.link.turns.call("prompt.submit", {"session_id": sid, "submission_id": "emp-fx-kill-q",
                                                      "text": "queued behind the killed turn"})
            result = await asyncio.wait_for(task, 10)
            await h.sink.flush()
        self.assertIs(result.outcome, TurnOutcome.FAILED)
        self.assertEqual(result.error_code, "runtime_restart")
        self.assertTrue(result.saw_tool)
        self.assertFalse(result.retry_advised)  # a tool ran: no automatic retry (D15)
        self.assertTrue(result.restart_path)
        resolve = h.gw.requests("prompt.resolve_unknown")[0]["params"]
        self.assertEqual(resolve["admission_id"], "65ff785a6c0b4040bba35bfd60d22193")
        self.assertEqual(resolve["execution_generation"], 1)
        self.assertEqual(h.emperor.kinds(turn.run_id)[-1], "turn.failed")
        reasoning_calls = [f for f in h.gw.requests("config.set") if f["params"]["key"] == "show_reasoning"]
        self.assertGreaterEqual(len(reasoning_calls), 2)  # re-set after the restart (D12)

    async def test_restart_path_delivers_turn_that_completed_during_drain(self) -> None:
        """R-4: a gateway restart closes the sockets, but a short turn still completes in the drain."""
        h = Harness("reconnect_replay", self.home)
        meta = h.gw.segments[1][0]
        meta["instance_id"], meta["authority_epoch"] = "restarted-instance", 3
        async with h:
            turn = h.turn("fx-replay")
            result = await asyncio.wait_for(h.runner.run(turn), 10)
        self.assertIs(result.outcome, TurnOutcome.COMPLETED)
        self.assertTrue(result.restart_path)
        self.assertFalse(result.retry_advised)
        self.assertEqual(h.gw.requests("session.events.since"), [])  # replay ring is gone after a restart
        self.assertEqual(len(h.gw.requests("prompt.submit")), 1)  # never re-submitted

    async def test_recover_after_bridge_restart(self) -> None:
        # First process: submit, then "crash" before message.complete is processed.
        h = Harness("reconnect_replay", self.home)
        # The first recorded connection drops mid-turn. Offer only that one, so the first
        # process cannot reconnect and finish the turn before the simulated crash.
        h.gw.segments = h.gw.segments[:1]
        async with h:
            turn = h.turn("fx-replay")
            task = asyncio.create_task(h.runner.run(turn))
            await h.wait_for(lambda: h.state.get_turn(turn.submission_id) is not None
                             and h.state.get_turn(turn.submission_id).get("admissionId"))
            await h.state.save()
            # The "crash" point: keep the state as persisted now. The replayed turn may
            # finish before the cancel lands (seen on Python 3.14), which must not change
            # what the second process starts from.
            emperor_dir = self.home / "emperor"
            crashed = self.home / "emperor-at-crash"
            shutil.copytree(emperor_dir, crashed)  # state, outbox and receipts as of the crash
            task.cancel()
            try:
                await task
            except BaseException:
                pass
        shutil.rmtree(emperor_dir)
        shutil.copytree(crashed, emperor_dir)
        # Second process: a new harness on the persisted state, replaying the second connection.
        h2 = Harness("reconnect_replay", self.home)
        h2.gw.index = 0  # the next connect uses the recording's reconnect segment
        h2.gw.segments = h2.gw.segments  # noqa: PLW0127 (explicit for readers)
        async with h2:
            recovered = await asyncio.wait_for(h2.runner.recover(h2.state.open_turns()), 10)
            await h2.sink.flush()
        self.assertEqual(len(recovered), 1)
        self.assertIs(recovered[0].result.outcome, TurnOutcome.COMPLETED)
        self.assertTrue(recovered[0].result.restart_path)


if __name__ == "__main__":
    unittest.main()
