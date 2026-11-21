import SwiftUI
import EmperorCore

/// Offline web components share presentation with the web; authentication stays native.
struct PhoneSurface: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.openURL) private var openURL
    let workspace: Installation
    var values: [String: JSONValue]
    var selectAgent: (String) -> Void = { _ in }
    var contentHeight: (Double) -> Void = { _ in }
    var body: some View {
        ChatWebView(payload: payload, workspace: workspace, client: model.client,
                    openLink: { openURL($0) }, selectAgent: selectAgent, contentHeight: contentHeight)
    }
    private var payload: JSONValue {
        var data: [String: JSONValue] = ["messages": .array([]), "previews": .array([]), "participants": .array([]), "agentNames": .object([:]), "liveRuns": .array([]), "replyRuns": .object([:]), "hasMore": .bool(false), "loaded": .bool(true), "streaming": .bool(false), "title": .string(""), "locale": .string(Locale.current.identifier), "mayWrite": .bool(false), "forceBottom": .number(0), "loadingOlder": .bool(false)]
        data.merge(values) { _, new in new }
        data["dark"] = .bool(scheme == .dark)
        data["reducedMotion"] = .bool(reduceMotion)
        data["textScale"] = .number(Double(UIFont.preferredFont(forTextStyle: .body).pointSize / 17))
        _ = typeSize // Refresh the payload when Dynamic Type changes.
        return .object(data)
    }
}

struct PhoneHome: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var scene
    @State private var connections = false
    @State private var directory = false
    @State private var selectedAgent: Agent?
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 0) {
                if let workspace = model.selected {
                    VStack(alignment: .leading, spacing: 10) {
                        Button { connections = true } label: {
                            HStack(spacing: 6) { Text(model.companyName).font(.subheadline.weight(.semibold)); Image(systemName: "chevron.down").font(.caption2.bold()) }
                        }.accessibilityHint("Switch instance or company")
                        if let snapshot = model.snapshots[workspace.id] {
                            Label("\(snapshot.workingCount) working · \(snapshot.agents.count) agents", systemImage: "circle.grid.2x2.fill")
                                .font(.subheadline).foregroundStyle(.secondary).monospacedDigit()
                        }
                    }.padding(.horizontal, 24).padding(.top, 12).padding(.bottom, 8).frame(maxWidth: 1200, alignment: .leading).frame(maxWidth: .infinity)
                    if let error = model.errors[workspace.id] {
                        ErrorRow(error: error) { Task { await model.refresh() } }.padding(.horizontal, 24)
                    }
                    if let snapshot = model.snapshots[workspace.id] {
                        if snapshot.agents.isEmpty {
                            ContentUnavailableView("Your team starts here", systemImage: "person.3", description: Text("Agents added to this company will appear here."))
                        } else {
                            PhoneSurface(workspace: workspace, values: ["mode": .string("fleet"), "agents": encodedAgents(snapshot.agents), "fresh": .bool(model.errors[workspace.id] == nil && scene == .active)], selectAgent: { id in selectedAgent = snapshot.agents.first { $0.id == id } })
                        }
                    } else { ProgressView("Bringing your team closer…").frame(maxWidth: .infinity, maxHeight: .infinity) }
                } else {
                    ContentUnavailableView {
                        Label("Your team, wherever you are", systemImage: "person.3.sequence.fill")
                    } description: { Text("Connect an EmperorClaw instance to begin. You can add more and switch anytime.") } actions: {
                        Button("Connect EmperorClaw") { connections = true }.buttonStyle(.borderedProminent)
                    }
                }
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Home").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button { directory = true } label: { Image(systemName: "person.3") }.accessibilityLabel("Agent directory") }
                ToolbarItem(placement: .topBarTrailing) { Button { Task { await model.refresh() } } label: { Image(systemName: "arrow.clockwise") }.accessibilityLabel("Refresh team") }
            }
            .sheet(isPresented: $connections) { ConnectionsView() }
            .sheet(isPresented: $directory) { FleetView(agentsOnly: true) }
            .sheet(item: $selectedAgent) { agent in
                if let workspace = model.selected { NavigationStack { ChatScreen(workspace: workspace, title: agent.name, agentID: agent.id).toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { selectedAgent = nil } } } } }
            }
            .sensoryFeedback(.selection, trigger: selectedAgent?.id)
            .task(id: "\(model.workspaceKey):\(scene)") {
                guard scene == .active else { return }
                await model.refresh()
                while !Task.isCancelled { do { try await Task.sleep(for: .seconds(10)) } catch { break }; guard !Task.isCancelled else { break }; await model.refresh() }
            }
        }
    }
    private func encodedAgents(_ agents: [Agent]) -> JSONValue {
        guard let data = try? JSONEncoder().encode(agents), let value = try? JSONDecoder().decode(JSONValue.self, from: data) else { return .array([]) }
        return value
    }
}

