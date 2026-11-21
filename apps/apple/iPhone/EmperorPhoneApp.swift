import SwiftUI

@main
struct EmperorPhoneApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.colorScheme) private var colorScheme
    var body: some Scene {
        WindowGroup {
            TabView {
                FleetView().tabItem { Label("Home", systemImage: "house") }
                FleetView(agentsOnly: true).tabItem { Label("Agents", systemImage: "person.3") }
                ConnectionsView().tabItem { Label("Connections", systemImage: "server.rack") }
            }.environmentObject(model)
                .tint(colorScheme == .dark ? EmperorTheme.brightAccent : EmperorTheme.accent)
                .task { model.start() }
                .alert("EmperorClaw", isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) { Button("OK") { model.notice = nil } } message: { Text(model.notice ?? "") }
        }
    }
}
