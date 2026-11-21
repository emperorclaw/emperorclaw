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

This is a startup check, not end-to-end acceptance. No signed build, physical-device test, authenticated real-VPS session or real APNs delivery was performed. This Xcode distribution contains SDK/command-line tooling but no Simulator GUI app for interactive review through the available visual controller.

Before distribution, validate browser consent/refresh/revocation against a development HTTPS server; at least three installations and two companies; scoped/private chat, tasks, attachments and approval races; phone/watch credential handoff and independent selection; offline retries and deep links; APNs enrollment/delivery/token rotation; configurable widgets; accessibility, localization, screen sizes and battery/network behavior. Configure signing/App Groups/APNs, final app icons, App Store metadata and privacy disclosures. No production database, VPS or Apple distribution account was changed.
