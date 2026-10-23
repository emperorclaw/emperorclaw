"""Session mapping tests (D4) + the shared fixture-replay gateway used by the other bridge tests.

`FixtureGateway` replays a recorded `tests/fixtures/hermes-v0224/*.jsonl` file: each recorded
connection becomes one segment serving both of the bridge's sockets. A client request is matched
to the next recorded request with the same method; the recorded frames that followed it are
played back (response ids rewritten to the client's ids). Unrecorded calls get a canned answer.
"""
from __future__ import annotations

import asyncio
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Callable, Optional

REPO = Path(__file__).resolve().parents[2]
BRIDGE_DIR = REPO / "integrations" / "hermes" / "emperor-claw" / "bridge"
FIXTURES = REPO / "tests" / "fixtures" / "hermes-v0224"
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

from emperor_bridge.gateway.client import GatewayLink  # noqa: E402
from emperor_bridge.gateway.sessions import (SessionManager, build_create_params, canonical_json,  # noqa: E402
                                             policy_hash, request_id_for)
from emperor_bridge.interfaces import (GatewayConfig, GatewayIdentity, GatewayUnavailable,  # noqa: E402
                                       ProfileTarget, SessionPolicy, WS_SUBPROTOCOL)
from emperor_bridge.state import BridgeState  # noqa: E402

_CLOSE = object()
CLOSE_EVENTS = {"disconnect", "sigkill_gateway"}


