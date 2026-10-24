# Timeline v2: calm by default, detail on demand

The 0.11 Timeline shows the right data but reads as noise: hundreds of thin bars, white event dots on every row and handoff arrows drawn all at once. Paperclip's Work Timeline looks better because it shows less. v2 keeps our data (outcomes, cost, handoffs) and adopts their calm.

## What Paperclip does well (from their screenshots)

| Pattern | What it does | Take it? |
|---|---|---|
| Pill bars | Rounded, ~10 px tall, centred in a tall row, lots of air | Yes |
| Two-colour encoding | Blue = delegated, amber = automation; nothing else competes | Yes, as an option (see "Colour by") |
| Hour-level default view | "Today" reads like a calendar day; bars are wide enough to see | Yes: default to Today, auto-fit to activity |
| Quiet chrome | 4 KPIs with small icons, legend in one line, range controls under the chart | Yes |
| Short tooltip | Title, time range, duration, status | Yes, plus cost |
| No arrows by default | Handoffs are not drawn as spaghetti | Yes: arrows only on focus |
| Role icons per agent | Crown, robot, eye | Later (needs agent role icons) |

## What we keep that they don't have

- Outcome colours (Done / Needs you / Failed / Stopped), cost and tokens per run.
- Handoff arrows, but shown only when you focus a task or agent.
- Busy % per agent.
- Restricted members and private chats respected.

## Design changes

1. **Bars.** Pills (`rx = height / 2`), 10 px tall, rows 44 px. Muted fills at about 70% opacity, full on hover. Running runs use the brand cyan with a slow shimmer; failed runs get a red fill; stopped runs are a grey outline.
2. **Clusters instead of barcodes.** Runs closer than 4 px at the current zoom merge into one cluster pill with a count ("12 runs"). Click or zoom to expand. This removes the barcode look at 7 and 30 days.
3. **Focus mode.** Click a bar to highlight every run of that task across agents and draw only that task's handoff arrows. Everything else dims to 20%. Esc clears. Hovering an agent name does the same for that agent.
4. **Detail panel.** Clicking opens a right-hand panel, not a navigation: task title, project, outcome, start–end, duration, tools, tokens, cost, the agent's last line, and "Open task". The current page stays put.
5. **Markers.** Event dots are hidden by default. A "Show events" toggle draws them as small ticks on the row baseline, not white dots.
6. **Colour by.** A segmented control: Outcome (default), Source (delegated vs automation, like Paperclip), Project (stable hue per project).
7. **Default range.** Default to Today with an hour axis, auto-fitted from the first activity of the day to now plus a small margin. 7 and 30 days use day ticks and clusters.
8. **Layout.**
   - KPI row: Runs, Agents active, Run time, Tokens, Cost, Success rate.
   - One toolbar: range, colour-by and filters on the left; zoom on the right.
   - Minimap with drag handles under the chart.
   - The chart fills the full container width. Today it stops early, which is a bug.
9. **Rows.** Agents with no runs in range are collapsed into "+3 idle agents". Only agents get rows: what people do (assign, approve, add a note) shows as a marker on the receiving agent's row ("Assigned by Priya"). Row hover gets a subtle highlight, and the axis stays sticky.
10. **Phone.** The per-agent list stays, with pills in place of dots.

## Dashboard ideas from Paperclip (separate slice)

- **Agent cards with the current task** ("Live now · NET-28 …", "Working…", "no output for 43 s"). When idle: "Finished 20 m ago · worked for 7 min". Our Right now card has this data, but the dashboard doesn't lead with it.
- **KPI tiles with a second line:** "9 agents enabled · 5 running, 0 paused, 0 errors", "3 tasks in progress · 7 open, 1 blocked", "Month spend · budget", "Pending approvals".
- **14-day charts:** run activity (succeeded / recovered / failed), tasks by status, success rate.
- **Sidebar:** agents with a "1 live" badge.

## Acceptance

- At 7 days on brain.malecu.eu, there is no barcode and no arrows until focus.
- Today is readable at a glance.
- Every existing scope and privacy test still passes.
- Screenshots: before and after, at desktop and phone sizes.
