import SwiftUI
import EmperorCore
import WidgetKit
#if os(iOS)
import UniformTypeIdentifiers
import QuickLook
#endif

struct WorkRoot: View {
    @EnvironmentObject var model: AppModel
    let kind: String
    @State private var connections = false
    var body: some View {
        NavigationStack {
            Group {
                if let workspace = model.selected {
                    if kind == "Messages" { ChatDirectory(workspace: workspace) }
                    else { WorkList(workspace: workspace, kind: kind) }
                } else { ContentUnavailableView("Connect an instance", systemImage: "server.rack", description: Text("Open Connections to add your EmperorClaw server.")) }
            }
            .navigationTitle(kind)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { connections = true } label: { Image(systemName: "server.rack") }.accessibilityLabel("Connections") } }
            .sheet(isPresented: $connections) { ConnectionsView() }
        }.id(model.workspaceKey)
    }
}

struct WorkList: View {
    @EnvironmentObject var model: AppModel
    let workspace: Installation
    let kind: String
    @State private var rows: [WorkItem] = []
    @State private var error: String?
    @State private var loading = true
    @State private var create = false
    @State private var filter = "All"
    @State private var nextBefore: String?
    @Environment(\.scenePhase) private var scene
    var isTasks: Bool { kind == "Projects" }
    var body: some View {
        List {
            if let error { Section { ErrorRow(error: error) { Task { await load() } } } }
            if loading && rows.isEmpty { ProgressView("Loading…") }
            if isTasks {
                #if os(iOS)
                Section {
                    ScrollView(.horizontal) {
                        HStack(spacing: 8) {
                            ForEach(["All", "Active", "Blocked", "Completed"], id: \.self) { value in
                                FilterChip(title: value, count: count(for: value), selected: filter == value) { withAnimation(.snappy) { filter = value } }
                            }
                        }.padding(.vertical, 2)
                    }.scrollIndicators(.hidden)
                }.listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
                #else
                Picker("Show", selection: $filter) { ForEach(["All", "Active", "Blocked", "Completed"], id: \.self) { Text($0) } }
                #endif
            }
            if isTasks {
                ForEach(rows.filter { matches($0, filter) }) { item in
                    NavigationLink { TaskScreen(workspace: workspace, id: item.id) } label: { TaskRow(item: item, assignee: agentName(item["assignedAgentId"].text)) }
                }
            } else {
                ForEach(inboxGroups, id: \.title) { group in
                    Section {
                        ForEach(group.items) { item in inboxLink(item, tint: group.tint) }
                    } header: {
                        SectionLabel(text: group.title, systemImage: group.icon, tint: group.tint).textCase(nil)
                    }
                }
            }
            if !loading && rows.isEmpty && error == nil {
                if isTasks { Label("No tasks yet", systemImage: "checklist").foregroundStyle(.secondary) }
                else {
                    ContentUnavailableView {
                        VStack(spacing: 14) {
                            Image("Mascot").resizable().interpolation(.high).scaledToFit().frame(height: 120).accessibilityHidden(true)
                            Text("You’re all caught up").font(.title3.bold()).fontDesign(.rounded)
                        }
                    } description: { Text("Decisions, blockers and mentions from your team will land here.") }
                    .listRowBackground(Color.clear)
                }
            }
            if isTasks, nextBefore != nil { Button("Load older tasks") { Task { await load(older: true) } } }
        }
        #if os(iOS)
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Color(.systemGroupedBackground))
        #endif
        .refreshable { await load() }
        .sensoryFeedback(.selection, trigger: filter)
        #if os(iOS)
        .toolbar { if isTasks { ToolbarItem(placement: .topBarLeading) { Button { create = true } label: { Image(systemName: "plus") }.disabled(!model.mayWrite).accessibilityLabel("New task") } } }
        #endif
        .task(id: scene) {
            guard scene == .active else { return }
            await load()
            while !Task.isCancelled { do { try await Task.sleep(for: .seconds(20)) } catch { break }; await load() }
        }
        .sheet(isPresented: $create, onDismiss: { Task { await load() } }) { NavigationStack { NewTaskScreen(workspace: workspace) } }
    }
    private func matches(_ item: WorkItem, _ filter: String) -> Bool {
        let state = item["state"].text
        return filter == "All" || (filter == "Blocked" && state == "blocked") || (filter == "Completed" && ["done", "cancelled"].contains(state)) || (filter == "Active" && !["done", "cancelled", "blocked"].contains(state))
    }
    private func count(for filter: String) -> Int? { filter == "All" ? nil : rows.filter { matches($0, filter) }.count }
    private func agentName(_ id: String) -> String? { id.isEmpty ? nil : model.snapshots[workspace.id]?.agents.first { $0.id == id }?.name }
    private struct InboxGroup { let title: String; let icon: String; let tint: Color; let items: [WorkItem] }
    private static let actionKinds: Set<String> = ["approval", "decision", "incident", "agent", "paused", "run_failed", "task_blocked", "request", "stalled"]
    /// Same three sections as the web Inbox (attention-rules.ts), most urgent first.
    private var inboxGroups: [InboxGroup] {
        func needsYou(_ item: WorkItem) -> Bool { if case .bool(let required) = item["actionRequired"] { return required }; return Self.actionKinds.contains(item["kind"].text) }
        let decide = rows.filter { needsYou($0) && ["approval", "decision"].contains($0["kind"].text) }
        let blocked = rows.filter { needsYou($0) && !["approval", "decision"].contains($0["kind"].text) }
        let fyi = rows.filter { !needsYou($0) }
        return [InboxGroup(title: "Needs a decision", icon: "hand.raised.fill", tint: .orange, items: decide),
                InboxGroup(title: "Blocked or failing", icon: "exclamationmark.triangle.fill", tint: .red, items: blocked),
                InboxGroup(title: "For your information", icon: "info.circle.fill", tint: .secondary, items: fyi)].filter { !$0.items.isEmpty }
    }
    @ViewBuilder private func inboxLink(_ item: WorkItem, tint: Color) -> some View {
        let subtitle = [item["memberName"].text, item["reason"].text.isEmpty ? item["detail"].text : item["reason"].text].filter { !$0.isEmpty }.joined(separator: " · ")
        if !item["approvalId"].text.isEmpty {
            NavigationLink { ApprovalScreen(workspace: workspace, id: item["approvalId"].text) } label: { WorkRow(title: item["title"].text, subtitle: subtitle, icon: "hand.raised", tint: tint) }
        } else if !item["taskId"].text.isEmpty {
            NavigationLink { TaskScreen(workspace: workspace, id: item["taskId"].text) } label: { WorkRow(title: item["title"].text, subtitle: subtitle, icon: "exclamationmark.bubble", tint: tint) }
        } else {
            NavigationLink { AttentionDetail(workspace: workspace, item: item) } label: { WorkRow(title: item["title"].text, subtitle: subtitle, icon: "bubble.left", tint: tint) }
        }
    }
    private func load(older: Bool = false) async {
        do {
            let result = try await model.client.work(workspace, path: isTasks ? "tasks" : "inbox", query: older ? ["before": nextBefore ?? ""] : [:])
            let incoming = result[isTasks ? "tasks" : "entries"].items.map(WorkItem.init)
            if older { let ids = Set(rows.map(\.id)); rows += incoming.filter { !ids.contains($0.id) } } else { rows = incoming }
            nextBefore = result["nextBefore"].text.isEmpty ? nil : result["nextBefore"].text
            if !isTasks { model.setNeedsYou(inboxGroups.filter { $0.title != "For your information" }.reduce(0) { $0 + $1.items.count }, for: workspace) }
            error = nil
        } catch { self.error = error.localizedDescription; if (error as? MobileFailure)?.invalidatesContent == true { rows = [] } }
        loading = false
    }
}

