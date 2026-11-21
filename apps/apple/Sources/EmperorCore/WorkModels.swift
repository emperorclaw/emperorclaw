import Foundation

/// Forward-compatible envelopes for the existing versioned work resources.
/// Views explicitly select user-facing fields; unknown fields stay opaque.
public enum JSONValue: Codable, Sendable, Equatable {
    case object([String: JSONValue]), array([JSONValue]), string(String), number(Double), bool(Bool), null
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self { case .object(let v): try c.encode(v); case .array(let v): try c.encode(v); case .string(let v): try c.encode(v); case .number(let v): try c.encode(v); case .bool(let v): try c.encode(v); case .null: try c.encodeNil() }
    }
    public subscript(_ key: String) -> JSONValue { if case .object(let v) = self { return v[key] ?? .null }; return .null }
    public var text: String { if case .string(let v) = self { return v }; return "" }
    public var items: [JSONValue] { if case .array(let v) = self { return v }; return [] }
    public var flag: Bool { if case .bool(let v) = self { return v }; return false }
    public var count: Int { if case .number(let v) = self, v.isFinite, v >= Double(Int.min), v < Double(Int.max) { return Int(v) }; return 0 }
}

public struct WorkItem: Identifiable, Sendable, Equatable {
    public var value: JSONValue
    public var id: String { value["id"].text }
    public init(_ value: JSONValue) { self.value = value }
    public subscript(_ key: String) -> JSONValue { value[key] }
}

public struct WorkspaceLink: Equatable, Sendable {
    public let installationID: String
    public let companyID: String
    public let kind: String
    public let resourceID: String
    public init?(url: URL) {
        guard url.scheme == "com.emperorclaw.app", url.host == "open", let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let q = parts.queryItems ?? []
        func unique(_ key: String) -> String? { let values = q.filter { $0.name == key }; return values.count == 1 ? values.first?.value : nil }
        guard let installation = unique("installation"), UUID(uuidString: installation) != nil,
              let company = unique("company"), UUID(uuidString: company) != nil,
              let kind = unique("kind"), ["approval", "task", "agent", "inbox"].contains(kind),
              let id = unique("id"), UUID(uuidString: id) != nil else { return nil }
        installationID = installation; companyID = company; self.kind = kind; resourceID = id
    }
    public static func url(installationID: String, companyID: String, kind: String, id: String) -> URL {
        var parts = URLComponents(string: "com.emperorclaw.app://open")!
        parts.queryItems = [.init(name: "installation", value: installationID), .init(name: "company", value: companyID), .init(name: "kind", value: kind), .init(name: "id", value: id)]
        return parts.url!
    }
}
