import SwiftUI
import WatchKit

@main
struct EmperorWatchApp: App {
    @WKApplicationDelegateAdaptor(PushDelegate.self) private var push
    @StateObject private var model = AppModel()
    var body: some Scene {
        WindowGroup {
            WatchHome().id(model.workspaceKey).environmentObject(model).tint(EmperorTheme.brightAccent)
                .task { push.model = model; model.start(); await push.restore() }
                .onOpenURL { url in Task { await model.open(url) } }
                .sheet(item: $model.destination) { link in ResourceSheet(link: link).environmentObject(model) }
                .alert("EmperorClaw", isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) { Button("OK") { model.notice = nil } } message: { Text(model.notice ?? "") }
        }
    }
}