struct WorkRow: View {
    let title: String; let subtitle: String; let icon: String
    var tint: Color? = nil
    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            #if os(iOS)
            Image(systemName: icon).font(.title3.weight(.medium)).foregroundStyle(tint ?? Color.accentColor)
                .frame(width: 44, height: 44).background((tint ?? Color.accentColor).opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            #endif
            VStack(alignment: .leading, spacing: 8) {
                Text(title).font(.headline).fontDesign(.rounded).fixedSize(horizontal: false, vertical: true)
                if !subtitle.isEmpty { Text(subtitle.replacingOccurrences(of: "_", with: " ")).font(.subheadline).foregroundStyle(.secondary).lineLimit(3) }
            }
        }.padding(.vertical, 12)
    }
}
struct TaskRow: View {
    let item: WorkItem
    var assignee: String?
    var body: some View {
        let style = TaskStateStyle(item["state"].text)
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: style.symbol).font(.title3).foregroundStyle(style.color).symbolRenderingMode(.hierarchical)
                .frame(width: 36, height: 36).background(style.color.opacity(0.12), in: RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous))
            VStack(alignment: .leading, spacing: 7) {
                Text(item["title"].text).font(.body.weight(.semibold)).fontDesign(.rounded).lineLimit(3).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    StatusPill(text: style.label, color: style.color)
                    if let assignee { Label(assignee, systemImage: "person.crop.circle").labelStyle(.titleAndIcon).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                }
            }
        }.padding(.vertical, 6).accessibilityElement(children: .combine)
    }
}

struct FilterChip: View {
    let title: String
    var count: Int? = nil
    let selected: Bool
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(title)
                if let count, count > 0 { Text(count, format: .number).monospacedDigit().foregroundStyle(selected ? Color.groupedBackground.opacity(0.7) : .secondary) }
            }
            .font(.subheadline.weight(selected ? .semibold : .medium)).fontDesign(.rounded)
            .padding(.horizontal, 14).frame(minHeight: 36)
            .foregroundStyle(selected ? Color.groupedBackground : Color.primary)
            .background(selected ? Color.primary : Color.cardSurface, in: Capsule())
        }.buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct ErrorRow: View {
    let error: String; let retry: () -> Void
    var body: some View { VStack(alignment: .leading, spacing: 8) { Label(error, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.orange); Button("Try again", action: retry) } }
}

