import XCTest
import CryptoKit
@testable import EmperorCore

/// The vector comes from the server's `sealForDevice` algorithm (Node crypto,
/// AES-256-GCM, nonce ‖ ciphertext ‖ tag, base64url) with a fixed key/nonce.
final class PushContentTests: XCTestCase {
    let key = SymmetricKey(data: Data(base64URL: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc")!)
    let sealed = "AwMDAwMDAwMDAwMDXtzXIWAKHDcTLCc5mXXTLo8e2s3w8OQcQKenx4aXKd7YwhkCeWcgYuKqKCe37JUgV0hq5qWgXFUWCh-SDx25WcbSFkmel0U8fdeGtvmv9QLMh_hEO1J_HN1g5eZCMQMu57ZYhZZBEnlO_xQ7WNEwlqinW0JLpvU7hKPVql9hLNKJh9_0EyXTFbczMZofXpAEkCyPYgeQ_B2gbccu"

    func testOpensServerSealedReply() throws {
        let content = try XCTUnwrap(PushContent.open(sealed, key: key))
        XCTAssertEqual(content.title, "Builder")
        XCTAssertEqual(content.body, "Deploy verified ✅")
        XCTAssertEqual(content.category, .reply)
        XCTAssertEqual(content.categoryIdentifier, "emperor.reply")
        XCTAssertEqual(content.agentID, "11111111-1111-4111-8111-111111111111")
        XCTAssertEqual(content.threadID, "22222222-2222-4222-8222-222222222222")
        XCTAssertNil(content.approvalID)
    }

    func testWrongKeyOrTamperingFailsClosed() {
        XCTAssertNil(PushContent.open(sealed, key: SymmetricKey(size: .bits256)))
        var tampered = Array(sealed); tampered[30] = tampered[30] == "A" ? "B" : "A"
        XCTAssertNil(PushContent.open(String(tampered), key: key))
        XCTAssertNil(PushContent.open("not base64 !", key: key))
    }
}
