"""What the model sees (D6): a frozen system prompt per session, a small delta per turn.

- ``system_prompt`` (``client_env.HERMES_EPHEMERAL_SYSTEM_PROMPT``, frozen per generation):
  identity, role instructions, memory, the operating guide, Emperor rules (incl. the lookup map and
  team-chat rules that the deleted plugin ``pre_llm_call`` hook used to inject, D22), the
  reply-format guide, roster, Company Brain context, and the STABLE thread context (thread kind and
  title, members, group roles, team roles, org chart). Lean mode swaps the static head for the
  server's kernel + knowledge index.
- ``api_text`` (persisted and replayed by Hermes on every turn, S-12): the message itself FIRST,
  then a delta of at most 400 chars: ``[emperor msg=<id8> from=<name> (<human|agent>) at=<HH:MM
  UTC>]``, a task line only when this agent's open-task set changed since the session's last turn,
  and ``[ack-first]`` for human senders. Open tasks and the main-chat digest are no longer pushed:
  the agent fetches them with tools.
- The continuity seed (5.6) is the only large ``api_text`` a session receives: on the first turn
  of a generation, recent thread history (cap 6000 chars), replayed with the session on purpose.

Server data (roster, Company Brain, live profile, org chart, lean payload) is cached per agent and
refreshed at most every ``ttl_s``; a failed refresh keeps the last value. A changed prompt only
takes effect through a new generation (throttled to 6 h unless identity/instructions changed).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

from .emperor_api import (agent_name_aliases, field, normalize_mention, sender_type_of, thread_of,
                          thread_type_of)
from .interfaces import SessionPolicy

DELTA_MAX = 400
SEED_MAX = 6000
SEED_MESSAGES = 30
REPLY_GUIDE_MAX = 1600
MEMORY_MAX, MEMORY_ITEM_MAX = 3000, 300
TASK_TEXT_MAX = 60
OPEN_TASK_STATES = frozenset({"inbox", "in_progress", "review"})
MAX_THREAD_DETAILS = 200
RICH_BLOCKS_CAPABILITY = "rich-blocks-v1"
LEAN_CAPABILITY = "lean-context: 1"
IDENTITY_ENV = "EMPEROR_PROMPT_IDENTITY"

BUILTIN_OPERATING_GUIDE = """## Emperor minimum operating practices

Emperor is the durable source of truth. Read the relevant scoped Knowledge & Rules before assuming company conventions. Use tools before claiming writes succeeded.

- Reply in the current thread. Direct threads are private; Team chat is visible to the company: never copy private details or secrets into it.
- Act on a team message only when it addresses your @name. To ask a sibling to do work, assign it a task; a @mention requests attention, it does not assign work.
- Reply to a requested handoff once. When a reply closes your own request, stop. FYI/status updates have no @mention.
- Every task has exactly one owner. Keep progress and blockers in task notes, not chat. Request an approval before spending money, publishing, deleting or sending anything outside the company.
- Notes are reusable doctrine: use status=active for established facts, draft for uncertain proposals. Never store secrets.
- Never claim a task is done, an agent was created, or a message was sent unless the tool call actually succeeded.
"""

EMPEROR_RULES = """Reply to the latest message. Do not recap old context unless asked.
Use Emperor tools only when the request needs durable state, exact chat history, or a real state change.
For reusable knowledge, create or update a normal Company Brain note with top-level status: active for established knowledge; use status: draft only when explicitly uncertain.
When writing Knowledge & Rules, use Obsidian-style markdown notes: frontmatter with scope/type/status/owner/tags, one reusable rule per note, explicit [[wikilinks]], and Evidence/Related sections when useful.
Do not fake folders in note titles; Emperor places notes by company/customer/project/agent scope.
Do not mention projects, tasks, resources, or Storage unless they are relevant to the user's request.
Emperor is the source of truth. If local memory and Emperor disagree, prefer Emperor and surface the mismatch.

