"""Shared types of the Emperor bridge 0.9 (stable contract between W3 core and W4 periphery).

Design reference: docs/design/hermes-persistent-runtime.md rev 2 (D1-D22, sections 4.3 and 5).
This module holds only immutable constants, dataclasses, exceptions and Protocols. It has no
module-level mutable state and imports nothing from the rest of the package.
"""
from __future__ import annotations

import enum
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping, Optional, Protocol, Sequence, runtime_checkable

# ---------------------------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------------------------

HERMES_CODE_VERSION = "0.22.4"
"""identify.code_version the bridge accepts (D1, D20)."""

GATEWAY_KIND = "hermes-gateway"
RUNTIME_PROTOCOL = 1
SESSION_AUTHORITY_CAPABILITY = "session-authority-v1"
WS_SUBPROTOCOL = "hermes-gateway-v1"
WS_TICKET_PREFIX = "hermes-gateway-ticket."

NS_EMPEROR_RUN = uuid.UUID("6f1c5a52-3b8e-5d0e-9c55-0e6d2f1a9b90")
"""Namespace for run ids: run_id = uuid5(NS_EMPEROR_RUN, f"{agent_id}:{submission_id}") (D5).

The agent id is part of the seed so two agents answering the same Emperor message never collide
on the same run id. The submission_id itself is unchanged (`emp-<msgId>[-rN]`)."""

SOCKET_TURNS = "turns"
SOCKET_MAINTENANCE = "maintenance"


class Topology(str, enum.Enum):
    """Gateway topology (D2, D21). `managed` behaves like standalone (one container = one agent)."""

    STANDALONE = "standalone"
    SHARED = "shared"
    MANAGED = "managed"


class TurnOutcome(str, enum.Enum):
    """Bridge-level turn outcome. Maps 1:1 onto the ledger finish status via `ledger_status`."""

    COMPLETED = "completed"
    CANCELLED = "cancelled"
    FAILED = "failed"
    TIMEOUT = "timeout"

    @property
    def ledger_status(self) -> str:
        return {"completed": "succeeded", "cancelled": "cancelled", "failed": "failed",
                "timeout": "timeout"}[self.value]


# ---------------------------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------------------------


class BridgeError(Exception):
    """Base class of every error raised by the bridge core."""


class GatewayUnavailable(BridgeError):
    """The gateway cannot be reached right now (socket missing, not ready, connection lost)."""


class GatewayIncompatible(BridgeError):
    """identify succeeded but the gateway fails a D1 check. Fatal: the bridge must not dispatch."""


class ProfileNotServed(GatewayUnavailable):
    """Shared gateway: the profile home is not in served_profiles (needs `hermes gateway rescan`)."""


class RpcError(BridgeError):
    """A JSON-RPC error frame. `reason` is data.reason for 4001 domain refusals."""

    def __init__(self, code: int, message: str, data: Optional[Mapping[str, Any]] = None) -> None:
        super().__init__(f"{code} {message}")
        self.code = code
        self.message = message
        self.data = dict(data or {})

    @property
    def reason(self) -> str:
        return str(self.data.get("reason") or self.message or "")


class RpcTimeout(BridgeError):
    """No response within the call timeout."""


class EmperorUnavailable(BridgeError):
    """Emperor HTTP failed transiently (network, 5xx, 429). The caller retries later."""


class RunNotFound(BridgeError):
    """409 run_not_found from the events endpoint: resend with the `run` header."""


class RunGone(BridgeError):
    """410 from the events endpoint: the run ended long ago. Drop its events."""


class AdmissionConflict(BridgeError):
    """The gateway already holds a different admission under this submission_id.

    Raised when ``prompt.submit`` answers ``admission_conflict`` or when a settled record already
    exists for the submission id: the caller must retry with a fresh ``-rN`` attempt rather than
    deferring the same submission id again and again."""


# ---------------------------------------------------------------------------------------------
# Gateway discovery and wire events
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class ProfileTarget:
    """Where one agent's gateway lives.

    Standalone/managed: control_home == profile_home. Shared: control_home is the default
    Hermes home (~/.hermes) and the ticket is minted with this profile's profile_id.
    """

    profile_name: str
    profile_home: Path
    control_home: Path
    topology: Topology = Topology.STANDALONE


@dataclass(frozen=True)
class GatewayIdentity:
    """Validated `identify` result plus the profile_id resolved for one ProfileTarget."""

    instance_id: str
    authority_epoch: int
    api_origin: str
    code_version: str
    code_sha: str
    profile_id: str
    hermes_home: str = ""
    pid: Optional[int] = None
    state: str = "ready"
    capabilities: tuple[str, ...] = ()

    @property
    def ws_url(self) -> str:
        return self.api_origin.replace("http://", "ws://", 1).rstrip("/") + "/api/ws"

    def same_instance(self, other: Optional["GatewayIdentity"]) -> bool:
        return (other is not None and other.instance_id == self.instance_id
                and other.authority_epoch == self.authority_epoch)


