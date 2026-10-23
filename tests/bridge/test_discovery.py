"""Discovery (D1, D21): identify validation, profile_id resolution, tickets, socket redirect, link connect."""
from __future__ import annotations

import asyncio
import copy
import json
import os
import socket
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_sessions import FixtureGateway  # noqa: E402

from emperor_bridge.gateway.client import GatewayLink  # noqa: E402
from emperor_bridge.gateway.discovery import (GatewayDiscovery, control_socket_path, resolve_target,  # noqa: E402
                                              unix_control_transport, validate_identify)
from emperor_bridge.interfaces import (GatewayConfig, GatewayIncompatible, GatewayUnavailable,  # noqa: E402
                                       ProfileNotServed, ProfileTarget, RpcError, Topology)

SPIKE = "/home/hermes/.hermes/profiles/spike"
IDENTIFY = {"ok": True, "protocol": 1, "id": 1, "result": {
    "protocol": 1, "kind": "hermes-gateway", "pid": 149, "hermes_home": SPIKE, "profile": "spike",
    "supervisor": "external", "code_sha": "4d04303818b61bf3aa09278af48356315515965b", "code_version": "0.22.4",
    "instance_id": "95bc730c", "runtime_protocol": 1, "authority_epoch": 1, "state": "ready",
    "api_origin": "http://127.0.0.1:55953",
    "served_profiles": [{"profile_id": SPIKE, "home": SPIKE}], "parked_profiles": {},
    "capabilities": ["session-authority-v1", "durable-admission-v1", "event-replay-v1"]}}
TARGET = ProfileTarget("spike", Path(SPIKE), Path(SPIKE))


def mutated(**changes: Any) -> dict:
    out = copy.deepcopy(IDENTIFY)
    out["result"].update(changes)
    return out


class ValidateIdentifyTest(unittest.TestCase):
    def test_spike_identify_is_accepted(self) -> None:
        ident = validate_identify(IDENTIFY, TARGET)
        self.assertEqual(ident.profile_id, SPIKE)
        self.assertEqual(ident.ws_url, "ws://127.0.0.1:55953/api/ws")
        self.assertEqual(ident.code_version, "0.22.4")

    def test_d1_refusals(self) -> None:
        for change in ({"kind": "gateway"}, {"runtime_protocol": 2}, {"capabilities": ["x"]},
                       {"code_version": "0.22.5"}, {"api_origin": "http://10.0.0.5:80"}):
            with self.subTest(change=change), self.assertRaises(GatewayIncompatible):
                validate_identify(mutated(**change), TARGET)

    def test_not_ready_is_retryable(self) -> None:
        for change in ({"state": "starting"}, {"state": "draining", "drain_reason": "restart"},
                       {"authority_epoch": 0}):
            with self.subTest(change=change), self.assertRaises(GatewayUnavailable):
                validate_identify(mutated(**change), TARGET)
        with self.assertRaises(GatewayUnavailable):
            validate_identify({"ok": False, "error": "boom"}, TARGET)

    def test_shared_gateway_resolves_profile_or_asks_for_rescan(self) -> None:
        root = "/home/jose/.hermes"
        shared = mutated(hermes_home=root, served_profiles=[
            {"profile_id": root, "home": root},
            {"profile_id": f"{root}/profiles/viktor", "home": f"{root}/profiles/viktor"}])
        viktor = ProfileTarget("viktor", Path(f"{root}/profiles/viktor"), Path(root), Topology.SHARED)
        self.assertEqual(validate_identify(shared, viktor).profile_id, f"{root}/profiles/viktor")
        qa = ProfileTarget("qa", Path(f"{root}/profiles/qa"), Path(root), Topology.SHARED)
        with self.assertRaises(ProfileNotServed):
            validate_identify(shared, qa)

    def test_resolve_target(self) -> None:
        root = Path("/r")
        self.assertEqual(resolve_target("viktor", "standalone", root).control_home, root / "profiles" / "viktor")
        shared = resolve_target("viktor", "shared", root)
        self.assertEqual((shared.profile_home, shared.control_home), (root / "profiles" / "viktor", root))
        self.assertEqual(resolve_target("default", "managed", root).profile_home, root)


