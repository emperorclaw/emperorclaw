# Native companion design

The phone is a quick way to understand the team and continue its work. Home is
an overview, not an agent profile or a finance dashboard.

## Navigation and layout

Home, Inbox, Messages, Projects and Views are the five destinations. Agent
profiles live in the Home directory; tapping a character opens its conversation.
Connections remains the place to switch among any number of servers/companies.
Each workspace owns its screen identity and authenticated transport.

iOS 18+ uses the system adaptable tab/sidebar navigation. Selection and navigation
are not keyed to screen width, so changing the available space does not reset the
workspace or selected tab. iOS 17 keeps the conventional tab bar. Content reading
width is limited; fleet and View grids reflow using available width. This is the
strategy for small/large phones, landscape, iPad and the two iPhone Duo displays.

## Home density

Each compact tile contains only the web's actual character, its name, a status
label and one truncated activity/task line. No role description, message body,
per-card CTA or financial summaries. The entire tile opens the conversation;
VoiceOver retains the full activity text. Eight agents fit in a 390×620 pt web
surface at standard text size. Larger accessibility text prioritizes legibility
and naturally reduces the column count rather than shrinking text.

Character appearances come from the server's existing avatar configuration,
with deterministic fallback for older servers. Animations indicate actual work;
reduced motion, backgrounding or a failed refresh stop them. Polling is foreground
only. Native errors remain visible above a cached fleet.

## Visual language

System San Francisco fonts, rounded headings, semantic native grouped surfaces,
softly tinted character desks, consistent 12/16/20/24 pt spacing and restrained
rounded corners. Teal is the interaction/working accent; amber marks waiting or
blocked work. Status always has text as well as color. Native navigation owns
transitions and sheets; haptic selection supplements agent selection. Appearance
follows the system or the existing explicit light/dark preference.

Messages uses spacious conversation cards with status and a short activity hint.
Inbox and task rows use rounded icon tiles and clear title/subtitle hierarchy.
Actions, approval confirmations, attachments and existing task controls remain
native. Rich task descriptions, timeline notes, approval rationale and attention
details reuse the web Markdown renderer for block content; short inline notes
remain native. Embedded documents report their complete content height.

## Views and shared content

Views has native search, scope/panel summaries and private-access indicators.
The detail screen bundles the production ViewGrid, including metric, line, bar,
table, list, Markdown and progress panels, their grid sizes and freshness labels.
Metadata-only access renders an explanation and no panel values. Refresh pauses
outside the foreground and overlapping responses cannot overwrite newer reads.

The server exposes only GET views and GET views/:id through the existing mobile
allow-list. The delegated web handlers retain company, module, scope and private
View authorization. No mobile View editing API is added. Servers without this
patch can still use the other destinations; Views requires the new server build.

The offline renderer keeps credentials in native transport, not JavaScript.
Existing chat widgets, choices, Markdown, previews and run activity continue to
use the same shared components and restricted bridge. Watch keeps its native
text fallback and independent instance switching; it does not run web content.

## Validation

2026-11-21: nine mobile WebKit regressions pass, including eight compact agent
tiles, full document height, all seven View panel types at 320/430/850 pt, both
appearances, metadata-only privacy and stopped animations for stale/reduced-motion
states. Fifteen Swift core tests and fourteen real mobile API integration tests
on disposable PostgreSQL pass. The full server static/unit suites also pass.

The signed iPhone/embedded Watch/widget simulator build passes. An authenticated
iPhone 17 Pro preview loads the live Brain fleet. iPhone Duo is listed among the
installed Xcode device types, but creating it with the installed iOS 27.2 runtime
returns “Incompatible device”; folding transitions have therefore not been
validated in that simulator. Physical-device VoiceOver, extreme Dynamic Type,
battery profiling and real folding transitions remain acceptance checks.