@dataclass(frozen=True)
class GatewayEvent:
    """One `{"method":"event"}` notification. Envelope fields are None for global/idle events."""

    type: str
    payload: Mapping[str, Any]
    session_id: Optional[str] = None
    seq: Optional[int] = None
    replay_epoch: Optional[str] = None
    admission_id: Optional[str] = None
    execution_generation: Optional[int] = None
    authority_epoch: Optional[int] = None
    received_at: float = 0.0
    replayed: bool = False

    @classmethod
    def from_params(cls, params: Mapping[str, Any], *, received_at: float = 0.0,
                    replayed: bool = False) -> "GatewayEvent":
        payload = params.get("payload")
        if not isinstance(payload, Mapping):
            payload = {}
        admission = params.get("admission_id") or payload.get("admission_id")
        return cls(type=str(params.get("type") or ""), payload=payload,
                   session_id=params.get("session_id"), seq=params.get("seq"),
                   replay_epoch=params.get("replay_epoch"), admission_id=admission,
                   execution_generation=params.get("execution_generation"),
                   authority_epoch=params.get("authority_epoch"), received_at=received_at,
                   replayed=replayed)


EventListener = Callable[[GatewayEvent], None]
ReconnectListener = Callable[["GatewayIdentity", bool], Awaitable[None]]
"""Called after both sockets are up again. The bool is True when the gateway restarted."""


@runtime_checkable
class RpcChannel(Protocol):
    """One serial JSON-RPC socket (`turns` or `maintenance`)."""

    async def call(self, method: str, params: Optional[Mapping[str, Any]] = None, *,
                   timeout: float = 30.0) -> Any: ...


@runtime_checkable
class GatewayLinkPort(Protocol):
    """The two-socket gateway connection the core uses (implemented by gateway.client.GatewayLink)."""

    turns: RpcChannel
    maintenance: RpcChannel

    @property
    def identity(self) -> Optional[GatewayIdentity]: ...

    @property
    def connected(self) -> bool: ...

    def add_event_listener(self, listener: EventListener) -> None: ...

    def add_reconnect_listener(self, listener: ReconnectListener) -> None: ...

    def inject_events(self, events: Sequence[GatewayEvent]) -> None:
        """Feed replayed (events.since) frames through the normal dedup + fan-out path."""

    def hold_session(self, session_id: str) -> None:
        """Queue live events of a session while it is being resynced (resume + events.since)."""

    def release_session(self, session_id: str) -> None:
        """Deliver the queued live events (dedup drops what the replay already delivered)."""

    def seed_cursor(self, session_id: str, replay_epoch: Optional[str], seq: int) -> None:
        """Start event dedup for a session at a known (replay_epoch, seq)."""


# ---------------------------------------------------------------------------------------------
# Sessions (D4, D6)
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class SessionPolicy:
    """Everything that goes into `session.create` for one thread. Built by W4 (`context.py`).

    The bridge turns this into CreateParams once per generation and replays the stored params
    verbatim afterwards. A changed policy only takes effect through a new generation, at most
    once per `refresh_min_interval_s` unless `urgent` (identity/instructions edits).
    """

    system_prompt: str
    thread_type: str = "direct"
    cwd: str = ""
    toolsets: tuple[str, ...] = ("emperor-claw", "web", "terminal", "code_execution")
    run_budget_seconds: int = 0
    yolo: bool = True
    follow_profile_config: bool = True
    extra_client_env: Mapping[str, str] = field(default_factory=dict)
    urgent: bool = False
    refresh_min_interval_s: float = 6 * 3600


@dataclass
class ThreadSession:
    """Persisted per-thread session record (state v2 `threads[<threadId>]`)."""

    thread_id: str
    generation: int
    create_params: dict[str, Any]
    policy_hash: str
    session_id: Optional[str] = None
    replay_epoch: Optional[str] = None
    last_seq: int = 0
    revision: int = 0
    execution_generation: int = 0
    context_used: Optional[int] = None
    last_task_set_hash: Optional[str] = None
    last_turn_at: Optional[str] = None
    generation_started_at: Optional[str] = None
    attached_instance: Optional[str] = None  # runtime only, never persisted

    @property
    def request_id(self) -> str:
        return str(self.create_params.get("request_id") or "")


@runtime_checkable
class SessionStore(Protocol):
    """Persistence for ThreadSession records (implemented by state.BridgeState)."""

    def get_thread(self, thread_id: str) -> Optional[ThreadSession]: ...

    def put_thread(self, session: ThreadSession) -> None: ...

    def all_threads(self) -> list[ThreadSession]: ...

    async def save(self) -> None: ...


