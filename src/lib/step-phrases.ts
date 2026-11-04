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

/** Tool name families, checked in order against the normalized tool name. */
const TOOL_VERBS: readonly { test: RegExp; verb: string }[] = [
    { test: /^(web ?search|search ?web|google|bing|serp|search engine|tavily|exa|brave search|perplexity)/, verb: "Searching the web" },
    { test: /(browser|navigate|web ?fetch|fetch url|scrape|crawl|http|curl|open url|visit)/, verb: "Browsing the web" },
    { test: /^(terminal|shell|bash|zsh|sh|exec|execute|run command|command|process|powershell|cmd)\b/, verb: "Using terminal" },
    { test: /(grep|search files|find files|glob|ripgrep|rg)\b/, verb: "Searching files" },
    { test: /^(read|view|cat|open file|file read|read file|list dir|ls|list files|get file)/, verb: "Reading" },
    { test: /^(write|edit|patch|apply patch|str replace|create file|file write|file edit|replace)/, verb: "Editing" },
    { test: /(send message|post message|reply|notify|slack|email|telegram|discord)/, verb: "Sending a message" },
    { test: /(delegate|subagent|spawn agent|task agent)/, verb: "Delegating" },
    { test: /(memory|remember|recall|knowledge|notes?)\b/, verb: "Checking notes" },
    { test: /(todo|plan|checklist)/, verb: "Planning" },
];

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
    for (const { test, verb } of TOOL_VERBS) if (test.test(name)) return verb;
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
