import Foundation
import CryptoKit

/// Notification content sealed by the server for this device only. The relay
/// and APNs carry ciphertext; the notification extension opens it locally.
public struct PushContent: Codable, Equatable, Sendable {
    public enum Category: String, Codable, Sendable { case approval, reply, attention }
    public let title: String
    public let body: String?
    public let category: Category
    public let approvalID: String?
    public let agentID: String?
    public let threadID: String?
    enum CodingKeys: String, CodingKey { case title = "t", body = "b", category = "c", approvalID = "ap", agentID = "a", threadID = "th" }

    /// `nonce ‖ ciphertext ‖ tag` (AES-256-GCM), base64url — the server's `sealForDevice`.
    public static func open(_ sealed: String, key: SymmetricKey) -> PushContent? {
        guard let data = Data(base64URL: sealed), let box = try? AES.GCM.SealedBox(combined: data),
              let plain = try? AES.GCM.open(box, using: key) else { return nil }
        return try? JSONDecoder().decode(PushContent.self, from: plain)
    }

    /// Notification category identifiers registered by the app.
    public var categoryIdentifier: String { "emperor.\(category.rawValue)" }
}

/// The device's content key, shared with the notification extension via the App Group.
/// One key per app install; rotating it only requires re-enabling notifications.
public enum PushContentKey {
    static let defaultsKey = "pushContentKey"
    public static func current() -> SymmetricKey? {
        guard let raw = UserDefaults(suiteName: WidgetCache.group)?.string(forKey: defaultsKey), let data = Data(base64URL: raw), data.count == 32 else { return nil }
        return SymmetricKey(data: data)
    }
    /// Returns the existing key or creates one, as base64url for enrollment.
    public static func ensure() -> String {
        let defaults = UserDefaults(suiteName: WidgetCache.group)
        if let raw = defaults?.string(forKey: defaultsKey), Data(base64URL: raw)?.count == 32 { return raw }
        let raw = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }.base64URLEncodedString()
        defaults?.set(raw, forKey: defaultsKey)
        return raw
    }
}

extension Data {
    init?(base64URL: String) {
        var text = base64URL.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        text += String(repeating: "=", count: (4 - text.count % 4) % 4)
        self.init(base64Encoded: text)
    }
    func base64URLEncodedString() -> String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
