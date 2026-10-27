/**
 * Length caps for the short names and titles people and agents type. They
 * reach lists, search, notifications and the activity log, so an unbounded
 * one is a storage and rendering hazard. Routes reject a longer value with a
 * 400 (MCP tools with their zod schema).
 */

/** Customer, agent and knowledge note names. */
export const NAME_MAX = 200;

/** Task titles (the writing guide asks for 80; this only stops abuse). */
export const TASK_TITLE_MAX = 500;

/** The 400 message when `value` is a string longer than `max` once trimmed, else null. */
export function lengthError(field: string, value: unknown, max: number): string | null {
    return typeof value === "string" && value.trim().length > max ? `${field} must be at most ${max.toLocaleString("en-US")} characters` : null;
}
