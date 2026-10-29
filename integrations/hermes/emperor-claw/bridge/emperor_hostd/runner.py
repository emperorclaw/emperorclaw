"""Job execution: ``systemd-run --user --collect`` units, their logs and their state on disk.

Layout (``~/.local/share/emperor-hermes/jobs``, mode 0700; files 0600)::

    <jobId>.json   job state: command, args, unit, state (running|done), lastSeq, result
    <jobId>.log    the job's stdout/stderr (StandardOutput=append:)
    <jobId>.exit   the exit code, written by emperor_hostd.jobwrap when the argv ends

A daemon restart never kills a job: the unit belongs to the user manager. On start the daemon
re-attaches to every ``running`` job (unit still active, or its .exit file says how it ended), and
a known jobId is never run twice: a repeated command replays the stored result. A job file that
cannot be read is "corrupt": it is reported as failed and NEVER run again.

Progress: log lines become progress frames (seq = line number). The read position is committed
only after the frames were handed to the socket (:meth:`JobRunner.commit`), and the last lines
sent are kept so they can be resent after a reconnect (the server ignores seqs it already has).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Optional, Sequence

from .commands import Plan
from .config import HostPaths
from .protocol import LINE_MAX, Redactor, clip_tail, progress, result

UNIT_PREFIX = "emperor-hostd-job-"
#: A job keeps running this long past its deadline before the daemon stops it.
DEADLINE_GRACE_SEC = 30
#: Polls a job may be "not active, no exit code" before it counts as lost (the unit may still be starting).
LOST_AFTER_POLLS = 3
#: Finished jobs are reported in hello (so a lost result is replayed) for this long, kept on disk longer.
REPORT_DONE_FOR_SEC = 24 * 3600
KEEP_FOR_SEC = 30 * 24 * 3600
#: Progress lines kept for a resend after a reconnect.
RESEND_LINES = 50
#: Most progress lines one job sends (the rest stays in its log; the server keeps 2000).
MAX_PROGRESS_LINES = 2000
#: Progress frames read per poll (the rest waits for the next poll; see connection.PROGRESS_PACE_SEC).
MAX_FRAMES_PER_POLL = 50
#: Jobs listed in hello (the server's schema limit), newest first.
MAX_REPORTED_JOBS = 200
#: Bytes read from a job log per poll, and for a result's tail.
READ_CHUNK = 256 * 1024
TAIL_BYTES = 64 * 1024
#: A gateway restart that printed this step did restart, even if waiting for "ready" then failed.
RESTARTED_STEP = "==> Restarted "


class RunnerError(RuntimeError):
    pass


def unit_name(job_id: str) -> str:
    return UNIT_PREFIX + job_id.replace("-", "")[:8]


def _write_private(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)


class JobStore:
    def __init__(self, directory: Path, now: Callable[[], float] = time.time) -> None:
        self.dir = directory
        self.now = now

    def ensure_dir(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            os.chmod(self.dir, 0o700)
        except OSError:
            pass

    def path(self, job_id: str, ext: str) -> Path:
        return self.dir / f"{job_id}.{ext}"

    def load(self, job_id: str) -> Optional[dict[str, Any]]:
        """The job, None when unknown, or ``{"state": "corrupt"}`` when its file cannot be read."""
        path = self.path(job_id, "json")
        if not path.exists():
            # A corrupt job already reported is kept as a tombstone: still never run, no longer listed.
            if self.path(job_id, "corrupt").exists():
                return {"jobId": job_id, "state": "corrupt", "command": "unknown", "retired": True}
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = None
        if not isinstance(data, dict) or data.get("jobId") != job_id or data.get("state") not in ("running", "done"):
            return {"jobId": job_id, "state": "corrupt", "command": "unknown"}
        return data

    def save(self, job: dict[str, Any]) -> None:
        self.ensure_dir()
        _write_private(self.path(job["jobId"], "json"), json.dumps(job, sort_keys=True))

    def all(self) -> list[dict[str, Any]]:
        try:
            files = sorted(self.dir.glob("*.json"))
        except OSError:
            return []
        return [job for job in (self.load(f.stem) for f in files) if job]

    def retire_corrupt(self, job_id: str) -> None:
        """After its failure was reported: stop listing the corrupt job, keep a tombstone so it never runs."""
        try:
            os.replace(self.path(job_id, "json"), self.path(job_id, "corrupt"))
        except OSError:
            pass

    def running(self) -> list[dict[str, Any]]:
        return [j for j in self.all() if j.get("state") == "running"]

    def reportable(self) -> list[dict[str, Any]]:
        """The hello ``jobs`` list: running jobs, jobs finished in the last day, and corrupt ones
        (reported as done, so the server asks again and gets the failure instead of a rerun)."""
        out = []
        cutoff = self.now() - REPORT_DONE_FOR_SEC
        for job in self.all():
            state = job.get("state")
            if state == "running" or state == "corrupt" or (state == "done" and job.get("finishedAt", 0) >= cutoff):
                when = float(job.get("finishedAt") or job.get("startedAt") or 0) if state != "corrupt" else self.now()
                out.append((state == "running", when, {"jobId": job["jobId"], "state": "running" if state == "running" else "done",
                                                        "lastSeq": int(job.get("lastSeq", 0))}))
        # Running first, then newest first; never more than the server accepts.
        out.sort(key=lambda item: (item[0], item[1]), reverse=True)
        return [item[2] for item in out[:MAX_REPORTED_JOBS]]

    def prune(self) -> None:
        """Delete finished jobs (state, log, exit code) older than 30 days."""
        cutoff = self.now() - KEEP_FOR_SEC
        for job in self.all():
            if job.get("state") == "done" and job.get("finishedAt", 0) < cutoff:
                for ext in ("json", "log", "exit"):
                    try:
                        self.path(job["jobId"], ext).unlink()
                    except OSError:
                        pass
        try:
            tombstones = list(self.dir.glob("*.corrupt"))
        except OSError:
            tombstones = []
        for f in tombstones:
            try:
                if f.stat().st_mtime < cutoff:
                    f.unlink()
            except OSError:
                pass


class SystemdExecutor:
    """Starts argv in a transient user unit. The command prefixes are injectable for tests."""

    def __init__(self, paths: HostPaths, env: dict[str, str], systemd_run: Sequence[str] = ("systemd-run",),
                 systemctl: Sequence[str] = ("systemctl",), python: Optional[str] = None,
                 pythonpath: Optional[str] = None) -> None:
        self.paths = paths
        self.env = env
        self.systemd_run = list(systemd_run)
        self.systemctl = list(systemctl)
        self.python = python or str(paths.stable_python if paths.stable_python.exists() else sys.executable)
        self.pythonpath = pythonpath or str(Path(__file__).resolve().parent.parent)

    def _run(self, argv: list[str], timeout: float = 30) -> "subprocess.CompletedProcess[str]":
        try:
            return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, env=self.env, check=False)
        except (OSError, subprocess.SubprocessError) as exc:
            return subprocess.CompletedProcess(argv, 127, "", str(exc))

    def module_argv(self, module: str, spec_path: Path) -> list[str]:
        """argv of a job that runs one of the daemon's own modules (same python, same package)."""
        return [self.python, "-m", module, str(spec_path)]

    def start(self, unit: str, argv: Sequence[str], log_path: Path, exit_path: Path, keep_pythonpath: bool = False) -> None:
        # The job's own process gets PYTHONPATH only when it is one of our modules: the installer
        # and systemctl never see the bundle on their path.
        wrap = [str(exit_path)] + (["--pythonpath", self.pythonpath] if keep_pythonpath else [])
        cmd = [*self.systemd_run, "--user", "--unit", unit, "--collect", "--quiet",
               f"--property=StandardOutput=append:{log_path}", f"--property=StandardError=append:{log_path}",
               f"--working-directory={self.paths.home}", "--setenv=HOSTD_PROGRESS=1",
               f"--setenv=PYTHONPATH={self.pythonpath}", f"--setenv=PATH={self.env.get('PATH', '/usr/bin:/bin')}",
               "--", self.python, "-m", "emperor_hostd.jobwrap", *wrap, "--", *argv]
        proc = self._run(cmd)
        if proc.returncode != 0:
            raise RunnerError((proc.stderr or proc.stdout or f"systemd-run exited {proc.returncode}").strip()[:300])

    def is_active(self, unit: str) -> bool:
        proc = self._run([*self.systemctl, "--user", "is-active", unit], timeout=15)
        return (proc.stdout or "").strip() in ("active", "activating", "deactivating", "reloading")

    def stop(self, unit: str) -> None:
        self._run([*self.systemctl, "--user", "stop", unit], timeout=60)


