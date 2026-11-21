import SwiftUI
import AuthenticationServices
import EmperorCore

struct ConnectView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    @Environment(\.webAuthenticationSession) private var authentication
    @State private var address = ""
    @State private var name = ""
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                Section("Your EmperorClaw server") {
                    TextField("https://emperor.example.com", text: $address).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityLabel("Server address")
                    TextField("Instance name (optional)", text: $name)
                }
                Section { Text("Sign in on your own server. Each instance keeps its own connection and permissions.").foregroundStyle(.secondary) }
                if let error { Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red) } }
                Section { Button { Task { await connect() } } label: { HStack { Text(busy ? "Connecting…" : "Connect securely"); if busy { Spacer(); ProgressView() } } }.disabled(busy || address.isEmpty) }
            }.navigationTitle("Add instance")
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) } }
        }
    }
    @MainActor private func connect() async {
        busy = true; error = nil; defer { busy = false }
        do {
            let server = try ServerAddress.parse(address)
            let discovery = try await model.client.discover(server)
            // Domain changes require explicit reconnection, never automatic
            // credential forwarding from an existing connection.
            if let saved = model.installations.first(where: { $0.id == discovery.installationId }), saved.server != server {
                error = "This installation is already saved at another address. Disconnect it before changing its address."; return
            }
            let attempt = SignInAttempt()
            let callback = try await authentication.authenticate(using: attempt.authorizationURL(server: server, deviceName: "iPhone"), callbackURLScheme: "com.emperorclaw.app")
            let installation = Installation(id: discovery.installationId, name: name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? server.host! : String(name.prefix(80)), server: server)
            try await model.client.connect(installation, code: attempt.code(from: callback), verifier: attempt.verifier)
            model.add(installation); dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