struct ViewsRoot: View {
    @EnvironmentObject private var model: AppModel
    @State private var connections = false
    var body: some View {
        NavigationStack {
            Group {
                if let workspace = model.selected { ViewsDirectory(workspace: workspace) }
                else { ContentUnavailableView("Connect an instance", systemImage: "server.rack", description: Text("Use Connections to choose your EmperorClaw server.")) }
            }
            .navigationTitle("Views")
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { connections = true } label: { Image(systemName: "server.rack") }.accessibilityLabel("Connections") } }
            .sheet(isPresented: $connections) { ConnectionsView() }
        }.id(model.workspaceKey)
    }
}

private struct ViewsDirectory: View {
    @EnvironmentObject private var model: AppModel
    let workspace: Installation
    @State private var views: [WorkItem] = []
    @State private var query = ""
    @State private var error: String?
    @State private var loading = true
    @State private var requestID = UUID()
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                Text("Your team's living reports.").font(.title2.bold()).fontDesign(.rounded)
                Text("Metrics, progress and context, kept together.").font(.subheadline).foregroundStyle(.secondary)
                if let error { ErrorRow(error: error) { Task { await load() } } }
                if loading { ProgressView("Loading views…").frame(maxWidth: .infinity) }
                ForEach(views.filter { query.isEmpty || $0["title"].text.localizedCaseInsensitiveContains(query) }) { view in
                    NavigationLink { PhoneViewDetail(workspace: workspace, id: view.id) } label: {
                        VStack(alignment: .leading, spacing: 12) {
                            HStack { Image(systemName: view["pinned"].flag ? "pin.fill" : "rectangle.3.group").foregroundStyle(.tint); Spacer(); Image(systemName: view["access"].text == "metadata" ? "lock" : "arrow.up.right").foregroundStyle(.secondary) }
                            Text(view["title"].text).font(.title3.bold()).fontDesign(.rounded).foregroundStyle(.primary)
                            if !view["description"].text.isEmpty { Text(view["description"].text).font(.subheadline).foregroundStyle(.secondary).lineLimit(3) }
                            HStack { Text(view["scopeLabel"].text); Spacer(); Text("\(view["panelCount"].count) panels") }.font(.caption).foregroundStyle(.secondary)
                        }.padding(20).frame(maxWidth: .infinity, alignment: .leading).background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 24))
                    }.buttonStyle(.plain)
                }
                if !loading && error == nil && views.isEmpty { ContentUnavailableView("Space for a clearer picture", systemImage: "rectangle.3.group", description: Text("Create a View on the web and it will appear here.")) }
                else if !loading && !query.isEmpty && !views.contains(where: { $0["title"].text.localizedCaseInsensitiveContains(query) }) { ContentUnavailableView.search(text: query) }
            }.padding(24).frame(maxWidth: 760).frame(maxWidth: .infinity)
        }.background(Color(.systemGroupedBackground)).searchable(text: $query, prompt: "Find a view")
            .task { await load() }.refreshable { await load() }
    }
    private func load() async {
        let request = UUID(); requestID = request
        do {
            let result = try await model.client.work(workspace, path: "views")
            try Task.checkCancellation(); guard requestID == request else { return }
            views = result["views"].items.map(WorkItem.init); error = nil
        } catch is CancellationError { return }
        catch { guard requestID == request else { return }; self.error = error.localizedDescription; if (error as? MobileFailure)?.invalidatesContent == true { views = [] } }
        loading = false
    }
}

private struct PhoneViewDetail: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var scene
    let workspace: Installation
    let id: String
    @State private var view: JSONValue?
    @State private var requestID = UUID()
    @State private var error: String?
    var body: some View {
        VStack(spacing: 0) {
            if let error { ErrorRow(error: error) { Task { await load() } }.padding() }
            if let view { PhoneSurface(workspace: workspace, values: ["mode": .string("view"), "view": view]) }
            else if error == nil { ProgressView("Opening view…").frame(maxWidth: .infinity, maxHeight: .infinity) }
        }.background(Color(.systemGroupedBackground)).navigationTitle(view?["title"].text ?? "View").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }.accessibilityLabel("Refresh view") } }
            .task(id: scene) {
                guard scene == .active else { return }; await load()
                while !Task.isCancelled { do { try await Task.sleep(for: .seconds(30)) } catch { break }; await load() }
            }
    }
    private func load() async {
        let request = UUID(); requestID = request
        do { let result = try await model.client.work(workspace, path: "views/\(id)"); try Task.checkCancellation(); guard requestID == request else { return }; view = result["view"]; error = nil }
        catch is CancellationError { return }
        catch { guard requestID == request else { return }; self.error = error.localizedDescription; if (error as? MobileFailure)?.invalidatesContent == true { view = nil } }
    }
}
