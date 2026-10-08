#!/usr/bin/env python3
"""
Hermes worker pairing: poll the Emperor Claw app until an agent is assigned,
then print `export` lines the entrypoint `eval`s to continue the normal flow.

Used on hosts without a Docker socket (Render). Authentication is the shared
EMPEROR_WORKER_PAIRING_SECRET; the worker id and the delivered config are
persisted on the disk so a restart re-uses them without re-pairing. The
agent-bound token is minted by the app and delivered exactly once; on restart
the app re-delivers the assignment without the token and this script re-uses
the persisted value.
"""
from __future__ import annotations

import json
import os
import shlex
import socket
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Dict

API_URL = os.environ.get("EMPEROR_CLAW_API_URL", "").strip()
PAIRING_SECRET = os.environ.get("EMPEROR_WORKER_PAIRING_SECRET", "").strip()
STATE_PATH = Path(os.environ.get("EMPEROR_CLAW_HERMES_STATE_PATH", str(Path.home() / ".hermes" / "emperor-bridge-state.json")))
PAIRING_STATE_PATH = Path(os.environ.get("EMPEROR_CLAW_PAIRING_STATE_PATH", str(STATE_PATH.parent / "emperor-pairing.json")))
POLL_SECONDS = float(os.environ.get("EMPEROR_CLAW_PAIRING_POLL_SECONDS", "5"))

# Mirror hermes-provisioning.ts PROVIDER_ENV_VAR: which env var Hermes reads the
# LLM key from for each provider.
PROVIDER_ENV_VAR = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "google": "GOOGLE_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "grok": "GROK_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
}


def normalize_api_url(url: str) -> str:
    """EMPEROR_CLAW_API_URL may be a bare host:port — prefix http:// when needed."""
    url = (url or "").strip().rstrip("/")
    if not url:
        raise RuntimeError("EMPEROR_CLAW_API_URL is required")
    if "://" not in url:
        url = "http://" + url
    return url


def load_state() -> Dict[str, Any]:
    if PAIRING_STATE_PATH.exists():
        try:
            state = json.loads(PAIRING_STATE_PATH.read_text(encoding="utf-8"))
            if isinstance(state, dict):
                return state
        except (ValueError, OSError):
            pass
    return {}


def save_state(state: Dict[str, Any]) -> None:
    PAIRING_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = PAIRING_STATE_PATH.with_name(PAIRING_STATE_PATH.name + ".tmp")
    tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
    os.replace(tmp, PAIRING_STATE_PATH)


def stable_worker_id(state: Dict[str, Any]) -> str:
    worker_id = str(state.get("workerId") or "").strip()
    if not worker_id:
        worker_id = f"hermes-worker-{socket.gethostname()}-{uuid.uuid4().hex[:12]}"
        state["workerId"] = worker_id
        save_state(state)
    return worker_id


def pair_request(url: str, secret: str, worker_id: str, agent_id: str | None) -> Dict[str, Any]:
    body: Dict[str, Any] = {"workerId": worker_id}
    if agent_id:
        body["agentId"] = agent_id
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url + "/api/runtime/pair",
        data=data,
        method="POST",
        headers={
            "X-Worker-Pairing-Secret": secret,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        payload = json.loads(res.read().decode("utf-8"))
    return payload if isinstance(payload, dict) else {}


def export_lines(delivery: Dict[str, Any], url: str) -> str:
    """Shell-safe `export KEY=value` lines for the delivered assignment."""
    lines: list[str] = []

    def export(key: str, value: str) -> None:
        lines.append(f"export {key}={shlex.quote(value)}")

    # Re-export the normalized API URL so the bridge never sees a bare host:port.
    export("EMPEROR_CLAW_API_URL", url)
    export("EMPEROR_CLAW_API_TOKEN", str(delivery.get("apiToken") or ""))
    export("EMPEROR_CLAW_AGENT_NAME", str(delivery.get("agentName") or ""))
    export("EMPEROR_CLAW_AGENT_ID", str(delivery.get("agentId") or ""))
    export("EMPEROR_CLAW_AGENT_ROLE", str(delivery.get("agentRole") or "operator"))
    export("EMPEROR_CLAW_RUNTIME_ID", str(delivery.get("runtimeId") or f"hermes-paired-{delivery.get('agentId', '')}"))
    provider = str(delivery.get("llmProvider") or "")
    model = str(delivery.get("llmModel") or "")
    if provider:
        export("EMPEROR_CLAW_LLM_PROVIDER", provider)
    if model:
        export("EMPEROR_CLAW_LLM_MODEL", model)
    key = delivery.get("llmApiKey")
    if key and provider:
        env_var = PROVIDER_ENV_VAR.get(provider.lower())
        if env_var:
            export(env_var, str(key))
    return "\n".join(lines)


def persist_delivery(state: Dict[str, Any], delivery: Dict[str, Any]) -> None:
    state["agentId"] = delivery.get("agentId")
    state["agentName"] = delivery.get("agentName")
    state["agentRole"] = delivery.get("agentRole", "operator")
    state["llmProvider"] = delivery.get("llmProvider") or ""
    state["llmModel"] = delivery.get("llmModel") or ""
    if delivery.get("apiToken"):
        state["apiToken"] = delivery["apiToken"]
    if delivery.get("llmApiKey"):
        state["llmApiKey"] = delivery["llmApiKey"]
    save_state(state)


def merged_delivery(state: Dict[str, Any], delivery: Dict[str, Any]) -> Dict[str, Any]:
    """Re-delivery on restart: the app hands back the assignment without the
    token, so fill the persisted secrets back in before exporting."""
    if delivery.get("apiToken"):
        return delivery
    merged = dict(delivery)
    merged["apiToken"] = str(state.get("apiToken") or "")
    merged["llmApiKey"] = state.get("llmApiKey") or ""
    merged["llmProvider"] = merged.get("llmProvider") or state.get("llmProvider") or ""
    merged["llmModel"] = merged.get("llmModel") or state.get("llmModel") or ""
    return merged


def run() -> int:
    url = normalize_api_url(API_URL)
    if not PAIRING_SECRET:
        raise RuntimeError("EMPEROR_WORKER_PAIRING_SECRET is required")
    state = load_state()
    worker_id = stable_worker_id(state)

    while True:
        agent_id = str(state.get("agentId") or "") or None
        try:
            delivery = pair_request(url, PAIRING_SECRET, worker_id, agent_id)
        except urllib.error.HTTPError as exc:
            if exc.code == 401:
                print("[pairing] unauthorized (secret mismatch) — retrying", flush=True)
            elif exc.code == 429:
                print("[pairing] rate limited — retrying", flush=True)
            else:
                print(f"[pairing] pairing endpoint returned {exc.code} — retrying", flush=True)
            time.sleep(POLL_SECONDS)
            continue
        except Exception as exc:
            print(f"[pairing] pairing request failed: {exc} — retrying", flush=True)
            time.sleep(POLL_SECONDS)
            continue

        if not delivery.get("assigned"):
            time.sleep(POLL_SECONDS)
            continue

        final = merged_delivery(state, delivery)
        if final.get("apiToken"):
            # First delivery (or a rotation): persist and continue with the new token.
            persist_delivery(state, final)
        print(export_lines(final, url), flush=True)
        return 0


if __name__ == "__main__":
    raise SystemExit(run())
