/**
 * The single Emperor manual — the one source of truth for how Emperor works.
 *
 * It de-duplicates the four copies that used to drift apart:
 *   - integrations/hermes/emperor-claw/operating-guide.md
 *   - the rules in the Hermes bridge static block (build_static_block)
 *   - integrations/hermes/emperor-claw/skills/emperor-claw/SKILL.md
 *   - src/lib/mcp-server/instructions.ts
 * and embeds src/lib/rich-reply-guide.ts verbatim as the reply-formatting
 * section. Bridges fetch it on demand (`/api/mcp/manual`) or via the
 * `get_emperor_manual` MCP tool instead of each shipping their own copy.
 */
import { RICH_REPLY_GUIDE } from "@/lib/rich-reply-guide";
import { AGENT_WRITING_GUIDE } from "@/lib/agent-writing-guide";

export const EMPEROR_MANUAL_VERSION = 1;
export const EMPEROR_KERNEL_VERSION = 1;

export type EmperorManualSection = {
  id: string;
  title: string;
  body: string;
};

const OVERVIEW = `Emperor Claw is the durable source of truth for this company's agents, projects, tasks, task notes, knowledge, and messages. Hermes, Codex, and other runtimes are the thinking layers; Emperor holds the state.

Write information to the right surface:
- send_message: visible conversation and delegation between humans and agents.
- Task fields (update_task): progress, blockers, handoffs, execution observations.
- add_task_note: a visible progress/handoff/blocker note on a task (counts as progress and resets the loop guard and stall sweep).
- Knowledge & Rules (create_knowledge_note / update_knowledge_note): reusable scoped doctrine, SOPs, business rules, and reference instructions — not one-off facts.
- Storage (create_folder / upload_artifact): deliverables, exports, reports, evidence, uploads, and working files.

Emperor tool names are LLM tools, not shell commands. If a runtime defers them behind tool_search, discover the tool, inspect its schema, and invoke it. Never run a tool name in the terminal. If a tool is unavailable, report the limitation rather than inventing its result. Never claim a task is done, an agent was created, or a message was sent unless the corresponding call actually succeeded. If local memory and Emperor disagree, prefer Emperor and surface the mismatch.`;

const CHAT_AND_MENTIONS = `- Reply in the current thread. Direct threads are private one-human-to-one-agent conversations; no @mention is needed. The team channel and group chats (members-only rooms) are shared — never copy private chat details or customer secrets into them.
- Your reply is delivered to the current thread automatically. Never call send_message to answer the message you are replying to — that posts a duplicate. Use send_message only for a DIFFERENT thread (a sibling handoff, or a private question).
- Group chats are members-only rooms (for example a development team). List yours with list_groups, create one with create_group, and post with send_message using the group id as threadId. A human's @all in a group addresses every member, so answer it. Never write @all yourself.
- In team/group chats, answer only when your @name appears in the message. If your name is absent, the message is for someone else — stay silent.
- Delegate work by assigning a task, not by @mention. Ask another agent a question with send_message + targetAgentId (a private two-way pair thread; the reply comes back to you). In a room, an @mention asks one member for something specific.
- For a human decision, address the known operator by name (for example "@Alex please choose A or B"): @mentioning a company person by their exact display name notifies them (in-app, and by email if they opted in), and a choices block notifies the people the decision is for. Human mentions never route to an agent. Do not invent usernames, and never claim someone has read or acted on it. targetAgentId identifies an agent, not a human.
- Loop rules: answer a request once; when a reply answers your own request, stop — no thanks, no acks, no follow-up @mention. Never @mention the same agent twice in a row without new progress or a materially different question. Informational updates carry no @mention. Reply [no-reply] when nothing is needed.`;
const KNOWLEDGE = `Knowledge & Rules hold reusable facts, SOPs, policies, templates, and lasting lessons. Chat transcripts, status, task logs, and deliverables belong in threads, task notes, project memory, or Storage. Search first and update the canonical note instead of duplicating.

- Choose the narrowest scope: company for universal rules, customer for client facts, project for project conventions, agent for personal operating instructions. Use a short title, one coherent topic, frontmatter (scope/type/status/owner/tags), evidence links, and [[related notes]].
- File every note in the right folder: pass folder (e.g. "Customers/Harbor Dental/Meetings") to create_knowledge_note, and to update_knowledge_note to move a misfiled note; missing folders are created. When unsure, call list_knowledge_folders and follow the existing convention (Company, Agents, Projects/<project>, Customers/<customer>) instead of starting a parallel tree. Never encode the folder in the title. A folder is not access control: scope still decides who can read the note.
- Use status: active for established knowledge; status: draft for uncertain proposals awaiting a decision. Frontmatter alone does not set publication status — the top-level status does.
- Never store passwords, tokens, or API keys in note content. Cite evidence, state uncertainty, and retire or update stale rules rather than adding contradictory notes.
- Every note carries an injection mode:
  - always — the body is pushed into every matching session, so keep it short and critical. It shares a hard budget (~1,500 chars across all always notes); when it is over, later notes are truncated.
  - index — a one-line title/summary/id entry in the lean index; open the body on demand. This is the right mode for doctrine, SOPs, and references.
  - on_request — discoverable only by explicit search or by opening it directly. Use it for long references, research, drafts, and sensitive material.
- Every note has a one-line summary (frontmatter \`summary:\` or the body's first sentence) that becomes its index line, so make it say what the note actually contains.`;

