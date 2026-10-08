/** A small readable label, never raw Markdown, rich blocks, or attachment URLs. */
export function queuePromptPreview(raw: string): string {
    const sample = raw.slice(0, 4096);
    const audio = /\[audio:[^\]]+\]/.test(sample);
    const text = sample
        .replace(/\[audio:[^\]]+\]/g, " ")
        .replace(/```[\s\S]*?(?:```|$)/g, " ")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
        .replace(/[`*_~\u0000-\u001f]/g, " ")
        .replace(/\s+/g, " ").trim();
    if (!text) return audio ? "Voice message" : sample.includes("```") ? "Code or structured content" : "Attachment";
    const characters = Array.from(text);
    return characters.length > 140 ? characters.slice(0, 139).join("").trimEnd() + "…" : text;
}