def load_fixture(name: str) -> list[dict[str, Any]]:
    with open(FIXTURES / f"{name}.jsonl", encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def fixture_events(name: str) -> list[dict[str, Any]]:
    """Every recorded event `params` object (incoming), in order, including events.since replays."""
    out = []
    for line in load_fixture(name):
        frame = line.get("frame") or {}
        if line["dir"] == "in" and frame.get("method") == "event":
            out.append(frame["params"])
    return out


def fixture_responses(name: str, method: str) -> list[dict[str, Any]]:
    """Responses (result or error frames) to every recorded request of `method`."""
    lines = load_fixture(name)
    ids = [line["frame"]["id"] for line in lines if line["dir"] == "out" and line["frame"].get("method") == method]
    found = []
    for wanted in ids:
        for line in lines:
            frame = line.get("frame") or {}
            if line["dir"] == "in" and "method" not in frame and frame.get("id") == wanted:
                found.append(frame)
                break
    return found


class FakeWS:
    subprotocol = WS_SUBPROTOCOL

    def __init__(self, player: "SegmentPlayer", role: str) -> None:
        self.player = player
        self.role = role
        self.inbox: asyncio.Queue = asyncio.Queue()
        self.sent: list[dict[str, Any]] = []

    async def send(self, text: str) -> None:
        frame = json.loads(text)
        self.sent.append(frame)
        self.player.on_request(self, frame)

    async def recv(self) -> str:
        item = await self.inbox.get()
        if item is _CLOSE:
            self.inbox.put_nowait(_CLOSE)
            raise ConnectionError("fixture socket closed")
        return item

    async def close(self) -> None:
        self.inbox.put_nowait(_CLOSE)

    def push(self, frame: dict[str, Any]) -> None:
        self.inbox.put_nowait(json.dumps(frame))


class SegmentPlayer:
    """One recorded connection. Events go to the first socket (turns); responses to the requester."""

    def __init__(self, items: list[dict[str, Any]], hooks: list[Callable[[str, dict], None]]) -> None:
        self.items = items
        self.pos = 0
        self.consumed: set[int] = set()
        self.idmap: dict[Any, tuple[FakeWS, Any, str]] = {}
        self.sockets: list[FakeWS] = []
        self.last_response: dict[str, dict[str, Any]] = {}
        self.closed = False
        self.hooks = hooks
        self.requests: list[dict[str, Any]] = []

    def attach(self, ws: FakeWS) -> None:
        self.sockets.append(ws)
        ws.push({"jsonrpc": "2.0", "method": "event", "params": {"type": "gateway.ready", "payload": {}}})
        if len(self.sockets) == 1:
            self._play_until_out()

    def on_request(self, ws: FakeWS, frame: dict[str, Any]) -> None:
        method, cid = frame.get("method"), frame.get("id")
        self.requests.append(frame)
        for hook in self.hooks:
            hook(method, frame.get("params") or {})
        if method == "gateway.ping":
            ws.push({"jsonrpc": "2.0", "id": cid, "result": {"ok": True}})
            return
        idx = next((i for i in range(self.pos, len(self.items)) if i not in self.consumed
                    and self.items[i]["dir"] == "out" and self.items[i]["frame"].get("method") == method), None)
        if idx is None:
            self._canned(ws, method, cid, frame.get("params") or {})
            return
        for skipped in range(self.pos, idx):  # recorded requests the bridge does not make
            if self.items[skipped]["dir"] == "out":
                self.consumed.add(skipped)
        fixture_id = self.items[idx]["frame"]["id"]
        self.idmap[fixture_id] = (ws, cid, method)
        self.consumed.add(idx)
        self._play_range(self.pos, idx, only_events=True)
        self.pos = idx + 1
        self._pull_response(fixture_id)
        self._play_until_out()

    def _canned(self, ws: FakeWS, method: str, cid: Any, params: dict[str, Any]) -> None:
        if method == "config.set":
            result: Any = {"key": params.get("key"), "value": "1", "scope": "session"}
        elif method in self.last_response:
            frame = copy.deepcopy(self.last_response[method])
            frame["id"] = cid
            ws.push(frame)
            return
        else:
            ws.push({"jsonrpc": "2.0", "id": cid, "error": {"code": -32601, "message": f"unrecorded {method}"}})
            return
        ws.push({"jsonrpc": "2.0", "id": cid, "result": result})

    def _pull_response(self, fixture_id: Any) -> None:
        for i in range(self.pos, len(self.items)):
            item = self.items[i]
            frame = item.get("frame") or {}
            # A response may be recorded after later requests (pipelining): deliver it now.
            if i in self.consumed or item["dir"] != "in" or "method" in frame:
                continue
            if frame.get("id") == fixture_id:
                self.consumed.add(i)
                self._deliver(frame)
                return

    def _play_range(self, start: int, stop: int, *, only_events: bool) -> None:
        for i in range(start, stop):
            if i in self.consumed:
                continue
            item = self.items[i]
            if item["dir"] == "in" and (not only_events or item["frame"].get("method") == "event"):
                self.consumed.add(i)
                self._deliver(item["frame"])

    def _play_until_out(self) -> None:
        while self.pos < len(self.items):
            item = self.items[self.pos]
            if item["dir"] == "out" and self.pos not in self.consumed:
                return
            if self.pos not in self.consumed:
                if item["dir"] == "meta" and item.get("event") in CLOSE_EVENTS:
                    self.consumed.add(self.pos)
                    self.pos += 1
                    self.close()
                    return
                if item["dir"] == "in":
                    self._deliver(item["frame"])
                self.consumed.add(self.pos)
            self.pos += 1

    def _deliver(self, frame: dict[str, Any]) -> None:
        if not self.sockets or self.closed:
            return
        if frame.get("method") == "event":
            if (frame.get("params") or {}).get("type") == "gateway.ready":
                return
            self.sockets[0].push(frame)
            return
        target = self.idmap.get(frame.get("id"))
        if target is None:
            return  # answer to a recorded request the bridge did not make
        ws, cid, method = target
        out = dict(frame)
        out["id"] = cid
        self.last_response[method] = out
        ws.push(out)

    def close(self) -> None:
        self.closed = True
        for ws in self.sockets:
            ws.inbox.put_nowait(_CLOSE)


class FixtureGateway:
    """Discovery + connector replaying a fixture, one recorded connection per link connect."""

    def __init__(self, name: str, profile_home: Path) -> None:
        self.lines = load_fixture(name)
        self.target = ProfileTarget("spike", Path(profile_home), Path(profile_home))
        self.hooks: list[Callable[[str, dict], None]] = []
        self.segments: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
        current = None
        for line in self.lines:
            if line["dir"] == "meta" and line.get("event") == "connected":
                current = (line, [])
                self.segments.append(current)
            elif current is not None:
                current[1].append(line)
        self.index = -1
        self.players: list[SegmentPlayer] = []
        self._pending_sockets = 0

    def identity_for(self, index: int) -> GatewayIdentity:
        meta = self.segments[index][0]
        return GatewayIdentity(instance_id=meta["instance_id"], authority_epoch=meta["authority_epoch"],
                               api_origin=meta["api_origin"], code_version="0.22.4", code_sha="4d04303818b6",
                               profile_id=str(self.target.profile_home))

    async def identify(self) -> GatewayIdentity:
        nxt = self.index + 1
        if nxt >= len(self.segments):
            raise GatewayUnavailable("fixture has no further connections")
        return self.identity_for(nxt)

    async def mint_ticket(self, identity: GatewayIdentity) -> str:
        return "fixture-ticket"

    async def connector(self, url: str, subprotocols: Any, config: GatewayConfig) -> FakeWS:
        if self._pending_sockets == 0:
            self.index += 1
            if self.index >= len(self.segments):
                raise GatewayUnavailable("no more recorded connections")
            self.players.append(SegmentPlayer(self.segments[self.index][1], self.hooks))
            self._pending_sockets = 2
        self._pending_sockets -= 1
        player = self.players[-1]
        ws = FakeWS(player, "turns" if self._pending_sockets == 1 else "maintenance")
        player.attach(ws)
        return ws

    def link(self) -> GatewayLink:
        config = GatewayConfig(ping_interval_s=3600, backoff_initial_s=0.01, backoff_max_s=0.05, ready_timeout_s=2)
        return GatewayLink(self, config=config, connector=self.connector)  # type: ignore[arg-type]

    def requests(self, method: Optional[str] = None) -> list[dict[str, Any]]:
        frames = [f for p in self.players for f in p.requests]
        return [f for f in frames if method is None or f.get("method") == method]


def policy(prompt: str = "You are Probe, an Emperor Claw agent.", **kw: Any) -> SessionPolicy:
    return SessionPolicy(system_prompt=prompt, cwd="/home/hermes", **kw)


class CreateParamsTest(unittest.TestCase):
    def test_shape_matches_plugin_contract(self) -> None:
        params = build_create_params(agent_id="agent-1", thread_id="thread-1", generation=3,
                                     policy=policy(), profile_home=Path("/home/jose/.hermes/profiles/viktor"))
        self.assertEqual(params["request_id"], "emperor/agent-1/thread-1/g3")
        self.assertEqual(params["source"], "tool")
        self.assertTrue(params["yolo"])
        env = params["client_env"]
        self.assertEqual(env["EMPEROR_SESSION_GEN"], "3")
        self.assertEqual(env["EMPEROR_THREAD_ID"], "thread-1")
        self.assertEqual(env["EMPEROR_AGENT_ID"], "agent-1")
        self.assertEqual(Path(env["EMPEROR_PROFILE_HOME"]), Path("/home/jose/.hermes/profiles/viktor"))
        self.assertEqual(env["HERMES_EPHEMERAL_SYSTEM_PROMPT"], "You are Probe, an Emperor Claw agent.")
        for name in env:
            self.assertTrue(name == "HERMES_EPHEMERAL_SYSTEM_PROMPT" or not name.startswith("HERMES_"))
        self.assertNotIn("title", params)  # title resolves existing sessions by name: never sent

    def test_policy_hash_is_canonical(self) -> None:
        a = build_create_params(agent_id="a", thread_id="t", generation=1, policy=policy(), profile_home=Path("/h"))
        b = json.loads(json.dumps(a))
        b = dict(reversed(list(b.items())))
        self.assertEqual(policy_hash(a), policy_hash(b))
        self.assertEqual(len(policy_hash(a)), 16)
        self.assertEqual(canonical_json(a), canonical_json(b))

    def test_secret_or_hermes_client_env_rejected(self) -> None:
        for name in ("EMPEROR_CLAW_API_TOKEN", "HERMES_THING", "OPENAI_API_KEY"):
            with self.assertRaises(ValueError):
                build_create_params(agent_id="a", thread_id="t", generation=1,
                                    policy=policy(extra_client_env={name: "x"}), profile_home=Path("/h"))

    def test_request_id(self) -> None:
        self.assertEqual(request_id_for("ag", "th", 7), "emperor/ag/th/g7")


class SessionManagerTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.state = BridgeState.load(self.home / "emperor" / "bridge-state.json", agent_id="probe-agent")

    async def asyncTearDown(self) -> None:
        self.tmp.cleanup()

    async def _manager(self, fixture: str) -> tuple[FixtureGateway, GatewayLink, SessionManager]:
        gw = FixtureGateway(fixture, self.home)
        link = gw.link()
        manager = SessionManager(link, self.state, agent_id="probe-agent", profile_home=self.home)
        await link.start()
        return gw, link, manager

    async def test_ensure_creates_sets_reasoning_and_persists(self) -> None:
        gw, link, manager = await self._manager("normal_turn")
        try:
            rec = await manager.ensure("fx-normal", policy())
        finally:
            await link.close()
        self.assertTrue(rec.session_id.startswith("local-162dd"))
        self.assertEqual(rec.replay_epoch, "a3f31766fa2a4b5094fb18ff88499605")
        methods = [f["method"] for f in gw.requests()]
        self.assertEqual(methods[:2], ["session.create", "config.set"])
        self.assertEqual(gw.requests("config.set")[0]["params"]["value"], "on")
        raw = json.loads((self.home / "emperor" / "bridge-state.json").read_text(encoding="utf-8"))
        stored = raw["threads"]["fx-normal"]
        self.assertEqual(stored["createParams"], rec.create_params)
        self.assertEqual(stored["policyHash"], policy_hash(rec.create_params))

    async def test_ensure_is_cached_while_attached(self) -> None:
        gw, link, manager = await self._manager("normal_turn")
        try:
            first = await manager.ensure("fx-normal", policy())
            second = await manager.ensure("fx-normal", policy())
        finally:
            await link.close()
        self.assertIs(first, second)
        self.assertEqual(len(gw.requests("session.create")), 1)

    async def test_replay_after_bridge_restart_is_byte_identical(self) -> None:
        gw, link, manager = await self._manager("normal_turn")
        try:
            rec = await manager.ensure("fx-normal", policy())
        finally:
            await link.close()
        sent_first = gw.requests("session.create")[0]["params"]
        reloaded = BridgeState.load(self.state.path, agent_id="probe-agent")
        gw2 = FixtureGateway("normal_turn", self.home)
        link2 = gw2.link()
        manager2 = SessionManager(link2, reloaded, agent_id="probe-agent", profile_home=self.home)
        await link2.start()
        try:
            rec2 = await manager2.ensure("fx-normal", policy())
        finally:
            await link2.close()
        sent_again = gw2.requests("session.create")[0]["params"]
        self.assertEqual(canonical_json(sent_first), canonical_json(sent_again))
        self.assertEqual(rec2.generation, rec.generation)
        self.assertEqual(rec2.session_id, rec.session_id)

    async def test_policy_change_is_throttled_unless_urgent(self) -> None:
        gw, link, manager = await self._manager("normal_turn")
        try:
            rec = await manager.ensure("fx-normal", policy())
            same = manager.plan("fx-normal", policy("A newer prompt"))
            self.assertIs(same, rec)  # within 6 h: keep replaying the stored params
            newer = manager.plan("fx-normal", policy("A newer prompt", urgent=True))
            self.assertEqual(newer.generation, rec.generation + 1)
            self.assertEqual(newer.create_params["client_env"]["EMPEROR_SESSION_GEN"], str(rec.generation + 1))
            self.assertTrue(newer.request_id.endswith(f"/g{rec.generation + 1}"))
            aged = manager.plan("fx-normal", policy("A newer prompt", refresh_min_interval_s=0))
            self.assertEqual(aged.generation, rec.generation + 1)
        finally:
            await link.close()

    async def test_bump_generation_forces_new_session(self) -> None:
        gw, link, manager = await self._manager("normal_turn")
        try:
            rec = await manager.ensure("fx-normal", policy())
            self.assertEqual(manager.bump_generation("fx-normal", "kill"), rec.generation + 1)
            planned = manager.plan("fx-normal", policy())
            self.assertEqual(planned.generation, rec.generation + 1)
        finally:
            await link.close()


if __name__ == "__main__":
    unittest.main()
