/**
 * Plain-text preview of an agent message for places that show text only
 * (notification popover, email, Slack/webhook bodies). Agents put buttons,
 * charts and widgets in fenced blocks (lib/rich-blocks.ts); quoting those
 * raw shows JSON like `{"question":"…","options":[…]}`. Here each rich
 * block becomes a short readable line, and Markdown noise is trimmed.
 * Pure and total: anything it can't read stays as written.
 */
import { parseChoices } from "@/lib/rich-blocks";

const FENCE_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*([A-Za-z]+)?[^\n]*\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm;

function chartTitle(body: string): string | null {
    try {
        const spec = JSON.parse(body) as { title?: unknown };
        return typeof spec?.title === "string" && spec.title.trim() ? spec.title.trim() : null;
    } catch {
        return null;
    }
}

function blockSummary(language: string, body: string): string | null {
    switch (language) {
        case "choices": {
            const spec = parseChoices(body.trim());
            if (!spec) return "Choose an option in the chat.";
            const options = `Options: ${spec.options.map((o) => o.label).join(" · ")}`;
            return spec.question ? `${spec.question} ${options}` : options;
        }
        case "chart": {
            const title = chartTitle(body);
            return title ? `[Chart: ${title}]` : "[Chart]";
        }
        case "stats":
            return "[Stats]";
        case "tabs":
            return "[Tabbed panel]";
        case "html":
            return "[Interactive widget]";
        default:
            return null;
    }
}

// Previews are a line or two; bounding the input keeps the fence scan linear-ish.
const MAX_PREVIEW_INPUT = 8000;

export function richMessagePreview(text: string | null | undefined): string {
    if (!text) return "";
    let out = text.slice(0, MAX_PREVIEW_INPUT).replace(FENCE_RE, (whole, _fence: string, language: string | undefined, body: string) => {
        const summary = language ? blockSummary(language.toLowerCase(), body) : null;
        return summary === null ? whole : `\n${summary}\n`;
    });
    // A clipped message can end inside an open ```choices fence: drop the raw tail.
    out = out.replace(/^[ \t]*(`{3,}|~{3,})[ \t]*(choices|chart|stats|tabs|html)\b[\s\S]*$/im, (_m, _f, language: string) =>
        `\n${blockSummary(language.toLowerCase(), "") ?? ""}`);
    return out
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{2,}/g, "\n")
        .replace(/\s+/g, " ")
        .trim();
}
