import SwiftUI

@main
struct EmperorWatchApp: App {
    @StateObject private var model = AppModel()
    var body: some Scene {
        WindowGroup {
            FleetView().environmentObject(model).tint(EmperorTheme.brightAccent)
                .task { model.start() }
                .alert("EmperorClaw", isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) { Button("OK") { model.notice = nil } } message: { Text(model.notice ?? "") }
        }
    }
}
