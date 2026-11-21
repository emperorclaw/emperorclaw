import SwiftUI
import EmperorCore

enum EmperorTheme {
    static let accent = Color(red: 0.02, green: 0.47, blue: 0.62)
    static let brightAccent = Color(red: 0.35, green: 0.83, blue: 0.96)
}

struct FleetView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var showConnections = false
    var agentsOnly = false
    var body: some View {
        NavigationStack {
            Group {
                if let selected = model.selected {
                    List {
                        Section {
                            Button { showConnections = true } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Label(model.companyName, systemImage: "server.rack").font(.headline)
                                    Text(selected.server.host ?? selected.name).font(.caption).foregroundStyle(.secondary)
                                }.frame(maxWidth: .infinity, alignment: .leading)
                            }.accessibilityHint("Switch installation or company")
                        }
                        if let error = model.errors[selected.id] {
                            Section {
                                Label("Connection unavailable", systemImage: "wifi.exclamationmark").foregroundStyle(.orange)
                                Text(error).font(.footnote)
                                if model.snapshots[selected.id] != nil { Text("Showing the last snapshot. Agent status may have changed.").font(.caption).foregroundStyle(.secondary) }
                                Button("Try again") { Task { await model.refresh() } }
                            }
                        }
                        if let snapshot = model.snapshots[selected.id] {
                            if !agentsOnly {
                                Section("Your team") {
                                    HStack {
                                        Metric(value: snapshot.workingCount, label: "Working")
                                        Spacer()
                                        Metric(value: snapshot.agents.count, label: "Agents")
                                    }.padding(.vertical, 4)
                                    if let date = ISO8601DateFormatter().date(from: snapshot.updatedAt) {
                                        Text("Updated \(date, style: .relative) ago").font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            }
                            Section("Agents") {
                                if snapshot.agents.isEmpty { Text("No agents visible in this company.").foregroundStyle(.secondary) }
                                ForEach(snapshot.agents) { agent in
                                    NavigationLink { AgentDetail(agent: agent) } label: { AgentRow(agent: agent) }
                                }
                            }
                        } else if model.loading.contains(selected.id) {
                            ProgressView("Loading team…")
                        }
                    }
                    .refreshable { await model.refresh() }
                    .task(id: "\(selected.id):\(selected.companyID ?? "")") { await model.refresh() }
                } else {
                    ContentUnavailableView {
                        Label("Your team, wherever you are", systemImage: "person.3.sequence.fill")
                    } description: {
                        #if os(iOS)
                        Text("Connect your EmperorClaw server to see your agents. Add as many instances as you need.")
                        #else
                        Text("Open Connections on iPhone and choose Send to Apple Watch.")
                        #endif
                    } actions: {
                        #if os(iOS)
                        Button("Connect EmperorClaw") { showConnections = true }.buttonStyle(.borderedProminent)
                        #endif
                    }
                }
            }
            .navigationTitle(agentsOnly ? "Agents" : "EmperorClaw")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button { showConnections = true } label: { Image(systemName: "server.rack") }.accessibilityLabel("Connections") }
            }
            .sheet(isPresented: $showConnections) { ConnectionsView() }
            .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await model.refresh() } } }
        }
    }
}

private struct Metric: View {
    let value: Int; let label: String
    var body: some View { VStack(alignment: .leading) { Text(value, format: .number).font(.largeTitle.bold()).monospacedDigit(); Text(label).font(.caption).foregroundStyle(.secondary) } }
}

struct AgentRow: View {
    let agent: Agent
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(agent.name).font(.headline)
            Label(agent.statusLabel, systemImage: agent.statusLabel == "Working" ? "bolt.fill" : "circle")
                .font(.caption).foregroundStyle(agent.statusLabel == "Working" ? Color.cyan : Color.secondary)
            if let task = agent.taskTitle { Text(task).font(.subheadline).lineLimit(2) }
            else if let activity = agent.activity { Text(activity).font(.subheadline).foregroundStyle(.secondary).lineLimit(2) }
        }.padding(.vertical, 4)
    }
}

struct AgentDetail: View {
    let agent: Agent
    var body: some View {
        List {
            Section { Label(agent.statusLabel, systemImage: "circle.fill"); Text(agent.role).foregroundStyle(.secondary) }
            if let title = agent.taskTitle { Section("Current task") { Text(title) } }
            if let activity = agent.activity { Section("Activity") { Text(activity) } }
            if let seen = agent.lastSeenAt, let date = ISO8601DateFormatter().date(from: seen) { Section("Last seen") { Text(date, style: .relative) } }
        }.navigationTitle(agent.name)
    }
}

struct ConnectionsView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    @State private var add = false
    @State private var query = ""
    @State private var disconnect: Installation?
    @State private var sending = false
    var body: some View {
        NavigationStack {
            List {
                ForEach(model.sortedInstallations.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || $0.server.absoluteString.localizedCaseInsensitiveContains(query) }) { installation in
                    Section {
                        Button { model.select(installation.id); dismiss() } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(installation.name).font(.headline)
                                    Text(installation.server.host ?? "").font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if model.selectedID == installation.id { Image(systemName: "checkmark.circle.fill").accessibilityLabel("Selected") }
                            }
                        }
                        if model.selectedID == installation.id, let companies = model.companies[installation.id], companies.count > 1 {
                            ForEach(companies) { company in
                                Button { model.selectCompany(company.id); dismiss() } label: { Label(company.name, systemImage: company.id == installation.companyID ? "checkmark.circle" : "building.2") }
                            }
                        }
                        #if os(iOS)
                        Button(installation.favorite ? "Remove favorite" : "Favorite", systemImage: installation.favorite ? "star.fill" : "star") { model.toggleFavorite(installation.id) }
                        Button("Reconnect Apple Watch", systemImage: "applewatch") {
                            sending = true
                            Task { await model.watchLink.reconnect(installation); sending = false }
                        }.disabled(sending)
                        Button("Disconnect this iPhone", role: .destructive) { disconnect = installation }
                        #endif
                    }
                }
                #if os(iOS)
                Section {
                    Button("Add instance", systemImage: "plus.circle") { add = true }
                    if !model.installations.isEmpty {
                        Button { sending = true; Task { await model.watchLink.send(); sending = false } } label: { Label(sending ? "Preparing connections…" : "Send to Apple Watch", systemImage: "applewatch") }.disabled(sending)
                    }
                }
                #endif
            }
            .navigationTitle("Connections")
            #if os(iOS)
            .searchable(text: $query, prompt: "Name or server")
            .sheet(isPresented: $add) { ConnectView() }
            #endif
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .confirmationDialog("Revoke this iPhone's connection?", isPresented: Binding(get: { disconnect != nil }, set: { if !$0 { disconnect = nil } })) {
                if let installation = disconnect { Button("Disconnect", role: .destructive) { Task { await model.disconnect(installation) }; disconnect = nil } }
            } message: { Text("Other instances and the separately authorized watch stay connected.") }
        }
    }
}
