export async function runBrainViaRuntimeAgent(input) {
    if (input.runtimeAgent.ensureAgentWorkspace) {
        await input.runtimeAgent.ensureAgentWorkspace(input.cfg);
    }
    const raw = await input.runtimeAgent.runEmbeddedPiAgent(input.invocation);
    const text = extractBrainText(raw);
    return {
        raw,
        text,
        sessionId: readSessionId(raw)
    };
}
function normalizePayloadText(value) {
    return String(value || "").replace(/\r\n/g, "\n").trim();
}
function selectBestPayloadText(payloads) {
    const texts = payloads
        .map((item) => (item && typeof item.text === "string"
        ? normalizePayloadText(item.text)
        : ""))
        .filter(Boolean);
    if (texts.length === 0)
        return null;
    if (texts.length === 1)
        return texts[0];
    const uniqueTexts = [];
    for (const text of texts) {
        if (uniqueTexts[uniqueTexts.length - 1] === text)
            continue;
        uniqueTexts.push(text);
    }
    const longest = uniqueTexts.reduce((best, current) => (current.length >= best.length ? current : best), "");
    const last = uniqueTexts[uniqueTexts.length - 1];
    const progressivelyGrowing = uniqueTexts.every((text, index) => {
        if (index === 0)
            return true;
        const previous = uniqueTexts[index - 1];
        return text.startsWith(previous) || previous.startsWith(text);
    });
    if (progressivelyGrowing)
        return longest || last;
    if (longest && last && (longest.includes(last) || last.includes(longest))) {
        return longest.length >= last.length ? longest : last;
    }
    return last || longest;
}
function looksLikeBrokenStreamArtifact(text) {
    if (!text)
        return false;
    if (/^data:\s*\{?/m.test(text))
        return true;
    if (text.split("\n").filter((line) => /^data:\s*/.test(line)).length >= 2)
        return true;
    if (/^\{"reply_text":/i.test(text) && !text.endsWith("}"))
        return true;
    if ((text.match(/\{\"type\":/g) || []).length >= 2)
        return true;
    return false;
}
function sanitizeBrainText(text) {
    const value = normalizePayloadText(text);
    if (!value || looksLikeBrokenStreamArtifact(value))
        return null;
    return value;
}
export function extractBrainText(raw) {
    const value = raw;
    const payloads = Array.isArray(value?.payloads)
        ? value.payloads
        : Array.isArray(value?.result?.payloads)
            ? value?.result?.payloads
            : [];
    const bestPayloadText = sanitizeBrainText(selectBestPayloadText(payloads));
    if (bestPayloadText)
        return bestPayloadText;
    const candidates = [
        value?.reply,
        value?.text,
        value?.message,
        value?.result?.reply,
        value?.result?.text,
        value?.result?.message
    ];
    for (const candidate of candidates) {
        if (typeof candidate === "string") {
            const sanitized = sanitizeBrainText(candidate);
            if (sanitized)
                return sanitized;
        }
    }
    return null;
}
export function readSessionId(raw) {
    const value = raw;
    const candidates = [
        value?.sessionId,
        value?.session_id,
        value?.session?.id,
        value?.meta?.agentMeta?.sessionId,
        value?.result?.sessionId,
        value?.result?.session_id,
        value?.result?.session?.id,
        value?.result?.meta?.agentMeta?.sessionId
    ];
    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim()) {
            return candidate;
        }
    }
    return null;
}