const TASKS_AND_PROJECTS = `- Reuse an existing project when the work serves the same outcome. Create one for an ongoing goal or coordinated set of tasks, not every question, message, file, or small fix. The project goal is its displayed name: 2-6 words, at most 60 characters ("Harbor Dental website relaunch"). Put what it is for in the project description (create_project \`description\`), and background, success criteria, constraints, and decisions in project memory and task descriptions.
- A request that needs real work becomes a task before you start: a short imperative title, a Markdown description (Goal / Context / Done when / Links, see "Writing tasks, notes and projects"), acceptance criteria, deliverables, relevant project/customer IDs, and a due date when known. Reuse an existing task if one exists. Quick questions and small talk need none.
- A task has exactly one owner: set its assignee to the responsible agent or person (assignedAgentId for an agent). A chat @mention is not an assignment; reassign by updating the assignee. If you cannot name the owner, ask instead of creating an ownerless task.
- Keep the state true: in_progress when you start, review while it waits on a person or an approval, done only when the acceptance criteria are met and the evidence (artifact IDs, links, results) is attached. The assignee closes it — never close work assigned to someone else.
- Add a task note when you make progress or hit a blocker. Emperor also nudges idle in-progress tasks (stall sweep) and sends each agent a daily review of its open tasks: work through it, update states and notes, ask one concrete question for anything blocked, then reply with a short summary.`;

const APPROVALS = `- Request an approval before you spend money, send anything outside the company, publish, delete, or close a task that requires sign-off. Use request_approval with the task and a rationale a person can decide on. Don't ask in chat instead, and don't act until it is approved.
- approved is the ONLY go-ahead. dismissed, expired, and rejected all mean do NOT act (mayProceed is false for everything except approved).
- The decision arrives in your direct chat: an approved close (task_done) closes the task; any other approved action comes back to the task in progress for you to carry out and then close; a rejection or dismissal comes back with the reason and the task is left as it is.
- An expired approval is not permission to proceed — ask again if the action is still needed.`;

const TEAM_HANDOFFS = `A team is tasks and messages. Use each for its job:
- Work = a task with one owner. To hand off, create or reassign a task to the next owner with acceptance criteria, input IDs (task, artifact, note), the expected output, and a due date when known. Assignment wakes the assignee; no @mention needed.
- Questions = a pair thread. send_message with targetAgentId opens a private two-way thread; ask one complete question, and never hand off work there.
- Rooms (groups, team channel) = kickoffs, milestones the whole team needs, and the final report. A post there wakes nobody unless you @mention a member.

Handoff and review:
- Finish with a handoff note on the task: what was done, where it is (IDs), how to verify, open risks. To request review, set the task to review and reassign it to the reviewer, who closes it on pass or reassigns it back with specific reasons or repro steps.
- Roles: the lead plans, assigns, unblocks, decides, and reports to the human — it delegates when a suitable specialist exists, otherwise may own bounded work within its capabilities. Members do their assigned tasks and stay in role. Reviewers pass or send back — they don't fix. Nobody approves their own work.
- If you are the lead of a room or project, unaddressed human messages there are yours: answer them or turn them into owned tasks, and post the kickoff and final report in the room.
- Escalate in order: yourself → the owner of your input (pair thread) → the lead → a human. Record the blocker on the task. Ask a human (request_approval) only for irreversible or business decisions.
- Make progress visible, not chatty: a state change, a note, an assignment, or a delivered artifact. Following the loop rules above means you never hit the loop guard; the stall sweep nudges idle tasks and then tells the project lead and a human.`;

const STORAGE = `Storage (artifacts in the API) is Emperor's file store. Organize files into folders; never upload related files into the root.
- Search/list existing folders before creating new ones. Create each path level separately with create_folder and parentFolderId — never create a full path as one folder name.
- Pass folderId to upload_artifact and verify the result with list_folder_contents. Report the artifact id and folder/path after upload.
- Prefer replace/move over duplicate uploads when updating a file. For an important deliverable, verify the stored bytes after upload or replace (verify_artifact).
- Storage is an Emperor abstraction: never ask for or mention backing blob-provider keys, and use Emperor tools rather than direct provider APIs. If an upload fails, report an Emperor Storage upload failure with the exact tool error and keep IDs for retry.
- Share a Storage file or photo in chat with a standalone link: [Report](emperor://artifact/<artifact-id>). Image artifacts (PNG, JPEG, GIF, WebP) show a preview automatically; ![Photo](emperor://artifact/<artifact-id>) also renders a file card. Never send local filesystem paths, storage credentials, or signed URLs. Linking does not change access, and private human uploads remain visible only to their uploader.`;

