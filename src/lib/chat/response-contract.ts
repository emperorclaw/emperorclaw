import { z } from "zod";

export const PREVIEW_MAX_BYTES = 128 * 1024;
export const responseSnapshotSchema = z.object({
    responseId: z.string().uuid(),
    segmentIndex: z.number().int().min(0).max(31),
    revision: z.number().int().min(1).max(2_147_483_647),
    text: z.string().max(PREVIEW_MAX_BYTES).refine(text => new TextEncoder().encode(text).length <= PREVIEW_MAX_BYTES),
    state: z.enum(["streaming", "sealed", "completed", "interrupted", "failed", "capped"]),
}).strict();
export type ResponseSnapshot = z.infer<typeof responseSnapshotSchema>;
export type ChatPreview = ResponseSnapshot & { runId: string; agentId: string; updatedAt: string; runStatus: string; finalMessageId: string | null; agentName: string };

/** Snapshot replacement is monotonic, including when network requests reorder. */
export function mayReplaceSnapshot(previous: Pick<ResponseSnapshot, "revision" | "state">, next: Pick<ResponseSnapshot, "revision" | "state">) {
    return next.revision > previous.revision && (previous.state === "streaming" || previous.state === next.state);
}
