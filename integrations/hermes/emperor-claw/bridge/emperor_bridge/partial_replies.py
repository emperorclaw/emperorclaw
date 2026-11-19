"""Bounded, capability-negotiated response previews; durable delivery stays authoritative."""
from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

MAX_BYTES = 128 * 1024
MAX_RUNS = 32
INTERVAL = 0.25


@dataclass
class Preview:
    run_id: str
    segment: int = 0
    revision: int = 0
    text: str = ""
    state: str = "streaming"
    failures: int = 0
    capped: bool = False
    finished: bool = False
    task: asyncio.Task | None = None
    pending: list[dict[str, Any]] = field(default_factory=list)
    cursors: dict[tuple[Any, Any], int] = field(default_factory=dict)

    def snapshot(self) -> dict[str, Any]:
        return {"responseId": str(uuid.uuid5(uuid.UUID(self.run_id), f"response:{self.segment}")),
                "segmentIndex": self.segment, "revision": self.revision,
                "text": self.text, "state": self.state}


class PartialReplies:
    def __init__(self, request: Callable, agent_id: str, enabled: Callable[[], bool]):
        self.request, self.agent_id, self.enabled = request, agent_id, enabled
        self.runs: dict[str, Preview] = {}

    def event(self, run_id: str, event: Any) -> None:
        if not self.enabled() or event.type not in ("message.delta", "message.interim"):
            return
        preview = self.runs.get(run_id)
        if preview is None:
            if len(self.runs) >= MAX_RUNS:
                return
            preview = self.runs[run_id] = Preview(run_id)
        if preview.capped:
            return
        seq = getattr(event, "seq", None)
        epoch = (getattr(event, "replay_epoch", None), getattr(event, "execution_generation", None))
        if isinstance(seq, int):
            if seq <= preview.cursors.get(epoch, -1):
                return
            preview.cursors[epoch] = seq
            if len(preview.cursors) > 8:
                preview.cursors.pop(next(iter(preview.cursors)))
        text = str(event.payload.get("text") or "")
        next_text = preview.text + text if event.type == "message.delta" else text or preview.text
        if len(next_text.encode("utf-8")) > MAX_BYTES:
            preview.capped, preview.state = True, "capped"
            preview.revision += 1
            self._start(preview)
            return  # Keep the bounded preview; complete content uses the durable reply.
        preview.text = next_text
        preview.revision += 1
        if event.type == "message.interim" and preview.segment < 31:
            preview.state = "sealed"
            preview.pending.append(preview.snapshot())
            preview.segment += 1
            preview.revision, preview.text, preview.state = 0, "", "streaming"
        self._start(preview)

    def finish(self, run_id: str, text: str, state: str = "completed") -> None:
        preview = self.runs.get(run_id)
        if preview is None:
            return
        if len(text.encode("utf-8")) <= MAX_BYTES:
            preview.text = text or preview.text
        preview.finished = True
        preview.state = state
        preview.revision += 1
        self._start(preview)

    def _start(self, preview: Preview) -> None:
        if preview.task is None or preview.task.done():
            preview.task = asyncio.get_running_loop().create_task(self._flush(preview))

    async def _flush(self, preview: Preview) -> None:
        sent = (-1, -1)
        try:
            while True:
                await asyncio.sleep(INTERVAL)
                if not self.enabled():
                    return
                if not preview.pending and (preview.segment, preview.revision) == sent:
                    if preview.state != "streaming":
                        return
                    # Stop an idle worker; the next delta restarts it.
                    return
                if not preview.pending and preview.revision == 0:
                    return
                body = preview.pending[0] if preview.pending else preview.snapshot()
                try:
                    await self.request("POST", f"/agents/runs/{preview.run_id}/responses", body,
                                       {"agentId": self.agent_id}, timeout=5)
                    sent = (body["segmentIndex"], body["revision"])
                    if preview.pending and preview.pending[0] is body:
                        preview.pending.pop(0)
                    preview.failures = 0
                except Exception:
                    preview.failures += 1
                    if preview.failures >= 4:
                        return
                    await asyncio.sleep(min(2, preview.failures * 0.5))
                if preview.state != "streaming" and not preview.pending and sent == (preview.segment, preview.revision):
                    return
        finally:
            if preview.finished or preview.failures >= 4:
                self.runs.pop(preview.run_id, None)

    async def close(self) -> None:
        tasks = [preview.task for preview in self.runs.values() if preview.task and not preview.task.done()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.runs.clear()
