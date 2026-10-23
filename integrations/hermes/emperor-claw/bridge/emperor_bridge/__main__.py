"""``python -m emperor_bridge <command>``.

  run [--profiles a,b]     the bridge (HERMES_PROFILE when --profiles is absent)
  healthcheck              exit 0 when the gateway is ready and the bridge's health.json is fresh
  doctor [--profiles a,b]  print the resolved configuration, interpreter, gateway and health
  outbox [--profile p]     list parked replies
  redeliver <messageId> [--profile p]
                           POST a parked or given-up reply again (same idempotency key)
  version                  print the bridge version
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from typing import Optional


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m emperor_bridge", description="Emperor Claw bridge for Hermes")
    sub = parser.add_subparsers(dest="command")
    run = sub.add_parser("run", help="run the bridge")
    run.add_argument("--profiles", help="comma-separated profiles (shared mode hosts several)")
    sub.add_parser("healthcheck", help="container/operator health probe")
    doctor = sub.add_parser("doctor", help="print resolved configuration and checks")
    doctor.add_argument("--profiles")
    outbox = sub.add_parser("outbox", help="list parked replies")
    outbox.add_argument("--profile")
    redeliver = sub.add_parser("redeliver", help="deliver a parked reply again")
    redeliver.add_argument("message_id")
    redeliver.add_argument("--profile")
    sub.add_parser("version")
    return parser


def _agent(profile: Optional[str]):
    from .config import AgentConfig, HostConfig
    host = HostConfig.from_env(profiles=profile)
    return AgentConfig.from_profile(host.profiles[0], host)


def cmd_doctor(profiles: Optional[str]) -> int:
    from .config import AgentConfig, ConfigError, HostConfig
    from .health import health_path, read_health
    from .supervisor import identify_sync
    from .version import BRIDGE_VERSION
    try:
        host = HostConfig.from_env(profiles=profiles)
    except ConfigError as exc:
        print(f"config: {exc}")
        return 2
    print(f"bridge {BRIDGE_VERSION} python {sys.version.split()[0]} topology={host.topology.value}")
    print(f"HERMES_PYTHON={host.hermes_python} HERMES_CHECKOUT={host.hermes_checkout}")
    bad = 0
    for profile in host.profiles:
        try:
            cfg = AgentConfig.from_profile(profile, host)
        except ConfigError as exc:
            print(f"[{profile}] config: {exc}")
            bad += 1
            continue
        print(f"[{profile}] home={cfg.profile_home} agentId={cfg.agent_id or '<resolve by name>'} api={cfg.api_url} "
              f"toolsets={','.join(cfg.toolsets)} parallel={cfg.max_parallel_turns}")
        try:
            result = (identify_sync(cfg.target.control_home) or {}).get("result") or {}
            print(f"[{profile}] gateway state={result.get('state')} version={result.get('code_version')}")
        except (OSError, ValueError) as exc:
            print(f"[{profile}] gateway unreachable: {exc}")
            bad += 1
        health = read_health(health_path(cfg.profile_home))
        print(f"[{profile}] health: {json.dumps(health) if health else 'none yet'}")
    return 1 if bad else 0


def cmd_outbox(profile: Optional[str]) -> int:
    from .outbox import Outbox
    cfg = _agent(profile)
    box = Outbox(cfg.outbox_dir)
    files = box.files()
    print(f"outbox {box.dir} ({len(files)} entries)" if files else f"outbox empty: {box.dir}")
    for path in files:
        entry = box.load(path) or {}
        state = "failed" if path.suffix == ".failed" else "queued"
        print(f"  {entry.get('message_id')} state={state} attempts={entry.get('attempts', 0)} "
              f"age={int(time.time() - float(entry.get('created_at') or time.time()))}s "
              f"{len(str((entry.get('body') or {}).get('text') or ''))} chars")
        if entry.get("last_error"):
            print(f"    last_error: {entry['last_error']}")
    return 0


def cmd_redeliver(message_id: str, profile: Optional[str]) -> int:
    from .emperor_api import EmperorClient
    from .outbox import Outbox
    cfg = _agent(profile)
    box = Outbox(cfg.outbox_dir)
    path = box.find(message_id)
    if path is None:
        print(f"no outbox entry for {message_id} in {box.dir}")
        return 2
    entry = box.requeue(path)
    client = EmperorClient(cfg.api_url, cfg.api_token, agent_id=cfg.agent_id)

    async def send(body, key):
        return await client.send_message(body, idempotency_key=key)

    async def delivered(_entry, _reply_id):
        return None

    try:
        reply_id = asyncio.run(box.deliver(entry, send, delivered, attempts=3))
    except Exception as exc:
        print(f"FAILED: {exc}")
        return 1
    print(f"DELIVERED as {reply_id or '<deduplicated by the server>'} (the run ledger is finished by the bridge only)")
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    args = _parser().parse_args(argv)
    command = args.command or "run"
    if command == "run":
        from .main import run
        return run(getattr(args, "profiles", None))
    if command == "healthcheck":
        from .health import main as health_main
        return health_main()
    if command == "doctor":
        return cmd_doctor(args.profiles)
    if command == "outbox":
        return cmd_outbox(args.profile)
    if command == "redeliver":
        return cmd_redeliver(args.message_id, args.profile)
    from .version import BRIDGE_VERSION
    print(BRIDGE_VERSION)
    return 0


if __name__ == "__main__":
    sys.exit(main())