# ---------------------------------------------------------------------------------------------
# Turns (D5, D10, D15, D16)
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class TurnAuthor:
    id: str
    name: str
    is_bot: bool = False
    origin: str = "emperor"

    def to_wire(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "is_bot": self.is_bot, "origin": self.origin}


def submission_id_for(trigger_message_id: str, attempt: int = 0) -> str:
    """`emp-<triggerMessageId>` plus `-r<n>` for retries (D5)."""
    base = f"emp-{trigger_message_id}"
    return base if attempt <= 0 else f"{base}-r{attempt}"


def run_id_for(submission_id: str, agent_id: str = "") -> str:
    seed = f"{agent_id}:{submission_id}" if agent_id else submission_id
    return str(uuid.uuid5(NS_EMPEROR_RUN, seed))


@dataclass(frozen=True)
class Turn:
    """One admission the bridge submits. Built by W4 from a scheduler TurnBatch.

    `message_ids` is every Emperor message this turn answers (coalesced), the last one is the
    trigger. Objective turns may have no message id: then `trigger_id` names the objective
    record and no turn file message id is written.
    """

    thread_id: str
    trigger_id: str
    text: str
    api_text: str
    policy: SessionPolicy
    message_ids: tuple[str, ...] = ()
    author: Optional[TurnAuthor] = None
    attempt: int = 0
    agent_id: str = ""
    trigger_kind: str = "message"
    queue_position: int = 0
    queued_at: Optional[float] = None  # time.time() when the first message was queued
    display_kind: Optional[str] = None  # "hidden" for objective evaluation turns (D18 fallback)
    reply_message_id: Optional[str] = None  # message the plugin acks; defaults to trigger

    @property
    def submission_id(self) -> str:
        return submission_id_for(self.trigger_id, self.attempt)

    @property
    def run_id(self) -> str:
        return run_id_for(self.submission_id, self.agent_id)

    @property
    def answers_message_id(self) -> Optional[str]:
        if self.reply_message_id:
            return self.reply_message_id
        return self.message_ids[-1] if self.message_ids else None


@dataclass(frozen=True)
class UsageLedger:
    """Ledger fields from `prompt.receipt.result` (D16)."""

    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    cache_read_tokens: Optional[int] = None
    cache_write_tokens: Optional[int] = None
    reasoning_tokens: Optional[int] = None
    api_calls: Optional[int] = None
    model: Optional[str] = None
    provider: Optional[str] = None
    cost_status: Optional[str] = None
    estimated_cost_usd: Optional[float] = None

    @property
    def cost_cents(self) -> Optional[int]:
        if self.cost_status in (None, "unknown") or self.estimated_cost_usd is None:
            return None
        return int(round(float(self.estimated_cost_usd) * 100))


@dataclass(frozen=True)
class TurnResult:
    """What TurnRunner.run returns. W4's ledger.finish_payload reads this."""

    outcome: TurnOutcome
    final_text: str
    usage: UsageLedger
    exit_reason: Optional[str] = None
    failure_reason: Optional[str] = None
    error_code: Optional[str] = None  # runtime_restart | idle_timeout | gateway_error | queue_full | ...
    retry_advised: bool = False  # D15: restart-lost and no tool ran -> resubmit once as -r1
    admission_id: Optional[str] = None
    execution_generation: Optional[int] = None
    duration_ms: Optional[int] = None
    queue_ms: Optional[int] = None
    first_token_ms: Optional[int] = None
    steps: int = 0
    tool_calls: int = 0
    saw_tool: bool = False
    context_used: Optional[int] = None
    restart_path: bool = False
    receipt: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class RecoveredTurn:
    """Outcome of the crash/restart recovery for one persisted `turns[...]` record."""

    submission_id: str
    record: Mapping[str, Any]
    result: Optional[TurnResult]  # None when the admission was never submitted


# ---------------------------------------------------------------------------------------------
# Emperor run events (section 4.3) and the Emperor HTTP surface the core needs
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class EmperorEvent:
    """One run event as POSTed to /api/mcp/agents/runs/[id]/events (camelCase on the wire).

    `seq` is assigned by the EventSink (monotonic per run). `source_key` is the stable identity
    used to derive the event id (`<replay_epoch>:<hermes seq>` or a bridge-made key).
    """

    kind: str
    ts: str
    source_key: str
    tool_name: Optional[str] = None
    tool_call_id: Optional[str] = None
    status: Optional[str] = None
    duration_ms: Optional[int] = None
    summary: Optional[str] = None
    data: Optional[Mapping[str, Any]] = None

    def to_wire(self, run_id: str, seq: int) -> dict[str, Any]:
        out: dict[str, Any] = {"id": str(uuid.uuid5(uuid.UUID(run_id), self.source_key)),
                               "seq": seq, "ts": self.ts, "kind": self.kind}
        for key, value in (("toolName", self.tool_name), ("toolCallId", self.tool_call_id),
                           ("status", self.status), ("durationMs", self.duration_ms),
                           ("summary", self.summary), ("data", dict(self.data) if self.data else None)):
            if value is not None:
                out[key] = value
        return out


