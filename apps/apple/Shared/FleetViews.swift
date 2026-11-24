import SwiftUI
import EmperorCore

enum EmperorTheme {
    /// Adaptive brand teal from the asset catalog: 5.5:1+ on light surfaces, 8:1+ on dark.
    static let accent = Color("AccentColor")
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
                        if !agentsOnly { HomeSummary(workspace: selected) }
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
                    .task(id: "\(selected.id):\(selected.companyID ?? ""):\(scenePhase)") {
                        guard scenePhase == .active else { return }; await model.refresh()
                        while !Task.isCancelled { do { try await Task.sleep(for: .seconds(15)) } catch { break }; await model.refresh() }
                    }
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
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showConnections = true } label: {
                        #if os(watchOS)
                        Image(systemName: "ellipsis").foregroundStyle(.black)
                        #else
                        Image(systemName: "server.rack")
                        #endif
                    }.accessibilityLabel("Connections")
                }
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
        #if os(iOS)
        HStack(spacing: 14) {
            AgentMonogram(agent: agent, size: 46)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text(agent.name).font(.headline).fontDesign(.rounded).foregroundStyle(.primary).lineLimit(1)
                    Spacer(minLength: 8)
                    Text(agent.paused == true ? "Paused" : agent.statusLabel).font(.caption.weight(.semibold)).foregroundStyle(agent.isWorking ? Color.green : .secondary)
                }
                if let line = agent.activity ?? agent.taskTitle, !line.isEmpty {
                    Text(line).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                } else { Text(agent.role.isEmpty ? "Ready when you are" : agent.role).font(.subheadline).foregroundStyle(.secondary).lineLimit(1) }
            }
        }
        .accessibilityElement(children: .combine)
        #else
        VStack(alignment: .leading, spacing: 5) {
            Text(agent.name).font(.headline)
            Label(agent.statusLabel, systemImage: agent.statusLabel == "Working" ? "bolt.fill" : "circle")
                .font(.caption).foregroundStyle(agent.statusLabel == "Working" ? Color.cyan : Color.secondary)
            if agent.paused == true { Text("New work paused").font(.caption).foregroundStyle(.orange) }
            if let task = agent.taskTitle { Text(task).font(.subheadline).lineLimit(2) }
            else if let activity = agent.activity { Text(activity).font(.subheadline).foregroundStyle(.secondary).lineLimit(2) }
        }.padding(.vertical, 4)
        #endif
    }
}

struct AgentDetail: View {
    @EnvironmentObject var model: AppModel
    let agent: Agent
    @State private var control: Bool?
    @State private var busy = false
    var body: some View {
        List {
            if let workspace = model.selected {
                NavigationLink("Chat with \(agent.name)") { ChatScreen(workspace: workspace, title: agent.name, agentID: agent.id) }
                if model.mayWrite {
                    Button("Pause agent") { control = true }.disabled(busy)
                    Button("Resume agent") { control = false }.disabled(busy)
                }
            }
            Section { Label(agent.statusLabel, systemImage: "circle.fill"); Text(agent.role).foregroundStyle(.secondary) }
            if let title = agent.taskTitle { Section("Current task") { Text(title) } }
            if let activity = agent.activity { Section("Activity") { Text(activity) } }
            if let seen = agent.lastSeenAt, let date = ISO8601DateFormatter().date(from: seen) { Section("Last seen") { Text(date, style: .relative) } }
        }.navigationTitle(agent.name)
        .confirmationDialog(control == true ? "Pause this agent?" : "Resume this agent?", isPresented: Binding(get: { control != nil }, set: { if !$0 { control = nil } })) {
            if let pause = control, let workspace = model.selected { Button(pause ? "Pause" : "Resume") { Task { busy = true; defer { busy = false }; do { _ = try await model.client.work(workspace, path: "agents/\(agent.id)/pause", method: "PATCH", body: .object(["paused": .bool(pause)])); await model.refresh() } catch { model.notice = error.localizedDescription } }; control = nil } }
        }
    }
}

struct ConnectionsView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    @State private var add = false
    @State private var query = ""
    @State private var disconnect: Installation?
    @State private var sending = false
    @State private var renaming: Installation?
    @State private var newName = ""
    @State private var reauth: Installation?
    @AppStorage("appearance") private var appearance = "system"
    var body: some View {
        NavigationStack {
            List {
                #if os(iOS)
                Picker("Appearance", selection: $appearance) { Text("System").tag("system"); Text("Light").tag("light"); Text("Dark").tag("dark") }
                #endif
                ForEach(model.sortedInstallations.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || $0.server.absoluteString.localizedCaseInsensitiveContains(query) }) { installation in
                    Section {
                        NavigationLink { NotificationsView(workspace: installation) } label: { Label("Notifications", systemImage: "bell") }
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
                        if model.expired.contains(installation.id) {
                            Button("Sign in again", systemImage: "person.crop.circle.badge.exclamationmark") { reauth = installation }
                        }
                        Button("Rename instance") { newName = installation.name; renaming = installation }
                        Button(installation.favorite ? "Remove favorite" : "Favorite", systemImage: installation.favorite ? "star.fill" : "star") { model.toggleFavorite(installation.id) }
                        Button("Reconnect Apple Watch", systemImage: "applewatch") {
                            sending = true
                            Task { await model.watchLink.reconnect(installation); sending = false }
                        }.disabled(sending)
                        Button("Disconnect this iPhone", role: .destructive) { disconnect = installation }
                        #else
                        Button("Disconnect this watch", role: .destructive) { disconnect = installation }
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
            .sheet(item: $reauth) { ConnectView(reauth: $0) }
            #endif
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .confirmationDialog("Disconnect this device?", isPresented: Binding(get: { disconnect != nil }, set: { if !$0 { disconnect = nil } })) {
                if let installation = disconnect { Button("Disconnect", role: .destructive) { Task { await model.disconnect(installation) }; disconnect = nil } }
            } message: { Text("Only this device's selected connection is revoked. Other instances and devices stay connected.") }
            .alert("Rename instance", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("Instance name", text: $newName)
                Button("Save") { if let installation = renaming { model.rename(installation.id, name: newName) }; renaming = nil }
                Button("Cancel", role: .cancel) { renaming = nil }
            }
        }
    }
}
