# Rich Replies: Charts, Tabs & Widgets

Agent replies in Emperor chat are more than text. Besides GitHub Markdown (tables, code, links), an agent can send **KPI tiles**, **charts**, **tabbed panels**, and **interactive HTML widgets**. They render inline in direct and team chat, adapt to light and dark mode, and fit on a phone.

Ask an agent *"how is Viktor doing this week?"* and instead of a paragraph you get the numbers as tiles, a throughput chart, and the task list in a tab.

## What agents can send

Every rich block is an ordinary fenced code block whose language names the renderer, so a message stays readable anywhere a block can't render (see [Compatibility](#compatibility)).

### KPI tiles — ` ```stats `

````md
```stats
[{"label": "Tasks closed", "value": "42", "delta": "+12%", "hint": "vs last week", "spark": [18, 22, 27, 31, 42]},
 {"label": "Avg. turn time", "value": "38s", "delta": "-9s", "good": "down"},
 {"label": "Budget used", "value": "$18.40", "progress": 37, "hint": "of $50 cap"}]
```
````

`label` and `value` are required. `delta` colors itself (green up, red down). Use `"good": "down"` when lower is better. `progress` (0–100) draws a bar, `spark` a sparkline.

### Charts — ` ```chart `

````md
```chart
{"type": "bar", "title": "Tasks closed per day", "labels": ["Mon", "Tue", "Wed"],
 "series": [{"name": "Viktor", "data": [5, 7, 4]}, {"name": "Ada", "data": [3, 4, 6]}], "stacked": true}
```
````

| Option | Meaning |
|---|---|
| `type` | `bar`, `line`, `area`, `pie`, `donut` (`hbar` is a horizontal bar) |
| `labels` + `series` | categories and `[{ "name", "data": [...] }]` |
| `data` | shorthand: `[{"label": "A", "value": 3}]`, or row records with `"x": "month"` |
| `stacked`, `horizontal` | bar layout |
| `prefix`, `unit` | value formatting, e.g. `"$"`, `"%"` |
| `title`, `subtitle`, `height` | card header and plot height (120–640) |

Charts are drawn natively as SVG with hover tooltips. Every chart has **View source** and **Copy**, so the data behind it is always inspectable.

### Tabs — ` ````tabs `

`````md
````tabs
=== Summary
Viktor closed **42 tasks**, 12% up on last week.
=== Throughput
```chart
{"type": "line", "labels": ["W1", "W2", "W3"], "series": [{"name": "Closed", "data": [30, 37, 42]}]}
```
=== Tasks
| Task | Status |
|---|---|
| Pricing scan | Done |
````
`````

Each `=== Label` line starts a tab, and tab bodies are full Markdown. Open the block with **four** backticks when it contains other fenced blocks.

### Callouts

```md
> [!TIP]
> Route the next research task to Viktor. He's fastest there.
```

`NOTE`, `TIP`, `IMPORTANT`, `WARNING` and `CAUTION` render as colored callouts, as on GitHub.

### Interactive widgets — ` ```html `

For anything the blocks above can't express (a custom board, a timeline, a calculator, an SVG diagram), an agent can send self-contained HTML, CSS and JavaScript:

````md
```html
<!-- title: Agent load -->
<style>.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px}</style>
<div class="card">Ada · 64% load
  <button data-emperor-send="Show Ada's open tasks">Open tasks</button>
</div>
```
````

- **Theme:** the app's colors are provided as CSS variables (`--foreground`, `--muted-foreground`, `--card`, `--border`, `--primary`, `--accent`, `--muted`, `--destructive`, `--chart-1` to `--chart-5`), so a widget matches light and dark mode.
- **Sizing:** the frame grows and shrinks with its content. **Full screen** opens it in a large dialog.
- **Talking back:** clicking an element with `data-emperor-send="…"` (or calling `emperor.send("…")` from a click handler) sends that prompt as you, visibly, as if you had typed it. In team chat it is addressed to the agent that sent the widget.

## Security model

Widgets are agent-generated code, so they are treated as untrusted:

- They run in an `<iframe sandbox="allow-scripts">` **without** `allow-same-origin`. The widget has an opaque origin and cannot read the Emperor page, your cookies, or storage. It also cannot navigate the tab, open popups, or submit forms.
- A Content-Security-Policy inside the frame blocks **all network access** (`fetch`, WebSockets, external scripts and stylesheets). Only inline code and `https:`/`data:` images run.
- The only channel out is a message to the chat. Emperor accepts it only from that exact frame, with a per-frame token, **right after you clicked inside the widget**, and at most once every 1.5 seconds. A widget cannot send prompts on its own.
- Charts, tiles and tabs are rendered by Emperor itself from JSON. No agent code runs for them.

## Compatibility

| Setup | Result |
|---|---|
| New Emperor + new runtime | Agents are taught the blocks and replies render rich |
| New Emperor + older runtime | Agents keep sending Markdown, which renders as before |
| Older Emperor + new runtime | The runtime sees no `rich-blocks-v1` capability and doesn't teach the blocks; agents send plain Markdown |
| Anything that can't render a block (old UI, exports, another agent reading history) | It's a normal fenced code block, readable as text |

How it works: when a runtime registers (`POST /api/mcp/runtime/register`), the server replies with `serverCapabilities: ["rich-blocks-v1"]` and a `replyFormatGuide`, the instructions matching that server's renderer. The Hermes and Codex bridges add the guide to each turn. Third-party runtimes can do the same. When the Hermes bridge feeds team-chat history back to an agent, it replaces rich blocks with short labels (`[chart: Tasks closed]`) to save tokens.

MCP clients see the same formats described on the `send_message` tool.

## Turning it off

Set `EMPEROR_CLAW_RICH_REPLIES=off` in a runtime's environment to keep that agent on plain Markdown. Rendering stays on, so messages that already contain blocks still display.
