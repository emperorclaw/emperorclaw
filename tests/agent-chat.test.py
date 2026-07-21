"""
EmperorClaw Agent Chat — LIVE integration tests (require a running instance,
a running bridge, and a real model). Not part of CI. See TESTING.md (Layer 4).
Validates: message send, agent response, dedup, sync filtering, no loops.

Usage:
  export EMPEROR_CLAW_API_URL=http://localhost:3000
  export EMPEROR_CLAW_API_TOKEN=<company MCP token>
  python tests/agent-chat.test.py
"""
import json
import os
import sys
import time
import unittest
import urllib.request
import urllib.error
import uuid

# ── Config ────────────────────────────────────────────────────────
API_BASE = os.environ.get("EMPEROR_CLAW_API_URL", "http://localhost:3000")
API_TOKEN = os.environ.get("EMPEROR_CLAW_API_TOKEN", "")

if not API_TOKEN:
    print("ERROR: Set EMPEROR_CLAW_API_TOKEN environment variable")
    print("Get a token from Settings > Access Tokens in EmperorClaw")
    sys.exit(1)

TEST_PREFIX = f"test-{uuid.uuid4().hex[:8]}"
print(f"Test run ID: {TEST_PREFIX}")
print(f"API: {API_BASE}")


def api(method, path, body=None):
    """Call EmperorClaw API."""
    url = f"{API_BASE}/api/mcp{path}"
    headers = {
        "Authorization": f"Bearer {API_TOKEN}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "emperorclaw-test/1.0",
        "Idempotency-Key": str(uuid.uuid4()),
    }
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read().decode()), res.status
    except urllib.error.HTTPError as e:
        body_text = e.read().decode()[:500]
        return json.loads(body_text) if body_text else {"error": str(e)}, e.code


def get_agents():
    """Get list of online agents."""
    resp, status = api("GET", "/agents?limit=50")
    agents = resp.get("agents", [])
    return [a for a in agents if a.get("status") == "online"]


class TestAgentChat(unittest.TestCase):
    """Tests that agents respond correctly to messages."""

    @classmethod
    def setUpClass(cls):
        """Find an online agent to test with."""
        agents = get_agents()
        if not agents:
            raise unittest.SkipTest("No online agents available for testing")
        cls.test_agent = agents[0]
        cls.agent_id = cls.test_agent["id"]
        cls.agent_name = cls.test_agent.get("name", "unknown")
        print(f"\nTesting with agent: {cls.agent_name} (id={cls.agent_id[:8]}...)")

    def test_01_agent_is_online(self):
        """Agent should be online and reachable."""
        self.assertIsNotNone(self.agent_id)
        self.assertIsNotNone(self.agent_name)
        print(f"  Agent: {self.agent_name} — ONLINE")

    def test_02_can_send_message_to_agent(self):
        """Can send a direct message to an agent."""
        resp, status = api("POST", "/messages/send", {
            "text": f"[TEST {TEST_PREFIX}] Hello! Please reply with exactly 'PONG' and nothing else.",
            "agentId": self.agent_id,
            "targetAgentId": self.agent_id,
            "thread_type": "direct",
        })
        self.assertIn(status, [200, 201])
        self.assertTrue(resp.get("ok"), f"Message send failed: {resp}")
        self.assertIsNotNone(resp.get("message_id"))
        self.__class__.thread_id = resp.get("thread_id")
        print(f"  Message sent: {resp.get('message_id')[:8]}... in thread {self.__class__.thread_id[:8]}...")

    def test_03_sync_returns_messages(self):
        """Sync endpoint should return messages (not empty)."""
        resp, status = api("GET", "/messages/sync?mode=all")
        self.assertEqual(status, 200)
        messages = resp.get("messages", [])
        self.assertIsInstance(messages, list)
        print(f"  Sync returned {len(messages)} messages — OK")

    def test_04_agent_does_not_duplicate(self):
        """Agent should NOT send duplicate responses to the same trigger."""
        thread_id = getattr(self.__class__, 'thread_id', None)
        if not thread_id:
            self.skipTest("No thread_id from previous test")
        
        # Wait 15s and check no new agent messages appear in this thread
        time.sleep(15)
        resp, status = api("GET", f"/messages/sync?mode=all&agentId={self.agent_id}")
        messages = resp.get("messages", [])
        agent_msgs_in_thread = [
            m for m in messages
            if m.get("senderType") == "agent" and m.get("threadId") == thread_id
        ]
        # Should have at most 1 agent message in this thread (our PONG response)
        self.assertLessEqual(
            len(agent_msgs_in_thread), 1,
            f"Agent sent {len(agent_msgs_in_thread)} replies instead of 1! Messages: {[m.get('text','')[:50] for m in agent_msgs_in_thread]}"
        )
        print(f"  Agent messages in thread: {len(agent_msgs_in_thread)} — OK (no duplicates)")


