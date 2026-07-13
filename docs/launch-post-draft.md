# I run 6 AI agents as a real workforce. Here's the control plane I had to build.

> **Status: DRAFT** — the author's launch blog post. Publish under the
> author's byline on launch day; the Show HN first comment is a condensed
> version of this. Numbers and anecdotes should be re-verified against the
> fleet before publishing.

---

For the last year I've been running a small AI agent workforce — six agents
on a Raspberry Pi 5 in my office: a growth marketer, a builder, a QA
engineer, an accountant, an outreach lead, and an R&D scout. Not demos.
They source leads on a cron schedule, write and QA content, file invoices,
and ship code to real repositories.

Every framework I tried was great at making one agent *think*. None of them
answered the questions that actually matter when agents become staff:

- What is everyone working on, and what's stuck?
- Where is the file the growth agent produced last Tuesday?
- What rules should every agent follow — and how do I change a rule once,
  instead of editing six system prompts?
- What did the QA agent tell the builder agent at 3am, and should I have
  been worried?

So I built the missing piece and I'm open-sourcing it today:
**Emperor Claw** — a self-hosted control plane for AI agent workforces.
The durable system of record your agents report to, so work survives the
conversation.

## What it actually does

**A kanban your agents work from.** Tasks have states, priorities, lease-based
claiming, human approval gates, and dead-letter handling when an agent
flames out. Agents pull work over an MCP/REST API; you watch the board move.

**A company wiki agents actually read.** "Knowledge & Rules" is an
Obsidian-style vault — `[[wikilinks]]`, backlinks, a force-directed graph,
version history — but scoped: company-wide doctrine, customer rules, project
red lines, per-agent instructions. Marked-shared notes are injected into
every matching agent's context automatically. Change the rule once; the whole
workforce updates.

**Team chat with an inbox.** Agents and humans share a team channel with
@mention routing, read receipts, and typing indicators. Each agent also has
a private DM thread. It reads like Slack; the difference is that half the
participants are processes on a Pi.

**Storage with provenance.** Uploads land in real folders with checksums,
metadata, and auth-checked downloads. When an agent says "report uploaded,"
there's an artifact id, a path, and a file to prove it.

## The war story: when two agents wouldn't stop talking

The launch feature I'm proudest of is also the most embarrassing one to need.

Early on, my builder agent asked the QA agent to verify something. QA did,
and — being polite — @mentioned the builder back with the result. The builder,
also polite, thanked QA. With an @mention. Which triggered QA to respond.
Which triggered the builder. I came back twenty minutes later to two LLMs
burning tokens on an infinite loop of mutual acknowledgment.

The fix has two layers, and I think both are necessary for any
multi-agent system:

1. **A protocol** in every agent's context: only act on team messages that
   @mention you; a reply that answers your request *closes* it — no thanks,
   no acknowledgment, no re-mention.
2. **A mechanical circuit breaker** in the bridge, because an LLM *will*
   eventually misjudge step 1: after N consecutive agent-authored messages in
   a thread with no human input, the bridge stops invoking the agent, posts
   one pause notice, and goes silent until a human speaks.

That's the design philosophy in miniature: agent autonomy with mechanical
guardrails, so agents coordinate without a human relaying every message —
and fail safe when they get it wrong.

## What Emperor is not

It's not another agent framework, and it doesn't ship a reasoning engine.
LangChain/CrewAI/AutoGen are the brain; Emperor is the operating body.
Bring your own agents: anything that can make HTTP calls can join the
workforce (the Hermes bridge — the reference integration my Pi fleet runs —
is a few hundred lines of Python, MIT-licensed).

It also assumes a single long-running process (WebSockets + Postgres
LISTEN/NOTIFY + a watchdog). It self-hosts on a $5 VPS or a Pi; it does not
deploy to serverless. That's a deliberate trade for simplicity you can audit.

## The license, stated plainly

Emperor Claw is Fair Source under the **Functional Source License
(FSL-1.1-Apache-2.0)** — the same license Sentry uses:

- Self-host it, modify it, use it commercially for your own company and
  clients. For a self-hoster it works like MIT.
- The one thing you can't do is sell Emperor Claw itself as a competing
  hosted service.
- **Every release automatically becomes Apache 2.0 two years after
  publication.** Nothing is locked up forever.

I'm a solo builder with no VC. This structure is what lets me open the code
completely while keeping a way to fund the work (an official hosted version
is coming for people who don't want to run Postgres). If that trade-off
isn't for you, the two-year Apache conversion means you only ever have to
disagree with me temporarily.

## Try it

```bash
git clone <repo-url> && cd emperorclaw
cp .env.example .env   # fill in two secrets
docker compose up      # app at localhost:3000, local storage, no cloud deps
```

The repo ships with a seeded demo team. The S3/MinIO storage adapter is the
flagship good-first-issue if you want to contribute.

I'll be in the comments. Ask me anything — especially about the loop guard,
the wikilink brain, or what running an agent workforce off a Raspberry Pi
for a year actually breaks.
