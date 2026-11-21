# EmperorClaw Apple apps

Initial development milestone: native iPhone/watchOS projects, independently saved server connections, browser sign-in with PKCE, Keychain credentials, company selection and a read-only agent snapshot. This is a development foundation, not the complete mobile release.

SwiftUI is used for both apps to share one Apple technology stack. Expo was considered; the user preferred whatever simplifies the implementation. Android is outside the current scope.

## Run locally

Requirements: a compatible Xcode installation with iOS/watchOS SDKs, Node 20+, PostgreSQL for server integration tests, and an HTTPS-accessible EmperorClaw development server. This milestone intentionally rejects plain HTTP and invalid certificates. A physical watch must independently reach the server; the phone's VPN is not a watch network proxy.

1. Apply the server migration using the existing `npm run db:migrate` workflow **on your chosen development database**. Migration `0088_mobile-sessions` adds the native-session tables; existing account-session revocation cascades to mobile credentials. Do not run destructive integration fixtures on a working installation.
2. Start the EmperorClaw server with its normal browser login configured. Configure a correct public HTTPS origin through the normal server/reverse-proxy setup. Preserve server-action origin validation behind the proxy.
3. Open `EmperorClaw.xcodeproj`. Select `EmperorPhone` or `EmperorWatch` and a compatible simulator/device. For physical devices, set your development team and signing configuration. The initial bundle IDs are `com.emperorclaw.app` and `com.emperorclaw.app.watchkitapp`.
4. On iPhone, use Connections → Add instance, enter an HTTPS origin and optional name, and approve access in the system browser. Repeat for three or more instances. Home and Agents display the active company's authorized snapshot.
5. Install the companion watch app on a paired watch. On iPhone choose Connections → Send to Apple Watch. Open the watch app to finish receiving credentials. Both devices select their active server/company independently. Sending connections again preserves refresh tokens already rotated on the watch.

The watch enrollment payload contains only separately issued watch credentials and profile metadata. The phone never sends its own access/refresh token to the watch. Profile metadata is saved locally; secrets are stored in the app's Keychain sandbox with device-only protection. Do not log token responses or enrollment payloads.

Disconnecting the phone revokes its own session only; the watch has an independent account session. Existing web Settings → profile/account sessions lists both devices and can revoke them individually or together. Use Reconnect Apple Watch on an instance to replace a revoked/expired enrollment or move to another paired watch; this replaces the remembered watch session for that instance. Revoke a lost watch immediately in the web account sessions list.

## Project structure

- `Sources/EmperorCore`: shared transport, models, URL validation, PKCE and Keychain storage.
- `Shared`: fleet UI, connection selector, app state and Watch Connectivity enrollment.
- `iPhone` and `Watch`: platform app entry points and iPhone sign-in.
- `Tests/EmperorCoreTests`: connection validation, callback binding, instance isolation and refresh concurrency.
- `scripts/generate-project.py`: deterministic Xcode project/plist/scheme generation, with no third-party generator dependency. Run after adding application source files. Signing customization should be kept in local Xcode settings or added deliberately to the generator.

## Verification

```sh
swift test --package-path apps/apple
python3 apps/apple/scripts/generate-project.py
xcodebuild -project apps/apple/EmperorClaw.xcodeproj -scheme EmperorPhone \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project apps/apple/EmperorClaw.xcodeproj -scheme EmperorWatch \
  -destination 'generic/platform=watchOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

For a compiler-only fallback, run `bash apps/apple/scripts/typecheck.sh`. This checks both platform source sets and the shared module, but does not link/package an app, validate embedded watch installation or replace UI/device tests.

The first local Xcode build was blocked by an installed-framework mismatch: `IDESimulatorFoundation` could not load a symbol from `DVTDownloads`. The code was checked directly with both platform SDKs instead. Repair/update the local Xcode system components before simulator and physical-device validation; no system-toolchain files were modified by this work.

Initial validation record (2026-11-21):

| Check | Result |
| --- | --- |
| Shared Swift tests | 8 passed, including cross-origin credential isolation, refresh concurrency and stale-refresh identity replacement |
| iPhone and watchOS SDK typechecks | Both passed |
| Server integration tests | 8 passed against a new temporary PostgreSQL cluster; all migrations applied there successfully |
| Focused TypeScript unit tests | 7 passed (mobile validation, login return destination, existing OAuth redirects) |
| Existing static tests | 174 passed |
| TypeScript application typecheck and focused ESLint | Passed |
| Xcode project and Info.plist syntax | Passed |
| Full Xcode build and interactive UI/device tests | Pending because of the local Xcode framework mismatch |

Temporary PostgreSQL was stopped and removed after testing. No existing database was used for the destructive test fixtures.

## Mobile API v1

All `/api/mobile/v1/*` responses are uncached. Except discovery and token exchange, routes require a native `Bearer ema_…` access token. Browser cookies and MCP tokens are not accepted as mobile credentials.

| Route | Behavior |
| --- | --- |
| `GET /api/mobile/v1/discovery` | Product/API version, persistent installation UUID, fixed callback, implemented capabilities; no company/account metadata |
| `/mobile/authorize` | Browser-session-protected consent page; server action validates origin and fixed callback |
| `POST /api/mobile/v1/token` | JSON `grantType: authorization_code`, `code`, `verifier`, or `grantType: refresh_token`, `refreshToken` |
| `GET /api/mobile/v1/companies` | Current authorized company list and roles |
| `GET /api/mobile/v1/companies/{companyId}/snapshot` | Scoped agent identity/activity using existing visibility and private-thread redaction services |
| `POST /api/mobile/v1/watch` | Phone-only authorization of a distinct watch account session |
| `DELETE /api/mobile/v1/session` | Revoke the presenting device's account session and credentials |

Token responses contain `accessToken`, `refreshToken`, `expiresIn` (seconds) and `deviceId`. Codes expire after five minutes and are consumed atomically. Access tokens expire after 15 minutes; refresh tokens rotate with a fixed account-session maximum of 30 days. Only hashes are stored server-side. Session deletion, account deletion and membership/scope changes are checked through the existing account and permission systems. The mobile API does not widen the existing MCP callback allow-list.

The native transport refuses redirects and sends no browser cookies. Every request captures its server/company context; changing selection cannot redirect an in-flight action to another VPS. An unavailable instance does not prevent selecting another. Cached snapshots are in memory and labeled stale after connection failures. Refresh on foreground/pull; continuous event updates are a later milestone.

## Remaining milestones

The full product plan is in `docs/roadmap/apple-apps-plan.md`. Next: validate the connection flow end to end on devices, improve connection removal synchronization, then implement contextual chat, inbox/approvals, tasks/results and permitted agent controls. Add the final five-tab navigation as these workflows become real. QR onboarding, relay/APNs, complications/Smart Stack, advanced freshness rules, client-side account switching within one server and production accessibility/visual QA remain pending. No push delivery, deployment or App Store release has been performed.
