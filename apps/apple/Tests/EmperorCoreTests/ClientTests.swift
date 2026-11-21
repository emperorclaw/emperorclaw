import XCTest
@testable import EmperorCore

private final class MemoryVault: CredentialVault, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Credentials] = [:]
    func read(_ key: String) throws -> Credentials? { lock.lock(); defer { lock.unlock() }; return values[key] }
    func write(_ credentials: Credentials, for key: String) throws { lock.lock(); defer { lock.unlock() }; values[key] = credentials }
    func remove(_ key: String) throws { lock.lock(); defer { lock.unlock() }; values[key] = nil }
}

private final class MockURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: ((URLRequest) throws -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, data) = try Self.handler!(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

final class ClientTests: XCTestCase {
    private func client(_ vault: MemoryVault) -> MobileClient {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [MockURLProtocol.self]
        return MobileClient(vault: vault, configuration: config)
    }
    private func installation(_ host: String = "one.example.com") throws -> Installation {
        .init(id: UUID().uuidString, name: host, server: try ServerAddress.parse("https://\(host)"), companyID: UUID().uuidString)
    }
    private func credential(_ token: String, expired: Bool = false) -> Credentials {
        .init(accessToken: token, refreshToken: "refresh-\(token)", deviceId: "device-\(token)", expiresAt: Date().addingTimeInterval(expired ? -100 : 1000))
    }
    func testEachServerReceivesOnlyItsOwnToken() async throws {
        let vault = MemoryVault(); let api = client(vault)
        let first = try installation(); let second = try installation("two.example.com")
        try vault.write(credential("one-token"), for: first.id)
        try vault.write(credential("two-token"), for: second.id)
        MockURLProtocol.handler = { request in
            let expected = request.url!.host == "one.example.com" ? "one-token" : "two-token"
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(expected)")
            return (200, Data(#"{"companies":[]}"#.utf8))
        }
        _ = try await api.companies(first); _ = try await api.companies(second)
    }
    func testConcurrentRequestsShareOneRotatingRefresh() async throws {
        let vault = MemoryVault(); let api = client(vault); let profile = try installation()
        try vault.write(credential("expired", expired: true), for: profile.id)
        let lock = NSLock(); var refreshCount = 0
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/token") {
                lock.lock(); refreshCount += 1; lock.unlock()
                return (200, Data(#"{"accessToken":"new-token","refreshToken":"new-refresh","deviceId":"device-expired","expiresIn":900}"#.utf8))
            }
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer new-token")
            return (200, Data(#"{"companies":[]}"#.utf8))
        }
        async let first = api.companies(profile)
        async let second = api.companies(profile)
        _ = try await (first, second)
        XCTAssertEqual(refreshCount, 1)
        XCTAssertEqual(try vault.read(profile.id)?.refreshToken, "new-refresh")
    }
    func testReplayedWatchEnrollmentDoesNotReplaceRotatedToken() async throws {
        let vault = MemoryVault(); let api = client(vault); let id = UUID().uuidString
        let initial = credential("initial")
        try await api.importWatchCredentials(initial, installationID: id)
        var rotated = initial; rotated.accessToken = "rotated"; rotated.refreshToken = "rotated-refresh"
        try vault.write(rotated, for: id)
        try await api.importWatchCredentials(initial, installationID: id)
        XCTAssertEqual(try vault.read(id)?.refreshToken, "rotated-refresh")
    }
    func testSnapshotCannotBeAcceptedForAnotherCompany() async throws {
        let vault = MemoryVault(); let api = client(vault); let profile = try installation()
        try vault.write(credential("valid"), for: profile.id)
        MockURLProtocol.handler = { _ in (200, Data("{\"companyId\":\"\(UUID().uuidString)\",\"updatedAt\":\"2026-11-21T12:00:00Z\",\"agents\":[]}".utf8)) }
        do { _ = try await api.snapshot(profile); XCTFail("Must reject another company's response") }
        catch MobileFailure.incompatibleServer { }
    }
    func testOldRefreshCannotOverwriteNewSignIn() async throws {
        let vault = MemoryVault(); let api = client(vault); let profile = try installation()
        try vault.write(credential("old", expired: true), for: profile.id)
        let started = expectation(description: "Old refresh started")
        let release = DispatchSemaphore(value: 0)
        MockURLProtocol.handler = { _ in
            started.fulfill()
            guard release.wait(timeout: .now() + 5) == .success else { throw MobileFailure.http(500) }
            return (200, Data(#"{"accessToken":"old-refreshed","refreshToken":"old-next","deviceId":"device-old","expiresIn":900}"#.utf8))
        }
        let pending = Task { try await api.companies(profile) }
        await fulfillment(of: [started], timeout: 3)
        try vault.write(credential("new-account"), for: profile.id)
        release.signal()
        do { _ = try await pending.value; XCTFail("Old refresh must be discarded") }
        catch MobileFailure.signInRequired { }
        XCTAssertEqual(try vault.read(profile.id)?.accessToken, "new-account")
    }
}
