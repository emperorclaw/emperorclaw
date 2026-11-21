# Apple validation record — 2026-11-21

## Passed

- Installed Xcode first-launch system components successfully, resolving the DVTDownloads/IDESimulatorFoundation incompatibility.
- Full Debug build for generic iOS Simulator: EmperorPhone, embedded EmperorWatch, PhoneWidgets and WatchWidgets. Both simulator architectures compiled and linked.
- Unsigned Release build for generic physical iOS, including watchOS and both widgets. This validates compilation/packaging, not provisioning or installation on physical devices.
- Installed and launched the phone app on iPhone 17 Pro / iOS 27.2 and watch app on Series 11 42 mm / watchOS 27.2. Reviewed rendered onboarding screens. Paired the two simulators.
- Fixed missing widget CFBundleName caught by simulator installation, the watch connections button's invisible glyph and a universal orientation build warning.
- Earlier automated checks remain recorded in the app README: Swift core, SDK typechecks, temporary-PostgreSQL integration, relay/server unit tests, static suite, TypeScript and ESLint.

## Evidence

| iPhone onboarding | Watch onboarding |
| --- | --- |
| ![iPhone onboarding](iphone-onboarding.png) | ![Watch onboarding](watch-onboarding.png) |

Reproduce builds with the commands in the parent README. Existing artifacts for this development session are under `/tmp/emperor-apple-derived` (Debug simulator) and `/tmp/emperor-apple-release` (unsigned Release); these temporary files are not deliverable release binaries.

## Still required

The initial startup record was followed by an ad hoc signed simulator build and authenticated testing against the user’s HTTPS instance. OAuth consent completed, a real agent conversation loaded, and the user’s test message was acknowledged by the server. After terminating and relaunching the app, the saved connection loaded the authorized company and live fleet again without another login, verifying Keychain persistence. The unsigned build’s Keychain -34018 failure was resolved by enabling simulator signing. Physical-device testing and real APNs delivery remain pending. Xcode 27 hosts simulator interaction in `Contents/Applications/DeviceHub.app` (Device Hub), which is accessible through the visual controller. Use ad hoc signing for simulator testing: `CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-`. An unsigned build reached the OAuth callback but failed to save credentials with Keychain error -34018; rebuilding with signing creates the required application-identifier entitlements.

Before distribution, broaden validation of refresh/revocation against a development HTTPS server; at least three installations and two companies; scoped/private chat, tasks, attachments and approval races; phone/watch credential handoff and independent selection; offline retries and deep links; APNs enrollment/delivery/token rotation; configurable widgets; accessibility, localization, screen sizes and battery/network behavior. Configure signing/App Groups/APNs, final app icons, App Store metadata and privacy disclosures. No production database, VPS or Apple distribution account was changed.

## Chat corrections

The iPhone transcript now bundles the web's actual Markdown/rich renderer. A
signed simulator installation connected to `brain.malecu.eu` opened Builder's
existing conversation at its newest reply; its Markdown table, inline code,
formatted paragraphs and worked/tools/token/model footer rendered correctly.
No test prompt was sent and no agent work was started during this check.

Automated validation: 15 Swift core tests; 13 mobile integration tests against a
fresh disposable PostgreSQL database (including cross-company entity isolation,
private reasoning and redacted private run timelines); 40 focused chat/rich/mobile
unit tests; six mobile WebKit regressions for long-history initial position,
reader/pagination anchoring, partial-to-final replacement, real rich components,
choice/widget actions, live activity and lazy native resource loading. TypeScript,
focused ESLint and a signed full iPhone/embedded Watch/widget build pass.

See `ChatWeb/README.md` for the restricted native bridge, bundle regeneration and
server streaming prerequisites. The authenticated Brain preview response reported `streaming=false`; live partial
token delivery therefore remains disabled on this deployment. Test fixtures
prove client rendering; enabling the existing server rollout flag and checking
a compatible runtime are still required to verify real partial delivery.

## Compact dashboard and Views redesign

The signed iPhone 17 Pro simulator is connected to the existing Brain session.
Visual inspection confirms all eight real agents are visible together, in four
compact rows: character, name, status and one activity line. Role descriptions,
large introduction text and per-card action footers were removed after review.
The directory and conversations retain the detailed workflows.

The shared bundle passes nine WebKit tests, including eight fully visible tiles
in a 390×620 pt surface, both appearances, reduced motion/stale data, rich task
documents and all seven View panel types across narrow/wide sizes. The server
suite passes 1,274 unit tests plus its static suite; fourteen disposable-database
mobile integration tests and fifteen Swift core tests pass. TypeScript and
focused ESLint pass. The signed phone/embedded Watch/widget build passes.

The mobile Views read endpoints and avatar fields are committed separately from
the native redesign. They still need deployment to an instance before its Views
can be opened in this build. The installed Brain server remains v0.42.1 at this
point. No new server release was published as part of the visual review.

Xcode lists an iPhone Duo device type, but the installed iOS 27.2 runtime refuses
to create it with “Incompatible device.” Responsive content was checked in
WebKit; a real folding transition and physical-device accessibility remain
unverified. See [the design record](../Design/native-redesign.md).