struct ChatDirectory: View {
    @EnvironmentObject var model: AppModel
    let workspace: Installation
    @State private var groups: [WorkItem] = []
    @State private var error: String?
    @State private var query = ""
    var body: some View {
        Group {
            #if os(iOS)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: DS.Space.xl) {
                    if let error { ErrorRow(error: error) { Task { await load() } } }
                    NavigationLink { ChatScreen(workspace: workspace, title: "Team") } label: {
                        HStack(spacing: DS.Space.l) {
                            Image(systemName: "person.3.sequence.fill").font(.title3).foregroundStyle(.white).symbolRenderingMode(.hierarchical)
                                .frame(width: 52, height: 52)
                                .background(LinearGradient(colors: [Color.accentColor, Color.accentColor.opacity(0.55)], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Team room").font(.headline).fontDesign(.rounded)
                                Text("Talk to every agent at once").font(.subheadline).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                        }
                        .padding(DS.Space.l)
                        .background(LinearGradient(colors: [Color.accentColor.opacity(0.14), Color.cardSurface], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
                    }.buttonStyle(QuietCardPress())
                    let agents = (model.snapshots[workspace.id]?.agents ?? []).sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }
                    if !agents.isEmpty {
                        VStack(alignment: .leading, spacing: DS.Space.s) {
                            SectionLabel(text: "Agents", systemImage: "sparkles")
                            VStack(spacing: 0) {
                                ForEach(Array(agents.enumerated()), id: \.element.id) { index, agent in
                                    if index > 0 { SoftDivider().padding(.leading, 76) }
                                    NavigationLink { ChatScreen(workspace: workspace, title: agent.name, agentID: agent.id) } label: {
                                        AgentRow(agent: agent).padding(.horizontal, DS.Space.l).padding(.vertical, DS.Space.m).contentShape(Rectangle())
                                    }.buttonStyle(QuietCardPress())
                                }
                            }.background(Color.cardSurface, in: RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
                        }
                    }
                    let visibleGroups = groups.filter { query.isEmpty || $0["title"].text.localizedCaseInsensitiveContains(query) }
                    if !visibleGroups.isEmpty {
                        VStack(alignment: .leading, spacing: DS.Space.s) {
                            SectionLabel(text: "Groups", systemImage: "person.2.fill")
                            VStack(spacing: 0) {
                                ForEach(Array(visibleGroups.enumerated()), id: \.element.id) { index, group in
                                    if index > 0 { SoftDivider().padding(.leading, 76) }
                                    NavigationLink { ChatScreen(workspace: workspace, title: group["title"].text, groupID: group.id) } label: {
                                        WorkRow(title: group["title"].text.isEmpty ? "Group conversation" : group["title"].text, subtitle: "", icon: "person.2.fill").padding(.horizontal, DS.Space.l).contentShape(Rectangle())
                                    }.buttonStyle(QuietCardPress())
                                }
                            }.background(Color.cardSurface, in: RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
                        }
                    }
                }.padding(.horizontal, 20).padding(.vertical, DS.Space.s).frame(maxWidth: 760).frame(maxWidth: .infinity)
            }.background(Color(.systemGroupedBackground)).searchable(text: $query, prompt: "Find a conversation")
            #else
            List {
                if let error { ErrorRow(error: error) { Task { await load() } } }
                NavigationLink("Team conversation") { ChatScreen(workspace: workspace, title: "Team") }
                ForEach(model.snapshots[workspace.id]?.agents ?? []) { agent in NavigationLink { ChatScreen(workspace: workspace, title: agent.name, agentID: agent.id) } label: { AgentRow(agent: agent) } }
                ForEach(groups) { group in NavigationLink(group["title"].text.isEmpty ? "Group conversation" : group["title"].text) { ChatScreen(workspace: workspace, title: group["title"].text, groupID: group.id) } }
            }
            #endif
        }.task { await model.refresh(); await load() }.refreshable { await model.refresh(); await load() }
    }
    private func load() async { do { groups = try await model.client.work(workspace, path: "groups")["groups"].items.map(WorkItem.init); error = nil } catch { self.error = error.localizedDescription } }
}

struct ChatScreen: View {
    @EnvironmentObject var model: AppModel
    let workspace: Installation
    let title: String
    var agentID: String? = nil
    var groupID: String? = nil
    var context: String? = nil
    @State private var transcript = ChatTranscript()
    @State private var loadingOlder = false
    @State private var conversationGeneration = UUID()
    @State private var regularRequest = UUID()
    @State private var forceBottom = 0
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.openURL) private var openURL
    @State private var draft = ""
    @State private var sendID = UUID()
    @State private var sending = false
    @State private var error: String?
    @State private var attachments: [JSONValue] = []
    #if os(iOS)
    @State private var tray: [ComposerAttachment] = []
    #endif
    @State private var importing = false
    @State private var directID: String?
    @State private var chatOptions: [WorkItem] = []
    @State private var showChats = false
    @State private var newChat = false
    @State private var newChatKey = UUID()
    @State private var previewURL: URL?
    @State private var createTask = false
    @State private var attemptedText: String?
    @State private var painted = false
    @Environment(\.scenePhase) private var scene
    var key: String { "draft:\(workspace.id):\(workspace.companyID ?? ""):\(agentID ?? groupID ?? "team"):\(newChat ? "new-" + newChatKey.uuidString : directID ?? "main")" }
    var query: [String: String] {
        var q: [String: String] = ["limit": "50"]
        if let agentID { q["targetAgentId"] = agentID }
        if let groupID { q["threadId"] = groupID }
        if let directID { q["directThreadId"] = directID }
        return q
    }
    var body: some View {
        VStack(spacing: 0) {
            if let context { Text(context).font(.caption).padding(10).frame(maxWidth: .infinity, alignment: .leading).background(.thinMaterial) }
            #if os(iOS)
            ChatWebView(payload: webPayload, workspace: workspace, client: model.client,
                loadOlder: { Task { await load(older: true) } },
                sendPrompt: { prompt in
                    guard !sending, model.mayWrite else { return false }
                    guard draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, attachments.isEmpty else { error = "Send or clear your draft before choosing a reply."; return false }
                    draft = prompt
                    return await send()
                },
                openAttachment: { file in Task { await openAttachment(file) } },
                openLink: { url in openURL(url) },
                didPaintTranscript: { withAnimation(.easeOut(duration: 0.2)) { painted = true } })
                .opacity(painted ? 1 : 0)
                .overlay { if !painted { ProgressView().controlSize(.regular).allowsHitTesting(false) } }
                .id("\(key):\(conversationGeneration)")
                .onChange(of: "\(key):\(conversationGeneration)") { _, _ in painted = false }
            #else
            watchTranscript
            #endif
            if let error { Text(error).font(.caption).foregroundStyle(.orange).padding(8) }
            if error != nil { Button("Start a new message") { draft = ""; attachments = []; sendID = UUID(); error = nil } .font(.caption) }
            #if os(watchOS)
            if !attachments.isEmpty { Text("\(attachments.count) attachment(s) ready").font(.caption).padding(5) }
            #endif
            #if os(iOS)
            ChatComposer(draft: $draft, placeholder: "Message \(title)…", canWrite: model.mayWrite, sending: sending, tray: tray,
                         onSend: { Task { await send() } },
                         onAttach: { data, name, mime, kind in attach(data, name: name, mime: mime, kind: kind) },
                         onRemove: removeAttachment,
                         onPickFiles: { importing = true },
                         onVoiceNote: sendVoiceNote)
            .sensoryFeedback(.impact(weight: .light), trigger: sendID)
            .sensoryFeedback(.error, trigger: error)
            #else
            HStack(alignment: .bottom, spacing: 10) {
                TextField("Message or dictate…", text: $draft, axis: .vertical).lineLimit(1...5).accessibilityLabel("Message").disabled(sending)
                Button { Task { await send() } } label: { Image(systemName: sending ? "hourglass" : "arrow.up.circle.fill").font(.title2).frame(minWidth: 44, minHeight: 44) }.disabled(sending || (draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty) || !model.mayWrite).accessibilityLabel("Send message")
            }.padding(10)
            #endif
        }
        .navigationTitle(title)
        .onAppear { draft = UserDefaults.standard.string(forKey: key) ?? ""; if let saved = UserDefaults.standard.string(forKey: key + ":command"), let id = UUID(uuidString: saved) { sendID = id }; if draft.isEmpty, let context { draft = "\(context)\n\n" } }
        .onChange(of: draft) { _, value in UserDefaults.standard.set(value, forKey: key); if let attemptedText, attemptedText != value, !sending { sendID = UUID(); self.attemptedText = nil; UserDefaults.standard.removeObject(forKey: key + ":command") } }
        .task(id: "\(scene):\(key):\(conversationGeneration)") {
            guard scene == .active else { return }; await load()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .milliseconds(transcript.liveRuns.contains { $0["status"].text == "running" } || !transcript.previews.isEmpty ? 1500 : 3000)) } catch { break }
                await load()
            }
        }
        .toolbar {
            if agentID != nil { ToolbarItem(placement: .topBarTrailing) { Button("Chats") { Task { await listChats() } }.disabled(sending) } }
            #if os(iOS)
            ToolbarItem(placement: .topBarTrailing) { Button { createTask = true } label: { Image(systemName: "checklist") }.accessibilityLabel("Create task from conversation") }
            #endif
        }
        .sheet(isPresented: $createTask) { NavigationStack { NewTaskScreen(workspace: workspace, initialText: transcript.messages.suffix(6).map { $0["text"].text }.joined(separator: "\n\n")) } }
        .sheet(isPresented: $showChats) {
            NavigationStack { List {
                Button("Main conversation") { switchConversation(nil); showChats = false }
                ForEach(chatOptions) { chat in Button(chat["title"].text.isEmpty ? "Conversation" : chat["title"].text) { switchConversation(chat.id); showChats = false } }
                Button("New conversation") { switchConversation(nil); newChatKey = UUID(); newChat = true; draft = ""; sendID = UUID(); showChats = false }
            }.navigationTitle("Conversations") }
        }
        #if os(iOS)
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard let urls = try? result.get() else { return }
            for url in urls.prefix(6) {
                let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
                guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 25 * 1024 * 1024, let data = try? Data(contentsOf: url) else { error = MobileFailure.responseTooLarge.localizedDescription; continue }
                let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                let kind: ComposerAttachment.Kind = mime.hasPrefix("image/") ? (UIImage(data: data).map { .image($0) } ?? .document(url.pathExtension)) : mime.hasPrefix("audio/") ? .voice(0) : .document(url.pathExtension)
                attach(data, name: url.lastPathComponent, mime: mime, kind: kind)
            }
        }
        .quickLookPreview($previewURL)
        #endif
    }
    private var webPayload: JSONValue {
        guard case .object(var data) = transcript.payload else { return .null }
        data["agentNames"] = .object(Dictionary((model.snapshots[workspace.id]?.agents ?? []).map { ($0.id, JSONValue.string($0.name)) }, uniquingKeysWith: { _, b in b }))
        data["title"] = .string(title); data["locale"] = .string(Locale.current.identifier)
        data["mayWrite"] = .bool(model.mayWrite && !sending)
        data["forceBottom"] = .number(Double(forceBottom))
        data["dark"] = .bool(colorScheme == .dark); data["loadingOlder"] = .bool(loadingOlder)
        return .object(data)
    }
    private func switchConversation(_ id: String?) {
        directID = id; newChat = false; transcript = ChatTranscript(); attachments = []; error = nil
        #if os(iOS)
        tray = []
        #endif
        conversationGeneration = UUID(); regularRequest = UUID(); loadingOlder = false; attemptedText = nil
        draft = UserDefaults.standard.string(forKey: key) ?? ""
        sendID = UserDefaults.standard.string(forKey: key + ":command").flatMap(UUID.init(uuidString:)) ?? UUID()
    }
    #if os(watchOS)
    private var watchTranscript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if transcript.hasMore { Button("Load earlier messages") { Task { await load(older: true) } }.disabled(loadingOlder) }
                    ForEach(transcript.messages) { message in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(message["senderType"].text == "human" ? "You" : title).font(.caption.bold()).foregroundStyle(.secondary)
                            Text(.init(message["text"].text))
                        }.id(message.id)
                    }
                    ForEach(visibleWatchPreviews) { preview in
                        VStack(alignment: .leading) {
                            Text(.init(preview["text"].text))
                            Text(preview["state"].text == "streaming" ? "Responding…" : "Response pending or interrupted").font(.caption2)
                        }
                    }
                    ForEach(transcript.liveRuns.filter { $0["status"].text == "running" }.map { WorkItem(.object(["id": $0["runId"], "current": $0["current"]])) }) { run in
                        Label(run["current"]["summary"].text.isEmpty ? "Working…" : run["current"]["summary"].text, systemImage: "gearshape.2").font(.caption)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }.padding(8)
            }
            .defaultScrollAnchor(.bottom)
            .onChange(of: forceBottom) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }
    private var visibleWatchPreviews: [WorkItem] {
        let ids = Set(transcript.messages.map(\.id))
        return transcript.previews.filter { !ids.contains($0["finalMessageId"].text) }.map { value in
            guard case .object(var map) = value else { return WorkItem(value) }
            map["id"] = value["responseId"]; return WorkItem(.object(map))
        }
    }
    #endif
    private func load(older: Bool = false) async {
        if newChat { transcript.receive(.object(["messages": .array([]), "hasMore": .bool(false)])); return }
        let requestKey = key, generation = conversationGeneration, requestID = UUID()
        if older { guard !loadingOlder else { return }; loadingOlder = true }
        else { regularRequest = requestID }
        defer { if older && requestKey == key && generation == conversationGeneration { loadingOlder = false } }
        do {
            var q = query
            if older { q["before"] = transcript.messages.first?["createdAt"].text }
            let response = try await model.client.work(workspace, path: "chat", query: q)
            guard !Task.isCancelled, key == requestKey, conversationGeneration == generation, older || regularRequest == requestID else { return }
            transcript.receive(response, older: older)
            error = nil
            if !older {
                var previewQuery = query; previewQuery["previews"] = "1"
                let live = try await model.client.work(workspace, path: "chat", query: previewQuery)
                guard !Task.isCancelled, key == requestKey, conversationGeneration == generation, regularRequest == requestID else { return }
                transcript.receivePreviews(live)
            }
        } catch {
            guard !Task.isCancelled, key == requestKey, conversationGeneration == generation, older || regularRequest == requestID else { return }
            self.error = error.localizedDescription
            if (error as? MobileFailure)?.invalidatesContent == true { transcript = ChatTranscript() }
        }
    }
    private func send() async -> Bool {
        guard !sending, model.mayWrite else { return false }
        let requestKey = key
        sending = true; defer { sending = false }
        do {
            let savedDraftKey = key
            attemptedText = draft
            UserDefaults.standard.set(sendID.uuidString, forKey: key + ":command")
            let text = context.map { draft.hasPrefix($0) ? draft : "\($0)\n\n\(draft)" } ?? draft
            var body: [String: JSONValue] = ["text": .string(text), "clientMessageId": .string(sendID.uuidString), "attachments": .array(attachments)]
            if let agentID { body["targetAgentId"] = .string(agentID) }; if let groupID { body["threadId"] = .string(groupID) }; if let directID { body["directThreadId"] = .string(directID) }
            if newChat { body["newChat"] = .object(["clientKey": .string(sendID.uuidString)]) }
            let result = try await model.client.work(workspace, path: "chat", method: "POST", body: .object(body), commandID: sendID)
            guard key == requestKey else { return false }
            if newChat { directID = result["thread"]["id"].text; newChat = false }
            draft = ""; attachments = []; sendID = UUID(); error = nil; forceBottom += 1
            #if os(iOS)
            tray = []
            #endif
            await load()
            UserDefaults.standard.removeObject(forKey: savedDraftKey)
            UserDefaults.standard.removeObject(forKey: savedDraftKey + ":command"); attemptedText = nil
            return true
        } catch { if key == requestKey { self.error = error.localizedDescription }; return false }
    }
    #if os(iOS)
    /// Uploads immediately so sending is instant; the chip shows progress or failure.
    private func attach(_ data: Data, name: String, mime: String, kind: ComposerAttachment.Kind) {
        let item = ComposerAttachment(name: name, kind: kind)
        tray.append(item)
        Task {
            do {
                let file = try await model.client.upload(workspace, data: data, name: name, mime: mime, commandID: UUID())
                guard let index = tray.firstIndex(where: { $0.id == item.id }) else { return } // removed meanwhile
                tray[index].uploaded = file; attachments.append(file)
            } catch {
                if let index = tray.firstIndex(where: { $0.id == item.id }) { tray[index].failed = error.localizedDescription }
            }
        }
    }
    private func removeAttachment(_ id: UUID) {
        if let uploaded = tray.first(where: { $0.id == id })?.uploaded { attachments.removeAll { $0["id"] == uploaded["id"] } }
        tray.removeAll { $0.id == id }
    }
    /// Voice notes send as soon as recording stops, like Messages.
    private func sendVoiceNote(_ url: URL, _ duration: TimeInterval) {
        guard let data = try? Data(contentsOf: url) else { error = "The voice note could not be read."; return }
        try? FileManager.default.removeItem(at: url)
        let length = Duration.seconds(duration).formatted(.time(pattern: .minuteSecond))
        let item = ComposerAttachment(name: "Voice note \(length).m4a", kind: .voice(duration))
        tray.append(item)
        Task {
            do {
                let file = try await model.client.upload(workspace, data: data, name: item.name, mime: "audio/mp4", commandID: UUID())
                guard let index = tray.firstIndex(where: { $0.id == item.id }) else { return }
                tray[index].uploaded = file; attachments.append(file)
                if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { draft = "Voice note (\(length))" }
                _ = await send()
            } catch {
                if let index = tray.firstIndex(where: { $0.id == item.id }) { tray[index].failed = error.localizedDescription }
            }
        }
    }
    #endif
    private func listChats() async { guard let agentID else { return }; do { chatOptions = try await model.client.work(workspace, path: "conversations", query: ["agentId": agentID])["chats"].items.map(WorkItem.init); showChats = true } catch { self.error = error.localizedDescription } }
    private func openAttachment(_ file: JSONValue) async {
        #if os(iOS)
        do { previewURL = try await model.client.download(workspace, id: file["id"].text, name: file["name"].text) } catch { self.error = error.localizedDescription }
        #else
        model.notice = "Review attachments on iPhone."
        #endif
    }
}

