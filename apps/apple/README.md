# EmperorClaw for iPhone and Apple Watch

Native SwiftUI apps for existing, independently hosted EmperorClaw installations. Minimum iOS 17/watchOS 10. SwiftUI keeps phone and watch on one Apple stack; Android is outside this scope.

## Implemented experience

- Five iPhone tabs: Home, Inbox, Messages, Projects and Agents. Dashboard activity, monthly spending, task creation/assignment/status/notes/results, private/team/group conversations, attachments and contextual agent questions.
- Approvals reuse the server's permissions and decision rules. Watch decisions are restricted to short, eligible task-completion approvals; other cases hand off to iPhone.
- Both devices save and switch among multiple installations and companies independently. Rename/favorite connections, select appearance, pause/resume new agent work, disconnect individual devices.
- QR onboarding from web Settings → Profile → Connect iPhone and Apple Watch. QR contains only the server origin; system-browser authentication still requires consent.
- Optional APNs notification enrollment with proof of delivery. Widgets, lock-screen accessories and watch complications pin one workspace and show cached counts with timestamps.

## Run locally

1. Use Node 20+ (22+ for the optional relay), PostgreSQL and an HTTPS EmperorClaw server. Apply migrations using `npm run db:migrate` against the intended development database. Native support requires migrations `0088` and `0089`.
2. Open `EmperorClaw.xcodeproj` in compatible Xcode. Choose EmperorPhone or EmperorWatch. Set your Apple development team and provision the bundle IDs, App Group `group.com.emperorclaw.app` and push capability. The defaults are `com.emperorclaw.app`, its `.watchkitapp` companion and their `.widgets` extensions. If changing identifiers, update generator, callback, entitlements and relay topic consistently.
3. On iPhone, Connections → Add instance. Enter its public HTTPS origin or scan its QR; approve access in the browser. Repeat for additional servers.
4. On a paired watch install the companion. In iPhone Connections choose Send to Apple Watch. Watch receives its own credentials and keeps an independent active selection. Reconnect Apple Watch replaces that instance's remembered watch session.
5. For notifications, configure [the optional relay](../../services/apple-push-relay/README.md), then enable notifications per instance in Connections. Tap the delivered enrollment notification to confirm. Re-enable after APNs token changes if delivery stops.

The watch needs its own route to each server. A phone's VPN does not proxy the watch's requests. HTTP and invalid certificates are rejected. Unavailable servers do not block selection of another saved connection.

## Security and API

Native secrets use device-only Keychain storage. Profile metadata and drafts stay local; widget App Group storage contains workspace names/counts/timestamps, never conversations or tokens. The phone transfers separately issued watch credentials, never its own refresh token. Disconnecting either device revokes that session; web account sessions can revoke both.

`/api/mobile/v1/discovery` is public capability metadata. `/mobile/authorize` uses browser consent and a fixed callback with PKCE. `/token` exchanges single-use five-minute codes or rotates refresh tokens; access tokens last 15 minutes, account sessions at most 30 days. Authenticated routes provide `/companies`, `/companies/{id}/snapshot`, allow-listed `/companies/{id}/work/*`, `/watch`, `/push` and `/session`. Browser cookies and MCP tokens are not mobile credentials.

Work routes reuse existing role, company, agent and private-chat checks. Mutations require an Idempotency-Key claimed before execution. An ambiguous outcome is acknowledged rather than blindly repeated. Switching workspaces cannot redirect an in-flight request or display its result in another workspace. Transport refuses redirects/cookies. Attachments are limited to 25 MB. Foreground polling pauses with inactive views; widgets depend on system refresh and cached data, not a permanent background connection.

## Source and verification

`Sources/EmperorCore` contains transport/models/security; `Shared` contains workflows, connection state, push and Watch Connectivity; `iPhone`, `Watch`, `Widgets` contain platform entry points. Regenerate the dependency-free project after adding sources:

```sh
python3 apps/apple/scripts/generate-project.py
swift test --package-path apps/apple
bash apps/apple/scripts/typecheck.sh
xcodebuild -project apps/apple/EmperorClaw.xcodeproj -scheme EmperorPhone -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project apps/apple/EmperorClaw.xcodeproj -scheme EmperorWatch -destination 'generic/platform=watchOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

Validation on 2026-11-21: 10 shared Swift tests, both app and widget SDK typechecks, 12 mobile integration tests against a new temporary PostgreSQL cluster with all migrations, focused server/relay tests, TypeScript and focused ESLint. The temporary database was removed; customer databases were not used.

## Release gates

Full linked builds and interactive validation remain pending. Local Xcode fails loading IDESimulatorFoundation because its DVTDownloads system framework is incompatible; `xcodebuild -runFirstLaunch` requires administrator authorization to install components. No compatible simulator runtime is available. Direct SDK typechecking passes but does not validate packaging, embedding, provisioning or runtime behavior.

Before release: repair Xcode/install runtimes; test authentication, three or more VPS connections, offline/retry/revocation, phone/watch handoff and real APNs on devices; validate small screens, Dynamic Type, VoiceOver, reduced motion and battery/network use; finish app icons, localization, App Store metadata/privacy disclosures and signing. The included privacy manifest declares UserDefaults usage for the app and App Group; publisher privacy disclosures still require review. No app, relay or server changes have been deployed or published.
