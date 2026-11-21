import XCTest
@testable import EmperorCore

final class ChatTranscriptTests: XCTestCase {
    private func message(_ id: String, _ time: String, text: String = "hello") -> JSONValue {
        .object(["id": .string(id), "createdAt": .string(time), "text": .string(text)])
    }
    private func page(_ messages: [JSONValue], more: Bool = false) -> JSONValue { .object(["messages": .array(messages), "hasMore": .bool(more)]) }
    func testPagingDoesNotResetWhenNewestPageIsPolled() {
        var state = ChatTranscript()
        state.receive(page([message("2", "2026-11-21T02:00:00Z")], more: true))
        XCTAssertTrue(state.loaded); XCTAssertTrue(state.hasMore)
        state.receive(page([message("1", "2026-11-21T01:00:00Z")]), older: true)
        XCTAssertFalse(state.hasMore)
        state.receive(page([message("2", "2026-11-21T02:00:00Z", text: "updated"), message("3", "2026-11-21T03:00:00Z")], more: true))
        XCTAssertFalse(state.hasMore)
        XCTAssertEqual(state.messages.map(\.id), ["1", "2", "3"])
        XCTAssertEqual(state.messages[1]["text"].text, "updated")
    }
    func testOlderPageCannotOverwriteCurrentActivity() {
        var state = ChatTranscript()
        var current = page([])
        if case .object(var map) = current { map["liveRuns"] = .array([.object(["runId": .string("current")])]); current = .object(map) }
        state.receive(current); state.receive(page([]), older: true)
        XCTAssertEqual(state.liveRuns.first?["runId"].text, "current")
    }
    func testPreviewRevisionsTerminalStatesAndExpiry() {
        var state = ChatTranscript()
        func receive(_ revision: Int, _ status: String, text: String) {
            state.receivePreviews(.object(["streaming": .bool(true), "previews": .array([.object(["responseId": .string("one"), "revision": .number(Double(revision)), "state": .string(status), "text": .string(text)])])]))
        }
        receive(3, "streaming", text: "latest"); receive(2, "streaming", text: "stale")
        XCTAssertEqual(state.previews.first?["text"].text, "latest")
        receive(4, "sealed", text: "sealed"); receive(5, "streaming", text: "invalid restart")
        XCTAssertEqual(state.previews.first?["state"].text, "sealed")
        state.receivePreviews(.object(["previews": .array([]), "streaming": .bool(false)]))
        XCTAssertTrue(state.previews.isEmpty); XCTAssertFalse(state.streaming)
    }
    func testFinalMessageCanLinkWithoutAnotherSnapshotRevision() {
        var state = ChatTranscript()
        let preview: [String: JSONValue] = ["responseId": .string("one"), "revision": .number(3), "state": .string("sealed"), "text": .string("Final segment"), "runStatus": .string("running")]
        state.receivePreviews(.object(["previews": .array([.object(preview)])]))
        var linked = preview
        linked["finalMessageId"] = .string("saved-message")
        linked["runStatus"] = .string("succeeded")
        state.receivePreviews(.object(["previews": .array([.object(linked)])]))
        XCTAssertEqual(state.previews.first?["finalMessageId"].text, "saved-message")
        XCTAssertEqual(state.previews.first?["runStatus"].text, "succeeded")
        XCTAssertEqual(state.previews.first?["revision"].count, 3)
        state.receivePreviews(.object(["previews": .array([.object(preview)])]))
        XCTAssertEqual(state.previews.first?["runStatus"].text, "succeeded")
        XCTAssertEqual(state.previews.first?["finalMessageId"].text, "saved-message")
    }
    func testRendererBridgeAcceptsOnlyScopedReadCapabilities() {
        let id = UUID().uuidString
        XCTAssertEqual(ChatResource("/api/ui/entities?refs=task:\(id),agent:\(id)")?.path, "entities")
        XCTAssertEqual(ChatResource("/api/chat/reasoning?messageId=\(id)")?.query["messageId"], id)
        XCTAssertEqual(ChatResource("/api/runs/\(id)/events")?.path, "runs/\(id)/events")
        for invalid in ["https://evil.example/api/ui/entities?refs=task:\(id)", "//evil.example/api/ui/entities", "/api/settings/tokens", "/api/chat/reasoning?messageId=\(id)&companyId=\(id)", "/api/chat/reasoning?messageId=\(id)&messageId=\(id)", "/api/ui/entities?refs=token:\(id)", "/api/ui/entities?refs=task:bad", "/api/runs/\(id)/events?company=other"] {
            XCTAssertNil(ChatResource(invalid), invalid)
        }
    }
}
