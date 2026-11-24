import Foundation
import UserNotifications
import SwiftUI
import EmperorCore
import Security
#if os(iOS)
import UIKit
typealias PushApplicationDelegate = UIApplicationDelegate
#else
import WatchKit
typealias PushApplicationDelegate = WKApplicationDelegate
#endif

final class PushDelegate: NSObject, PushApplicationDelegate, UNUserNotificationCenterDelegate {
    @MainActor static weak var current: PushDelegate?
    @MainActor weak var model: AppModel? { didSet { if model != nil, let waiting { self.waiting = nil; receive(waiting) } } }
    @MainActor private var pendingID: String?
    @MainActor private var token: String?
    @MainActor private var waiting: [AnyHashable: Any]?
    override init() {
        super.init()
        #if os(iOS)
        NotificationActions.register()
        #endif
        Task { @MainActor in Self.current = self; token = PushTokenStorage.read(); pendingID = UserDefaults.standard.string(forKey: "pushPendingInstance"); UNUserNotificationCenter.current().delegate = self }
    }
    /// iPhone seals content end to end; the watch keeps generic alerts (no extension).
    static var contentKey: String? {
        #if os(iOS)
        return PushContentKey.ensure()
        #else
        return nil
        #endif
    }
    @MainActor var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }
    @MainActor func restore() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return }
        #if os(iOS)
        UIApplication.shared.registerForRemoteNotifications()
        #else
        WKApplication.shared().registerForRemoteNotifications()
        #endif
    }
    @MainActor func enable(for installation: Installation) async {
        do {
            guard try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) else { model?.notice = "Allow notifications in your device's system settings."; return }
            pendingID = installation.id
            UserDefaults.standard.set(installation.id, forKey: "pushPendingInstance")
            if let token { await enroll(token) }
            else {
                #if os(iOS)
                UIApplication.shared.registerForRemoteNotifications()
                #else
                WKApplication.shared().registerForRemoteNotifications()
                #endif
            }
        } catch { model?.notice = error.localizedDescription }
    }
    #if os(iOS)
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) { receivedToken(deviceToken) }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) { Task { @MainActor in model?.notice = error.localizedDescription } }
    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any], fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) { completionHandler(.noData) }
    #else
    func didRegisterForRemoteNotifications(withDeviceToken deviceToken: Data) { receivedToken(deviceToken) }
    func didFailToRegisterForRemoteNotificationsWithError(_ error: Error) { Task { @MainActor in model?.notice = error.localizedDescription } }
    #endif
    private func receivedToken(_ data: Data) { let value = data.map { String(format: "%02x", $0) }.joined(); Task { @MainActor in token = value; PushTokenStorage.save(value); if let waiting { self.waiting = nil; receive(waiting) } else { await enroll(value) } } }
    @MainActor private func enroll(_ value: String) async {
        guard let model, let id = pendingID, let installation = model.installations.first(where: { $0.id == id }) else { return }
        do { try await model.client.configurePush(installation, token: value, environment: environment, contentKey: Self.contentKey); model.notice = "Tap the confirmation notification to finish enabling alerts for this instance." }
        catch {
            // Don't retry (and re-alert) on every launch; the person can try again from Notifications.
            pendingID = nil; UserDefaults.standard.removeObject(forKey: "pushPendingInstance")
            model.notice = error.localizedDescription
        }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        #if os(iOS)
        if [NotificationActions.approve, NotificationActions.reject, NotificationActions.reply].contains(response.actionIdentifier) {
            // Background action: no UI, no AppModel needed — saved connections and Keychain credentials suffice.
            let saved = UserDefaults.standard.data(forKey: "installations").flatMap { try? JSONDecoder().decode([Installation].self, from: $0) } ?? []
            Task {
                let result = await NotificationActions.perform(response, client: MobileClient(), installations: saved)
                if let result { NotificationActions.confirm(result, replacing: response.notification.request) }
                else { receive(response.notification.request.content.userInfo) }
                completionHandler()
            }
            return
        }
        #endif
        receive(response.notification.request.content.userInfo); completionHandler()
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) { completionHandler([.banner, .sound]) }
    private func receive(_ info: [AnyHashable: Any]) {
        guard let event = info["emperor"] as? [String: String], let installationID = event["installation"] else { return }
        Task { @MainActor in
            guard let model else { waiting = info; return }
            guard let installation = model.installations.first(where: { $0.id == installationID }) else { return }
            if let challenge = event["challenge"] {
                guard let token else {
                    waiting = info
                    #if os(iOS)
                    UIApplication.shared.registerForRemoteNotifications()
                    #else
                    WKApplication.shared().registerForRemoteNotifications()
                    #endif
                    return
                }
                do { try await model.client.configurePush(installation, token: token, environment: environment, challenge: challenge, contentKey: Self.contentKey); pendingID = nil; UserDefaults.standard.removeObject(forKey: "pushPendingInstance"); model.notice = "Notifications enabled for \(installation.name)." }
                catch { model.notice = error.localizedDescription }
            } else if let company = event["company"], let kind = event["kind"], let id = event["id"] {
                await model.open(WorkspaceLink.url(installationID: installationID, companyID: company, kind: kind, id: id))
            }
        }
    }
}

private enum PushTokenStorage {
    static var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.emperorclaw.push", kSecAttrAccount as String: "apns-token"] }
    static func read() -> String? { var q = query; q[kSecReturnData as String] = true; var result: CFTypeRef?; guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }; return String(data: data, encoding: .utf8) }
    static func save(_ value: String) { let values: [String: Any] = [kSecValueData as String: Data(value.utf8), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]; if SecItemUpdate(query as CFDictionary, values as CFDictionary) == errSecItemNotFound { var q = query; values.forEach { q[$0.key] = $0.value }; SecItemAdd(q as CFDictionary, nil) } }
}

struct NotificationsView: View {
    @EnvironmentObject var model: AppModel
    let workspace: Installation
    @State private var busy = false
    var body: some View {
        List {
            Section { Text("Alerts for \(workspace.name)").font(.headline); Text("Approvals, direct mentions and important failures. System Focus and notification settings control when alerts appear.") }
            Button("Enable notifications") { Task { busy = true; await PushDelegate.current?.enable(for: workspace); busy = false } }.disabled(busy)
            Button("Disable for this instance", role: .destructive) { Task { do { try await model.client.configurePush(workspace, enabled: false); model.notice = "Notifications disabled." } catch { model.notice = error.localizedDescription } } }
            Text("This instance must have the optional EmperorClaw Apple push relay configured. The relay sends generic alerts; work details are fetched directly from your server.").font(.caption).foregroundStyle(.secondary)
        }.navigationTitle("Notifications")
    }
}
