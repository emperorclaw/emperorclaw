import SwiftUI
import WebKit
import OSLog
import EmperorCore

/// One offline transcript, using the same renderer as the web. Credentials and
/// company selection remain in MobileClient; JavaScript only receives content.
struct ChatWebView: UIViewRepresentable {
    let payload: JSONValue
    let workspace: Installation
    let client: MobileClient
    var loadOlder: () -> Void = {}
    var sendPrompt: (String) async -> Bool = { _ in false }
    var openAttachment: (JSONValue) -> Void = { _ in }
    var openLink: (URL) -> Void = { _ in }
    var selectAgent: (String) -> Void = { _ in }
    var contentHeight: (Double) -> Void = { _ in }

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(context.coordinator, name: "chat")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false; view.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false // the transcript owns its scroll anchor
        view.scrollView.backgroundColor = .clear
        if let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "ChatWeb") {
            context.coordinator.documentURL = url
            view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
        context.coordinator.view = view
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.update()
    }
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.closed = true
        coordinator.tasks.values.forEach { $0.cancel() }
        view.configuration.userContentController.removeScriptMessageHandler(forName: "chat")
        view.navigationDelegate = nil
        view.stopLoading()
    }

    @MainActor final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var parent: ChatWebView
        weak var view: WKWebView?
        var documentURL: URL?
        var ready = false, closed = false
        var lastPayload: JSONValue?
        var tasks: [String: Task<Void, Never>] = [:]
        init(_ parent: ChatWebView) { self.parent = parent }

        func update() {
            guard ready, !closed, lastPayload != parent.payload, let view,
                  let data = try? JSONEncoder().encode(parent.payload),
                  let object = try? JSONSerialization.jsonObject(with: data) else { return }
            #if DEBUG
            if parent.payload["streamingKnown"].flag && lastPayload?["streamingKnown"].flag != true {
                Logger(subsystem: "com.emperorclaw.app", category: "ChatRenderer").notice("Transcript loaded: messages=\(self.parent.payload["messages"].items.count) streaming=\(self.parent.payload["streaming"].flag)")
            }
            #endif
            lastPayload = parent.payload
            view.callAsyncJavaScript("window.emperor.update(payload)", arguments: ["payload": object], in: nil, in: .page) { _ in }
        }
        func resolve(_ id: String, value: JSONValue = .null, error: String? = nil) {
            guard !closed, let view, let data = try? JSONEncoder().encode(value), let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else { return }
            view.callAsyncJavaScript("window.emperor.resolve(id, value, error)", arguments: ["id": id, "value": object, "error": error as Any? ?? NSNull()], in: nil, in: .page) { _ in }
        }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            // Sandboxed agent widgets cannot invoke native APIs, even if they
            // discover the WebKit handler. Only our bundled main frame may.
            guard !closed, message.frameInfo.isMainFrame, message.frameInfo.request.url == documentURL,
                  let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            switch type {
            case "ready": ready = true; update()
            case "older": parent.loadOlder()
            case "height":
                guard let height = body["height"] as? Double, height.isFinite, height >= 1, height <= 100_000 else { return }
                parent.contentHeight(height)
            case "agent":
                guard parent.payload["mode"].text == "fleet", let id = body["agentId"] as? String,
                      parent.payload["agents"].items.contains(where: { $0["id"].text == id }) else { return }
                parent.selectAgent(id)
            case "attachment":
                guard let file = body["file"] as? [String: Any], let id = file["id"] as? String,
                      let match = parent.payload["messages"].items.flatMap({ $0["metadataJson"]["attachments"].items }).first(where: { $0["id"].text == id }) else { return }
                parent.openAttachment(match)
            case "link":
                guard let raw = body["url"] as? String, raw.count <= 4096,
                      let url = URL(string: raw, relativeTo: parent.workspace.server)?.absoluteURL,
                      url.scheme == "https", url.user == nil, url.password == nil else { return }
                parent.openLink(url)
            case "resource", "sendPrompt":
                guard let id = body["id"] as? String, UUID(uuidString: id) != nil, tasks[id] == nil, tasks.count < 12 else { return }
                tasks[id] = Task { [weak self] in
                    guard let self else { return }; defer { tasks.removeValue(forKey: id) }
                    do {
                        if type == "sendPrompt" {
                            guard parent.payload["mayWrite"].flag, let prompt = body["prompt"] as? String, !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, prompt.utf8.count <= 32_000 else { throw MobileFailure.http(400) }
                            let sent = await parent.sendPrompt(prompt)
                            resolve(id, value: .bool(sent))
                        } else {
                            guard let raw = body["url"] as? String, let resource = ChatResource(raw) else { throw MobileFailure.http(400) }
                            let result = try await parent.client.work(parent.workspace, path: resource.path, query: resource.query)
                            guard !Task.isCancelled else { return }
                            resolve(id, value: result)
                        }
                    } catch { resolve(id, error: error.localizedDescription) }
                }
            default: break
            }
        }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            // The bundled main document is the only top-level navigation.
            // Widget srcdoc frames remain opaque and follow the web sandbox CSP.
            if action.targetFrame?.isMainFrame == false { decisionHandler(.allow); return }
            if action.request.url == documentURL && action.navigationType == .other { decisionHandler(.allow) }
            else { decisionHandler(.cancel) }
        }
    }
}
