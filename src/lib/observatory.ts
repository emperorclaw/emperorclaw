import type { DashboardTeam, SceneAgent, SceneCommunication } from "./team-scene";

export interface ObservatoryBay { id: string; teamId: string | null; name: string; agents: SceneAgent[] }

/** Sectors are seating, never exclusive teams. Chat membership only filters the roster. */
export function observatoryBays(agents: SceneAgent[], teams: DashboardTeam[], teamId: string | null): ObservatoryBay[] {
    const selected = teams.find((t) => t.id === teamId);
    const bays: ObservatoryBay[] = [];
    const members = [...agents.filter((a) => !selected || selected.memberKeys.includes(a.member.key))].sort((a, b) => a.member.name.localeCompare(b.member.name) || a.member.key.localeCompare(b.member.key));
    for (let i = 0; i < members.length; i += 6) bays.push({ id: `${selected?.id ?? "company"}-${i / 6}`, teamId: selected?.id ?? null, name: selected?.name ?? `Sector ${String(i / 6 + 1).padStart(2, "0")}`, agents: members.slice(i, i + 6) });

    return bays;
}

/** Only fresh, visible communications can create a speaking cue or connection. */
export function visibleCommunications(messages: SceneCommunication[], keys: Set<string>, now: Date, fresh: boolean, teamId: string | null): SceneCommunication[] {
    if (!fresh) return [];
    return messages.filter((m) => {
        const age = now.getTime() - Date.parse(m.at);
        return age >= 0 && age < 30_000 && keys.has(m.actorKey) && (!teamId || m.teamId === teamId || (m.teamId === null && m.targetKey !== null && keys.has(m.targetKey)));
    }).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 3);
}

/** Scene copy is a bounded plain-text preview; the full response stays in Messages. */
export function sceneMessagePreview(raw: string, limit = 112): string {
    const sample = raw.slice(0, 4096).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
    const codeOnly = /^\s*```/.test(sample);
    if (codeOnly) return "Shared code · open conversation";
    let text = sample.replace(/```[\s\S]*?(?:```|$)/g, " ")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
        .replace(/[`*_~]/g, "").replace(/\s+/g, " ").trim();
    if (!text) return "Shared a response · open conversation";
    if (raw.length > 1200) text = `Shared a detailed response: ${text}`;
    const points = Array.from(text);
    if (points.length <= limit) return text;
    const cut = points.slice(0, limit - 1).join("");
    const space = cut.lastIndexOf(" ");
    return (space > limit / 2 ? cut.slice(0, space) : cut).trimEnd() + "…";
}