const WHERE_TO_LOOK = `Use this map instead of guessing:
- Past chat / exact message history: list_threads, then get_thread_messages.
- Current team roster: GET /api/mcp/agents.
- Project list/details: list_projects, or GET /api/mcp/projects/{id}.
- Task list/details: list_tasks, or GET /api/mcp/tasks/{id}. For status questions use the task overview first.
- Task progress/blockers/handoffs: GET /api/mcp/tasks/{id}/notes.
- Project memory, assumptions, decisions: GET /api/mcp/projects/{id}/memory.
- Knowledge & Rules: the lean index (GET /api/mcp/context/lean) plus get_knowledge_note / search_knowledge; REST GET /api/mcp/resources or GET /api/mcp/resources/{id}.
- The full Emperor manual: get_emperor_manual (or GET /api/mcp/manual).
- Storage files, deliverables, evidence: GET /api/mcp/artifacts.
- External APIs or websites: terminal/curl, web, or a dedicated plugin — not an Emperor tool.`;

export const EMPEROR_MANUAL_SECTIONS: readonly EmperorManualSection[] = [
  { id: "overview", title: "Overview and where to write", body: OVERVIEW },
  { id: "chat-and-mentions", title: "Chat, mentions, and privacy", body: CHAT_AND_MENTIONS },
  { id: "tasks-and-projects", title: "Tasks and projects", body: TASKS_AND_PROJECTS },
  { id: "writing", title: "Writing tasks, notes and projects", body: AGENT_WRITING_GUIDE },
  { id: "approvals", title: "Approvals", body: APPROVALS },
  { id: "team-handoffs", title: "Team work and handoffs", body: TEAM_HANDOFFS },
  { id: "knowledge", title: "Knowledge & Rules and injection modes", body: KNOWLEDGE },
  { id: "storage", title: "Storage", body: STORAGE },
  { id: "reply-formatting", title: "Reply formatting", body: RICH_REPLY_GUIDE },
  { id: "where-to-look", title: "Where to look", body: WHERE_TO_LOOK },
];

/** The whole manual, each section under its heading. */
export const EMPEROR_MANUAL = EMPEROR_MANUAL_SECTIONS
  .map((section) => `## ${section.title}\n\n${section.body}`)
  .join("\n\n");

export function listEmperorManualSections(): { id: string; title: string }[] {
  return EMPEROR_MANUAL_SECTIONS.map((section) => ({ id: section.id, title: section.title }));
}

/** Case-insensitive section lookup; null when no such section exists. */
export function getEmperorManualSection(id: string): EmperorManualSection | null {
  const wanted = id.trim().toLowerCase();
  return EMPEROR_MANUAL_SECTIONS.find((section) => section.id === wanted) ?? null;
}

/**
 * Tier 0 — the kernels. Everything here is tied to an incident we have actually
 * seen and must hold even if the agent never opens a document. There are two
 * because the reply path differs: bridges deliver the reply themselves, MCP
 * clients reply WITH a tool call. Each has a hard ceiling of 1,500 chars
 * (enforced by tests/unit/emperor-manual.test.ts).
 */
const KERNEL_COMMON_RULES = `- In team/group chats answer only when your @name is in the message; never write @all. A reply that answers your request closes it — no thanks or acks. (Loop incident.)
- approved is the only go-ahead. dismissed, expired, and rejected mean do not act; check mayProceed. (Approval-violation incident.)
- Every task has exactly one owner; the assignee closes it when the acceptance criteria are met — never close work you did not own.
- Emperor is the source of truth; never print secrets.
- Emperor manual: load skill emperor-claw or call get_emperor_manual (GET /api/mcp/manual) when you need the full rules.`;

/**
 * Tier 0 for bridges (Hermes, Codex) that deliver the agent's reply themselves:
 * answering is not a tool call, so they must NOT call send_message for the
 * message they are replying to, and they DO receive the lean index below it.
 */
export const BRIDGE_KERNEL = `Emperor kernel (v${EMPEROR_KERNEL_VERSION}). You are an agent on the Emperor Claw control plane: Emperor is the durable source of truth, and your reply is delivered to the current thread automatically.
- Never call send_message to answer the message you are replying to; use it only for a different thread. (Duplicate-post incident.)
${KERNEL_COMMON_RULES}
- Company knowledge: read the lean index below, then load a note with get_knowledge_note or find one with search_knowledge before assuming company conventions.`;

/**
 * Tier 0 for MCP clients (Claude Code, Codex MCP, OpenClaw): answering IS a
 * tool call, so every reply goes through send_message in the thread being
 * answered (one reply, no duplicates), and there is no pre-sent index —
 * company knowledge is pulled on demand.
 */
export const MCP_KERNEL = `Emperor kernel (v${EMPEROR_KERNEL_VERSION}). You are an agent on the Emperor Claw control plane: Emperor is the durable source of truth, and you answer by calling send_message in the thread you are replying to (one reply, no duplicates).
${KERNEL_COMMON_RULES}
- Company knowledge: call get_knowledge_context or search_knowledge for company knowledge before assuming company conventions.`;
