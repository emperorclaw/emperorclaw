import XCTest
import CryptoKit
@testable import EmperorCore

final class ConnectionTests: XCTestCase {
    func testServerAddressPreservesOriginAndRejectsCredentialTricks() throws {
        XCTAssertEqual(try ServerAddress.parse(" https://EXAMPLE.com:443/ ").absoluteString, "https://example.com")
        XCTAssertEqual(try ServerAddress.parse("https://example.com:8443").port, 8443)
        for address in ["http://example.com", "https://user:pass@example.com", "https://example.com/api", "https://example.com?token=secret", "https://example.com#fragment", "javascript:alert(1)", "https://example.com@evil.test"] {
            XCTAssertThrowsError(try ServerAddress.parse(address), address)
        }
    }
    func testPKCEAndCallbackAreBoundToOneAttempt() throws {
        let attempt = SignInAttempt()
        XCTAssertEqual(attempt.verifier.count, 43)
        XCTAssertEqual(attempt.challenge, Data(SHA256.hash(data: Data(attempt.verifier.utf8))).base64URL)
        let code = "emc_" + String(repeating: "a", count: 43)
        let callback = URL(string: "\(SignInAttempt.callback)?state=\(attempt.state)&code=\(code)")!
        XCTAssertEqual(try attempt.code(from: callback), code)
        XCTAssertThrowsError(try SignInAttempt().code(from: callback))
        for invalid in [
            "com.emperorclaw.app://evil/callback?state=\(attempt.state)&code=\(code)",
            "\(callback.absoluteString)&state=\(attempt.state)",
            "\(callback.absoluteString)&code=\(code)",
            "\(callback.absoluteString)&error=access_denied",
            "\(callback.absoluteString)#fragment",
        ] { XCTAssertThrowsError(try attempt.code(from: URL(string: invalid)!)) }
    }
    func testMoreThanTwoInstallationsRemainIndependent() throws {
        let profiles = try (0..<10).map { i in Installation(id: UUID().uuidString, name: "Company", server: try ServerAddress.parse("https://instance\(i).example.com"), companyID: UUID().uuidString) }
        let restored = try JSONDecoder().decode([Installation].self, from: JSONEncoder().encode(profiles))
        XCTAssertEqual(profiles, restored)
        XCTAssertEqual(Set(restored.map(\.id)).count, 10)
        XCTAssertEqual(Set(restored.map(\.server)).count, 10)
        XCTAssertFalse(String(data: try JSONEncoder().encode(profiles), encoding: .utf8)!.contains("accessToken"))
    }
}

final class WorkContractTests: XCTestCase {
    func testWorkspaceLinksCannotChooseAnUnrelatedOriginOrAmbiguousContext() throws {
        let installation = UUID().uuidString, company = UUID().uuidString, task = UUID().uuidString
        let url = WorkspaceLink.url(installationID: installation, companyID: company, kind: "task", id: task)
        XCTAssertEqual(WorkspaceLink(url: url)?.companyID, company)
        XCTAssertNil(WorkspaceLink(url: URL(string: url.absoluteString + "&company=" + UUID().uuidString)!))
        XCTAssertNil(WorkspaceLink(url: URL(string: url.absoluteString.replacingOccurrences(of: "com.emperorclaw.app://open", with: "https://evil.test"))!))
        XCTAssertNil(WorkspaceLink(url: WorkspaceLink.url(installationID: installation, companyID: company, kind: "admin", id: task)))
    }
    func testForwardCompatibleEnvelopesHandleLargeNumbersWithoutCrashing() throws {
        let value = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"unknown":{"nested":true},"count":1e100}"#.utf8))
        XCTAssertEqual(value["count"].count, 0)
        XCTAssertTrue(value["unknown"]["nested"].flag)
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value)), value)
    }
}