Where to look in Emperor (fetch on demand; nothing below is pushed into your messages):
- Past chat/history: emperor_list_threads, then emperor_get_thread_messages. Thread history is REST-readable.
- Your open tasks: emperor_list_tasks; status questions: emperor_get_task_overview first; one task: emperor_get_task.
- Task progress/history: emperor_request GET /tasks/{id}/notes. Project memory: GET /projects/{id}/memory.
- Team roster: emperor_request GET /agents. Groups and memberships: emperor_list_groups. Org chart: GET /organization.
- Objective check-in: emperor_update_objective(objectiveId, action='update'|'block'|'complete').
- Company Brain / Knowledge & Rules: emperor_request GET /resources/context for resolved context, POST /resources for established knowledge (active) or uncertain proposals (draft), GET /resources for lookup.
- Storage/files: emperor_list_folder_contents to browse; emperor_create_folder (projectId/customerId, parentFolderId for subfolders) then emperor_upload_artifact(filePath, kind, projectId, folderId); emperor_verify_artifact to check an upload.
- emperor_request is not a generic external HTTP client; for external APIs use terminal/curl or a dedicated plugin.

Storage rules:
- Storage is an Emperor abstraction; do not ask for or mention backing blob-provider keys.
- Create/find the folder first and pass folderId; never upload randomly into the Storage root. Search before creating duplicates; prefer move/replace over duplicate uploads.
- If an upload fails, report an Emperor Storage upload failure with the tool error.

Messaging model:
- Direct threads are private one-human-to-one-agent conversations. Reply normally in direct threads.
- Your answer is delivered to the current thread automatically. Do NOT call emperor_send_message to reply to the message you are answering: that posts a duplicate. Use emperor_send_message only to message a DIFFERENT thread.
- Team chat is the shared visible coordination thread for humans and all agents. Group chats are members-only team channels with the same @mention rules. A human's @all in a group is addressed to you; never write @all yourself.
- ONLY respond to a team chat message if your @name appears in it. If your name is absent, the message is for someone else: stay silent.
- To ask a sibling to do something: post in team chat with @SiblingName and one concrete request (use the roster for the exact @name), or emperor_send_message(targetAgentId=<id or name>, text=...) to reach one sibling in your shared work-team chat.
- When a sibling @mentions you with a request, complete the work then reply with the answer and @mention them ONCE so it routes back. That reply CLOSES the request.
- If you receive a reply that answers a request YOU made, do not reply again: no thanks, no acknowledgment, no follow-up @mention.
- Never @mention the same agent twice in a row without a new human message or a materially new question in between.
- Informational updates (status, FYI, task done with no one waiting) go to team chat with NO @mention.
- Safety net: too many consecutive agent messages without human input pause your replies in that thread.