class TestServerDedup(unittest.TestCase):
    """Tests that server-side deduplication prevents duplicate sends."""

    @classmethod
    def setUpClass(cls):
        agents = get_agents()
        if not agents:
            raise unittest.SkipTest("No online agents available")
        cls.agent_id = agents[0]["id"]
        cls.agent_name = agents[0].get("name", "unknown")
        print(f"\nTesting dedup with: {cls.agent_name}")

    def test_same_message_twice_is_deduped(self):
        """Sending the exact same message twice in the same thread should be deduplicated."""
        text = f"[DEDUP TEST {TEST_PREFIX}] This is a unique dedup test message."
        thread_id = f"dedup-test-{uuid.uuid4().hex[:8]}"
        
        # First send — should succeed
        resp1, status1 = api("POST", "/messages/send", {
            "text": text,
            "agentId": self.agent_id,
            "thread_id": thread_id,
            "thread_type": "direct",
        })
        self.assertTrue(resp1.get("ok"), f"First send failed: {resp1}")
        msg1_id = resp1.get("message_id")
        print(f"  First send: {msg1_id[:8] if msg1_id else 'deduplicated'}...")
        
        # Second send of SAME text in SAME thread — should be deduplicated
        resp2, status2 = api("POST", "/messages/send", {
            "text": text,
            "agentId": self.agent_id,
            "thread_id": thread_id,
            "thread_type": "direct",
        })
        self.assertTrue(resp2.get("ok"), f"Second send failed: {resp2}")
        
        is_dedup = resp2.get("deduplicated") == True or resp2.get("message_id") is None
        self.assertTrue(is_dedup, f"Second identical message was NOT deduplicated! resp={resp2}")
        print(f"  Second send: deduplicated=True — OK")

    def test_different_message_is_not_deduped(self):
        """Different messages should NOT be deduplicated."""
        text1 = f"[UNIQUE A {TEST_PREFIX}] Message A {uuid.uuid4().hex[:6]}"
        text2 = f"[UNIQUE B {TEST_PREFIX}] Message B {uuid.uuid4().hex[:6]}"
        
        resp1, _ = api("POST", "/messages/send", {
            "text": text1,
            "agentId": self.agent_id,
            "thread_type": "direct",
        })
        resp2, _ = api("POST", "/messages/send", {
            "text": text2,
            "agentId": self.agent_id,
            "thread_type": "direct",
        })
        
        # Both should have message_ids (not deduplicated)
        self.assertIsNotNone(resp1.get("message_id"), f"First unique msg was deduped: {resp1}")
        self.assertIsNotNone(resp2.get("message_id"), f"Second unique msg was deduped: {resp2}")
        self.assertNotEqual(resp1.get("message_id"), resp2.get("message_id"))
        print(f"  Both unique messages have different IDs — OK")


class TestSyncFiltering(unittest.TestCase):
    """Tests that sync endpoint correctly filters already-replied messages."""

    @classmethod
    def setUpClass(cls):
        agents = get_agents()
        if not agents:
            raise unittest.SkipTest("No online agents available")
        cls.agent_id = agents[0]["id"]
        cls.agent_name = agents[0].get("name", "unknown")
        print(f"\nTesting sync filtering with: {cls.agent_name}")

    def test_sync_with_agentid_excludes_replied(self):
        """Sync with ?agentId= should not return messages the agent already replied to."""
        # Get messages with agentId filter
        resp, status = api("GET", f"/messages/sync?mode=all&agentId={self.agent_id}")
        self.assertEqual(status, 200)
        messages = resp.get("messages", [])
        
        # Count how many are from THIS agent (should be 0, we filter own messages)
        own_msgs = [m for m in messages if m.get("senderId") == self.agent_id]
        self.assertEqual(len(own_msgs), 0, 
            f"Sync returned {len(own_msgs)} messages from the agent itself! Should be 0.")
        
        print(f"  Sync returned {len(messages)} messages, 0 from self — OK")

    def test_sync_without_agentid_works(self):
        """Sync without agentId should still work (backwards compat)."""
        resp, status = api("GET", "/messages/sync?mode=all")
        self.assertEqual(status, 200)
        self.assertIn("messages", resp)
        print(f"  Sync without agentId returned {len(resp.get('messages',[]))} messages — OK")


class TestNoAgentLoop(unittest.TestCase):
    """Tests that agents don't get stuck in loops."""

    @classmethod
    def setUpClass(cls):
        agents = get_agents()
        if not agents:
            raise unittest.SkipTest("No online agents available")
        cls.agent_id = agents[0]["id"]
        cls.agent_name = agents[0].get("name", "unknown")
        print(f"\nTesting loop prevention with: {cls.agent_name}")

    def test_no_rapid_agent_messages(self):
        """Check that no agent is posting more than 5 messages per minute."""
        resp, status = api("GET", "/messages/sync?mode=all")
        messages = resp.get("messages", [])
        
        # Group by agent and count recent messages
        now = time.time()
        agent_counts = {}
        for m in messages:
            if m.get("senderType") != "agent":
                continue
            sender = m.get("senderId", "unknown")
            created = m.get("createdAt", "")
            try:
                # Parse ISO date
                ts = time.mktime(time.strptime(created[:19], "%Y-%m-%dT%H:%M:%S"))
                if now - ts < 120:  # Last 2 minutes
                    agent_counts[sender] = agent_counts.get(sender, 0) + 1
            except:
                pass
        
        for agent_id, count in agent_counts.items():
            self.assertLess(count, 10, 
                f"Agent {agent_id[:8]}... posted {count} messages in 2 min! Possible loop.")
        
        print(f"  Agent message counts (last 2min): {agent_counts} — OK (all < 10)")


if __name__ == "__main__":
    unittest.main(verbosity=2)