struct TaskScreen: View {
    @EnvironmentObject var model: AppModel
    let workspace: Installation
    let id: String
    @State private var story: JSONValue = .null
    @State private var note = ""
    @State private var error: String?
    @State private var busy = false
    @State private var commandID = UUID()
    @State private var agent = ""
    @State private var lastBody: JSONValue?
    var task: JSONValue { story["task"] }
    var taskContext: String { "Task: \(task["title"].text) [\(id)]" }
    var body: some View {
        List {
            if let error { ErrorRow(error: error) { Task { await load() } } }
            Section {
                Text(task["title"].text).font(.headline)
                Text(task["state"].text).font(.caption).foregroundStyle(.secondary)
                if !task["description"].text.isEmpty { RichTextBlock(text: task["description"].text, workspace: workspace) }
                if !task["blockedReason"].text.isEmpty { Label(task["blockedReason"].text, systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
                Text(task["projectName"].text).font(.caption)
            }
            Section("Ask about this") {
                ForEach(model.snapshots[workspace.id]?.agents ?? []) { a in TaskAgentChatLink(workspace: workspace, agent: a, context: taskContext) }
            }
            #if os(iOS)
                if model.mayWrite {
                Section("Manage") {
                    Picker("Assign agent", selection: $agent) { Text("Choose agent").tag(""); ForEach(story["assignees"]["agents"].items.map(WorkItem.init)) { a in Text(a["name"].text).tag(a.id) } }
                    Button("Assign") { Task { await mutate(path: "tasks/\(id)", method: "PATCH", body: .object(["assignedAgentId": .string(agent)])) } }.disabled(agent.isEmpty || busy)
                    Menu("Change status") { ForEach(["inbox", "in_progress", "review", "blocked", "done", "failed"], id: \.self) { state in Button(state.replacingOccurrences(of: "_", with: " ")) { Task { await mutate(path: "tasks/\(id)", method: "PATCH", body: .object(["state": .string(state)])) } } } }.disabled(busy)
                    TextField("Comment or dictate…", text: $note, axis: .vertical)
                    Button("Add comment") { Task { if await mutate(path: "tasks/\(id)/notes", method: "POST", body: .object(["comment": .string(note)])) { note = "" } } }.disabled(note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
                }
            }
            #endif
            Section("Activity and results") {
                ForEach(Array(story["entries"].items.enumerated()), id: \.offset) { _, entry in
                    TaskTimelineRow(workspace: workspace, taskID: id, entry: entry)
                }
            }
            if story["hasMore"].flag { Button("Load older activity") { Task { await load(older: true) } } }
        }.navigationTitle("Task").task { await load() }.refreshable { await load() }
    }
    private func load(older: Bool = false) async { do { let result = try await model.client.work(workspace, path: "tasks/\(id)", query: older ? ["before": story["nextBefore"].text] : [:]); if older, case .object(var values) = result { values["entries"] = .array(story["entries"].items + result["entries"].items); story = .object(values) } else { story = result }; error = nil } catch { self.error = error.localizedDescription; if (error as? MobileFailure)?.invalidatesContent == true { story = .null } } }
    private func mutate(path: String, method: String, body: JSONValue) async -> Bool { busy = true; defer { busy = false }; if body != lastBody { commandID = UUID(); lastBody = body }; do { _ = try await model.client.work(workspace, path: path, method: method, body: body, commandID: commandID); commandID = UUID(); lastBody = nil; error = nil; await load(); return true } catch { self.error = error.localizedDescription; return false } }
}

private struct TaskAgentChatLink: View {
    let workspace: Installation
    let agent: Agent
    let context: String
    var body: some View { NavigationLink { ChatScreen(workspace: workspace, title: agent.name, agentID: agent.id, context: context) } label: { Text(agent.name) } }
}

private struct TaskTimelineRow: View {
    @EnvironmentObject var model: AppModel
    let workspace: Installation
    let taskID: String
    let entry: JSONValue
    @State private var fileURL: URL?
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(entry["title"].text.isEmpty ? entry["kind"].text.capitalized : entry["title"].text).font(.headline)
            ForEach(["text", "note", "body", "summary", "status"], id: \.self) { field in if !entry[field].text.isEmpty { RichTextBlock(text: entry[field].text, workspace: workspace) } }
            if entry["kind"].text == "artifact" {
                Button("Open result") {
                    #if os(iOS)
                    Task { do { fileURL = try await model.client.download(workspace, id: entry["id"].text, name: entry["title"].text) } catch { model.notice = error.localizedDescription } }
                    #else
                    model.watchLink.handoff(workspace: workspace, kind: "task", id: taskID)
                    #endif
                }
            }
        }
        #if os(iOS)
        .quickLookPreview($fileURL)
        #endif
    }
}

extension WorkspaceLink: @retroactive Identifiable {
    public var id: String { "\(installationID):\(companyID):\(kind):\(resourceID)" }
}

struct ResourceSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let link: WorkspaceLink
    var body: some View {
        NavigationStack { Group {
            if let workspace = model.selected, workspace.id == link.installationID, workspace.companyID == link.companyID {
                if link.kind == "approval" { ApprovalScreen(workspace: workspace, id: link.resourceID) }
                else if link.kind == "task" { TaskScreen(workspace: workspace, id: link.resourceID) }
                else if let agent = model.snapshots[workspace.id]?.agents.first(where: { $0.id == link.resourceID }) { ChatScreen(workspace: workspace, title: agent.name, agentID: agent.id) }
                else { WorkList(workspace: workspace, kind: "Inbox") }
            }
        }.toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } } }
    }
}

