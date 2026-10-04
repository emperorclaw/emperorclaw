/**
 * An agent's instructions (its role doctrine files) as one prompt section.
 * Provisioning passes it to the container at start; bridges since 0.8.59 also
 * read it live from GET /agents/{id}/memory, so edits apply on the next turn.
 */
// The bridge reads its role doctrine from EMPEROR_CLAW_AGENT_INSTRUCTIONS and
// prepends it to every turn's system prompt. Provisioning used to never set
// this, so a hired role's SOUL/AGENTS doctrine was stored but never reached
// the runtime. Order matters: operating rules first, then persona, then the
// identity anchor. Unknown doctrine files are appended after the known ones.
const DOCTRINE_ENV_ORDER = ["AGENTS.md", "SOUL.md", "IDENTITY.md"];
const MAX_AGENT_INSTRUCTIONS_CHARS = 12000;

export function buildAgentInstructions(doctrine: Record<string, string> | null | undefined): string {
    if (!doctrine || typeof doctrine !== "object") return "";
    const parts: string[] = [];
    for (const key of DOCTRINE_ENV_ORDER) {
        const value = doctrine[key];
        if (typeof value === "string" && value.trim()) parts.push(value.trim());
    }
    for (const [key, value] of Object.entries(doctrine)) {
        if (DOCTRINE_ENV_ORDER.includes(key)) continue;
        if (typeof value === "string" && value.trim()) parts.push(`### ${key}\n${value.trim()}`);
    }
    return parts.join("\n\n").slice(0, MAX_AGENT_INSTRUCTIONS_CHARS);
}
