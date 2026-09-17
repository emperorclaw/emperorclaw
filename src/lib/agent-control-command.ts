export type AgentControlAction = "kill" | "queue" | "replace";
export function parseAgentControlCommand(text: string): { action: AgentControlAction; prompt: string } | null {
    const match = text.trim().match(/^\/(kill|queue|replace)(?:\s+([\s\S]*))?$/i);
    if (!match) return null;
    return { action: match[1].toLowerCase() as AgentControlAction, prompt: (match[2] || "").trim() };
}
export function validateAgentControl(action: unknown, prompt: unknown): string | null {
    if (!["kill", "queue", "replace"].includes(String(action))) return "Choose kill, queue, or replace";
    if (action === "kill") return prompt ? "/kill takes no prompt; use /replace for a new prompt" : null;
    if (typeof prompt !== "string" || !prompt.trim()) return "A prompt is required";
    return prompt.length > 32000 ? "Prompt must be at most 32,000 characters" : null;
}
