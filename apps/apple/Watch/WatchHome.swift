import SwiftUI
import EmperorCore

/// Glanceable wrist home: is the team OK, does anything need me, who is doing what.
struct WatchHome: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var showConnections = false
    @State private var counts: JSONValue = .null
    @State private var inboxLoaded = false
    @State private var spending: JSONValue = .null

    enum ChatTarget: Hashable { case agent(String), team }
    @State private var page = 0
    @State private var chat: ChatTarget?

    var body: some View {
        NavigationStack {
            Group {
                if let workspace = model.selected {
                    let agents = model.snapshots[workspace.id]?.agents ?? []
                    TabView(selection: $page) {
                        WatchOffice(agents: agents, company: model.companyName, needsYou: counts["needsYou"].count) { chat = .agent($0.id) }
                            .tag(0)
                        WatchAgentList(agents: agents, open: { chat = .agent($0.id) }, openTeam: { chat = .team })
                            .tag(1)
                        home(workspace).tag(2)
                    }
                    .tabViewStyle(.page)
                    .navigationDestination(item: $chat) { target in
                        switch target {
                        case .team: WatchAgentChat(workspace: workspace, agent: nil)
                        case .agent(let id): WatchAgentChat(workspace: workspace, agent: agents.first { $0.id == id })
                        }
                    }
                    .task(id: "\(workspace.id):\(workspace.companyID ?? ""):\(scenePhase)") {
                        guard scenePhase == .active else { return }
                        await reload(workspace)
                        while !Task.isCancelled { do { try await Task.sleep(for: .seconds(15)) } catch { break }; await reload(workspace) }
                    }
                    .onAppear { if Self.qa("--qa-team") { page = 1 } }
                    .onChange(of: agents.count) { _, _ in
                        if Self.qa("--qa-agent"), chat == nil, let first = agents.first(where: \.isWorking) { chat = .agent(first.id) }
                    }
                } else { welcome }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showConnections = true } label: { Image(systemName: "arrow.left.arrow.right").foregroundStyle(.black) }.accessibilityLabel("Switch workspace")
                }
            }
            .sheet(isPresented: $showConnections) { ConnectionsView() }
        }
    }

    private func home(_ workspace: Installation) -> some View {
        let snapshot = model.snapshots[workspace.id]
        let agents = (snapshot?.agents ?? []).sorted { $0.isWorking != $1.isWorking ? $0.isWorking : $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        return List {
            hero(snapshot).listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 0, leading: 4, bottom: 6, trailing: 4))
            if let error = model.errors[workspace.id] {
                Label { Text(error).font(.footnote).lineLimit(3) } icon: { Image(systemName: "wifi.exclamationmark").foregroundStyle(.orange) }
            }
            needsYou(workspace)
            if !agents.isEmpty {
                Section {
                    ForEach(agents) { agent in
                        NavigationLink { WatchAgentDetail(agent: agent) } label: { WatchAgentRow(agent: agent) }
                    }
                } header: { SectionLabel(text: "Team", systemImage: "person.3.fill") }
            } else if snapshot == nil {
                HStack { Spacer(); ProgressView(); Spacer() }.listRowBackground(Color.clear)
            }
            Section {
                NavigationLink { ChatScreen(workspace: workspace, title: "Team") } label: { WatchActionRow(title: "Team room", symbol: "person.3.sequence.fill", tint: EmperorTheme.brightAccent) }
                NavigationLink { WorkList(workspace: workspace, kind: "Projects").navigationTitle("Tasks") } label: { WatchActionRow(title: "Tasks", symbol: "checklist", tint: .indigo) }
                if spending != .null {
                    HStack {
                        WatchActionRow(title: "This month", symbol: "chart.line.uptrend.xyaxis", tint: .mint)
                        Spacer()
                        Text(Double(spending["costCents"].count) / 100, format: .currency(code: "USD").precision(.fractionLength(0))).font(.headline).fontDesign(.rounded).monospacedDigit()
                    }.accessibilityElement(children: .combine)
                }
            }
            Section {
                Button { showConnections = true } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(workspace.server.host ?? workspace.name).font(.caption2).foregroundStyle(.secondary)
                        if let date = snapshot.flatMap({ ISO8601DateFormatter.fractional.date(from: $0.updatedAt) ?? ISO8601DateFormatter().date(from: $0.updatedAt) }) {
                            Text("Updated \(date, style: .relative) ago").font(.caption2).foregroundStyle(.tertiary)
                        }
                    }
                }.listRowBackground(Color.clear)
            }
        }
        .listStyle(.carousel)
        .refreshable { await reload(workspace) }
    }

    /// DEBUG-only QA entry points, so screens below the fold can be captured in the simulator.
    private static func qa(_ flag: String) -> Bool {
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains(flag)
        #else
        false
        #endif
    }

    private func hero(_ snapshot: FleetSnapshot?) -> some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                BrandCrown(size: 16)
                Text(model.companyName).font(.title3.weight(.bold)).fontDesign(.rounded).lineLimit(1).minimumScaleFactor(0.7)
                if let snapshot {
                    Text(snapshot.workingCount == 0 ? "Team is idle" : "\(snapshot.workingCount) working")
                        .font(.footnote.weight(.semibold)).foregroundStyle(snapshot.workingCount > 0 ? Color.green : .secondary)
                        .contentTransition(.numericText()).monospacedDigit()
                }
            }
            Spacer(minLength: 0)
            if let snapshot, !snapshot.agents.isEmpty {
                Gauge(value: Double(snapshot.workingCount), in: 0...Double(snapshot.agents.count)) {
                    Image(systemName: "person.3.fill")
                } currentValueLabel: {
                    Text("\(snapshot.workingCount)").fontDesign(.rounded).monospacedDigit()
                }
                .gaugeStyle(.accessoryCircularCapacity).tint(.green)
                .accessibilityLabel("\(snapshot.workingCount) of \(snapshot.agents.count) agents working")
            }
        }
    }

    @ViewBuilder private func needsYou(_ workspace: Installation) -> some View {
        let needs = counts["needsYou"].count
        NavigationLink { WorkList(workspace: workspace, kind: "Inbox").navigationTitle("Inbox") } label: {
            HStack(spacing: 10) {
                Image(systemName: !inboxLoaded ? "tray" : needs > 0 ? "hand.raised.fill" : "checkmark.seal.fill")
                    .font(.title3).foregroundStyle(!inboxLoaded ? Color.secondary : needs > 0 ? Color.orange : Color.green)
                    .symbolEffect(.bounce, value: needs)
                VStack(alignment: .leading, spacing: 1) {
                    if !inboxLoaded { Text("Inbox").font(.headline).fontDesign(.rounded) }
                    else if needs > 0 {
                        Text("\(needs) need\(needs == 1 ? "s" : "") you").font(.headline).fontDesign(.rounded).monospacedDigit()
                        Text([counts["decide"].count > 0 ? "\(counts["decide"].count) to decide" : nil, counts["blocked"].count > 0 ? "\(counts["blocked"].count) blocked" : nil].compactMap { $0 }.joined(separator: " · "))
                            .font(.caption2).foregroundStyle(.secondary)
                    } else {
                        Text("All clear").font(.headline).fontDesign(.rounded)
                        Text("Nothing needs you").font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }.padding(.vertical, 4)
        }
        .listRowBackground(RoundedRectangle(cornerRadius: 16, style: .continuous).fill((inboxLoaded && needs > 0 ? Color.orange : Color.white).opacity(inboxLoaded && needs > 0 ? 0.22 : 0.1)))
    }

    private var welcome: some View {
        ScrollView {
            VStack(spacing: 10) {
                Image("Mascot").resizable().interpolation(.high).scaledToFit().frame(height: 72).accessibilityHidden(true)
                Text("Your team, on your wrist").font(.headline).fontDesign(.rounded).multilineTextAlignment(.center)
                Text("On iPhone, open Connections and choose Send to Apple Watch.").font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }.padding(.horizontal, 6)
        }
    }

    private func reload(_ workspace: Installation) async {
        await model.refresh()
        if let inbox = try? await model.client.work(workspace, path: "inbox") {
            counts = inbox["counts"]; inboxLoaded = true
            model.setNeedsYou(counts["needsYou"].count, for: workspace)
        }
        spending = (try? await model.client.work(workspace, path: "spending")) ?? .null
    }
}

struct BrandCrown: View {
    var size: CGFloat
    var body: some View { Image("Emblem").resizable().interpolation(.high).scaledToFit().frame(height: size).accessibilityHidden(true) }
}

struct WatchAgentRow: View {
    let agent: Agent
    var body: some View {
        HStack(spacing: 10) {
            AgentMonogram(agent: agent, size: 32)
            VStack(alignment: .leading, spacing: 1) {
                Text(agent.name).font(.headline).fontDesign(.rounded).lineLimit(1)
                Text(line).font(.caption2).foregroundStyle(agent.isWorking ? Color.green : .secondary).lineLimit(2)
            }
        }.padding(.vertical, 3).accessibilityElement(children: .combine)
    }
    private var line: String {
        if agent.paused == true { return "Paused" }
        if agent.isWorking, let work = agent.activity ?? agent.taskTitle, !work.isEmpty { return work }
        return agent.statusLabel
    }
}

struct WatchActionRow: View {
    let title: String, symbol: String, tint: Color
    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: symbol).font(.body.weight(.semibold)).foregroundStyle(tint).frame(width: 26)
            Text(title).font(.headline).fontDesign(.rounded)
        }
    }
}