Each message you receive ends with a short metadata line from Emperor, `[emperor msg=<id> from=<name> (human|agent) at=<time>]`, sometimes a `[tasks ...]` line (your open tasks changed) and `[ack-first]`. With `[ack-first]`, if the work needs more than a couple of tool calls or ~30 s, send ONE short acknowledgement with emperor_send_message(acknowledge=true) first, then work, then reply with the result. Never acknowledge chit-chat or one-step answers."""

FORMAT_BASE = ("Formatting: your reply is shown in Emperor Claw's web chat, a graphical app, not a terminal. "
               "Markdown renders (tables, code blocks, links, lists), so use it; ignore any earlier note that says "
               "Markdown does not render.")


def digest(text: str, length: int = 16) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:length]


def clean_line(value: Any, limit: int) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


def load_operating_guide(override: str = "", packaged: Optional[Path] = None) -> str:
    """The guide for the system prompt. Never raises; falls back to the built-in minimum."""
    candidates = [Path(override)] if override else []
    candidates.append(packaged or Path(__file__).resolve().parent.parent.parent / "operating-guide.md")
    for path in candidates:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        if text.strip():
            return text
    return BUILTIN_OPERATING_GUIDE


def parse_server_capabilities(response: Any) -> tuple[frozenset[str], str]:
    """(capabilities, reply-format guide) from /runtime/register; an old server yields (∅, "")."""
    if not isinstance(response, Mapping):
        return frozenset(), ""
    raw = response.get("serverCapabilities")
    caps = frozenset(str(c) for c in raw if isinstance(c, (str, int))) if isinstance(raw, list) else frozenset()
    guide = response.get("replyFormatGuide")
    return caps, (guide.strip()[:REPLY_GUIDE_MAX] if isinstance(guide, str) else "")


def format_roster(agents: Sequence[Mapping[str, Any]], agent_id: str, *, with_ids: bool) -> str:
    if not agents:
        return "Team roster: unavailable; use emperor_request GET /agents only if needed."
    lines = []
    for agent in list(agents)[:24]:
        name = str(agent.get("name") or agent.get("id") or "unknown")
        own_id = str(agent.get("id") or "")
        skills = agent.get("skillsJson") if isinstance(agent.get("skillsJson"), list) else []
        siblings = {normalize_mention(alias) for other in agents if str(other.get("id") or "") != own_id
                    for alias in agent_name_aliases(str(other.get("name") or ""))}
        aliases = sorted((a for a in agent_name_aliases(name) if not re.search(r"\s", a)
                          and normalize_mention(a) not in siblings), key=lambda a: (len(a), a.lower()))
        role = str(agent.get("role") or "").strip()
        head = f"- {name}{' (you)' if own_id == agent_id else ''}{f' — {role}' if role else ''}"
        tail = (f" · {', '.join(str(s) for s in skills[:3])}" if skills else "") + \
            (f" · id {own_id}" if own_id and with_ids else "")
        lines.append(f"{head}: @{aliases[0]}{tail}" if aliases else
                     f"{head}: no unambiguous alias; use an explicitly assigned task{tail}")
    return "Team roster (name, role, and a distinct @alias):\n" + "\n".join(lines)


def format_company_brain_context(context: Any) -> str:
    sources = context.get("sources") if isinstance(context, Mapping) else None
    sections = []
    for source in sources if isinstance(sources, list) else []:
        text = str(source.get("content") or "").strip()
        if not text:
            continue
        title = source.get("name") or source.get("displayName") or source.get("id") or "Company Brain source"
        sections.append(f"### {title} ({source.get('scopeType') or 'company'}/{source.get('resourceType') or 'knowledge_base'}, "
                        f"priority {source.get('priority')})\nsource_id: {source.get('id')}\n{text}")
    if not sections:
        return ("Company Brain: nothing resolved for you. Use emperor_request GET /resources/context or retrieve a "
                "specific note when durable doctrine matters.")
    return ("Company Brain context resolved by Emperor. Use these source ids when citing loaded doctrine; "
            "do not blindly assume every shared resource was injected.\n" + "\n\n".join(sections[:16]))


def format_memory(entries: Sequence[Mapping[str, Any]]) -> str:
    lines, used = [], 0
    for entry in reversed(list(entries)):
        text = clean_line(entry.get("summary") or entry.get("content"), MEMORY_ITEM_MAX)
        if not text:
            continue
        line = f"- ({entry.get('kind') or 'note'}) {text}"
        if used + len(line) > MEMORY_MAX:
            break
        lines.append(line)
        used += len(line) + 1
    return ("What you remember (your Emperor memory; people can edit it in the app):\n"
            + "\n".join(reversed(lines))) if lines else ""


def format_organization(info: Any, agent_id: str) -> str:
    """Leader + this agent's reporting line + one escalation rule, under 400 chars."""
    if not isinstance(info, Mapping) or not info.get("configured"):
        return ""
    leader = info.get("leader") if isinstance(info.get("leader"), Mapping) else {}
    if leader.get("kind") == "agent" and leader.get("id") == agent_id:
        line = "you lead the company; report to humans"
    else:
        target = "humans"
        reporting = [r for r in info.get("reporting") or [] if isinstance(r, Mapping)]
        teams = [t for t in info.get("teams") or [] if isinstance(t, Mapping)]
        if reporting:
            to = reporting[0].get("reportsTo") if isinstance(reporting[0].get("reportsTo"), Mapping) else {}
            target = str(to.get("name") or "humans")
        elif teams:
            coordinator = teams[0].get("coordinator") if isinstance(teams[0].get("coordinator"), Mapping) else {}
            if coordinator.get("kind") == "agent" and coordinator.get("id") == agent_id:
                target = str(leader.get("name") or "humans")
            else:
                target = str(coordinator.get("name") or leader.get("name") or "unassigned")
        line = "you report to " + target[:64]
    return (f"Org: leader {str(leader.get('name') or 'unassigned')[:64]}; {line}\n"
            "Escalate cross-team conflicts to the leader; details: GET /organization.")