DROPPABLE_EVENT_KINDS = frozenset({"reasoning", "tool.progress", "usage", "notice"})
TERMINAL_EVENT_KINDS = frozenset({"turn.completed", "turn.failed", "turn.interrupted"})


@runtime_checkable
class EmperorPort(Protocol):
    """The Emperor HTTP calls the core makes. Implemented by W4 (`emperor_api.py`).

    Raise EmperorUnavailable for transient failures, RunNotFound for 409 run_not_found,
    RunGone for 410. Any other HTTP error raises BridgeError (the batch is dropped).
    """

    async def post_run_events(self, run_id: str, events: Sequence[Mapping[str, Any]],
                              run_header: Optional[Mapping[str, Any]] = None) -> Mapping[str, Any]: ...

    async def ack_control_command(self, command_id: str) -> None: ...


@runtime_checkable
class EventSinkPort(Protocol):
    """Bridge -> Emperor run events, batched (implemented by events.EventSink)."""

    def open_run(self, run_id: str, header: Mapping[str, Any], *, next_seq: int = 0) -> None: ...

    def emit(self, run_id: str, event: EmperorEvent) -> None: ...

    def next_seq(self, run_id: str) -> int: ...

    def dropped(self, run_id: str) -> int: ...

    async def flush(self, run_id: Optional[str] = None) -> None: ...

    def close_run(self, run_id: str) -> None: ...


@runtime_checkable
class TurnStore(Protocol):
    """Persistence for in-flight turn records (state v2 `turns[...]`)."""

    def get_turn(self, submission_id: str) -> Optional[dict[str, Any]]: ...

    def put_turn(self, submission_id: str, record: dict[str, Any]) -> None: ...

    def drop_turn(self, submission_id: str) -> None: ...

    def open_turns(self) -> dict[str, dict[str, Any]]: ...

    async def save(self) -> None: ...


# ---------------------------------------------------------------------------------------------
# Configuration of the core (W4 fills these from HostConfig/AgentConfig)
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class GatewayConfig:
    expected_code_version: str = HERMES_CODE_VERSION
    ping_interval_s: float = 15.0
    ping_timeout_s: float = 10.0
    open_timeout_s: float = 10.0
    ready_timeout_s: float = 10.0
    max_frame_bytes: int = 8 * 1024 * 1024
    backoff_initial_s: float = 0.2
    backoff_max_s: float = 5.0
    control_timeout_s: float = 5.0


@dataclass(frozen=True)
class TurnConfig:
    idle_timeout_s: float = 900.0  # EMPEROR_CLAW_HERMES_TURN_IDLE_TIMEOUT_SECONDS
    rpc_timeout_s: float = 30.0
    interrupt_grace_s: float = 60.0  # after interrupt, poll the receipt if no message.complete
    turn_file_ttl_s: float = 6 * 3600.0
    tick_s: float = 0.5
    clarify_answer: str = "No human is available to answer. Use your best judgment and continue."


@dataclass(frozen=True)
class SchedulerConfig:
    max_parallel_turns: int = 3  # EMPEROR_CLAW_HERMES_MAX_PARALLEL_TURNS
    followup_mode: str = "coalesce"  # EMPEROR_CLAW_HERMES_FOLLOWUP ("steer" gated by R-3)
    max_coalesced: int = 10


@dataclass(frozen=True)
class CompactionConfig:
    after_tokens: int = 60000  # EMPEROR_CLAW_HERMES_COMPACT_AFTER_TOKENS, 0 = off
    keep_last: int = 6
    timeout_s: float = 660.0
    max_busy_retries: int = 3


@dataclass(frozen=True)
class EventSinkConfig:
    flush_ms: int = 500  # EMPEROR_CLAW_HERMES_EVENT_FLUSH_MS
    batch_max: int = 50
    body_max_bytes: int = 120 * 1024
    spool_cap: int = 5000  # per agent
    retry_initial_s: float = 1.0
    retry_max_s: float = 30.0


@dataclass(frozen=True)
class AgentIdentity:
    """Who this AgentRuntime is. W4 builds it from the profile .env."""

    agent_id: str
    agent_name: str
    runtime_id: str
    bridge_version: str
    profile: ProfileTarget
