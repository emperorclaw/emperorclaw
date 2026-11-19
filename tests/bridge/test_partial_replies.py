"""Preview transport is bounded, coalesces updates and never controls durable delivery."""
import asyncio
import unittest
from types import SimpleNamespace
from uuid import uuid4
from emperor_bridge.partial_replies import PartialReplies, MAX_BYTES


class PartialReplyTests(unittest.IsolatedAsyncioTestCase):
    async def test_coalesces_and_finishes_with_stable_identity(self):
        calls = []
        async def request(*args, **kwargs):
            calls.append(args[2])
            return {"accepted": True}
        previews = PartialReplies(request, "agent", lambda: True)
        run = str(uuid4())
        for word in ("Hello", " world", "!"):
            previews.event(run, SimpleNamespace(type="message.delta", payload={"text": word}))
        await asyncio.sleep(.3)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["text"], "Hello world!")
        previews.finish(run, "Final **answer**")
        await asyncio.sleep(.6)
        self.assertEqual(calls[-1]["text"], "Final **answer**")
        self.assertEqual(calls[-1]["responseId"], calls[0]["responseId"])
        self.assertEqual(calls[-1]["state"], "completed")
        self.assertNotIn(run, previews.runs)
        await previews.close()

    async def test_interim_seals_one_segment_before_next_text(self):
        calls = []
        async def request(*args, **kwargs):
            calls.append(args[2])
        previews = PartialReplies(request, "agent", lambda: True)
        run = str(uuid4())
        previews.event(run, SimpleNamespace(type="message.delta", payload={"text": "First"}))
        previews.event(run, SimpleNamespace(type="message.interim", payload={"text": "First segment"}))
        previews.event(run, SimpleNamespace(type="message.delta", payload={"text": "Second"}))
        await asyncio.sleep(.6)
        self.assertEqual([call["segmentIndex"] for call in calls], [0, 1])
        self.assertEqual(calls[0]["state"], "sealed")
        self.assertEqual(calls[1]["text"], "Second")
        self.assertNotEqual(calls[0]["responseId"], calls[1]["responseId"])
        await previews.close()

    async def test_old_server_and_byte_limit(self):
        calls = []
        async def request(*args, **kwargs):
            calls.append(args)
        enabled = False
        previews = PartialReplies(request, "agent", lambda: enabled)
        run = str(uuid4())
        previews.event(run, SimpleNamespace(type="message.delta", payload={"text": "ignored"}))
        self.assertEqual(previews.runs, {})
        enabled = True
        previews.event(run, SimpleNamespace(type="message.delta", payload={"text": "a" * (MAX_BYTES + 1)}))
        self.assertEqual(previews.runs[run].text, "")
        await previews.close()
        self.assertEqual(calls, [])

    async def test_transport_failure_does_not_escape_into_turn(self):
        async def request(*args, **kwargs):
            raise OSError("offline")
        previews = PartialReplies(request, "agent", lambda: True)
        previews.event(str(uuid4()), SimpleNamespace(type="message.delta", payload={"text": "hello"}))
        await asyncio.sleep(.3)
        await previews.close()
        self.assertEqual(previews.runs, {})
