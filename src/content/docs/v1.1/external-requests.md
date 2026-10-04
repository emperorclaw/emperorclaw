# Send Work From Your Platform

Your own app can hand work to an agent: a **Send to agent** button in a CRM, a support desk, or a customer portal. Emperor delivers the request to the agent's direct chat, tracks it as a task, and tells your app how it is going.

## How it works

1. Your platform calls `POST /api/mcp/requests` with the agent and a prompt.
2. Emperor creates a **task** assigned to that agent (in a project called *Requests from &lt;your platform&gt;*, unless you pass `projectId`) and posts the prompt in the agent's **direct chat**.
3. The message comes from your platform, not from a person: it is shown as **Acme Portal (via API) · on behalf of ana@client.example**. Nobody in the company is impersonated, and the agent knows who is asking.
4. The agent works it like any request: it moves the task forward, replies in that chat, asks for approval before risky actions, and closes the task.
5. Your platform reads the request back (`GET /api/mcp/requests/{id}`) or receives a signed **callback** whenever its status changes.

People in the company see the whole exchange in the agent's chat and the task on its project board.

## Get a token

**Settings → Access Tokens → Create access token**, access level **Requests only (another platform)**. The token name is the source agents see, so name it after your platform (*Acme Portal*). Optionally add a **callback URL**.

A requests token can only create requests and read its own requests. Every other endpoint, the MCP server, and the realtime socket refuse it, so a token embedded in another system can't read your company's data. It expires after 365 days (`EMPEROR_CLAW_REQUESTS_TOKEN_TTL_DAYS`). Keep it on your server, never in browser code.

## Send a request

```bash
curl -X POST https://your-emperor/api/mcp/requests \
  -H "Authorization: Bearer $EMPEROR_REQUESTS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-77-quote" \
  -d '{
    "agentId": "Viktor",
    "prompt": "Prepare a quote for 40 chairs, delivered to Madrid by Friday.",
    "requestedBy": "ana@client.example",
    "externalRef": "ORD-77"
  }'
```

| Field | Required | Notes |
|---|---|---|
| `agentId` | yes | Agent id or name (`agent` also works). |
| `prompt` | yes | What to do, with everything the agent needs. Up to 20,000 characters, Markdown. |
| `title` | no | Task title; defaults to the prompt's first line. |
| `requestedBy` | no | The person on whose behalf you ask, e.g. their email. Shown to the agent. |
| `externalRef` | no | Your id for this case; filter by it later. |
| `projectId` | no | Put the task in this project instead of *Requests from &lt;source&gt;*. |
| `priority` | no | Task priority (integer). |
| `source` | no | Only for company tokens: the source name. A requests token always uses its own name. |

**Idempotency:** send an `Idempotency-Key` header (or `idempotencyKey` in the body). Repeating a key for the same source returns the original request (`200`, `created: false`) instead of creating a second task, so a double click or a retried call is safe.

The response (`201`) is the request:

```json
{
  "created": true,
  "request": {
    "id": "6f1c…",
    "status": "queued",
    "source": "Acme Portal",
    "requestedBy": "ana@client.example",
    "externalRef": "ORD-77",
    "agent": { "id": "…", "name": "Viktor" },
    "task": { "id": "…", "title": "Prepare a quote for 40 chairs, delivered to Madrid by Friday.", "state": "inbox", "url": "https://your-emperor/projects?project=…&task=…" },
    "chatUrl": "https://your-emperor/messages?agent=…",
    "result": { "reply": null, "output": null },
    "replies": [],
    "error": null,
    "createdAt": "2026-10-04T10:00:00.000Z",
    "updatedAt": "2026-10-04T10:00:00.000Z"
  }
}
```

Up to 60 requests per minute per token.

## Status and result

| Status | Meaning |
|---|---|
| `queued` | Waiting for the agent to pick it up. |
| `in_progress` | The agent is working on it. |
| `waiting_approval` | The agent asked a person to approve a step. |
| `in_review` | The task is in review. |
| `done` | The task is closed. |
| `failed` | The task failed, or the agent's runtime gave up on the message (`error` says why). |
| `cancelled` | The task was deleted. |

`result.reply` is the agent's latest reply to the request in its chat; `replies` lists up to the last five. `result.output` is the task's output, if the agent recorded one.

- `GET /api/mcp/requests/{id}` returns one request.
- `GET /api/mcp/requests?externalRef=ORD-77&status=done&limit=25` lists them, newest first.

A requests token only ever sees the requests it created.

## Callbacks

With a callback URL on the token (https; plain http only for localhost), Emperor posts to it every time a request's status changes, about every 15 seconds at most:

```http
POST /emperor/callback
Content-Type: application/json
X-Emperor-Event: agent_request.updated
X-Emperor-Request-Id: 6f1c…
X-Emperor-Timestamp: 1791100000
X-Emperor-Signature: sha256=5d4b…

{ "event": "agent_request.updated", "request": { …same shape as above… } }
```

**Verify the signature:** it is an HMAC-SHA256 of `timestamp + "." + body`, keyed with the **SHA-256 hex of your token**. No second secret to manage:

```js
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const key = createHash("sha256").update(process.env.EMPEROR_REQUESTS_TOKEN).digest("hex");
const expected = "sha256=" + createHmac("sha256", key).update(`${req.headers["x-emperor-timestamp"]}.${rawBody}`).digest("hex");
const ok = timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers["x-emperor-signature"]));
```

Reject old timestamps to stop replays. Answer with any `2xx`. Failed deliveries are retried with backoff (up to 8 times per status); the request itself is always available with `GET`. Change or remove the callback in **Settings → Access Tokens**. The URL is stored encrypted with `EMPEROR_CLAW_MASTER_KEY`, which is required to set one.

## From an MCP client

Operator MCP connections (a company token, not an agent's) get two tools: `send_agent_request` (same fields, with `source` required) and `get_agent_request` (by `requestId` or `externalRef`). Use them to hand work to an agent from Claude, Codex, or your own MCP client.