class DiscoveryTransportTest(unittest.IsolatedAsyncioTestCase):
    async def test_identify_and_ticket_via_transport(self) -> None:
        sent = []

        def transport(path: Path, request: dict, timeout: float) -> dict:
            sent.append((path, request))
            if request["verb"] == "identify":
                return IDENTIFY
            return {"ok": True, "result": {"ticket": "tk-1", "expires_in_seconds": 30}}

        with tempfile.TemporaryDirectory() as tmp:
            target = ProfileTarget("spike", Path(SPIKE), Path(tmp))
            (Path(tmp) / "gateway.sock.path").write_text("/run/hermes-gw-abc/control.sock\n", encoding="utf-8")
            disco = GatewayDiscovery(target, transport=transport)
            ident = await disco.identify()
            self.assertEqual(await disco.mint_ticket(ident), "tk-1")
        self.assertEqual(sent[0][0], Path("/run/hermes-gw-abc/control.sock"))
        self.assertEqual(sent[1][1]["params"], {"profile_id": SPIKE, "instance_id": "95bc730c",
                                                "purpose": "interactive"})

    async def test_stale_instance_ticket_is_unavailable(self) -> None:
        def transport(path, request, timeout):
            return IDENTIFY if request["verb"] == "identify" else {"ok": False, "error": "PermissionError: stale runtime instance"}

        disco = GatewayDiscovery(TARGET, transport=transport)
        with self.assertRaises(GatewayUnavailable):
            await disco.mint_ticket(await disco.identify())

    def test_default_socket_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(control_socket_path(Path(tmp)), Path(tmp) / "gateway.sock")

    @unittest.skipUnless(hasattr(socket, "AF_UNIX") and hasattr(os, "getuid"), "needs UNIX sockets")
    async def test_real_unix_socket_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            os.chmod(tmp, 0o700)
            path = Path(tmp) / "gateway.sock"
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(str(path))
            os.chmod(path, 0o600)
            server.listen(1)

            def serve() -> None:
                conn, _ = server.accept()
                with conn:
                    conn.recv(65536)
                    conn.sendall(json.dumps(IDENTIFY).encode() + b"\n")

            thread = threading.Thread(target=serve, daemon=True)
            thread.start()
            response = await asyncio.to_thread(unix_control_transport, path, {"verb": "identify"}, 2.0)
            thread.join(2)
            server.close()
        self.assertEqual(response["result"]["kind"], "hermes-gateway")


class LinkConnectTest(unittest.IsolatedAsyncioTestCase):
    async def test_upgrade_refusal_retries_with_fresh_ticket(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            gw = FixtureGateway("normal_turn", Path(tmp))
            tickets = []
            original_ticket = gw.mint_ticket

            async def counting_ticket(identity):
                tickets.append(1)
                return await original_ticket(identity)

            gw.mint_ticket = counting_ticket  # type: ignore[method-assign]
            failures = [RuntimeError("server rejected WebSocket connection: HTTP 403")]

            async def flaky(url, protocols, config):
                self.assertEqual(protocols[0], "hermes-gateway-v1")
                self.assertTrue(protocols[1].startswith("hermes-gateway-ticket."))
                if failures:
                    raise failures.pop()
                return await gw.connector(url, protocols, config)

            link = GatewayLink(gw, config=GatewayConfig(ping_interval_s=3600, backoff_initial_s=0.01),
                               connector=flaky)  # type: ignore[arg-type]
            identity = await link.start()
            try:
                self.assertEqual(identity.instance_id, "2de16222fff0477a9c9976261fa06aca")
                self.assertTrue(link.connected)
                self.assertGreaterEqual(len(tickets), 3)  # one refused + two sockets
                with self.assertRaises(RpcError) as caught:
                    await link.maintenance.call("bogus.method", {})
                self.assertEqual(caught.exception.code, -32601)
            finally:
                await link.close()

    async def test_incompatible_gateway_is_fatal(self) -> None:
        def transport(path, request, timeout):
            return mutated(code_version="0.23.0")

        link = GatewayLink(GatewayDiscovery(TARGET, transport=transport))
        with self.assertRaises(GatewayIncompatible):
            await link.start()


if __name__ == "__main__":
    unittest.main()
