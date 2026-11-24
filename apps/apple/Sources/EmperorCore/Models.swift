import Foundation
import CryptoKit

public enum MobileFailure: Error, LocalizedError {
    case invalidServer, incompatibleServer, invalidCallback, signInRequired, http(Int), responseTooLarge
    case server(Int, String), alreadyReceived
    public var invalidatesContent: Bool { switch self { case .signInRequired, .http(403), .http(404), .server(403, _), .server(404, _): return true; default: return false } }
    public var errorDescription: String? {
        switch self {
        case .invalidServer: return "Enter an HTTPS server address without a path, password, query or fragment."
        case .incompatibleServer: return "This server does not support this version of the mobile app."
        case .invalidCallback: return "The sign-in response could not be verified. Start again."
        case .signInRequired: return "Sign in to this instance again. Your session has expired or was revoked."
        case .http(let code): return "The server returned an error (\(code)). Try again."
        case .responseTooLarge: return "The server response is too large."
        case .server(_, let message): return message
        case .alreadyReceived: return "The server already received this action. Refresh to check its result before starting another."
        }
    }
}

public enum ServerAddress {
    public static func parse(_ input: String) throws -> URL {
        guard var parts = URLComponents(string: input.trimmingCharacters(in: .whitespacesAndNewlines)),
              parts.scheme?.lowercased() == "https", let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/" else { throw MobileFailure.invalidServer }
        parts.scheme = "https"; parts.host = host.lowercased(); parts.path = ""
        if parts.port == 443 { parts.port = nil }
        guard let url = parts.url else { throw MobileFailure.invalidServer }
        return url
    }
}

public struct Installation: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var server: URL
    public var companyID: String?
    public var favorite: Bool
    public init(id: String, name: String, server: URL, companyID: String? = nil, favorite: Bool = false) {
        self.id = id; self.name = name; self.server = server; self.companyID = companyID; self.favorite = favorite
    }
}

public struct Company: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var role: String
}

public struct Agent: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var role: String
    public var state: String
    public var activity: String?
    public var taskTitle: String?
    public var lastSeenAt: String?
    public var avatarAppearance: JSONValue?
    public var avatarUrl: String?
    public var paused: Bool?
    public var statusLabel: String {
        switch state {
        case "working", "busy", "typing", "thinking": return "Working"
        case "idle", "online", "available": return "Available"
        case "offline": return "Offline"
        case "blocked": return "Blocked"
        case "paused": return "Paused"
        case "waiting": return "Waiting"
        default: return "Status unavailable"
        }
    }
}

public struct FleetSnapshot: Codable, Sendable {
    public var companyId: String
    public var updatedAt: String
    public var agents: [Agent]
    public var workingCount: Int { agents.filter { $0.statusLabel == "Working" }.count }
}

public struct Discovery: Decodable, Sendable {
    public var product: String
    public var apiVersion: Int
    public var installationId: String
    public var callback: String
    public var capabilities: [String]
}

public struct Credentials: Codable, Sendable {
    public var accessToken: String
    public var refreshToken: String
    public var deviceId: String
    public var expiresAt: Date
    public init(accessToken: String, refreshToken: String, deviceId: String, expiresAt: Date) {
        self.accessToken = accessToken; self.refreshToken = refreshToken; self.deviceId = deviceId; self.expiresAt = expiresAt
    }
}

public struct SignInAttempt: Sendable {
    public static let callback = "com.emperorclaw.app://oauth/callback"
    public let verifier: String
    public let state: String
    public init() {
        verifier = Self.random(); state = Self.random()
    }
    private static func random() -> String {
        (0..<32).map { _ in UInt8.random(in: .min ... .max) }.withUnsafeBytes { Data($0) }.base64URL
    }
    public var challenge: String { Data(SHA256.hash(data: Data(verifier.utf8))).base64URL }
    public func authorizationURL(server: URL, deviceName: String) -> URL {
        var url = URLComponents(url: server.appendingPathComponent("mobile/authorize"), resolvingAgainstBaseURL: false)!
        url.queryItems = [.init(name: "challenge", value: challenge), .init(name: "state", value: state), .init(name: "deviceName", value: String(deviceName.prefix(80)))]
        return url.url!
    }
    public func code(from url: URL) throws -> String {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              "\(parts.scheme ?? "")://\(parts.host ?? "")\(parts.path)" == Self.callback,
              parts.user == nil, parts.password == nil, parts.port == nil, parts.fragment == nil,
              parts.queryItems?.filter({ $0.name == "state" }).count == 1,
              parts.queryItems?.first(where: { $0.name == "state" })?.value == state,
              parts.queryItems?.first(where: { $0.name == "error" }) == nil,
              parts.queryItems?.filter({ $0.name == "code" }).count == 1,
              let code = parts.queryItems?.first(where: { $0.name == "code" })?.value, code.hasPrefix("emc_"), code.count == 47
        else { throw MobileFailure.invalidCallback }
        return code
    }
}

extension Data {
    var base64URL: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
}
