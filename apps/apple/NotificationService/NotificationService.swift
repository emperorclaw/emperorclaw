import UserNotifications
import EmperorCore

/// Opens end-to-end sealed content on the device and shows it. If anything is
/// missing (old server, no key, tampering) the generic relay text stays.
final class NotificationService: UNNotificationServiceExtension {
    private var handler: ((UNNotificationContent) -> Void)?
    private var fallback: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        handler = contentHandler
        let content = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
        fallback = content
        guard let event = content.userInfo["emperor"] as? [String: Any], let sealed = event["sealed"] as? String,
              let key = PushContentKey.current(), let opened = PushContent.open(sealed, key: key) else {
            contentHandler(content); return
        }
        content.title = opened.title
        content.body = opened.body ?? ""
        content.categoryIdentifier = opened.categoryIdentifier
        switch opened.category {
        case .reply:
            content.threadIdentifier = "reply:\(opened.threadID ?? opened.agentID ?? "")"
            content.subtitle = ""
        case .approval:
            content.threadIdentifier = "approvals"
            content.subtitle = "Approval needed"
            content.interruptionLevel = .timeSensitive
        case .attention:
            content.threadIdentifier = "attention"
        }
        // Action handling needs the ids; the app reads them back from userInfo.
        var info = content.userInfo
        var emperor = event
        emperor["approval"] = opened.approvalID
        emperor["agent"] = opened.agentID
        emperor["thread"] = opened.threadID
        emperor.removeValue(forKey: "sealed")
        info["emperor"] = emperor
        content.userInfo = info
        contentHandler(content)
    }

    override func serviceExtensionTimeWillExpire() {
        if let handler, let fallback { handler(fallback) }
    }
}