def format_thread_context(thread_id: str, thread_type: str, detail: Mapping[str, Any], agent_name: str) -> str:
    """Stable per-thread context: kind, title, members, coordinator. Never message content."""
    kind = thread_type or str(detail.get("type") or "") or "direct"
    title = clean_line(detail.get("title"), 120)
    lines = [f"This session is Emperor thread {thread_id} ({kind}{f': {title}' if title else ''})."]
    if kind == "direct":
        lines.append("It is a private direct conversation with one human. Reply normally; no @mention is needed.")
    members = [m for m in detail.get("members") or [] if isinstance(m, Mapping)]
    if kind == "group" and str(detail.get("description") or "") != "agent-pair":
        purpose = clean_line(detail.get("description"), 600)
        if purpose:
            lines.append(f"Group purpose: {purpose}")
        coordinators = [m for m in members if m.get("role") in ("coordinator", "owner_coordinator") and m.get("name")]
        if coordinators:
            lead = coordinators[0]
            lines.append(f"Team coordinator: {clean_line(lead['name'], 80)} ({'human' if lead.get('kind') == 'human' else 'agent'}). "
                         "This applies only to this group and grants no extra permissions. Coordinate with owned tasks; "
                         "raise blockers to the coordinator with the task and a concrete question.")
        agents = [clean_line(m.get("name"), 40) for m in members if m.get("kind") == "agent" and m.get("name")]
        humans = [clean_line(m.get("name"), 40) for m in members if m.get("kind") == "human" and m.get("name")]
        if agents:
            lines.append("Agent members: " + ", ".join(f"{n}{' (you)' if n == agent_name else ''}" for n in agents[:24]))
        if humans:
            lines.append("Human members: " + ", ".join(humans[:24]))
        lines.append("Group rules: only these members see it. To hand work to a member, @mention them once with one "
                     "concrete request; agents outside the group do not receive it. When a human writes @all, answer "
                     "for your own part only. Never write @all yourself.")
    elif kind == "team":
        lines.append("This is the shared team channel: answer only when your @name is in the message.")
    return "\n".join(lines)


def format_team_roles(details: Mapping[str, Mapping[str, Any]], agent_id: str, agent_name: str) -> str:
    teams = []
    for thread_id, detail in details.items():
        if detail.get("type") != "group" or detail.get("description") == "agent-pair":
            continue
        members = [m for m in detail.get("members") or [] if isinstance(m, Mapping)]
        own = next((m for m in members if m.get("kind") == "agent" and
                    (m.get("id") == agent_id or (not m.get("id") and m.get("name") == agent_name))), None)
        if own is None:
            continue
        lead = next((m for m in members if m.get("role") in ("coordinator", "owner_coordinator")), None)
        role = "coordinator" if own.get("role") in ("coordinator", "owner_coordinator") else "member"
        teams.append((str(thread_id), f"{clean_line(detail.get('title') or 'Team', 48)}: you are {role}; "
                                      f"coordinator: {clean_line(lead.get('name'), 48) if lead else 'none'}"))
    if not teams:
        return ""
    rows = [row for _, row in sorted(teams)[:4]]
    more = [f"Plus {len(teams) - 4} other teams available through emperor_list_groups."] if len(teams) > 4 else []
    return "\n".join(["Your work teams (responsibilities apply only within each team):", *rows, *more])


