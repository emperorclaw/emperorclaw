import { eventThreadIds } from "./direct-chat-mode";
import type { RealtimeSubject } from "./realtime-delivery";

/**
 * The invalidation topics a browser socket receives. `thread:<id>`, `run:<id>`,
 * `task:<id>` and `project:<id>` name one record; `inbox`, `dashboard`,
 * `agents` and `projects` name a whole surface. A client subscribes to the
 * topics it cares about and refetches when any of them appears in an
 * `{ type: "invalidate", topics }` message.
 */
export type RealtimeTopic = string;

export type RealtimeInvalidation = { type: "invalidate"; topics: string[] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function addId(set: Set<string>, prefix: string, value: unknown) {
    if (typeof value === "string" && UUID_RE.test(value)) set.add(`${prefix}:${value}`);
}

/**
 * The one place mcp_events event types are mapped to invalidation topics. Pure
 * (no DB): reads ids from the broadcast payload and the resolved subject. The
 * server calls this once per NOTIFY and fans the result out to human sockets.
 */
export function eventTopicsFor(payload: unknown, subject: RealtimeSubject | null): string[] {
    const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, any>;
    const topics = new Set<string>();
    const type = typeof p.type === "string" ? p.type : "";

    // Named records → their id topics.
    for (const id of eventThreadIds(payload)) topics.add(`thread:${id}`);
    addId(topics, "run", p.runId);
    addId(topics, "run", p.run?.id);
    addId(topics, "task", p.taskId);
    addId(topics, "task", p.task?.id);
    for (const key of ["artifact", "memory", "incident", "approval", "pipeline", "folder", "schedule", "definition"]) {
        addId(topics, "task", p[key]?.taskId);
    }
    addId(topics, "thread", p.groupId);
    for (const id of subject?.projectIds ?? []) topics.add(`project:${id}`);

    // Broad "something on this surface changed" topics by event type.
    switch (type) {
        case "thread_message":
        case "participant_status":
            topics.add("dashboard");
            topics.add("inbox");
            break;
        case "run_updated":
            topics.add("dashboard");
            break;
        case "agent_status":
        case "agent_registered":
        case "agent_updated":
        case "objective_updated":
        case "runtime_session_degraded":
        case "runtime_checkin_retry":
            topics.add("agents");
            topics.add("dashboard");
            break;
        case "task_updated":
        case "task_note_added":
        case "new_task":
            topics.add("dashboard");
            topics.add("projects");
            topics.add("inbox");
            break;
        case "project_created":
        case "project_updated":
            topics.add("projects");
            break;
        case "group_updated":
            topics.add("dashboard");
            break;
        case "incident_updated":
        case "incident_deleted":
            topics.add("inbox");
            topics.add("dashboard");
            break;
        case "approval_created":
        case "approval_updated":
            topics.add("inbox");
            topics.add("dashboard");
            break;
        default:
            break;
    }

    return [...topics];
}
