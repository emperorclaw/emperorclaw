import Foundation

/// Refuse redirects even on token exchange: credentials must stay at the
/// explicitly selected origin. System certificate validation remains intact.
private final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

public actor MobileClient {
    private let session: URLSession
    private let vault: any CredentialVault
    // Actor reentrancy still allows two requests to observe expired tokens.
    // Share the refresh operation so the rotating token is used only once.
    private var refreshes: [String: Task<Credentials, Error>] = [:]
    private var workServers: Set<String> = []
    public init(vault: any CredentialVault = KeychainVault(), configuration: URLSessionConfiguration? = nil) {
        self.vault = vault
        let config = configuration ?? URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20; config.timeoutIntervalForResource = 30
        config.httpShouldSetCookies = false; config.urlCache = nil; config.httpCookieStorage = nil; config.urlCredentialStorage = nil
        self.session = URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
    }
    private func request<T: Decodable>(_ type: T.Type, server: URL, path: String, method: String = "GET", body: [String: String]? = nil, token: String? = nil, query: [String: String] = [:], payload: Data? = nil, commandID: UUID? = nil, contentType: String = "application/json") async throws -> T {
        let origin = try ServerAddress.parse(server.absoluteString)
        var parts = URLComponents(url: origin.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        parts.queryItems = query.isEmpty ? nil : query.sorted { $0.key < $1.key }.map { .init(name: $0.key, value: $0.value) }
        var request = URLRequest(url: parts.url!)
        request.httpMethod = method; request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body { request.httpBody = try JSONEncoder().encode(body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let payload { request.httpBody = payload; request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        if let commandID { request.setValue(commandID.uuidString, forHTTPHeaderField: "Idempotency-Key") }
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw MobileFailure.incompatibleServer }
        if response.statusCode == 401 { throw MobileFailure.signInRequired }
        guard (200..<300).contains(response.statusCode) else {
            let message = (try? JSONDecoder().decode(JSONValue.self, from: data))?["error"].text
            throw MobileFailure.server(response.statusCode, message ?? "The request could not be completed.")
        }
        guard data.count <= 2_000_000 else { throw MobileFailure.responseTooLarge }
        if (try? JSONDecoder().decode(JSONValue.self, from: data))?["replayed"].flag == true { throw MobileFailure.alreadyReceived }
        return try JSONDecoder().decode(T.self, from: data)
    }
    public func discover(_ server: URL) async throws -> Discovery {
        let discovery = try await request(Discovery.self, server: server, path: "api/mobile/v1/discovery")
        guard discovery.product == "EmperorClaw", discovery.apiVersion == 1,
              UUID(uuidString: discovery.installationId) != nil, discovery.callback == SignInAttempt.callback,
              discovery.capabilities.contains("user_sessions") else { throw MobileFailure.incompatibleServer }
        if discovery.capabilities.contains("workflows") { workServers.insert(server.absoluteString) }
        return discovery
    }
    private struct TokenResponse: Decodable {
        var accessToken: String; var refreshToken: String; var expiresIn: Double; var deviceId: String
        var credentials: Credentials { .init(accessToken: accessToken, refreshToken: refreshToken, deviceId: deviceId, expiresAt: Date().addingTimeInterval(expiresIn - 30)) }
    }
    public func connect(_ installation: Installation, code: String, verifier: String) async throws {
        let result = try await request(TokenResponse.self, server: installation.server, path: "api/mobile/v1/token", method: "POST", body: ["grantType": "authorization_code", "code": code, "verifier": verifier])
        try vault.write(result.credentials, for: installation.id)
    }
    @discardableResult
    public func importWatchCredentials(_ credentials: Credentials, installationID: String) throws -> Bool {
        // Application contexts may be delivered repeatedly. Never overwrite a
        // token already rotated by the watch with an old phone-side copy.
        if try vault.read(installationID)?.deviceId != credentials.deviceId {
            try vault.write(credentials, for: installationID)
            return true
        }
        return false
    }
    private func credentials(for installation: Installation) async throws -> Credentials {
        guard let saved = try vault.read(installation.id) else { throw MobileFailure.signInRequired }
        if saved.expiresAt > Date() { return saved }
        if let pending = refreshes[installation.id] { return try await pending.value }
        let task = Task { () throws -> Credentials in
            let result = try await self.request(TokenResponse.self, server: installation.server, path: "api/mobile/v1/token", method: "POST", body: ["grantType": "refresh_token", "refreshToken": saved.refreshToken])
            // A new browser sign-in may have replaced this identity while
            // the network request was suspended. Never restore its old token.
            guard let current = try self.vault.read(installation.id), current.deviceId == saved.deviceId, current.refreshToken == saved.refreshToken else { throw MobileFailure.signInRequired }
            try self.vault.write(result.credentials, for: installation.id)
            return result.credentials
        }
        refreshes[installation.id] = task
        defer { refreshes[installation.id] = nil }
        return try await task.value
    }
    public func companies(_ installation: Installation) async throws -> [Company] {
        struct Result: Decodable { var companies: [Company] }
        let auth = try await credentials(for: installation)
        return try await request(Result.self, server: installation.server, path: "api/mobile/v1/companies", token: auth.accessToken).companies
    }
    public func snapshot(_ installation: Installation) async throws -> FleetSnapshot {
        guard let id = installation.companyID, UUID(uuidString: id) != nil else { throw MobileFailure.incompatibleServer }
        let auth = try await credentials(for: installation)
        let result = try await request(FleetSnapshot.self, server: installation.server, path: "api/mobile/v1/companies/\(id)/snapshot", token: auth.accessToken)
        guard result.companyId == id else { throw MobileFailure.incompatibleServer }
        return result
    }
    public func pairWatch(_ installation: Installation, replacingDeviceID: String? = nil) async throws -> Credentials {
        let auth = try await credentials(for: installation)
        let result = try await request(TokenResponse.self, server: installation.server, path: "api/mobile/v1/watch", method: "POST", body: replacingDeviceID.map { ["replacingDeviceId": $0] } ?? [:], token: auth.accessToken)
        return result.credentials
    }
    public func revoke(_ installation: Installation) async throws {
        struct Result: Decodable { var revoked: Bool }
        let auth = try await credentials(for: installation)
        let _: Result = try await request(Result.self, server: installation.server, path: "api/mobile/v1/session", method: "DELETE", token: auth.accessToken)
        if try vault.read(installation.id)?.deviceId == auth.deviceId { try vault.remove(installation.id) }
    }

    public func work(_ installation: Installation, path: String, method: String = "GET", query: [String: String] = [:], body: JSONValue? = nil, commandID: UUID? = nil) async throws -> JSONValue {
        guard let company = installation.companyID, UUID(uuidString: company) != nil else { throw MobileFailure.incompatibleServer }
        if !workServers.contains(installation.server.absoluteString) { let info = try await discover(installation.server); guard info.capabilities.contains("workflows") else { throw MobileFailure.incompatibleServer } }
        let auth = try await credentials(for: installation)
        return try await request(JSONValue.self, server: installation.server, path: "api/mobile/v1/companies/\(company)/work/\(path)", method: method, token: auth.accessToken, query: query, payload: try body.map { try JSONEncoder().encode($0) }, commandID: method == "GET" ? nil : commandID ?? UUID())
    }

    public func upload(_ installation: Installation, data: Data, name: String, mime: String, commandID: UUID) async throws -> JSONValue {
        guard data.count <= 25 * 1024 * 1024, let company = installation.companyID else { throw MobileFailure.responseTooLarge }
        let auth = try await credentials(for: installation)
        let boundary = "Emperor-\(commandID.uuidString)"
        let safeName = name.replacingOccurrences(of: "\"", with: "_").replacingOccurrences(of: "\r", with: "_").replacingOccurrences(of: "\n", with: "_")
        var body = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(safeName)\"\r\nContent-Type: \(mime)\r\n\r\n".utf8)
        body.append(data); body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        return try await request(JSONValue.self, server: installation.server, path: "api/mobile/v1/companies/\(company)/work/attachments", method: "POST", token: auth.accessToken, payload: body, commandID: commandID, contentType: "multipart/form-data; boundary=\(boundary)")
    }

    public func download(_ installation: Installation, id: String, name: String) async throws -> URL {
        guard UUID(uuidString: id) != nil, let company = installation.companyID else { throw MobileFailure.incompatibleServer }
        let auth = try await credentials(for: installation)
        let origin = try ServerAddress.parse(installation.server.absoluteString)
        var request = URLRequest(url: origin.appendingPathComponent("api/mobile/v1/companies/\(company)/work/artifacts/\(id)/download"))
        request.setValue("Bearer \(auth.accessToken)", forHTTPHeaderField: "Authorization")
        let (temporary, response) = try await session.download(for: request)
        defer { try? FileManager.default.removeItem(at: temporary) }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw MobileFailure.http((response as? HTTPURLResponse)?.statusCode ?? 500) }
        let bytes = try temporary.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard bytes <= 25 * 1024 * 1024 else { throw MobileFailure.responseTooLarge }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let target = folder.appendingPathComponent(URL(fileURLWithPath: name).lastPathComponent)
        try FileManager.default.moveItem(at: temporary, to: target)
        return target
    }
    public func configurePush(_ installation: Installation, token: String? = nil, environment: String = "sandbox", challenge: String? = nil, enabled: Bool = true, kinds: [String] = ["approval", "decision", "mention", "reply", "agent_failed", "agent_down"], contentKey: String? = nil) async throws {
        let auth = try await credentials(for: installation)
        var values: [String: JSONValue] = ["enabled": .bool(enabled), "environment": .string(environment), "kinds": .array(kinds.map(JSONValue.string))]
        if let contentKey { values["contentKey"] = .string(contentKey) }
        if let token { values["deviceToken"] = .string(token) }; if let challenge { values["challenge"] = .string(challenge) }
        let _: JSONValue = try await request(JSONValue.self, server: installation.server, path: "api/mobile/v1/push", method: "POST", token: auth.accessToken, payload: JSONEncoder().encode(JSONValue.object(values)))
    }
}
