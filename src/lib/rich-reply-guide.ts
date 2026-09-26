import { RICH_BLOCKS_CAPABILITY } from "@/lib/rich-blocks";

/**
 * The agent-facing contract for rich replies, served to runtimes by THIS
 * server so the instructions an agent follows always match the renderer that
 * will draw its reply. A bridge talking to an older server never receives it
 * and keeps writing plain Markdown; an older bridge simply ignores it.
 *
 * It is injected into every turn, so every line has to earn its tokens.
 * Keep it in sync with src/lib/rich-blocks.ts (parsers) and the renderers in
 * src/components/rich/.
 */
export const RICH_REPLY_GUIDE = `## Rich replies

Your reply is rendered in Emperor Claw's web chat, not a terminal. GitHub Markdown renders fully: headings, **bold**, lists, tables, code, links, and callouts (\`> [!NOTE]\`, \`> [!TIP]\`, \`> [!WARNING]\`). When an answer involves numbers, status, comparisons, or trends, show it visually: a visual reply beats a paragraph. Lead with a one-line takeaway in prose; visuals support the answer, they don't replace it. Quick conversational answers stay plain text.

Four fenced blocks render as UI. Use real data only, never invented numbers; with no data, don't chart.

1. KPI tiles:
\`\`\`stats
[{"label":"Open tasks","value":"12","delta":"+3","hint":"since Monday"},{"label":"Budget used","value":"$18","progress":36},{"label":"Error rate","value":"0.4%","delta":"-0.2","good":"down","spark":[0.9,0.7,0.6,0.4]}]
\`\`\`
label and value are required. Optional: delta ("+12%", "-3"), good:"down" when lower is better, hint, progress (0-100), spark (list of numbers).

2. Charts:
\`\`\`chart
{"type":"bar","title":"Tasks closed","labels":["Mon","Tue","Wed"],"series":[{"name":"Ada","data":[3,5,2]},{"name":"Rex","data":[1,4,3]}]}
\`\`\`
type is bar, line, area, pie, or donut. Options: "stacked":true, "horizontal":true (bar; best for rankings and long names), "prefix":"$", "unit":"%", "subtitle". Pie/donut take one series, or "data":[{"label":"A","value":3}]. Use line/area for time, bar to compare, donut for share of a whole (7 slices at most).

3. Tabs, for long or multi-part answers:
\`\`\`\`tabs
=== Summary
Markdown…
=== Details
| Task | Owner |
|---|---|
\`\`\`\`
Each \`=== Label\` line starts a tab. Tab bodies are full Markdown and can hold stats and chart blocks. When the tabs block contains other fenced blocks, open and close it with FOUR backticks.

4. Interactive widget: sandboxed HTML/CSS/JS for what the blocks above can't do (a custom board, timeline, calculator, SVG diagram):
\`\`\`html
<!-- title: Agent load -->
<style>.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px}</style>
<div class="card">Ada · 64% load <button data-emperor-send="Show Ada's open tasks">Details</button></div>
\`\`\`
It must be self-contained: inline <style>, <script>, and SVG only. External scripts, fetch, and all network access are blocked. Theme colors are CSS variables: --foreground, --muted-foreground, --card, --border, --primary, --accent, --muted, --destructive, --chart-1 to --chart-5. Use them and leave the background transparent so the widget fits light and dark mode. The frame sizes itself to your content. data-emperor-send="prompt" on a clickable element (or emperor.send("prompt") in script) sends that prompt to you as the operator when clicked; answer it like any message. Prefer stats, chart, and tabs when they fit: they render natively.

Keep tables to about 20 rows (summarize the rest) and use one or two visuals per reply unless asked for more. In team chat, other agents read your message as text, so state the key facts in prose too.`;

export const SERVER_CAPABILITIES = [RICH_BLOCKS_CAPABILITY] as const;
