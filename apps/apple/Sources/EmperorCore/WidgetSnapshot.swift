import Foundation

public struct WidgetSnapshot: Codable, Identifiable, Sendable {
    public let installationID: String
    public let companyID: String
    public let name: String
    public let working: Int
    public let total: Int
    public let needsYou: Int?
    public let date: Date
    public var id: String { "\(installationID):\(companyID)" }
    public init(installationID: String, companyID: String, name: String, working: Int, total: Int, needsYou: Int?, date: Date) {
        self.installationID = installationID; self.companyID = companyID; self.name = name; self.working = working; self.total = total; self.needsYou = needsYou; self.date = date
    }
}
public enum WidgetCache {
    public static let group = "group.com.emperorclaw.app"
    public static func read() -> [WidgetSnapshot] {
        guard let data = UserDefaults(suiteName: group)?.data(forKey: "fleetWidgets") else { return [] }
        return (try? JSONDecoder().decode([WidgetSnapshot].self, from: data)) ?? []
    }
    public static func write(_ value: WidgetSnapshot) {
        var entries = read().filter { $0.id != value.id }; entries.append(value)
        UserDefaults(suiteName: group)?.set(try? JSONEncoder().encode(entries), forKey: "fleetWidgets")
    }
    public static func remove(installationID: String) {
        UserDefaults(suiteName: group)?.set(try? JSONEncoder().encode(read().filter { $0.installationID != installationID }), forKey: "fleetWidgets")
    }
}