struct NewTaskScreen: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let workspace: Installation
    var initialText = ""
    @State private var title = ""
    @State private var description = ""
    @State private var project = ""
    @State private var agent = ""
    @State private var projects: [WorkItem] = []
    @State private var error: String?
    @State private var busy = false
    @State private var commandID = UUID()
    @State private var lastBody: JSONValue?
    var body: some View {
        Form {
            if let error { Text(error).foregroundStyle(.orange) }
            TextField("Task title", text: $title)
            TextField("Description", text: $description, axis: .vertical).lineLimit(3...8)
            Picker("Project", selection: $project) { Text("General").tag(""); ForEach(projects) { Text($0["goal"].text).tag($0.id) } }
            Picker("Agent", selection: $agent) { Text("Unassigned").tag(""); ForEach(model.snapshots[workspace.id]?.agents ?? []) { Text($0.name).tag($0.id) } }
            Button(busy ? "Creating…" : "Create task") { Task { await create() } }.disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
        }.navigationTitle("New task").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .task { description = initialText; do { projects = try await model.client.work(workspace, path: "projects")["projects"].items.map(WorkItem.init) } catch { self.error = error.localizedDescription } }
    }
    private func create() async { busy = true; defer { busy = false }; do { var body: [String: JSONValue] = ["title": .string(title), "description": .string(description), "useDefaultProject": .bool(project.isEmpty)]; if !project.isEmpty { body["projectId"] = .string(project) }; if !agent.isEmpty { body["assignedAgentId"] = .string(agent) }; let payload = JSONValue.object(body); if lastBody != payload { commandID = UUID(); lastBody = payload }; _ = try await model.client.work(workspace, path: "tasks", method: "POST", body: payload, commandID: commandID); dismiss() } catch { self.error = error.localizedDescription } }
}

