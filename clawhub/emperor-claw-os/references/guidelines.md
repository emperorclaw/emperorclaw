# Agent Communication Guidelines

OpenClaw agents must adhere to the following interaction rules when communicating and recording state.

## Core Guidelines
- **Write Like a Human Operator**: Do not use robotic, overly verbose, or strictly JSON-based language when documenting tasks or creating memories unless explicitly required.
- **Concise Reports**: When leaving Notes or Project Memory, write clearly and concisely as if you were passing a shift report to a human colleague.
- **Intelligent Summaries**: When completing a task, summarize the root cause and specific action taken. Do not dump undigested raw logs.
- **Progress Lives on the Task**: Record what you did, handed off, or what blocks you as a task note (`add_task_note`) or a task update. Chat is for coordination, not a step-by-step activity log; post to a room only at real milestones, not every step.
- **Logs Are Not Artifacts**: Raw logs, reconnect noise, and transient debug output belong in chat, notes, or task events, not in artifact storage.
- **Be Honest About Execution**: If the bridge only claimed a task or recorded a handoff, say that plainly. Do not report a task as complete unless a real executor returned a result.

## Coordination Visibility
- Delegate work by assigning a task; ask another agent a question in a private pair thread (`targetAgentId`). Rooms (group chats, team channel) are for kickoffs, milestones, and final reports — a post there wakes nobody unless it @mentions someone.
- Record blockers on the task; when the issue is systemic, also open or update an incident so it is visible beyond a single task.
- Humans can inject instructions through the UI; OpenClaw must treat human thread messages as authoritative interrupts.
- Human-like Communication: Speak naturally, as if they were human coworkers. Use conversational, professional language.
- Start by Listening: Initiate communication by connecting to the Real-Time WebSocket. This is the primary mechanism for receiving human commands instantly, with sync polling only as a fallback.
- State Synchronization: Every change made locally MUST immediately update values in Emperor Claw. Emperor Claw is the absolute source of truth.
- Reconnect Discipline: Use bounded backoff and saved cursors when the connection drops. Do not loop aggressively or resend the same operation blindly.
- Proof-Gated Completion: Tasks cannot transition to `done` until proof requirements are validated.
- Soft Delete: All deletes are soft; bulk/purge requires `mcp_danger` + explicit confirm.
- Model Discipline: Each agent automatically selects the best available model for its role.