def sender_label(message: Mapping[str, Any], roster: Mapping[str, str]) -> str:
    meta = message.get("metadataJson") if isinstance(message.get("metadataJson"), Mapping) else {}
    sender_id = field(message, "senderId", "sender_id")
    name = message.get("senderName") or meta.get("senderName") or roster.get(sender_id) or meta.get("senderEmail")
    return clean_line(name or sender_type_of(message) or "someone", 40)


def task_lines(tasks: Sequence[Mapping[str, Any]], agent_id: str) -> tuple[str, list[str], int]:
    """(hash of this agent's open-task set, up to 2 short lines, open count) for the delta."""
    active = [t for t in tasks if isinstance(t, Mapping) and str(t.get("state") or "") in OPEN_TASK_STATES
              and str(t.get("assignedAgentId") or agent_id) == agent_id]
    key = sorted((str(t.get("id")), str(t.get("state"))) for t in active)
    lines = []
    for task in active[:2]:
        spec = task.get("inputJson") if isinstance(task.get("inputJson"), Mapping) else {}
        title = clean_line(spec.get("title") or task.get("taskType") or "task", TASK_TEXT_MAX)
        lines.append(f'{str(task.get("id"))[:8]} "{title}" [{str(task.get("state")).replace("_", " ")}]')
    return digest(json.dumps(key)), lines, len(active)


def build_delta(message: Mapping[str, Any], *, roster: Mapping[str, str], tasks: Optional[list[str]],
                open_count: int, ack_first: bool, coalesced: int = 1) -> str:
    """The <= 400 char metadata block that follows the message text (D6)."""
    stamp = time.strftime("%H:%M", time.gmtime(_created(message)))
    kind = "agent" if sender_type_of(message) == "agent" else "human"
    head = f"[emperor msg={str(message.get('id') or '')[:8]} from={sender_label(message, roster)} ({kind}) at={stamp} UTC"
    head += f" +{coalesced - 1} earlier]" if coalesced > 1 else "]"
    parts = [head]
    if tasks is not None:
        parts.append(f"[tasks changed: {open_count} open" + ("; " + "; ".join(tasks) if tasks else "") + "]")
    if ack_first and kind == "human":
        parts.append("[ack-first]")
    delta = "\n".join(parts)
    return delta if len(delta) <= DELTA_MAX else delta[: DELTA_MAX - 1] + "]"


def _created(message: Mapping[str, Any]) -> float:
    from .emperor_api import parse_iso
    return parse_iso(message.get("createdAt") or message.get("created_at")) or time.time()


def format_seed(history: Sequence[Mapping[str, Any]], exclude: set[str], roster: Mapping[str, str]) -> str:
    """`history` newest first. Recent thread history for the first turn of a generation (5.6), newest last, <= 6000 chars."""
    lines: list[str] = []
    used = 0
    for entry in (h for h in history if isinstance(h, Mapping)):  # newest first: keep the most recent
        if str(entry.get("id") or "") in exclude:
            continue
        text = clean_line(entry.get("text"), 600)
        if not text:
            continue
        line = f"- {sender_label(entry, roster)}: {text}"
        if used + len(line) > SEED_MAX - 200:
            break
        lines.append(line)
        used += len(line) + 1
    if not lines:
        return ""
    return ("[earlier in this thread, oldest first; context only, already answered]\n"
            + "\n".join(reversed(lines)))


