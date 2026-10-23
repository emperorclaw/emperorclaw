"""Objectives in bridge 0.9 (D18): command handling, durable state before acknowledgement, steps
queued through the scheduler, native evaluation (with the saved reply after a restart), budget
pauses and the adapter's launch environment."""
import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "integrations/hermes/emperor-claw/bridge"))

from emperor_bridge.goals import ADAPTER, NativeGoals, Objectives, goal_message_id  # noqa: E402


def run(coro):
    return asyncio.run(coro)


def command(action, cid="c1", **request):
    return {"id": cid, "threadId": "t1", "senderId": "human-1",
            "metadataJson": {"runtimeGoalRequest": {"action": action, **request}}}


class Harness:
    def __init__(self, commands=(), native_fail=False, budget=True, busy=False, session="local-1"):
        self.commands = None if commands is None else list(commands)
        self.acks, self.saves, self.native_calls, self.steps = [], [], [], []
        self.native_fail, self.budget, self.busy, self.session = native_fail, budget, busy, session
        self.data = {}
        self.goals = Objectives(request=self.request, data=self.data, save=self.save, agent_id="a1", native=self.native,
                                session_for=lambda t: self.session, submit_step=self.submit,
                                budget_ok=self.budget_ok, thread_busy=lambda t: self.busy)

    async def request(self, method, path, body=None, query=None, **_):
        if method == "GET":
            if self.commands is None:
                raise ConnectionError("old server")
            commands, self.commands = self.commands, []
            return {"commands": commands}
        self.acks.append((body["commandId"], dict(body["goal"]), len(self.saves)))
        return {"ok": True}

    async def save(self):
        self.saves.append(json.loads(json.dumps(self.data.get("objective"))))

    async def native(self, payload):
        self.native_calls.append(dict(payload))
        if self.native_fail:
            raise RuntimeError("native unavailable")
        action = payload["action"]
        if action == "evaluate":
            return {"status": "active", "turnsUsed": 1, "maxTurns": 3, "shouldContinue": True, "prompt": "keep going",
                    "sessionId": payload["sessionId"], "message": "continue"}
        status = {"start": "active", "status": "active", "resume": "active", "pause": "paused", "clear": "cleared"}[action]
        return {"status": status, "objective": payload.get("objective", "Write a haiku"), "turnsUsed": 0, "maxTurns": 3,
                "sessionId": payload["sessionId"], "prompt": "continue it"}

    async def budget_ok(self):
        return self.budget

    def submit(self, step):
        self.steps.append(step)
        return True