struct ApprovalScreen: View {
    @EnvironmentObject var model: AppModel
    let workspace: Installation
    let id: String
    @State private var detail: JSONValue = .null
    @State private var error: String?
    @State private var decision: String?
    @State private var busy = false
    @State private var commandID = UUID()
    @State private var note = ""
    var approval: JSONValue { detail["approval"] }
    var body: some View {
        List {
            if let error { ErrorRow(error: error) { Task { await load() } } }
            Section("Review request") {
                Text(workspace.name).font(.caption).foregroundStyle(.secondary)
                Text(approval["actionType"].text).font(.headline)
                Text(approval["status"].text).font(.caption)
                RichTextBlock(text: approval["rationale"].text, workspace: workspace)
                // The full visible arguments must be reviewed before deciding.
                if approval["actionArgsJson"] != .null { Text(readable(approval["actionArgsJson"])).font(.body.monospaced()) }
                if approval["metadataJson"]["actionArgs"] != .null { Text(readable(approval["metadataJson"]["actionArgs"])).font(.body.monospaced()) }
                if approval["metadataJson"]["args"] != .null { Text(readable(approval["metadataJson"]["args"])).font(.body.monospaced()) }
            }
            ForEach(detail["tasks"].items.map(WorkItem.init)) { task in NavigationLink(task["inputJson"]["title"].text.isEmpty ? "Review affected task" : task["inputJson"]["title"].text) { TaskScreen(workspace: workspace, id: task.id) } }
            if approval["status"].text == "pending" && detail["mobileDecision"]["mayDecide"].flag {
                #if os(watchOS)
                if detail["mobileDecision"]["watchEligible"].flag {
                    Button("Approve") { decision = "approved" }.disabled(busy)
                    Button("Reject", role: .destructive) { decision = "rejected" }.disabled(busy)
                }
                Button("Review on iPhone") { model.watchLink.handoff(workspace: workspace, kind: "approval", id: id) }
                #else
                Section {
                    TextField("Decision note (optional)", text: $note, axis: .vertical)
                    Button("Approve") { decision = "approved" }.disabled(busy)
                    Button("Reject", role: .destructive) { decision = "rejected" }.disabled(busy)
                }
                #endif
            }
        }.navigationTitle("Approval").task { await load() }.refreshable { await load() }
        .confirmationDialog("Confirm this decision for \(workspace.name)?", isPresented: Binding(get: { decision != nil }, set: { if !$0 { decision = nil } })) {
            if let choice = decision { Button(choice == "approved" ? "Approve action" : "Reject action", role: choice == "rejected" ? .destructive : nil) { Task { await decide(choice) }; decision = nil } }
        } message: { Text("The server will check current permissions and whether this request is still pending.") }
    }
    private func load() async { do { detail = try await model.client.work(workspace, path: "approvals/\(id)"); error = nil } catch { self.error = error.localizedDescription; if (error as? MobileFailure)?.invalidatesContent == true { detail = .null } } }
    private func decide(_ status: String) async { busy = true; defer { busy = false }; do { _ = try await model.client.work(workspace, path: "approvals/\(id)", method: "PATCH", body: .object(["status": .string(status), "resolutionNote": .string(note)]), commandID: commandID); commandID = UUID(); await load() } catch { let message = error.localizedDescription; await load(); self.error = message } }
    private func readable(_ value: JSONValue) -> String { let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]; return (try? encoder.encode(value)).flatMap { String(data: $0, encoding: .utf8) } ?? "" }
}

