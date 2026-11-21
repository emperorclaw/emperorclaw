import SwiftUI

@main
struct EmperorPhoneApp: App {
    @UIApplicationDelegateAdaptor(PushDelegate.self) private var push
    @StateObject private var model = AppModel()
    @AppStorage("appearance") private var appearance = "system"
    init() {
        // Screen titles speak in the same rounded voice as the team, distinct from system chrome.
        let appearance = UINavigationBar.appearance()
        func rounded(_ style: UIFont.TextStyle, _ weight: UIFont.Weight) -> UIFont {
            let base = UIFont.preferredFont(forTextStyle: style)
            let font = UIFont.systemFont(ofSize: base.pointSize, weight: weight)
            return UIFont(descriptor: font.fontDescriptor.withDesign(.rounded) ?? font.fontDescriptor, size: base.pointSize)
        }
        appearance.largeTitleTextAttributes = [.font: rounded(.largeTitle, .heavy)]
        appearance.titleTextAttributes = [.font: rounded(.headline, .semibold)]
    }
    var body: some Scene {
        WindowGroup {
            navigation.environmentObject(model)
                .preferredColorScheme(preferredAppearance)
                .tint(EmperorTheme.accent)
                .task {
                    ChatRenderer.prewarm()
                    push.model = model; model.start()
                    #if DEBUG
                    if ViewDesignPreview.enabled || ProcessInfo.processInfo.arguments.contains("--open-views") { model.tab = 4 }
                    #endif
                    await model.refresh(); await push.restore()
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
                Tab("Home", systemImage: "crown", value: 0) { PhoneHome().id(model.workspaceKey) }
                Tab("Inbox", systemImage: "tray.full", value: 1) { WorkRoot(kind: "Inbox") }.badge(model.selectedNeedsYou)
                Tab("Messages", systemImage: "bubble.left.and.text.bubble.right", value: 2) { WorkRoot(kind: "Messages") }
                Tab("Projects", systemImage: "checklist", value: 3) { WorkRoot(kind: "Projects") }
                Tab("Views", systemImage: "chart.bar.doc.horizontal", value: 4) { ViewsRoot() }
            }.tabViewStyle(.sidebarAdaptable)
        } else {
            TabView(selection: $model.tab) {
                PhoneHome().id(model.workspaceKey).tabItem { Label("Home", systemImage: "crown") }.tag(0)
                WorkRoot(kind: "Inbox").tabItem { Label("Inbox", systemImage: "tray.full") }.badge(model.selectedNeedsYou).tag(1)
                WorkRoot(kind: "Messages").tabItem { Label("Messages", systemImage: "bubble.left.and.text.bubble.right") }.tag(2)
                WorkRoot(kind: "Projects").tabItem { Label("Projects", systemImage: "checklist") }.tag(3)
                ViewsRoot().tabItem { Label("Views", systemImage: "chart.bar.doc.horizontal") }.tag(4)
            }
        }
    }

}