class GoalsTests(unittest.TestCase):
    def test_start_is_persisted_before_acknowledgment_and_keyed_by_the_thread_session(self):
        h = Harness([command("start", objective="Write a haiku", maxTurns=3)])
        run(h.goals.process_commands())
        self.assertEqual(h.native_calls[0]["sessionId"], "local-1")
        self.assertEqual(h.data["objective"]["status"], "active")
        cid, goal, saves_before_ack = h.acks[0]
        self.assertEqual((cid, goal["status"]), ("c1", "active"))
        self.assertGreaterEqual(saves_before_ack, 1)

    def test_old_server_keeps_messaging_and_suspends_goal_dispatch(self):
        h = Harness(None)
        self.assertFalse(run(h.goals.process_commands()))
        self.assertFalse(h.data["goalTransportReady"])
        self.assertIsNone(run(h.goals.run_next()))

    def test_first_step_runs_the_objective_as_a_goal_turn(self):
        h = Harness([command("start", objective="Write a haiku")])
        run(h.goals.process_commands())
        step_id = run(h.goals.run_next())
        step = h.steps[0]
        self.assertEqual(step["id"], step_id)
        self.assertTrue(step["goalTurn"])
        self.assertEqual(step["text"], "Write a haiku")
        self.assertEqual(step["replyToMessageId"], "c1")
        self.assertEqual(h.data["objective"]["stepQueued"], step_id)
        self.assertIsNone(run(h.goals.run_next()), "one step at a time")

    def test_step_reply_is_saved_before_the_judge_and_then_judged_once(self):
        h = Harness([command("start", objective="x")])
        run(h.goals.process_commands())
        step_id = run(h.goals.run_next())
        run(h.goals.after_step(step_id, "a haiku", True))
        self.assertTrue(any(s and s.get("pendingEvaluation") == "a haiku" for s in h.saves))
        evaluations = [c for c in h.native_calls if c["action"] == "evaluate"]
        self.assertEqual(len(evaluations), 1)
        self.assertEqual(evaluations[0]["response"], "a haiku")
        self.assertNotIn("pendingEvaluation", h.data["objective"])
        self.assertEqual(h.data["objective"]["prompt"], "keep going")

    def test_restart_judges_the_saved_reply_without_running_the_model_again(self):
        h = Harness([])
        h.data.update(goalTransportReady=True, objective={"status": "active", "sessionId": "local-1", "threadId": "t1",
                                                          "commandId": "c1", "pendingEvaluation": "saved reply"})
        self.assertIsNone(run(h.goals.run_next()))
        self.assertEqual(h.steps, [])
        self.assertEqual([c["response"] for c in h.native_calls if c["action"] == "evaluate"], ["saved reply"])

    def test_new_generation_migrates_the_goal_session(self):
        h = Harness([command("start", objective="x")], session="local-1")
        run(h.goals.process_commands())
        h.session = "local-2"
        run(h.goals.run_next())
        status = [c for c in h.native_calls if c["action"] == "status"][0]
        self.assertEqual((status["sessionId"], status["previousSession"]), ("local-2", "local-1"))

    def test_budget_pause_is_durable_and_published(self):
        h = Harness([command("start", objective="x")])
        run(h.goals.process_commands())
        h.budget = False
        run(h.goals.run_next())
        self.assertEqual(h.data["objective"]["status"], "paused")
        self.assertIn("budget", h.acks[-1][1]["message"])
        self.assertEqual(h.steps, [])

    def test_native_failure_pauses_instead_of_retry_loop(self):
        h = Harness([command("start", objective="x")])
        run(h.goals.process_commands())
        h.native_fail = True
        run(h.goals.run_next())
        self.assertEqual(h.data["objective"]["status"], "paused")

    def test_pause_is_applied_locally_even_when_native_fails(self):
        h = Harness([command("start", objective="x")])
        run(h.goals.process_commands())
        h.native_fail = True
        h.commands = [command("pause", cid="c2")]
        run(h.goals.process_commands())
        self.assertEqual(h.data["objective"]["status"], "paused")
        self.assertEqual(h.acks[-1][0], "c2")

    def test_start_during_a_running_step_is_rejected(self):
        h = Harness([command("start", objective="x")])
        run(h.goals.process_commands())
        h.commands = [command("resume", cid="c3")]
        run(h.goals.process_commands(active_threads=("t1",)))
        self.assertIn("Wait for current work", h.acks[-1][1]["message"])

    def test_replayed_command_is_acknowledged_without_resetting(self):
        h = Harness([command("start", objective="x")])
        run(h.goals.process_commands())
        calls = len(h.native_calls)
        h.commands = [command("start", objective="x")]
        run(h.goals.process_commands())
        self.assertEqual(len(h.native_calls), calls)
        self.assertEqual(h.acks[-1][0], "c1")

    def test_failed_step_pauses(self):
        h = Harness([command("start", objective="x")])
        run(h.goals.process_commands())
        step_id = run(h.goals.run_next())
        run(h.goals.after_step(step_id, None, False))
        self.assertEqual(h.data["objective"]["status"], "paused")

    def test_other_conversation_does_not_affect_the_objective(self):
        h = Harness([command("start", objective="x")])
        run(h.goals.process_commands())
        run(h.goals.record_external_turn("another-thread", "reply"))
        self.assertFalse([c for c in h.native_calls if c["action"] == "evaluate"])
        run(h.goals.record_external_turn("t1", "reply"))
        self.assertTrue([c for c in h.native_calls if c["action"] == "evaluate"])

    def test_step_ids_are_unique_per_turn(self):
        self.assertNotEqual(goal_message_id({"commandId": "c1", "turnsUsed": 0}),
                            goal_message_id({"commandId": "c1", "turnsUsed": 1}))


class NativeAdapterTests(unittest.TestCase):
    def test_adapter_ships_beside_the_package(self):
        self.assertTrue(ADAPTER.exists())
        self.assertIn('os.environ["HERMES_DISABLE_LAZY_INSTALLS"] = "1"', ADAPTER.read_text(encoding="utf-8"))

    def test_native_runner_passes_checkout_home_and_payload(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp) / "adapter.py"
            fake.write_text("import json, os, sys\np = json.load(sys.stdin)\nprint('noise')\n"
                            "print(json.dumps({'status': 'active', 'home': os.environ['HERMES_HOME'],"
                            " 'pp': os.environ['PYTHONPATH'], 'lazy': os.environ['HERMES_DISABLE_LAZY_INSTALLS'],"
                            " 'action': p['action']}))\n")
            native = NativeGoals(python=sys.executable, checkout=Path(tmp), profile_home=Path(tmp) / "home", adapter=fake)
            out = run(native({"action": "status", "sessionId": "s"}))
        self.assertEqual((out["action"], out["lazy"]), ("status", "1"))
        self.assertTrue(out["home"].endswith("home"))
        self.assertEqual(out["pp"], tmp)

    def test_unavailable_answer_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp) / "adapter.py"
            fake.write_text("import json\nprint(json.dumps({'status': 'unavailable', 'message': 'no'}))\n")
            native = NativeGoals(python=sys.executable, checkout=Path(tmp), profile_home=Path(tmp), adapter=fake)
            with self.assertRaises(RuntimeError):
                run(native({"action": "status", "sessionId": "s"}))


if __name__ == "__main__":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    unittest.main()