class JobRunner:
    """Starts jobs, follows their logs and turns their end into a result frame."""

    def __init__(self, store: JobStore, executor: SystemdExecutor, redactor: Redactor,
                 now: Callable[[], float] = time.time) -> None:
        self.store = store
        self.executor = executor
        self.redactor = redactor
        self.now = now
        self._inactive_polls: dict[str, int] = {}

    def active(self) -> Optional[dict[str, Any]]:
        running = self.store.running()
        return running[0] if running else None

    def start(self, job_id: str, plan: Plan, deadline_sec: int) -> dict[str, Any]:
        """Persist the job first (so a crash right after still knows it), then start its unit.

        A module job gets its arguments in ``<jobId>.spec`` (0600; it may hold a token): the module
        deletes it as soon as it read it, and it is deleted here when the job ends or cannot start."""
        job = {"jobId": job_id, "command": plan.command, "args": {k: v for k, v in plan.args.items() if "token" not in k.lower()},
               "summary": plan.summary, "units": list(plan.units), "unit": unit_name(job_id), "state": "running",
               "startedAt": self.now(), "deadlineSec": int(deadline_sec), "lastSeq": 0, "logOffset": 0, "recent": []}
        if plan.token_sha256:
            job["tokenSha256"] = plan.token_sha256
        if plan.exit_reasons:
            job["exitReasons"] = {str(code): reason for code, reason in plan.exit_reasons}
        self.store.save(job)
        log_path = self.store.path(job_id, "log")
        fd = os.open(str(log_path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        os.close(fd)
        argv = list(plan.argv or [])
        try:
            if plan.module:
                spec_path = self.store.path(job_id, "spec")
                _write_private(spec_path, json.dumps({**(plan.secret_spec or {}), "jobId": job_id}, sort_keys=True))
                argv = self.executor.module_argv(plan.module, spec_path)
            self.executor.start(job["unit"], argv, log_path, self.store.path(job_id, "exit"), keep_pythonpath=bool(plan.module))
        except (RunnerError, OSError) as exc:
            self.finish(job, ok=False, exit_code=None, error_code="start_failed", summary=f"could not start: {exc}")
        return job

    def _drop_spec(self, job_id: str) -> None:
        try:
            self.store.path(job_id, "spec").unlink()
        except OSError:
            pass

    def finish_inline(self, job_id: str, plan: Plan, ok: bool = True) -> dict[str, Any]:
        """A command answered in-process (refresh_inventory): stored done right away."""
        job = {"jobId": job_id, "command": plan.command, "args": plan.args, "summary": plan.summary, "unit": None,
               "state": "running", "startedAt": self.now(), "deadlineSec": 60, "lastSeq": 0, "logOffset": 0, "recent": []}
        self.finish(job, ok=ok, exit_code=0 if ok else None, error_code=None, summary=plan.summary)
        return job

    def finish(self, job: dict[str, Any], ok: bool, exit_code: Optional[int], error_code: Optional[str], summary: str) -> dict[str, Any]:
        job["state"] = "done"
        job["finishedAt"] = self.now()
        job["result"] = {"ok": ok, "exitCode": exit_code, "errorCode": error_code, "summary": self.redactor.text(summary)[:500],
                         "logTail": self.redactor.text(clip_tail(self._tail_text(job["jobId"]))), "units": job.get("units") or []}
        if ok and job.get("tokenSha256"):
            job["result"]["tokenSha256"] = job["tokenSha256"]
        self.store.save(job)
        # A spec the job never read (it crashed or never started) must not outlive it.
        self._drop_spec(job["jobId"])
        self._inactive_polls.pop(job["jobId"], None)
        return job

    def result_frame(self, job: dict[str, Any]) -> dict[str, Any]:
        if job.get("state") == "corrupt":
            return result(job["jobId"], False, None, "the host's record of this job is unreadable; it was not run again",
                          "", "corrupt_state")
        r = job.get("result") or {}
        return result(job["jobId"], bool(r.get("ok")), r.get("exitCode"), str(r.get("summary") or ""), str(r.get("logTail") or ""),
                      r.get("errorCode"), r.get("units") or None, r.get("tokenSha256"))

    def _tail_text(self, job_id: str, limit: int = TAIL_BYTES) -> str:
        """The end of a job log only (logs can be large)."""
        path = self.store.path(job_id, "log")
        try:
            with path.open("rb") as fh:
                fh.seek(0, os.SEEK_END)
                size = fh.tell()
                fh.seek(max(0, size - limit))
                return fh.read().decode("utf-8", "replace")
        except OSError:
            return ""

    def _line_frame(self, job_id: str, seq: int, line: str) -> dict[str, Any]:
        text = self.redactor.text(line.rstrip("\r"))[:LINE_MAX]
        step = text[4:].strip() if text.startswith("==> ") else None
        return progress(job_id, seq, text, step)

    def read_new_lines(self, job: dict[str, Any], max_frames: int = MAX_FRAMES_PER_POLL) -> tuple[list[dict[str, Any]], int, int]:
        """(frames for up to ``max_frames`` complete lines since the committed position, new offset, new seq).
        Nothing is saved."""
        path = self.store.path(job["jobId"], "log")
        offset = int(job.get("logOffset", 0))
        seq = int(job.get("lastSeq", 0))
        try:
            with path.open("rb") as fh:
                fh.seek(offset)
                chunk = fh.read(READ_CHUNK)
        except OSError:
            return [], offset, seq
        end = chunk.rfind(b"\n")
        if end < 0:
            return [], offset, seq
        frames = []
        consumed = 0
        for raw in chunk[: end + 1].split(b"\n")[:-1]:
            if len(frames) >= max_frames:
                break
            seq += 1
            consumed += len(raw) + 1
            if seq <= MAX_PROGRESS_LINES:
                frames.append(self._line_frame(job["jobId"], seq, raw.decode("utf-8", "replace")))
        return frames, offset + consumed, seq

    def commit(self, job: dict[str, Any], offset: int, seq: int, sent: list[dict[str, Any]]) -> None:
        """The frames up to (offset, seq) were handed to the socket: remember the position and the last lines."""
        current = self.store.load(job["jobId"]) or job
        if current.get("state") != "running":
            return
        current["logOffset"] = offset
        current["lastSeq"] = seq
        current["recent"] = (list(current.get("recent") or []) + [{"seq": f["seq"], "line": f.get("line", ""), "step": f.get("step")} for f in sent])[-RESEND_LINES:]
        self.store.save(current)
        job.update(current)

    def recent_lines(self, job: dict[str, Any]) -> list[dict[str, Any]]:
        """The last progress frames sent for a running job (resent after a reconnect)."""
        out = []
        for item in job.get("recent") or []:
            frame = progress(job["jobId"], int(item["seq"]), str(item.get("line") or ""), item.get("step"))
            out.append(frame)
        return out

    def _restarted_anyway(self, job: dict[str, Any]) -> bool:
        return job.get("command") == "restart_agent" and RESTARTED_STEP in self._tail_text(job["jobId"])

    def poll(self, job: dict[str, Any]) -> tuple[list[dict[str, Any]], Optional[dict[str, Any]], int, int]:
        """(progress frames, result frame when the job ended, offset, seq). Commit after sending the frames."""
        frames, offset, seq = self.read_new_lines(job)
        exit_path = self.store.path(job["jobId"], "exit")
        label = job.get("summary") or job["command"]
        if exit_path.exists():
            # The process ended: everything it wrote is in the log now.
            probe = {**job, "logOffset": offset, "lastSeq": seq}
            more, offset, seq = self.read_new_lines(probe, MAX_FRAMES_PER_POLL - len(frames))
            frames += more
            # Lines beyond this poll's cap are not sent as progress; the result's log tail has them.
            try:
                code = int(exit_path.read_text(encoding="utf-8").strip() or "1")
            except (OSError, ValueError):
                code = 1
            job.update({"logOffset": offset, "lastSeq": seq})
            if code == 0:
                done = self.finish(job, ok=True, exit_code=0, error_code=None, summary=f"{label}: done")
            elif self._restarted_anyway(job):
                done = self.finish(job, ok=True, exit_code=code, error_code=None,
                                   summary=f"{label}: restarted, but the gateway was not ready in time (exit {code}); check emperor-hermes status")
            else:
                reason = (job.get("exitReasons") or {}).get(str(code))
                done = self.finish(job, ok=False, exit_code=code, error_code=f"exit_{code}",
                                   summary=f"{label}: failed: {reason} (exit {code})" if reason else f"{label}: failed (exit {code})")
            return frames, self.result_frame(done), offset, seq
        if self.now() > float(job.get("startedAt", 0)) + int(job.get("deadlineSec", 300)) + DEADLINE_GRACE_SEC:
            if job.get("unit"):
                self.executor.stop(job["unit"])
            job.update({"logOffset": offset, "lastSeq": seq})
            done = self.finish(job, ok=False, exit_code=None, error_code="timeout", summary=f"{label}: timed out")
            return frames, self.result_frame(done), offset, seq
        if job.get("unit") and not self.executor.is_active(job["unit"]):
            misses = self._inactive_polls.get(job["jobId"], 0) + 1
            self._inactive_polls[job["jobId"]] = misses
            if misses >= LOST_AFTER_POLLS and not exit_path.exists():
                job.update({"logOffset": offset, "lastSeq": seq})
                done = self.finish(job, ok=False, exit_code=None, error_code="lost", summary=f"{label}: the job ended without an exit code")
                return frames, self.result_frame(done), offset, seq
        else:
            self._inactive_polls.pop(job["jobId"], None)
        return frames, None, offset, seq
