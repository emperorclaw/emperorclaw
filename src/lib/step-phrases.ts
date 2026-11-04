/**
 * Pure: an agent's current run step as a person would narrate it ("Using
 * terminal: npm test", "Searching the web: desk lamps", "Thinking: ..."),
 * for desk screens (GET /api/mcp/live `step`) and any surface that wants the
 * same words. Input is the step's generic label (publicActivityLine, or a
 * fixed generic line such as "Writing the reply") and its optional detail;
 * output stays generic in `label` and never adds words the step did not
 * carry: only the tool name is turned into a verb. ASCII only.
 *
 * Displayed as `label` alone, or `label: text`.
 */

export interface HumanStep {
    label: string;
    text?: string;
}

/**
 * Tool name families, checked in order. A family matches only when one of its
 * phrases appears as whole words in the normalized tool name ("read file" in
 * "read file", "browser" in "browser navigate"), so "catalog", "lsp",
 * "process invoice" or "example x" never borrow a verb; anything unsure falls
 * back to the generic "Using <tool>".
 */
const TOOL_VERBS: readonly { phrases: readonly string[]; verb: string }[] = [
    { phrases: ["web search", "websearch", "search web", "google search", "bing search", "brave search", "tavily search", "exa search", "serp", "perplexity"], verb: "Searching the web" },
    { phrases: ["browser", "browse", "navigate", "web fetch", "webfetch", "fetch url", "open url", "scrape", "crawl", "http request", "curl"], verb: "Browsing the web" },
    { phrases: ["terminal", "shell", "bash", "zsh", "powershell", "exec", "execute command", "run command", "run shell", "command line"], verb: "Using terminal" },
    { phrases: ["grep", "ripgrep", "glob", "search files", "find files", "file search"], verb: "Searching files" },
    { phrases: ["read", "read file", "file read", "view file", "open file", "get file", "cat", "list dir", "list directory", "list files", "ls"], verb: "Reading" },
    { phrases: ["write", "write file", "file write", "edit", "edit file", "file edit", "patch", "apply patch", "str replace", "create file", "multi edit"], verb: "Editing" },
    { phrases: ["send message", "post message", "send email", "send slack message", "send telegram", "notify"], verb: "Sending a message" },
    { phrases: ["delegate", "delegate task", "subagent", "spawn agent"], verb: "Delegating" },
    { phrases: ["memory", "remember", "recall", "knowledge", "search knowledge", "notes"], verb: "Checking notes" },
    { phrases: ["todo", "todo write", "todos", "update plan", "checklist"], verb: "Planning" },
];

/** Whether `phrase` appears in `name` as whole words. */
function hasPhrase(name: string, phrase: string): boolean {
    return ` ${name} `.includes(` ${phrase} `);
}

const LABEL_MAX = 26;

/** "mcp__github__create_issue" -> "github create issue"; "functions.web_search" -> "web search". */
export function prettyToolName(tool: string): string {
    return tool
        .replace(/^mcp__/i, "")
        .replace(/^functions\./i, "")
        .replace(/__/g, " ")
        .replace(/[_\-.]+/g, " ")
        .replace(/[^\x20-\x7E]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

/** The narrating verb for a tool ("Using terminal"), or "Using <tool>" for an unknown one. */
export function toolVerb(tool: string): string {
    const name = prettyToolName(tool);
    for (const { phrases, verb } of TOOL_VERBS) if (phrases.some((p) => hasPhrase(name, p))) return verb;
    return name ? `Using ${name}` : "Using a tool";
}

function cap(value: string, max = LABEL_MAX): string {
    return value.length <= max ? value : `${value.slice(0, max - 3).trimEnd()}...`;
}

/**
 * Narrate one step. `label` is the generic step label already stripped of a
 * trailing ellipsis ("Running terminal", "Preparing web_search", "terminal
 * done", "Thinking", "Writing the reply", "Delegating"); `text` is the
 * detail the screen may show, if any.
 */
export function humanStep(label: string, text?: string): HumanStep {
    const detail = text?.trim() || undefined;
    const withText = (l: string): HumanStep => (detail ? { label: cap(l), text: detail } : { label: cap(l) });
    let m: RegExpMatchArray | null;
    if ((m = label.match(/^Running (.+)$/))) return withText(toolVerb(m[1]));
    if ((m = label.match(/^Preparing (.+)$/))) return withText(`Getting ${prettyToolName(m[1]) || "a tool"} ready`);
    if ((m = label.match(/^(.+) done$/)) && label !== "Done") return withText(`Done with ${prettyToolName(m[1]) || "a tool"}`);
    if ((m = label.match(/^(.+) failed$/)) && label !== "Failed") {
        const name = prettyToolName(m[1]) || "a tool";
        return withText(`${name.charAt(0).toUpperCase()}${name.slice(1)} failed`);
    }
    if (label === "Delegating" && detail) {
        const whole = `Delegating to ${detail}`;
        return whole.length <= LABEL_MAX ? { label: whole } : { label: "Delegating", text: detail };
    }
    return withText(label);
}
