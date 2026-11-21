import Foundation

/// A conversation owns its history and revisioned previews. Pagination never
/// decides whether the reader should follow the live edge.
public struct ChatTranscript: Sendable, Equatable {
    public private(set) var messages: [WorkItem] = []
    public private(set) var previews: [JSONValue] = []
    public private(set) var participants: [JSONValue] = []
    public private(set) var liveRuns: [JSONValue] = []
    public private(set) var replyRuns: JSONValue = .object([:])
    public private(set) var hasMore = false
    public private(set) var loaded = false
    public private(set) var streaming = false
    public private(set) var streamingKnown = false
    public init() {}

    public mutating func receive(_ response: JSONValue, older: Bool = false) {
        let incoming = response["messages"].items.map(WorkItem.init)
        let ids = Set(incoming.map(\.id))
        let retained = messages.filter { !ids.contains($0.id) }
        let combined = older ? incoming + retained : retained + incoming
        messages = combined.enumerated().sorted {
            let a = $0.element["createdAt"].text, b = $1.element["createdAt"].text
            return a == b ? $0.offset < $1.offset : a < b
        }.map(\.element)
        if !loaded || older { hasMore = response["hasMore"].flag }
        loaded = true
        // Older pages must not replace current activity with stale information.
        if !older { liveRuns = response["liveRuns"].items; participants = response["participants"].items }
        if case .object(let old) = replyRuns, case .object(let new) = response["replyRuns"] {
            replyRuns = .object(old.merging(new) { _, new in new })
        }
    }

    public mutating func receivePreviews(_ response: JSONValue) {
        streamingKnown = true
        streaming = response["streaming"].flag
        let old = Dictionary(previews.map { ($0["responseId"].text, $0) }, uniquingKeysWith: { _, b in b })
        // The server's list is authoritative for expiry; revisions are monotonic
        // while present, including sealed/failed/interrupted segments.
        previews = response["previews"].items.filter { !$0["responseId"].text.isEmpty }.map { next in
            guard let previous = old[next["responseId"].text] else { return next }
            let keepSnapshot = next["revision"].count <= previous["revision"].count || (previous["state"].text != "streaming" && previous["state"].text != next["state"].text)
            guard case .object(var map) = keepSnapshot ? previous : next else { return previous }
            // Final-message linkage and run status are joined by the server,
            // independently of snapshot revisions. A sealed segment can acquire
            // its durable message ID without another token/revision.
            if !next["finalMessageId"].text.isEmpty { map["finalMessageId"] = next["finalMessageId"] }
            else if !previous["finalMessageId"].text.isEmpty { map["finalMessageId"] = previous["finalMessageId"] }
            let previousStatus = previous["runStatus"].text
            let restartsFinishedRun = !previousStatus.isEmpty && previousStatus != "running" && next["runStatus"].text == "running"
            if next["runStatus"] != .null && !restartsFinishedRun { map["runStatus"] = next["runStatus"] }
            if next["agentName"] != .null { map["agentName"] = next["agentName"] }
            return .object(map)
        }
    }

    public var payload: JSONValue { .object([
        "messages": .array(messages.map(\.value)), "previews": .array(previews),
        "participants": .array(participants), "liveRuns": .array(liveRuns), "replyRuns": replyRuns,
        "hasMore": .bool(hasMore), "loaded": .bool(loaded), "streaming": .bool(streaming), "streamingKnown": .bool(streamingKnown)
    ]) }
}

/// Strict capability map for the offline renderer, rather than a general HTTP
/// bridge. Server handlers retain the web's resource and private-chat guards.
public struct ChatResource: Sendable, Equatable {
    public let path: String
    public let query: [String: String]
    public init?(_ input: String) {
        guard input.utf8.count <= 8192, input.hasPrefix("/api/"), !input.hasPrefix("//"),
              let url = URLComponents(string: input), url.scheme == nil, url.host == nil, url.fragment == nil else { return nil }
        let items = url.queryItems ?? []
        guard Set(items.map(\.name)).count == items.count else { return nil }
        var query: [String: String] = [:]
        for item in items { guard let value = item.value else { return nil }; query[item.name] = value }
        switch url.path {
        case "/api/ui/entities":
            guard query.count == 1, let refs = query["refs"], !refs.isEmpty else { return nil }
            let parts = refs.split(separator: ",", omittingEmptySubsequences: false)
            guard parts.count <= 50, parts.allSatisfy({ part in
                let pair = part.split(separator: ":", omittingEmptySubsequences: false)
                return pair.count == 2 && ["task", "project", "agent", "knowledge", "artifact"].contains(String(pair[0])) && UUID(uuidString: String(pair[1])) != nil
            }) else { return nil }
            path = "entities"
        case "/api/chat/reasoning":
            guard query.count == 1, let id = query["messageId"], UUID(uuidString: id) != nil else { return nil }
            path = "chat/reasoning"
        default:
            let parts = url.path.split(separator: "/")
            guard query.isEmpty, parts.count == 4, parts[0] == "api", parts[1] == "runs", parts[3] == "events", UUID(uuidString: String(parts[2])) != nil else { return nil }
            path = "runs/\(parts[2])/events"
        }
        self.query = query
    }
}
