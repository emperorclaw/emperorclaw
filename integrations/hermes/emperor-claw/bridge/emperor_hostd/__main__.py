"""``python -m emperor_hostd <command>``.

  run          the daemon (systemd: emperor-hermes-hostd.service)
  inventory    print what the daemon would report (redacted), then exit
  version      print the daemon version

Exit 78 (EX_CONFIG) when hostd.env is missing/invalid or the host was revoked: the unit has
RestartPreventExitStatus=78, so systemd does not restart it in a loop.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import signal
import sys
import time

from .config import HostdConfigError, HostPaths, file_mode_too_open, load_hostd_config
from .protocol import EXIT_CONFIG, Redactor
from .version import HOSTD_VERSION

log = logging.getLogger("emperor_hostd")


class _UtcFormatter(logging.Formatter):
    converter = time.gmtime

    def formatTime(self, record: logging.LogRecord, datefmt: str | None = None) -> str:  # noqa: N802
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)) + f".{int(record.msecs):03d}Z"


def setup_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_UtcFormatter("[%(asctime)s] [emperor-hostd] %(levelname)s %(message)s"))
    root = logging.getLogger("emperor_hostd")
    root.handlers[:] = [handler]
    root.setLevel(getattr(logging, level.upper(), logging.INFO))
    root.propagate = False


def _context(paths: HostPaths):
    from .connection import DaemonContext
    from .inventory import clean_env
    from .runner import JobRunner, JobStore, SystemdExecutor
    config = load_hostd_config(paths.hostd_env)
    redactor = Redactor([config.host_token])
    runner = JobRunner(JobStore(paths.jobs_dir), SystemdExecutor(paths, clean_env(paths)), redactor)
    return DaemonContext(paths=paths, config=config, runner=runner, redactor=redactor)


def cmd_run() -> int:
    from .connection import run_daemon
    paths = HostPaths.from_env()
    try:
        ctx = _context(paths)
    except HostdConfigError as exc:
        log.error("%s", exc)
        return EXIT_CONFIG
    if file_mode_too_open(paths.hostd_env):
        log.warning("%s is readable by other users; run: chmod 600 %s", paths.hostd_env, paths.hostd_env)
    log.info("emperor-hostd %s for %s (host %s)", HOSTD_VERSION, ctx.config.origin, ctx.config.host_id)

    async def main() -> int:
        loop = asyncio.get_running_loop()
        task = asyncio.current_task()
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, task.cancel)  # type: ignore[union-attr]
            except (NotImplementedError, RuntimeError):
                pass
        try:
            return await run_daemon(ctx)
        except asyncio.CancelledError:
            log.info("stopping")
            return 0

    return asyncio.run(main())


def cmd_inventory() -> int:
    paths = HostPaths.from_env()
    try:
        ctx = _context(paths)
    except HostdConfigError as exc:
        print(f"config: {exc}", file=sys.stderr)
        return EXIT_CONFIG
    from .protocol import encode
    print(json.dumps(json.loads(encode(ctx.inventory(), ctx.redactor)), indent=2))
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="python -m emperor_hostd", description="Emperor Claw runtime host daemon")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("run")
    sub.add_parser("inventory")
    sub.add_parser("version")
    args = parser.parse_args(argv)
    setup_logging()
    if args.command == "version":
        print(f"emperor-hostd {HOSTD_VERSION}")
        return 0
    if args.command == "inventory":
        return cmd_inventory()
    if args.command in (None, "run"):
        return cmd_run()
    parser.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
