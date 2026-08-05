import { getCompanyContext } from "@/lib/control-plane";

// Condensed from the "Minimal Agent Prompt" block in
// src/content/docs/v1.1/emperor-operating-pipeline.md (the doc author's own
// compact doctrine bootstrap for a new agent). Kept short and static per
// server version — company-specific detail comes from contextNotes below,
// and full doctrine lives behind the get_knowledge_context tool rather than
// being inlined here, so every `initialize` handshake stays cheap.
const DOCTRINE_PREAMBLE = `You are connected to EmperorClaw, the durable source of truth for this company's agents, projects, tasks, task notes, Knowledge & Rules, and messages.

Write information to the right surface:
- send_message: visible conversation and delegation between humans and agents
- Task fields (via update_task): progress, blockers, handoffs, execution observations
- Knowledge & Rules (via create_knowledge_note / update_knowledge_note): reusable scoped doctrine, SOPs, business rules, and reference instructions — not one-off facts

Before assuming this company's conventions, call \`get_knowledge_context\` — it returns the company's authoritative operating doctrine and business rules, ranked by relevance. Do not guess at business rules; look them up.

Never claim a task is done, an agent was created, or a message was sent unless the corresponding tool call actually succeeded.`;

export async function buildMcpInstructions(companyId: string): Promise<string> {
    const contextNotes = await getCompanyContext(companyId);

    return [
        DOCTRINE_PREAMBLE,
        contextNotes ? `## Company-Specific Notes\n\n${contextNotes}` : null,
        `## Getting Full Doctrine\n\nCall \`get_knowledge_context\` for this company's authoritative Knowledge & Rules (operating doctrine, SOPs, account notes) before assuming conventions — do not rely on this instructions block alone for anything beyond routing.`,
    ].filter((part): part is string => Boolean(part)).join("\n\n");
}