class ContextBuilder:
    """Per-agent cache of server context + the prompt/delta builders. One per AgentRuntime."""

    def __init__(self, client: Any, *, agent_id: str, agent_name: str, agent_role: str, instructions: str,
                 ack_first: bool = True, rich_replies: bool = True, context_mode: str = "full",
                 doctrine_resource_id: str = "", operating_guide_path: str = "", shared_max_chars: int = 6000,
                 max_chars_per_resource: Optional[int] = None, ttl_s: float = 600.0, profile_ttl_s: float = 60.0,
                 run_budget_s: int = 0, cwd: str = "", toolsets: Sequence[str] = (),
                 logger: Optional[logging.Logger] = None, clock: Any = time.monotonic) -> None:
        self._client = client
        self._request = client.request
        self.agent_id, self.agent_name, self.agent_role = agent_id, agent_name, agent_role
        self._env_instructions = instructions
        self.ack_first, self._rich, self._mode = ack_first, rich_replies, context_mode
        self._doctrine, self._shared_max, self._per_resource = doctrine_resource_id, shared_max_chars, max_chars_per_resource
        self._guide = load_operating_guide(operating_guide_path)
        self._ttl, self._profile_ttl = ttl_s, profile_ttl_s
        self._run_budget, self._cwd, self._toolsets = run_budget_s, cwd, tuple(toolsets)
        self._log = logger or logging.getLogger("emperor_bridge.context")
        self._clock = clock
        self.capabilities: frozenset[str] = frozenset()
        self.reply_guide = ""
        self._values: dict[str, Any] = {"agents": [], "brain": None, "instructions": None, "memories": [],
                                        "organization": None, "lean": None, "tasks": None}
        self._fetched: dict[str, float] = {}
        self._lean_etag = ""
        self.thread_details: dict[str, dict[str, Any]] = {}

    @classmethod
    def for_agent(cls, client: Any, cfg: Any, agent_id: str, *, logger: Optional[logging.Logger] = None) -> "ContextBuilder":
        """Built from an AgentConfig (duck-typed to keep this module free of config imports)."""
        return cls(client, agent_id=agent_id, agent_name=cfg.agent_name, agent_role=cfg.agent_role,
                   instructions=cfg.agent_instructions, ack_first=cfg.ack_first, rich_replies=cfg.rich_replies,
                   context_mode=cfg.context_mode, doctrine_resource_id=cfg.doctrine_resource_id,
                   operating_guide_path=cfg.operating_guide_path, shared_max_chars=cfg.shared_resource_max_chars,
                   max_chars_per_resource=cfg.max_chars_per_resource, run_budget_s=cfg.turn_timeout_s, cwd=cfg.cwd,
                   toolsets=cfg.toolsets, logger=logger)

    # ---- server data -----------------------------------------------------------------------

    def set_capabilities(self, capabilities: frozenset[str], reply_guide: str) -> None:
        self.capabilities, self.reply_guide = capabilities, reply_guide

    @property
    def rich_active(self) -> bool:
        return self._rich and RICH_BLOCKS_CAPABILITY in self.capabilities and bool(self.reply_guide)

    @property
    def lean_active(self) -> bool:
        return self._mode == "lean" and LEAN_CAPABILITY in self.capabilities

    def remember_threads(self, threads: Any) -> None:
        if isinstance(threads, Mapping):
            for thread_id, detail in threads.items():
                if isinstance(detail, Mapping):
                    self.thread_details[str(thread_id)] = dict(detail)
            while len(self.thread_details) > MAX_THREAD_DETAILS:
                self.thread_details.pop(next(iter(self.thread_details)))

    def roster_names(self) -> dict[str, str]:
        return {str(a.get("id")): str(a.get("name") or a.get("id")) for a in self._values["agents"] if a.get("id")}

    def _stale(self, key: str, ttl: float) -> bool:
        return key not in self._fetched or self._clock() - self._fetched[key] >= ttl

    async def _load(self, key: str, ttl: float, fetch: Any) -> None:
        if not self._stale(key, ttl):
            return
        self._fetched[key] = self._clock()  # also on failure: no retry storm, the last value stays
        try:
            value = await fetch()
        except Exception as exc:
            self._log.info("context %s fetch failed (keeping the last value): %s", key, exc)
            return
        if value is not None:
            self._values[key] = value

    async def refresh(self) -> None:
        """Refresh every stale input concurrently. Never raises."""
        jobs = [self._load("agents", self._ttl, self._fetch_agents), self._load("profile", self._profile_ttl, self._fetch_profile),
                self._load("organization", self._ttl, self._fetch_organization)]
        jobs.append(self._load("lean", self._ttl, self._fetch_lean) if self.lean_active else
                    self._load("brain", self._ttl, self._fetch_brain))
        await asyncio.gather(*jobs)

    async def _fetch_agents(self) -> Any:
        payload = await self._request("GET", "/agents", query={"limit": 50}, timeout=10)
        agents = payload.get("agents") if isinstance(payload, Mapping) else None
        return [a for a in agents if isinstance(a, Mapping)] if isinstance(agents, list) else None

    async def _fetch_profile(self) -> Any:
        payload = await self._request("GET", f"/agents/{self.agent_id}/memory", query={"limit": 20}, timeout=10)
        if isinstance(payload, Mapping):
            if isinstance(payload.get("instructions"), str):
                self._values["instructions"] = payload["instructions"].strip()
            if isinstance(payload.get("entries"), list):
                self._values["memories"] = [e for e in payload["entries"] if isinstance(e, Mapping)]
        return None

    async def _fetch_organization(self) -> Any:
        return await self._request("GET", "/organization", query={"agentId": self.agent_id}, timeout=10)

    async def _fetch_brain(self) -> Any:
        query: dict[str, Any] = {"agentId": self.agent_id, "maxChars": self._shared_max}
        if self._per_resource:
            query["maxCharsPerResource"] = self._per_resource
        if self._doctrine:
            query["resourceId"] = self._doctrine
        return await self._request("GET", "/resources/context", query=query, timeout=10)

    async def _fetch_lean(self) -> Any:
        status, payload, etag = await self._client.get_with_etag("/context/lean", {"agentId": self.agent_id},
                                                                 self._lean_etag)
        if status == 304:
            return None
        self._lean_etag = etag
        return payload if isinstance(payload, Mapping) else None

    async def open_tasks(self, ttl_s: float = 30.0) -> Optional[list[Mapping[str, Any]]]:
        await self._load("tasks", ttl_s, lambda: self._request(
            "GET", "/tasks", query={"assignedAgentId": self.agent_id, "limit": 25}, timeout=5))
        tasks = self._values.get("tasks")
        rows = tasks.get("tasks") if isinstance(tasks, Mapping) else None
        return [t for t in rows if isinstance(t, Mapping)] if isinstance(rows, list) else None

    # ---- system prompt ---------------------------------------------------------------------

    @property
    def instructions(self) -> str:
        live = self._values.get("instructions")
        return live if isinstance(live, str) else self._env_instructions

    @property
    def identity_hash(self) -> str:
        return digest(json.dumps([self.agent_name, self.agent_role, self.instructions]), 12)

    def _head(self) -> list[str]:
        parts = ["You are replying from a Hermes Agent runtime connected to Emperor Claw.\n"
                 f"Agent name: {self.agent_name}\nAgent role: {self.agent_role}"]
        if self.instructions:
            parts.append(f"Role instructions:\n{self.instructions}")
        memory = format_memory(self._values.get("memories") or [])
        if memory:
            parts.append(memory)
        return parts

    def _static(self) -> list[str]:
        lean = self._values.get("lean") if self.lean_active else None
        if isinstance(lean, Mapping):
            parts = [str(lean.get(k) or "").strip() for k in ("kernel", "alwaysBlock")]
            index = str(lean.get("knowledgeIndex") or "").strip()
            if index:
                parts.append("Company knowledge index — load a note with emperor_get_knowledge_note, search with "
                             "emperor_search_knowledge\n" + index)
            parts += [str(lean.get("roster") or "").strip(), EMPEROR_RULES,
                      "Formatting: plain markdown; for rich blocks load manual section reply-formatting"]
            return [p for p in parts if p]
        guidance = FORMAT_BASE + ("\n\n" + self.reply_guide if self.rich_active else "")
        return [self._guide.strip(), EMPEROR_RULES, guidance,
                format_roster(self._values["agents"], self.agent_id, with_ids=self.rich_active),
                format_company_brain_context(self._values.get("brain"))]

    def system_prompt(self, thread_id: str, thread_type: str = "") -> tuple[str, str]:
        detail = self.thread_details.get(thread_id) or {}
        kind = thread_type or str(detail.get("type") or "")
        thread = [format_thread_context(thread_id, kind, detail, self.agent_name)]
        organization = format_organization(self._values.get("organization"), self.agent_id)
        if organization:
            thread.append(organization)
        if kind == "direct":
            roles = format_team_roles(self.thread_details, self.agent_id, self.agent_name)
            if roles:
                thread.append(roles)
        text = "\n\n".join(self._head() + self._static() + ["## This conversation\n" + "\n\n".join(thread)]) + "\n"
        return text, digest(text)

    def policy(self, thread_id: str, thread_type: str, previous_params: Optional[Mapping[str, Any]] = None) -> SessionPolicy:
        """SessionPolicy for a thread. `urgent` when identity/instructions changed since that generation."""
        text, _ = self.system_prompt(thread_id, thread_type)
        identity = self.identity_hash
        old_env = (previous_params or {}).get("client_env") or {}
        urgent = bool(previous_params) and old_env.get(IDENTITY_ENV) not in (None, identity)
        return SessionPolicy(system_prompt=text, thread_type=thread_type or "direct", cwd=self._cwd,
                             toolsets=self._toolsets or SessionPolicy.toolsets, run_budget_seconds=self._run_budget,
                             extra_client_env={IDENTITY_ENV: identity}, urgent=urgent)

    # ---- per turn --------------------------------------------------------------------------

    async def delta(self, message: Mapping[str, Any], *, last_task_hash: Optional[str], coalesced: int = 1,
                    goal_turn: bool = False) -> tuple[str, Optional[str]]:
        """(delta text, new task-set hash). The task line appears only when the set changed."""
        tasks = await self.open_tasks()
        lines, new_hash, count = None, last_task_hash, 0
        if tasks is not None:
            new_hash, task_rows, count = task_lines(tasks, self.agent_id)
            if new_hash != last_task_hash:
                lines = task_rows
        return build_delta(message, roster=self.roster_names(), tasks=lines, open_count=count,
                           ack_first=self.ack_first and not goal_turn, coalesced=coalesced), new_hash

    async def seed(self, thread_id: str, exclude: set[str]) -> str:
        try:
            payload = await self._request("GET", f"/threads/{thread_id}/messages", query={"limit": SEED_MESSAGES},
                                          timeout=10)
        except Exception as exc:
            self._log.info("continuity seed for %s unavailable: %s", thread_id, exc)
            return ""
        rows = payload.get("messages") if isinstance(payload, Mapping) else None
        rows = [r for r in rows if isinstance(r, Mapping)] if isinstance(rows, list) else []
        rows.sort(key=lambda r: str(r.get("createdAt") or ""), reverse=True)
        return format_seed(rows, exclude, self.roster_names())


def compose_api_text(messages: Sequence[Mapping[str, Any]], delta: str, seed: str = "") -> tuple[str, str]:
    """(text, api_text): the message(s) first, then the delta, then (first turn only) the seed."""
    texts = [str(m.get("text") or "").strip() for m in messages]
    text = "\n\n".join(t for t in texts if t) or "(empty message)"
    api_text = f"{text}\n\n{delta}"
    if seed:
        api_text += "\n\n" + seed
    return text, api_text


__all__ = ["ContextBuilder", "compose_api_text", "build_delta", "format_seed", "parse_server_capabilities",
           "load_operating_guide", "format_roster", "format_company_brain_context", "format_organization",
           "format_thread_context", "format_team_roles", "task_lines", "thread_of", "thread_type_of"]
