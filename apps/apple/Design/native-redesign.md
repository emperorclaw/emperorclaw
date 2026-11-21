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

## Brand and design system (2026-11-21)

`Shared/DesignSystem.swift` is the shared vocabulary for iPhone and Watch, following the
iOS design-agent audit pillars. Typography uses SF design axes only: `.rounded` heavy large
titles (set globally on the navigation bar), rounded names/headlines/numbers, small-caps `SectionLabel`s for structure and `.monospacedDigit()` for
live counts. Colour carries meaning only: teal = interactive/working, orange = decide,
red = blocked, green = done/clear, indigo = review. `TaskStateStyle`, `StatusPill`,
`AgentMonogram` (stable per-agent hue + status badge) and `SoftDivider` replace ad-hoc styling.

`Assets.xcassets` holds the crown app icon (light/dark), the `Emblem` and `Mascot` artwork from
the web branding, a brand-dark launch screen and an adaptive `AccentColor`
(#006A8C light, #5ED6F5 dark/watch: 5.5:1+ and 8:1+). The previous teal measured 2.8:1 on
dark glass controls. Home leads with a "Needs you" card (web attention rules) that also drives
the Inbox tab badge and the widget's `needsYou` count. Watch home (`Watch/WatchHome.swift`) is a
carousel: crown + company + working gauge, one needs-you tile, team rows and quick actions.
DEBUG-only `--qa-team` / `--qa-agent` launch arguments open below-the-fold Watch screens for
simulator capture, since watch simulators accept no injected touches here.

Motion uses SwiftUI-equivalent springs in the chat renderer (`.smooth` bounce 0, `.snappy` bounce .15),
generated as CSS `linear()` curves with bézier fallbacks for iOS 17.0–17.1; new rows rise, scale and
un-blur in, the live row springs open and collapses after fading, and Reduce Motion stops all of it.
The composer (`iPhone/ChatComposer.swift`) accepts pasted images (custom UITextView), Photos and Files
via a + menu, shows an upload tray with progress, and records AAC voice notes iMessage-style (mic
replaces send when empty; recording bar with timer and levels). Audio setup runs off the main thread
with a 5 s timeout so a stalled input can never freeze the UI. Attachments render as typed chips.

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


## Views refinement — editorial collection

The collection now promotes one accessible pinned View (otherwise the first
accessible View), then shows the remaining collection in an adaptive native grid.
All/Pinned/Projects filters and scope/title search operate on the current server
response. Cards show the actual key metric when available, its label, scope,
maintainer and last panel update. No synthetic chart thumbnail, fabricated metric
or “live” claim is used. Metadata-only cards suppress content fields locally too.

The visual direction uses a serif editorial heading, rounded data typography,
neutral grouped surfaces, restrained teal illumination and thin separators.
The detail reader applies the same framing around all seven production panel
renderers. Each panel can open in an accessible focus dialog, including long
lists/tables; closing restores keyboard focus and revoked access removes any
expanded content immediately. Gallery-to-detail zoom is native on iOS 18+ and
falls back to regular navigation with Reduce Motion or iOS 17.

Debug builds have an explicit `--views-design-preview` launch option containing
fictional sample data, labeled as such in both collection and detail. This mode
does not read or write View data on a server. `--views-design-dark` additionally
sets a temporary dark appearance without changing saved user preferences. Both
flags and fixtures are excluded from Release builds. Normal launches continue
to use the real selected instance, which still requires the mobile Views patch.

Validation: ten mobile WebKit tests pass, including all panel types in both
appearances, narrow/wide widths, modal keyboard/dismissal/focus restoration and
access revocation. Forty-seven View contract/access/translation tests pass;
TypeScript, focused ESLint and the signed phone/Watch/widget build pass. Native
collection and detail were visually inspected with labeled sample data.
