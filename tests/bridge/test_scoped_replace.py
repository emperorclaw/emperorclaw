"""Thread-scoped Replace (private direct-chat mode, 0.9.3): a Replace in one person's own direct
thread touches only that thread; unscoped Replace and Kill stay agent-wide."""
from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BRIDGE_DIR = REPO / "integrations" / "hermes" / "emperor-claw" / "bridge"
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

from emperor_bridge.controls import ControlPlane, command_thread_scope  # noqa: E402
from emperor_bridge.emperor_api import split_control_commands  # noqa: E402
from emperor_bridge.scheduler import InboundMessage, Scheduler  # noqa: E402


class Runner:
    def __init__(self, active):
        self.active = list(active)
        self.interrupted: list[tuple[str, str]] = []

    def active_threads(self):
        return list(self.active)

    def thread_for_message(self, message_id):
        return None

    async def interrupt(self, thread_id, reason="stop"):
        if thread_id in self.active:
            self.interrupted.append((thread_id, reason))
            return True
        return False


class Sessions:
    def __init__(self, threads):
        self.threads = list(threads)
        self.bumped: list[str] = []

    def bump_generation(self, thread_id, reason):
        if thread_id not in self.threads:
            return None
        self.bumped.append(thread_id)
        return 2

    def bump_all(self, reason):
        self.bumped.extend(self.threads)
        return list(self.threads)

    async def save(self):
        pass

    async def close_retired(self):
        return 0


class Emperor:
    def __init__(self):
        self.acks: list[str] = []

    async def ack_control_command(self, command_id):
        self.acks.append(command_id)


def command(action, thread="tA", scope=None, cid="c1", created="2026-10-23T12:00:00.000Z"):
    control = {"action": action, **({"scope": scope} if scope else {})}
    return {"id": cid, "threadId": thread, "createdAt": created, "metadataJson": {"runtimeControl": control}}


def message(mid, thread, created):
    return InboundMessage(mid, thread, raw={"id": mid, "threadId": thread, "createdAt": created})


class ScopedReplaceTests(unittest.TestCase):
    def run_controls(self, commands):
        async def go():
            async def dispatch(batch):
                return None
            scheduler = Scheduler(dispatch)
            scheduler.pause()  # keep everything queued so the drop is observable
            for m in (message("a-old", "tA", "2026-10-23T11:59:00.000Z"),
                      message("a-new", "tA", "2026-10-23T12:00:01.000Z"),
                      message("b-1", "tB", "2026-10-23T11:59:00.000Z")):
                scheduler.submit(m)
            runner, sessions, emperor = Runner(["tA", "tB"]), Sessions(["tA", "tB"]), Emperor()
            resets, kills = [], []

            async def on_kill(action):
                kills.append(action)

            async def on_thread_reset(thread_id):
                resets.append(thread_id)
            plane = ControlPlane(scheduler, runner, sessions, emperor, on_kill=on_kill, on_thread_reset=on_thread_reset)
            outcome = await plane.apply(commands)
            return outcome, scheduler, runner, sessions, emperor, resets, kills

        return asyncio.run(go())

    def test_scoped_replace_touches_only_its_thread(self):
        outcome, scheduler, runner, sessions, emperor, resets, kills = self.run_controls(
            [command("replace", "tA", scope="thread")])
        self.assertEqual(outcome.dropped_messages, ["a-old"], "only that thread's older queued work")
        self.assertTrue(scheduler.has_pending("tA"), "the replacing prompt queued after the command stays")
        self.assertTrue(scheduler.has_pending("tB"), "another person's queue is untouched")
        self.assertEqual(runner.interrupted, [("tA", "replace")])
        self.assertEqual(sessions.bumped, ["tA"], "only that thread's session generation is retired")
        self.assertEqual((emperor.acks, resets, kills), (["c1"], ["tA"], []))

    def test_unscoped_replace_stays_agent_wide(self):
        outcome, scheduler, runner, sessions, emperor, _resets, kills = self.run_controls([command("replace", "tA")])
        self.assertEqual(sorted(outcome.dropped_messages), ["a-new", "a-old", "b-1"])
        self.assertEqual(sorted(t for t, _ in runner.interrupted), ["tA", "tB"])
        self.assertEqual(sorted(sessions.bumped), ["tA", "tB"])
        self.assertEqual(kills, ["replace"])

    def test_kill_is_always_agent_wide(self):
        _outcome, _scheduler, runner, sessions, _emperor, _resets, kills = self.run_controls(
            [command("kill", "tA", scope="thread")])
        self.assertEqual(sorted(t for t, _ in runner.interrupted), ["tA", "tB"])
        self.assertEqual(sorted(sessions.bumped), ["tA", "tB"])
        self.assertEqual(kills, ["kill"])

    def test_a_scoped_replace_with_an_agent_wide_command_goes_agent_wide(self):
        _outcome, _scheduler, runner, _sessions, emperor, _resets, _kills = self.run_controls(
            [command("replace", "tA", scope="thread", cid="c1"), command("kill", "tB", cid="c2")])
        self.assertEqual(sorted(t for t, _ in runner.interrupted), ["tA", "tB"])
        self.assertEqual(sorted(emperor.acks), ["c1", "c2"])

    def test_scope_is_read_from_server_rows_and_fake_commands(self):
        self.assertEqual(command_thread_scope(command("replace", "tA", scope="thread")), "tA")
        self.assertIsNone(command_thread_scope(command("replace", "tA")))
        self.assertIsNone(command_thread_scope(command("kill", "tA", scope="thread")))
        _stops, kills = split_control_commands({"commands": [{"id": "x", "action": "replace", "threadId": "tA",
                                                              "scope": "thread"}]})
        self.assertEqual(command_thread_scope(kills[0]), "tA")


if __name__ == "__main__":
    unittest.main()