struct AttentionDetail: View {
    @EnvironmentObject var model: AppModel
    let workspace: Installation
    let item: WorkItem
    var body: some View { List {
        Text(item["title"].text).font(.headline); RichTextBlock(text: item["reason"].text, workspace: workspace)
        if let agent = model.snapshots[workspace.id]?.agents.first(where: { $0.id == item["agentId"].text }) { NavigationLink("Ask \(agent.name)") { ChatScreen(workspace: workspace, title: agent.name, agentID: agent.id, context: item["title"].text) } }
        Button("Mark read") { Task { do { _ = try await model.client.work(workspace, path: "inbox/state", method: "POST", body: .object(["items": .array([.object(["key": .string(item.id), "fingerprint": item["fingerprint"]])]), "action": .string("read")])) } catch { model.notice = error.localizedDescription } } }
    }.navigationTitle("Needs you") }
}

struct HomeSummary: View {
    @EnvironmentObject var model: AppModel
    let workspace: Installation
    @State private var count: Int?
    @State private var spending: JSONValue = .null
    var body: some View {
        Section("Needs you") { NavigationLink { WorkList(workspace: workspace, kind: "Inbox").navigationTitle("Inbox") } label: { Label(count.map { "\($0) need your attention" } ?? "Review your inbox", systemImage: "tray") } }
        if spending != .null { Section("This month · estimated") { Text(Double(spending["costCents"].count) / 100, format: .currency(code: "USD")).font(.title2.bold()); if spending["budgetCents"].count > 0 { Text("Budget: \(Double(spending["budgetCents"].count) / 100, format: .currency(code: "USD"))").font(.caption) } } }
        Section("Work") { NavigationLink("Tasks and results") { WorkList(workspace: workspace, kind: "Projects").navigationTitle("Tasks") } }
        .task(id: model.snapshots[workspace.id]?.updatedAt) { do { count = try await model.client.work(workspace, path: "inbox")["counts"]["needsYou"].count; if let snapshot = model.snapshots[workspace.id], let company = workspace.companyID { WidgetCache.write(.init(installationID: workspace.id, companyID: company, name: "\(workspace.name) · \(model.companyName)", working: snapshot.workingCount, total: snapshot.agents.count, needsYou: count, date: Date())); WidgetCenter.shared.reloadAllTimelines() } } catch { count = nil }; spending = (try? await model.client.work(workspace, path: "spending")) ?? .null }
    }
}
