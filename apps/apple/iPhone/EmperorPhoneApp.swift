import SwiftUI

@main
struct EmperorPhoneApp: App {
    @UIApplicationDelegateAdaptor(PushDelegate.self) private var push
    @StateObject private var model = AppModel()
    @Environment(\.colorScheme) private var colorScheme
    @AppStorage("appearance") private var appearance = "system"
    var body: some Scene {
        WindowGroup {
            TabView(selection: $model.tab) {
                FleetView().id(model.workspaceKey).tabItem { Label("Home", systemImage: "house") }.tag(0)
                WorkRoot(kind: "Inbox").tabItem { Label("Inbox", systemImage: "tray") }.tag(1)
                WorkRoot(kind: "Messages").tabItem { Label("Messages", systemImage: "bubble.left.and.bubble.right") }.tag(2)
                WorkRoot(kind: "Projects").tabItem { Label("Projects", systemImage: "folder") }.tag(3)
                FleetView(agentsOnly: true).id(model.workspaceKey).tabItem { Label("Agents", systemImage: "person.3") }.tag(4)
            }.environmentObject(model)
                .preferredColorScheme(appearance == "system" ? nil : appearance == "dark" ? .dark : .light)
                .tint(colorScheme == .dark ? EmperorTheme.brightAccent : EmperorTheme.accent)
                .task { push.model = model; model.start(); await push.restore() }
                .onOpenURL { url in Task { await model.open(url) } }
                .sheet(item: $model.destination) { link in ResourceSheet(link: link).environmentObject(model) }
                .alert("EmperorClaw", isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) { Button("OK") { model.notice = nil } } message: { Text(model.notice ?? "") }
        }
    }
}
