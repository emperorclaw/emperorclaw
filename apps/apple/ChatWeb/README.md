# Shared iPhone chat transcript

The iPhone keeps its SwiftUI navigation, composer, secure transport and attachment
viewer. One local WKWebView renders the transcript using the production web
MarkdownRenderer, StreamingMarkdown, rich blocks, reasoning disclosure and run
steps/footer. This is an offline bundle, not a remotely hosted page or a second
login. Watch uses a native text/activity fallback because watchOS has no WKWebView.

Run `npm run build:apple-chat` after changing shared components, translations or
styles. Generated files in `../iPhone/ChatWeb` are committed so Xcode builds do not
need Node or network access. CI checks that the bundle matches the sources.
`npm run test:apple-chat` runs mobile WebKit regressions; install its browser with
`npx playwright install webkit` first. Browser tests use fictional content and a
local static server, without a customer account or database.

The native bridge accepts only main-frame messages from the bundled document.
It never shares credentials with JavaScript. Read capabilities are limited to
entity summaries, one message's saved reasoning and one run's events; each calls
an explicit mobile endpoint with the current installation/company and the web's
existing authorization checks. Links open through native HTTPS navigation;
attachment IDs must belong to a loaded message. Choices and widget actions use
the ordinary idempotent native send, respect read-only access and preserve any
existing draft. A fresh WebView on conversation/workspace changes isolates the
web renderer's entity cache and outstanding requests.

Widgets retain the web's opaque-origin `sandbox="allow-scripts"` (no same-origin,
popups or forms), their own first-position CSP, token/source checks and user
activation requirement. The parent permits inline scripts for the sandbox's
inline bridge; agent HTML is only inserted inside that sandbox. The transcript
has no network fetch capability: component reads are mapped to the restricted
native bridge, and CSP blocks connections. HTTPS images remain supported as in
the web. Partial replies deliberately disable widgets, actions and images until
the durable reply arrives.

The initial page always starts at the latest message, independently of
`hasMore`. Resize following stops when the reader scrolls up or selects text;
pagination preserves the visible row's position. “Latest message” or a successful
send resumes following. Preview revisions cannot move backwards or restart
terminal segments, and a final message replaces its preview with the same row
key. Conversation changes and cancelled requests cannot populate another chat.

Rich read endpoints require the server patch containing `chat/reasoning`,
`entities` and `runs/:id/events` in the mobile work allow-list. Actual partial
replies also require the server's existing `EMPEROR_CHAT_STREAMING=1` rollout
configuration and a compatible Hermes bridge (0.39.0+). The app does not simulate
partial output or change the server's streaming rollout policy.


The same local bundle also hosts compact fleet characters, embedded rich documents
and the production ViewGrid. `mode` selects the surface. Fleet taps are validated
against the supplied roster before opening native chat; embedded documents can
only report a bounded finite height. View data is fetched by native transport,
with metadata-only access explicitly suppressing panels. Reduce Motion and native
Dynamic Type preferences accompany surface payloads. No credentials or arbitrary
URL fetch capability are added by these surfaces.
