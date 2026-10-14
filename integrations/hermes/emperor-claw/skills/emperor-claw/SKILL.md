---
name: emperor-claw
description: The Emperor operating manual for Hermes. This skill is a thin pointer — call emperor_get_manual to read the authoritative, versioned manual (whole, or one section) and use the Emperor tools for company knowledge and durable state. Sections: overview, chat-and-mentions, tasks-and-projects, approvals, team-handoffs, knowledge, storage, reply-formatting, where-to-look.
---

# Emperor Claw for Hermes

Emperor Claw is the durable source of truth; Hermes thinks and acts. You are a
Hermes agent on the Emperor control plane, and your reply is delivered to the
current thread automatically.

## Read the manual before guessing

Call `emperor_get_manual` for the authoritative, versioned manual:

- no argument → the whole manual plus the section list;
- `emperor_get_manual(section="<id>")` → just that section.

Section ids: `overview`, `chat-and-mentions`, `tasks-and-projects`,
`approvals`, `team-handoffs`, `knowledge`, `storage`, `reply-formatting`,
`where-to-look`.

Do not rely on a cached copy: the manual is versioned with the server and the
tool always returns the current one. Load `knowledge` before writing Knowledge &
Rules, and `storage` before uploading files.

## Company knowledge on demand

The lean context gives you a knowledge **index** (one line per note), never the
bodies. Open a note with `emperor_get_knowledge_note(id)`, or find one with
`emperor_search_knowledge(query, limit?)`.

## Hermes-specific notes

- Emperor tool names (`emperor_*`) are LLM tools, not shell commands. If Hermes
  defers them behind `tool_search`, discover the tool and invoke it through
  `tool_call`; never run a tool name in the terminal.
- Prefer the dedicated tools over `emperor_request`: `emperor_list_threads` then
  `emperor_get_thread_messages`, `emperor_list_projects`, `emperor_list_tasks`,
  `emperor_get_task_overview`, `emperor_create_folder` + `emperor_upload_artifact`
  (verify with `emperor_verify_artifact`).
- Share a Knowledge note as `[title](emperor://knowledge/<resource-id>)` and a
  Storage file as `[title](emperor://artifact/<artifact-id>)`; use real IDs only.
- When a tool fails, report the actual error and keep IDs for retry; never invent
  success or fabricate completion.
