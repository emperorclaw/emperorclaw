"""Runs one job's argv inside its transient unit and records the exit code.

``python -m emperor_hostd.jobwrap <exit_file> [--pythonpath DIR] -- argv...`` (started by
``systemd-run --user``). The unit is ``--collect``ed when it ends, so systemd forgets its exit
status; this file is how the daemon learns it, even when the daemon itself restarted while the job
ran. No shell is involved: argv is executed as a list, with a clean environment. ``--pythonpath``
is given only to jobs that run one of the daemon's own modules (emperor_hostd.provision).
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

KEEP_ENV = ("PATH", "HOME", "LANG", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "USER", "LOGNAME", "HOSTD_PROGRESS")


def write_exit(path: Path, code: int) -> None:
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(f"{code}\n")
    os.replace(tmp, path)


def main(argv: list[str]) -> int:
    pythonpath = None
    if len(argv) >= 3 and argv[1] == "--pythonpath":
        pythonpath = argv[2]
        argv = [argv[0], *argv[3:]]
    if len(argv) < 3 or argv[1] != "--":
        print("usage: python -m emperor_hostd.jobwrap <exit_file> [--pythonpath DIR] -- argv...", file=sys.stderr)
        return 64
    exit_file = Path(argv[0])
    command = argv[2:]
    env = {k: os.environ[k] for k in KEEP_ENV if k in os.environ}
    env.setdefault("HOSTD_PROGRESS", "1")
    if pythonpath:
        env["PYTHONPATH"] = pythonpath
        env["PYTHONUNBUFFERED"] = "1"  # progress lines reach the log as they happen
    try:
        code = subprocess.call(command, env=env, stdin=subprocess.DEVNULL)
    except OSError as exc:
        print(f"emperor-hostd: cannot run {command[0]}: {exc}", flush=True)
        code = 127
    write_exit(exit_file, code)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
