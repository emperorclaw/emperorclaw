/**
 * Approval cards in chat (0.30): the pure parts shared by the server, which
 * posts the card (lib/approval-card.ts), and the chat UI, which renders it
 * (components/approval-card.tsx). No database, safe for the client bundle.
 *
 * The card's message text is deliberately neutral: who asks and a short label
 * (the task title or the action's name). Never the rationale and never the
 * action's arguments — an action-policy rationale is the full argument preview
 * (recipients, amounts, bodies), and every reader of the thread sees the text.
 * The rationale is served only to people who may decide the approval.
 */

/** Reserved message metadata: `{ approvalCard: { approvalId, status? } }` on the card. */
export const APPROVAL_CARD_KEY = "approvalCard";
/** Reserved message metadata on the decision message: the card message it answers. */
export const APPROVAL_DECISION_FOR_KEY = "approvalDecisionFor";

const LABEL_MAX = 120;
const NAME_MAX = 80;

/**
 * One line of plain text that is safe to post: no line breaks and no "@" (a
 * task title such as "Ask @Builder" must not turn the card into a mention
 * that wakes an agent), bounded in length.
 */
export function neutralCardLine(value: string, max = LABEL_MAX): string {
    const line = value.replace(/@/g, "").replace(/\s+/g, " ").trim();
    return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** The card's short label: the task title (with the action for anything but closing it), else the action's name. */
export function approvalCardLabel(input: { actionType: string; actionLabel: string; taskTitle?: string | null }): string {
    const action = neutralCardLine(input.actionLabel);
    const title = input.taskTitle ? neutralCardLine(input.taskTitle) : "";
    if (!title) return action;
    return input.actionType === "task_done" ? title : `${action}: ${title}`;
}

/** The card message text (also what old clients, mirrors and bridges show). */
export function approvalCardText(agentName: string | null | undefined, label: string): string {
    const name = agentName && agentName.trim() ? neutralCardLine(agentName, NAME_MAX) : "an agent";
    return `Approval requested by ${name}: ${label}`;
}

/**
 * The decision notice posted in a shared card thread (a group, a task thread):
 * the outcome and who decided. People read it right under the card, so it
 * carries no raw id (the id stays in the message metadata). Never the
 * resolution note or task links: everyone in the thread reads it, and the note
 * is for the agent (it gets the full message in its direct thread).
 */
export function approvalDecisionNoticeText(input: { approvalId: string; status: string; deciderName?: string | null }): string {
    if (input.status === "expired") return "Approval request expired without a decision.";
    const name = input.deciderName && input.deciderName.trim() ? neutralCardLine(input.deciderName, NAME_MAX) : "";
    return name ? `Approval request ${input.status} by ${name}.` : `Approval request ${input.status}.`;
}

/**
 * The approval a chat message is the card for, or null. Only a system message
 * is a card: agents cannot post as system, and the key is reserved metadata
 * (message-routing.ts), so a forged card never renders Approve/Reject buttons.
 */
export function approvalCardIdOf(message: { senderType?: string | null; metadataJson?: unknown }): string | null {
    if (message.senderType !== "system") return null;
    const meta = message.metadataJson && typeof message.metadataJson === "object" ? message.metadataJson as Record<string, unknown> : null;
    const card = meta?.[APPROVAL_CARD_KEY];
    if (!card || typeof card !== "object" || Array.isArray(card)) return null;
    const id = (card as Record<string, unknown>).approvalId;
    return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
}
