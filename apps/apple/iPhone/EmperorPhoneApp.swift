import SwiftUI

@main
struct EmperorPhoneApp: App {
    @UIApplicationDelegateAdaptor(PushDelegate.self) private var push
    @StateObject private var model = AppModel()
    @Environment(\.colorScheme) private var colorScheme
    @AppStorage("appearance") private var appearance = "system"
    var body: some Scene {
        WindowGroup {
            navigation.environmentObject(model)
                .preferredColorScheme(preferredAppearance)
                .tint(colorScheme == .dark ? EmperorTheme.brightAccent : EmperorTheme.accent)
                .task {
                    push.model = model; model.start(); await push.restore()
                    #if DEBUG
                    if ViewDesignPreview.enabled { model.tab = 4 }
                    #endif
                }
                .onOpenURL { url in Task { await model.open(url) } }
                .sheet(item: $model.destination) { link in ResourceSheet(link: link).environmentObject(model) }
                .alert("EmperorClaw", isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) { Button("OK") { model.notice = nil } } message: { Text(model.notice ?? "") }
        }
    }
    private var preferredAppearance: ColorScheme? {
        #if DEBUG
        if ViewDesignPreview.enabled && ProcessInfo.processInfo.arguments.contains("--views-design-dark") { return .dark }
        #endif
        return appearance == "system" ? nil : appearance == "dark" ? .dark : .light
    }
    @ViewBuilder private var navigation: some View {
        if #available(iOS 18.0, *) {
            TabView(selection: $model.tab) {
                Tab("Home", systemImage: "house", value: 0) { PhoneHome().id(model.workspaceKey) }
                Tab("Inbox", systemImage: "tray", value: 1) { WorkRoot(kind: "Inbox") }
                Tab("Messages", systemImage: "bubble.left.and.bubble.right", value: 2) { WorkRoot(kind: "Messages") }
                Tab("Projects", systemImage: "folder", value: 3) { WorkRoot(kind: "Projects") }
                Tab("Views", systemImage: "rectangle.3.group", value: 4) { ViewsRoot() }
            }.tabViewStyle(.sidebarAdaptable)
        } else {
            TabView(selection: $model.tab) {
                PhoneHome().id(model.workspaceKey).tabItem { Label("Home", systemImage: "house") }.tag(0)
                WorkRoot(kind: "Inbox").tabItem { Label("Inbox", systemImage: "tray") }.tag(1)
                WorkRoot(kind: "Messages").tabItem { Label("Messages", systemImage: "bubble.left.and.bubble.right") }.tag(2)
                WorkRoot(kind: "Projects").tabItem { Label("Projects", systemImage: "folder") }.tag(3)
                ViewsRoot().tabItem { Label("Views", systemImage: "rectangle.3.group") }.tag(4)
            }
        }
    }

}
