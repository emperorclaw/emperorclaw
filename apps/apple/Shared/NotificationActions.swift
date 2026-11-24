#if os(iOS)
import UserNotifications
import EmperorCore

/// Actionable notifications: approve/reject from the lock screen, reply inline.
/// Actions run with the app's own credentials and the same server rules.
enum NotificationActions {
    static let approve = "emperor.approve", reject = "emperor.reject", reply = "emperor.reply.text", open = "emperor.open"

    static func register() {
        let approveAction = UNNotificationAction(identifier: approve, title: "Approve", options: [.authenticationRequired], icon: UNNotificationActionIcon(systemImageName: "checkmark.circle"))
        let rejectAction = UNNotificationAction(identifier: reject, title: "Reject", options: [.authenticationRequired, .destructive], icon: UNNotificationActionIcon(systemImageName: "xmark.circle"))
        let replyAction = UNTextInputNotificationAction(identifier: reply, title: "Reply", options: [.authenticationRequired], icon: UNNotificationActionIcon(systemImageName: "arrowshape.turn.up.left"), textInputButtonTitle: "Send", textInputPlaceholder: "Message")
        let openAction = UNNotificationAction(identifier: open, title: "Open", options: [.foreground])
        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(identifier: "emperor.approval", actions: [approveAction, rejectAction, openAction], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: "emperor.reply", actions: [replyAction, openAction], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: "emperor.attention", actions: [openAction], intentIdentifiers: [], options: []),
        ])
    }

    /// Runs a background action. Returns a short result to show, or nil when the app should open instead.
    static func perform(_ response: UNNotificationResponse, client: MobileClient, installations: [Installation]) async -> String? {
        guard let event = response.notification.request.content.userInfo["emperor"] as? [String: Any],
              let installationID = event["installation"] as? String, let company = event["company"] as? String,
              var installation = installations.first(where: { $0.id == installationID }) else { return nil }
        installation.companyID = company
        do {
            switch response.actionIdentifier {
            case approve, reject:
                guard let approval = (event["approval"] as? String) ?? (event["kind"] as? String == "approval" ? event["id"] as? String : nil) else { return nil }
                let status = response.actionIdentifier == approve ? "approved" : "rejected"
                _ = try await client.work(installation, path: "approvals/\(approval)", method: "PATCH", body: .object(["status": .string(status)]), commandID: UUID())
                return status == "approved" ? "Approved" : "Rejected"
            case reply:
                guard let text = (response as? UNTextInputNotificationResponse)?.userText.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
                var body: [String: JSONValue] = ["text": .string(text), "clientMessageId": .string(UUID().uuidString)]
                if let agent = event["agent"] as? String { body["targetAgentId"] = .string(agent) }
                if let thread = event["thread"] as? String { body["directThreadId"] = .string(thread) }
                guard body["targetAgentId"] != nil else { return nil }
                _ = try await client.work(installation, path: "chat", method: "POST", body: .object(body), commandID: UUID())
                return "Sent"
            default:
                return nil
            }
        } catch {
            return "Couldn’t complete: \(error.localizedDescription)"
        }
    }

    /// Confirms a background action with a quiet local notification (no app launch).
    static func confirm(_ text: String, replacing request: UNNotificationRequest) {
        let content = UNMutableNotificationContent()
        content.title = request.content.title
        content.body = text
        content.threadIdentifier = request.content.threadIdentifier
        // Success is quiet; a refused action must be seen.
        content.interruptionLevel = text.hasPrefix("Couldn’t") ? .active : .passive
        if text.hasPrefix("Couldn’t") { content.sound = .default }
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "done-\(request.identifier)", content: content, trigger: nil))
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [request.identifier])
    }
}
#endif