/// Agent card: who, state, current work, and the two things worth doing from a wrist.
struct WatchAgentDetail: View {
    @EnvironmentObject private var model: AppModel
    let agent: Agent
    @State private var control: Bool?
    @State private var busy = false
    @State private var done = 0
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    AgentMonogram(agent: agent, size: 40)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(agent.name).font(.headline).fontDesign(.rounded).lineLimit(2)
                        StatusPill(text: agent.paused == true ? "Paused" : agent.statusLabel, color: agent.statusColor)
                    }
                }
                if let work = agent.taskTitle ?? agent.activity, !work.isEmpty {
                    VStack(alignment: .leading, spacing: 3) {
                        SectionLabel(text: "Now", systemImage: "bolt.fill", tint: .green)
                        Text(work).font(.footnote)
                    }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.cardSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                if let workspace = model.selected {
                    NavigationLink { ChatScreen(workspace: workspace, title: agent.name, agentID: agent.id) } label: {
                        Label("Message", systemImage: "bubble.left.fill").frame(maxWidth: .infinity)
                    }.buttonStyle(.borderedProminent).tint(EmperorTheme.brightAccent).foregroundStyle(.black)
                    if model.mayWrite {
                        Button { control = agent.paused != true } label: {
                            Label(agent.paused == true ? "Resume" : "Pause", systemImage: agent.paused == true ? "play.fill" : "pause.fill").frame(maxWidth: .infinity)
                        }.buttonStyle(.bordered).disabled(busy)
                    }
                }
                if !agent.role.isEmpty { Text(agent.role).font(.caption2).foregroundStyle(.secondary) }
            }.padding(.horizontal, 4)
        }
        .navigationTitle(agent.name)
        .sensoryFeedback(.success, trigger: done)
        .confirmationDialog(control == true ? "Pause \(agent.name)?" : "Resume \(agent.name)?", isPresented: Binding(get: { control != nil }, set: { if !$0 { control = nil } })) {
            if let pause = control, let workspace = model.selected {
                Button(pause ? "Pause" : "Resume", role: pause ? .destructive : nil) {
                    Task {
                        busy = true; defer { busy = false }
                        do { _ = try await model.client.work(workspace, path: "agents/\(agent.id)/pause", method: "PATCH", body: .object(["paused": .bool(pause)])); done += 1; await model.refresh() }
                        catch { model.notice = error.localizedDescription }
                    }
                    control = nil
                }
            }
        }
    }
}
