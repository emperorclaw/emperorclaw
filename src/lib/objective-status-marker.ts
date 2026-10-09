/**
 * Pure parser for the tool-less objective-status fallback.
 *
 * Every runtime can post a normal text reply, but not every runtime exposes MCP
 * tools (the Codex bridge states it has no Emperor tools). The objective prompt
 * teaches one optional, isolated marker line:
 *
 *   EMPEROR_OBJECTIVE_STATUS {"objectiveId":"…","action":"complete", …}
 *
 * This module has NO database or service imports, so messaging/control-plane can
 * sanitize text without pulling in the objective service (and without a cycle).
 * Authorization is checked elsewhere: only an authenticated agent reply to its
 * own objective prompt is ever applied.
 */

export const OBJECTIVE_STATUS_MARKER = "EMPEROR_OBJECTIVE_STATUS";

export const OBJECTIVE_STATUS_ACTIONS = ["update", "pause", "resume", "block", "complete", "cancel"] as const;
export type ObjectiveStatusAction = (typeof OBJECTIVE_STATUS_ACTIONS)[number];

export interface ObjectiveStatusMarker {
    objectiveId: string;
    action: ObjectiveStatusAction;
    summary?: string;
    blockerReason?: string;
    completionSummary?: string;
    objective?: string;
    cadenceMinutes?: number;
}

function normalizeMarker(raw: unknown): ObjectiveStatusMarker | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    if (typeof value.objectiveId !== "string" || !value.objectiveId.trim()) return null;
    if (typeof value.action !== "string" || !OBJECTIVE_STATUS_ACTIONS.includes(value.action as ObjectiveStatusAction)) return null;
    const marker: ObjectiveStatusMarker = { objectiveId: value.objectiveId.trim(), action: value.action as ObjectiveStatusAction };
    for (const key of ["summary", "blockerReason", "completionSummary", "objective"] as const) {
        if (typeof value[key] === "string" && (value[key] as string).trim()) marker[key] = (value[key] as string).trim();
    }
    if (Number.isFinite(Number(value.cadenceMinutes))) marker.cadenceMinutes = Number(value.cadenceMinutes);
    return marker;
}

/**
 * Split a reply into its visible text and an optional objective-status marker.
 * Only a whole line that is exactly the marker followed by a JSON object is
 * recognized; a malformed line is left alone so ordinary text is preserved.
 */
export function parseObjectiveStatusMarker(text: string): { marker: ObjectiveStatusMarker | null; strippedText: string } {
    const lines = String(text ?? "").split("\n");
    const kept: string[] = [];
    let marker: ObjectiveStatusMarker | null = null;
    for (const line of lines) {
        if (marker) { kept.push(line); continue; }
        const match = line.match(/^\s*EMPEROR_OBJECTIVE_STATUS\s+(\{.*\})\s*$/);
        if (!match) { kept.push(line); continue; }
        try {
            const parsed = normalizeMarker(JSON.parse(match[1]));
            if (parsed) { marker = parsed; continue; }
        } catch { /* not a valid marker line: keep it as ordinary text */ }
        kept.push(line);
    }
    // Drop a single trailing blank line left by removing the marker.
    while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
    return { marker, strippedText: kept.join("\n").trimEnd() };
}

/** Reserved server-only metadata key carrying an authorized marker. */
export const OBJECTIVE_STATUS_METADATA_KEY = "__objectiveStatus";

export function readStoredObjectiveMarker(metadata: unknown): ObjectiveStatusMarker | null {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    return normalizeMarker((metadata as Record<string, unknown>)[OBJECTIVE_STATUS_METADATA_KEY]);
}
