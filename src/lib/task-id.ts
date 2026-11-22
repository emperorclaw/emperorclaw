/**
 * Task ids have three shapes on the wire.
 *
 * The API takes a UUID, but the product shows every task as an eight-character
 * short code (the upper-cased head of its id — see getTaskDetailForCompany) and
 * people paste that code back into MCP calls and links. A truncated id is the
 * same mistake. Everything that is not a UUID used to reach the query as-is, so
 * Postgres answered `invalid input syntax for type uuid` and the route turned
 * that into a 500 with a driver trace (2026-11-21: /api/mcp/tasks/7793dcfa).
 *
 * This module is pure so the classification can be unit-tested without a
 * database; the company-scoped lookup lives in lib/openclaw/task-context.ts.
 */

/** A full UUID, any case. Matches what the `uuid` column accepts. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Hex digits only: a short code, or an id with its dashes stripped. */
const HEX_ONLY_RE = /^[0-9a-f]+$/i;

/** The short code is the first 8 characters of the id, so that is the floor. */
export const SHORT_CODE_LENGTH = 8;

export type TaskRef =
    | { kind: "id"; id: string }
    | { kind: "prefix"; prefix: string }
    | { kind: "invalid"; error: string };

function withDashes(hex: string): string {
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Classify what a caller sent as a task reference.
 *
 * - a UUID, or the same 32 hex digits without dashes → `id` (canonical, lower case)
 * - 8..31 hex digits → `prefix` (short code / truncated id)
 * - anything else → `invalid`, with a message that says what to send instead
 */
export function classifyTaskRef(raw: string | null | undefined): TaskRef {
    const value = (raw ?? "").trim();
    if (!value) {
        return { kind: "invalid", error: `Task id is required: pass the task UUID or its ${SHORT_CODE_LENGTH}-character short code.` };
    }
    if (UUID_RE.test(value)) {
        return { kind: "id", id: value.toLowerCase() };
    }
    if (HEX_ONLY_RE.test(value)) {
        const hex = value.toLowerCase();
        if (hex.length === 32) return { kind: "id", id: withDashes(hex) };
        if (hex.length >= SHORT_CODE_LENGTH && hex.length < 32) {
            return { kind: "prefix", prefix: hex };
        }
    }
    return {
        kind: "invalid",
        error: `Invalid task id "${value}": pass the task UUID or its ${SHORT_CODE_LENGTH}-character short code (hex), not a name or an arbitrary string.`,
    };
}
