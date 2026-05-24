export const EMPEROR_CHANNEL_ID = "emperor-claw-os";
export const EMPEROR_CHANNEL_LABEL = "Emperor";
function getChannelSection(cfg) {
    return (cfg.channels?.[EMPEROR_CHANNEL_ID] || {});
}
function normalizeApiUrl(value) {
    return value.replace(/\/+$/, "");
}
export function resolveEmperorChannelAccount(cfg, accountId) {
    const section = getChannelSection(cfg);
    const token = String(section.token || "").trim();
    const apiUrl = normalizeApiUrl(String(section.apiUrl || "https://emperorclaw.malecu.eu").trim());
    if (!token) {
        throw new Error("emperor channel: channels.emperor-claw-os.token is required");
    }
    return {
        accountId: accountId ?? null,
        apiUrl,
        token,
        senderAgentId: String(section.senderAgentId || "").trim() || null,
        allowFrom: Array.isArray(section.allowFrom) ? section.allowFrom.map((value) => String(value)).filter(Boolean) : [],
        dmPolicy: typeof section.dmSecurity === "string" ? section.dmSecurity : undefined,
        defaultChatId: String(section.defaultChatId || "team").trim() || "team"
    };
}
export function listEmperorChannelAccountIds(_cfg) {
    return ["default"];
}
export function inspectEmperorChannelAccount(cfg, accountId) {
    const section = getChannelSection(cfg);
    const token = String(section.token || "").trim();
    const apiUrl = String(section.apiUrl || "").trim();
    return {
        accountId: accountId ?? null,
        enabled: Boolean(token),
        configured: Boolean(token && apiUrl),
        tokenStatus: token ? "available" : "missing",
        apiUrlStatus: apiUrl ? "available" : "missing",
        senderAgentStatus: String(section.senderAgentId || "").trim() ? "available" : "missing",
        defaultChatId: String(section.defaultChatId || "team").trim() || "team"
    };
}
