"""Async JSON-RPC client for the Hermes gateway WebSocket (`hermes-gateway-v1`).

`GatewayConnection` is one authenticated socket. The server runs requests serially per socket
(W0 finding 6), so `GatewayLink` keeps two: `turns` (create/resume/submit/interrupt/receipt/
config) and `maintenance` (compress, bulk replay). Events from both sockets go through one
per-session seq dedup and fan out to listeners. Any socket loss closes both, re-identifies,
mints fresh tickets and reconnects with backoff 0.2 -> 5 s; reconnect listeners then resume
sessions and replay (`session.events.since`) or run the restart path (D14, D15).
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from typing import Any, Awaitable, Callable, Mapping, Optional, Sequence

from ..interfaces import (EventListener, GatewayConfig, GatewayEvent, GatewayIdentity,
                          GatewayIncompatible, GatewayUnavailable, ReconnectListener, RpcError,
                          RpcTimeout, SOCKET_MAINTENANCE, SOCKET_TURNS, WS_SUBPROTOCOL,
                          WS_TICKET_PREFIX)
from .discovery import GatewayDiscovery

try:  # websockets is in the Hermes venv (15.0.1, D17); tests inject a fake connector.
    from websockets.asyncio.client import connect as _ws_connect
    from websockets.exceptions import ConnectionClosed as _WsClosed
except ImportError:  # pragma: no cover - exercised only outside the Hermes venv
    _ws_connect = None
    _WsClosed = ConnectionError

Connector = Callable[[str, Sequence[str], GatewayConfig], Awaitable[Any]]
"""(ws_url, subprotocols, config) -> websocket with async send(str), recv() -> str, close(), .subprotocol"""

CLOSED_ERRORS: tuple[type[BaseException], ...] = (_WsClosed, ConnectionError, EOFError, OSError)


async def websockets_connector(url: str, subprotocols: Sequence[str], config: GatewayConfig) -> Any:
    if _ws_connect is None:
        raise GatewayUnavailable("the websockets package is not installed in this interpreter")
    kwargs: dict[str, Any] = {"subprotocols": list(subprotocols), "open_timeout": config.open_timeout_s,
                              "max_size": config.max_frame_bytes, "proxy": None}
    try:
        return await _ws_connect(url, **kwargs)
    except TypeError:  # websockets < 15 has no proxy kwarg (and never used env proxies)
        kwargs.pop("proxy")
        return await _ws_connect(url, **kwargs)


def _discard(fut: asyncio.Future) -> None:
    """Retrieve or cancel an abandoned future so asyncio never logs 'exception never retrieved'."""
    if fut.done():
        if not fut.cancelled():
            fut.exception()
    else:
        fut.cancel()


class GatewayConnection:
    """One socket: pipelined requests, responses matched by id, events pushed to `on_event`."""

    def __init__(self, name: str, ws: Any, on_event: Callable[[Mapping[str, Any], "GatewayConnection"], None],
                 logger: logging.Logger, on_close: Optional[Callable[[], None]] = None) -> None:
        self.name = name
        self._on_close = on_close
        self._ws = ws
        self._on_event = on_event
        self._log = logger
        self._next_id = 0
        self._pending: dict[Any, asyncio.Future] = {}
        self.closed = asyncio.Event()
        self.ready = asyncio.Event()
        self.close_reason: str = ""
        self._reader = asyncio.create_task(self._read(), name=f"gateway-{name}-reader")

    async def _read(self) -> None:
        try:
            while True:
                raw = await self._ws.recv()
                try:
                    frame = json.loads(raw)
                except ValueError:
                    self._log.warning("gateway ws=%s non-JSON frame dropped", self.name)
                    continue
                self._dispatch(frame)
        except asyncio.CancelledError:
            self.close_reason = "cancelled"
            raise
        except CLOSED_ERRORS as exc:
            self.close_reason = f"{type(exc).__name__}: {exc}"
        except Exception as exc:  # defensive: a reader bug must not hang callers
            self._log.exception("gateway ws=%s reader crashed", self.name)
            self.close_reason = f"reader crash: {exc}"
        finally:
            self._fail_pending()
            self.closed.set()
            if self._on_close is not None:
                self._on_close()

    def _dispatch(self, frame: Mapping[str, Any]) -> None:
        method = frame.get("method")
        if method is None:
            fut = self._pending.pop(frame.get("id"), None)
            if fut is not None and not fut.done():
                fut.set_result(frame)
            return
        if method == "event":
            params = frame.get("params") or {}
            if params.get("type") == "gateway.ready":
                self.ready.set()
            self._on_event(params, self)
            return
        # Server->client requests (sudo, secret, ...): a headless bridge lets them time out.
        self._log.info("gateway ws=%s ignoring server request %s", self.name, method)

    def _fail_pending(self) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(GatewayUnavailable(f"ws={self.name} closed: {self.close_reason}"))
        self._pending.clear()

    async def call(self, method: str, params: Optional[Mapping[str, Any]] = None, *,
                   timeout: float = 30.0) -> Any:
        if self.closed.is_set():
            raise GatewayUnavailable(f"ws={self.name} is closed")
        self._next_id += 1
        rid = self._next_id
        fut = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        frame = {"jsonrpc": "2.0", "id": rid, "method": method, "params": dict(params or {})}
        try:
            await self._ws.send(json.dumps(frame))
        except CLOSED_ERRORS as exc:
            self._pending.pop(rid, None)
            _discard(fut)
            raise GatewayUnavailable(f"ws={self.name} send failed: {exc}") from exc
        try:
            response = await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError as exc:
            self._pending.pop(rid, None)
            _discard(fut)
            raise RpcTimeout(f"{method} timed out after {timeout}s on ws={self.name}") from exc
        if "error" in response:
            err = response.get("error") or {}
            raise RpcError(int(err.get("code") or 0), str(err.get("message") or ""), err.get("data"))
        return response.get("result")

    async def close(self) -> None:
        with contextlib.suppress(Exception):
            await self._ws.close()
        self._reader.cancel()
        with contextlib.suppress(BaseException):
            await self._reader
        self._fail_pending()
        self.closed.set()


class _Channel:
    """`link.turns` / `link.maintenance`: waits for the link to be up, then calls that socket."""

    def __init__(self, link: "GatewayLink", name: str) -> None:
        self._link = link
        self.name = name

    async def call(self, method: str, params: Optional[Mapping[str, Any]] = None, *,
                   timeout: float = 30.0) -> Any:
        deadline = time.monotonic() + timeout
        conn = await self._link._connection(self.name, timeout)
        started = time.monotonic()
        try:
            return await conn.call(method, params, timeout=max(0.1, deadline - time.monotonic()))
        finally:
            self._link._log.debug("rpc ws=%s method=%s ms=%.1f", self.name, method,
                                  (time.monotonic() - started) * 1000)


class GatewayLink:
    """Two sockets to one gateway for one profile, with reconnect, ping and event fan-out."""

    def __init__(self, discovery: GatewayDiscovery, *, config: GatewayConfig = GatewayConfig(),
                 connector: Optional[Connector] = None, logger: Optional[logging.Logger] = None) -> None:
        self._discovery = discovery
        self._config = config
        self._connector = connector or websockets_connector
        self._log = logger or logging.getLogger("emperor_bridge.gateway")
        self._conns: dict[str, GatewayConnection] = {}
        self._identity: Optional[GatewayIdentity] = None
        self._ready = asyncio.Event()
        self._closing = False
        self._event_listeners: list[EventListener] = []
        self._reconnect_listeners: list[ReconnectListener] = []
        self._cursors: dict[str, tuple[Optional[str], int]] = {}
        self._held: dict[str, list[GatewayEvent]] = {}
        self._tasks: list[asyncio.Task] = []
        self.reconnects = 0
        self.fatal_error: Optional[str] = None  # set when the gateway fails D1 after a reconnect
        self.turns = _Channel(self, SOCKET_TURNS)
        self.maintenance = _Channel(self, SOCKET_MAINTENANCE)

    # ---- public surface -------------------------------------------------------------------

    @property
    def identity(self) -> Optional[GatewayIdentity]:
        return self._identity

    @property
    def connected(self) -> bool:
        return self._ready.is_set()

    def add_event_listener(self, listener: EventListener) -> None:
        self._event_listeners.append(listener)

    def add_reconnect_listener(self, listener: ReconnectListener) -> None:
        self._reconnect_listeners.append(listener)

    async def start(self) -> GatewayIdentity:
        """Connect both sockets (retrying while the gateway is unavailable) and start supervision."""
        await self._connect_with_backoff()
        self._ready.set()
        self._tasks = [asyncio.create_task(self._supervise(), name="gateway-supervisor"),
                       asyncio.create_task(self._ping_loop(), name="gateway-ping")]
        assert self._identity is not None
        return self._identity

    async def close(self) -> None:
        self._closing = True
        self._ready.clear()
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            with contextlib.suppress(BaseException):
                await task
        await self._close_conns()

    def inject_events(self, events: Sequence[GatewayEvent]) -> None:
        for event in events:
            self._deliver(event)

    def hold_session(self, session_id: str) -> None:
        self._held.setdefault(session_id, [])

    def release_session(self, session_id: str) -> None:
        for event in self._held.pop(session_id, []):
            self._deliver(event)

    def cursor(self, session_id: str) -> Optional[tuple[Optional[str], int]]:
        return self._cursors.get(session_id)

    def seed_cursor(self, session_id: str, replay_epoch: Optional[str], seq: int) -> None:
        """Start dedup for a session at a known point (resume snapshot or persisted state)."""
        self._cursors[session_id] = (replay_epoch, int(seq or 0))

    # ---- events ---------------------------------------------------------------------------

    def _on_frame_event(self, params: Mapping[str, Any], conn: GatewayConnection) -> None:
        self._on_frame_event_live(GatewayEvent.from_params(params, received_at=time.time()))

    def _on_frame_event_live(self, event: GatewayEvent) -> None:
        held = self._held.get(event.session_id or "")
        if held is not None:
            held.append(event)
            return
        self._deliver(event)

    def _deliver(self, event: GatewayEvent) -> None:
        if event.session_id and event.seq is not None:
            prior = self._cursors.get(event.session_id)
            if prior is not None and prior[0] == event.replay_epoch and event.seq <= prior[1]:
                return  # seen on the other socket or already replayed
            self._cursors[event.session_id] = (event.replay_epoch, int(event.seq))
        for listener in list(self._event_listeners):
            try:
                listener(event)
            except Exception:
                self._log.exception("event listener failed for %s", event.type)

    # ---- connection management ------------------------------------------------------------

    async def _connection(self, name: str, timeout: float) -> GatewayConnection:
        deadline = time.monotonic() + timeout
        while True:
            if self._closing:
                raise GatewayUnavailable("gateway link is closed")
            remaining = deadline - time.monotonic()
            try:
                await asyncio.wait_for(self._ready.wait(), max(0.0, remaining))
            except asyncio.TimeoutError as exc:
                raise GatewayUnavailable(f"gateway not connected within {timeout}s") from exc
            conn = self._conns.get(name)
            if conn is not None and not conn.closed.is_set():
                return conn
            self._ready.clear()  # the supervisor has not noticed the loss yet
            if remaining <= 0:
                raise GatewayUnavailable(f"ws={name} is down")
            await asyncio.sleep(min(0.05, remaining))

    async def _open(self, name: str, identity: GatewayIdentity) -> GatewayConnection:
        ticket = await self._discovery.mint_ticket(identity)
        try:
            ws = await self._connector(identity.ws_url, [WS_SUBPROTOCOL, WS_TICKET_PREFIX + ticket], self._config)
        except GatewayUnavailable:
            raise
        except Exception as exc:  # HTTP 403 on the upgrade, refused, timeout: re-identify + new ticket
            raise GatewayUnavailable(f"ws={name} upgrade failed: {exc}") from exc
        if getattr(ws, "subprotocol", WS_SUBPROTOCOL) != WS_SUBPROTOCOL:
            with contextlib.suppress(Exception):
                await ws.close()
            raise GatewayIncompatible(f"subprotocol mismatch: {getattr(ws, 'subprotocol', None)!r}")
        conn = GatewayConnection(name, ws, self._on_frame_event, self._log, on_close=self._ready.clear)
        try:
            await asyncio.wait_for(conn.ready.wait(), self._config.ready_timeout_s)
        except asyncio.TimeoutError as exc:
            await conn.close()
            raise GatewayUnavailable(f"ws={name}: no gateway.ready") from exc
        return conn

    async def _connect_once(self) -> tuple[GatewayIdentity, bool]:
        identity = await self._discovery.identify()
        previous = self._identity
        conns = {}
        try:
            for name in (SOCKET_TURNS, SOCKET_MAINTENANCE):
                conns[name] = await self._open(name, identity)
        except BaseException:
            for conn in conns.values():
                await conn.close()
            raise
        self._conns = conns
        self._identity = identity
        restarted = previous is not None and not identity.same_instance(previous)
        if restarted:
            self._cursors.clear()  # replay epochs and seqs restart with the gateway
        return identity, restarted

    async def _connect_with_backoff(self) -> tuple[GatewayIdentity, bool]:
        delay = self._config.backoff_initial_s
        while True:
            try:
                return await self._connect_once()
            except GatewayIncompatible:
                raise
            except (GatewayUnavailable, RpcError, OSError) as exc:
                if self._closing:
                    raise GatewayUnavailable("gateway link closed during connect") from exc
                self._log.warning("gateway connect failed (%s); retry in %.1fs", exc, delay)
                await asyncio.sleep(delay)
                delay = min(self._config.backoff_max_s, delay * 2)
        # unreachable

    async def _close_conns(self) -> None:
        conns, self._conns = self._conns, {}
        for conn in conns.values():
            await conn.close()

    async def _supervise(self) -> None:
        self._ready.set()
        while not self._closing:
            waits = [asyncio.create_task(c.closed.wait()) for c in self._conns.values()]
            done, pending = await asyncio.wait(waits, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            if self._closing:
                return
            reasons = ", ".join(f"{c.name}: {c.close_reason}" for c in self._conns.values() if c.closed.is_set())
            self._log.warning("gateway socket lost (%s); reconnecting", reasons)
            self._ready.clear()
            await self._close_conns()
            try:
                identity, restarted = await self._connect_with_backoff()
            except GatewayIncompatible as exc:
                self.fatal_error = str(exc)
                self._log.error("gateway became incompatible (%s); dispatch stays stopped", exc)
                return
            self.reconnects += 1
            self._ready.set()
            for listener in list(self._reconnect_listeners):
                try:
                    await listener(identity, restarted)
                except Exception:
                    self._log.exception("reconnect listener failed")

    async def _ping_loop(self) -> None:
        while not self._closing:
            await asyncio.sleep(self._config.ping_interval_s)
            if not self._ready.is_set():
                continue
            for conn in list(self._conns.values()):
                try:
                    await conn.call("gateway.ping", timeout=self._config.ping_timeout_s)
                except (GatewayUnavailable, RpcTimeout, RpcError) as exc:
                    self._log.warning("gateway.ping failed on ws=%s: %s", conn.name, exc)
                    await conn.close()
