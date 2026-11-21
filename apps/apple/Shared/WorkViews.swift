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
            Section { Text(model.companyName).font(.caption).foregroundStyle(.secondary) }
            if let error { Section { ErrorRow(error: error) { Task { await load() } } } }
            if loading && rows.isEmpty { ProgressView("Loading…") }
            if isTasks {
                Picker("Show", selection: $filter) { ForEach(["All", "Active", "Blocked", "Completed"], id: \.self) { Text($0) } }
                #if os(iOS)
                Button("New task", systemImage: "plus.circle") { create = true }.disabled(!model.mayWrite)
                #endif
            }
            ForEach(rows.filter { item in
                guard isTasks else { return true }
                let state = item["state"].text
                return filter == "All" || (filter == "Blocked" && state == "blocked") || (filter == "Completed" && ["done", "cancelled"].contains(state)) || (filter == "Active" && !["done", "cancelled", "blocked"].contains(state))
            }) { item in
                if isTasks {
                    NavigationLink { TaskScreen(workspace: workspace, id: item.id) } label: { WorkRow(title: item["title"].text, subtitle: item["state"].text, icon: "checklist") }
                } else if !item["approvalId"].text.isEmpty {
                    NavigationLink { ApprovalScreen(workspace: workspace, id: item["approvalId"].text) } label: { WorkRow(title: item["title"].text, subtitle: item["reason"].text, icon: "hand.raised") }
                } else if !item["taskId"].text.isEmpty {
                    NavigationLink { TaskScreen(workspace: workspace, id: item["taskId"].text) } label: { WorkRow(title: item["title"].text, subtitle: item["reason"].text, icon: "exclamationmark.bubble") }
                } else {
                    NavigationLink { AttentionDetail(workspace: workspace, item: item) } label: { WorkRow(title: item["title"].text, subtitle: item["reason"].text, icon: "bubble.left") }
                }
            }
            if !loading && rows.isEmpty && error == nil { Label(isTasks ? "No tasks yet" : "Nothing needs your attention", systemImage: "checkmark.circle").foregroundStyle(.secondary) }
            if isTasks, nextBefore != nil { Button("Load older tasks") { Task { await load(older: true) } } }
        }
        .refreshable { await load() }
        .task(id: scene) {
            guard scene == .active else { return }
            await load()
            while !Task.isCancelled { do { try await Task.sleep(for: .seconds(20)) } catch { break }; await load() }
        }
        .sheet(isPresented: $create, onDismiss: { Task { await load() } }) { NavigationStack { NewTaskScreen(workspace: workspace) } }
    }
    private func load(older: Bool = false) async {
        do {
            let result = try await model.client.work(workspace, path: isTasks ? "tasks" : "inbox", query: older ? ["before": nextBefore ?? ""] : [:])
            let incoming = result[isTasks ? "tasks" : "entries"].items.map(WorkItem.init)
            if older { let ids = Set(rows.map(\.id)); rows += incoming.filter { !ids.contains($0.id) } } else { rows = incoming }
            nextBefore = result["nextBefore"].text.isEmpty ? nil : result["nextBefore"].text
            error = nil
        } catch { self.error = error.localizedDescription; if (error as? MobileFailure)?.invalidatesContent == true { rows = [] } }
        loading = false
    }
}

struct WorkRow: View {
    let title: String; let subtitle: String; let icon: String
    var body: some View { VStack(alignment: .leading, spacing: 6) { Label(title, systemImage: icon).font(.headline); if !subtitle.isEmpty { Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(3) } }.padding(.vertical, 5) }
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
    var body: some View {
        List {
            if let error { ErrorRow(error: error) { Task { await load() } } }
            Section("Company") { NavigationLink("Team conversation") { ChatScreen(workspace: workspace, title: "Team") } }
            Section("Agents") {
                ForEach(model.snapshots[workspace.id]?.agents ?? []) { agent in
                    NavigationLink { ChatScreen(workspace: workspace, title: agent.name, agentID: agent.id) } label: { AgentRow(agent: agent) }
                }
            }
            if !groups.isEmpty {
                Section("Groups") { ForEach(groups) { group in NavigationLink(group["title"].text.isEmpty ? "Group conversation" : group["title"].text) { ChatScreen(workspace: workspace, title: group["title"].text, groupID: group.id) } } }
            }
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
    @State private var messages: [WorkItem] = []
    @State private var previews: [WorkItem] = []
    @State private var draft = ""
    @State private var sendID = UUID()
    @State private var sending = false
    @State private var error: String?
    @State private var attachments: [JSONValue] = []
    @State private var importing = false
    @State private var directID: String?
    @State private var chatOptions: [WorkItem] = []
    @State private var showChats = false
    @State private var newChat = false
    @State private var hasMore = false
    @State private var previewURL: URL?
    @State private var createTask = false
    @State private var attemptedText: String?
    @Environment(\.scenePhase) private var scene
    var key: String { "draft:\(workspace.id):\(workspace.companyID ?? ""):\(agentID ?? groupID ?? "team"):\(directID ?? "main")" }
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
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        if hasMore { Button("Load earlier messages") { Task { await load(older: true) } } }
                        ForEach(messages) { message in
                            VStack(alignment: .leading, spacing: 5) {
                                Text(message["senderType"].text == "human" ? "You" : title).font(.caption.bold()).foregroundStyle(.secondary)
                                Text(.init(message["text"].text))
                                let files = message["metadataJson"]["attachments"].items
                                ForEach(Array(files.enumerated()), id: \.offset) { _, file in
                                    Button(file["name"].text.isEmpty ? "Open attachment" : file["name"].text) { Task { await openAttachment(file) } }
                                }
                                if message["senderType"].text == "human" { Text(message["deliveryState"].text == "failed" ? "Delivery failed" : "Received by server").font(.caption2).foregroundStyle(.secondary) }
                            }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(message["senderType"].text == "human" ? Color.cyan.opacity(0.10) : Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 14)).id(message.id)
                        }
                        ForEach(previews) { preview in Text(.init(preview["text"].text)).padding(12).background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14)) }
                        Color.clear.frame(height: 1).id("bottom")
                    }.padding()
                }.onChange(of: messages.count) { _, _ in if !hasMore { proxy.scrollTo("bottom", anchor: .bottom) } }
            }
            if let error { Text(error).font(.caption).foregroundStyle(.orange).padding(8) }
            if error != nil { Button("Start a new message") { draft = ""; attachments = []; sendID = UUID(); error = nil } .font(.caption) }
            if !attachments.isEmpty { Text("\(attachments.count) attachment(s) ready").font(.caption).padding(5) }
            HStack(alignment: .bottom, spacing: 10) {
                #if os(iOS)
                Button { importing = true } label: { Image(systemName: "paperclip").frame(minWidth: 44, minHeight: 44) }.accessibilityLabel("Attach file").disabled(sending)
                #endif
                TextField("Message or dictate…", text: $draft, axis: .vertical).lineLimit(1...5).accessibilityLabel("Message").disabled(sending)
                Button { Task { await send() } } label: { Image(systemName: sending ? "hourglass" : "arrow.up.circle.fill").font(.title2).frame(minWidth: 44, minHeight: 44) }.disabled(sending || (draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty) || !model.mayWrite).accessibilityLabel("Send message")
            }.padding(10).background(.thinMaterial)
        }
        .navigationTitle(title)
        .onAppear { draft = UserDefaults.standard.string(forKey: key) ?? ""; if let saved = UserDefaults.standard.string(forKey: key + ":command"), let id = UUID(uuidString: saved) { sendID = id }; if draft.isEmpty, let context { draft = "\(context)\n\n" } }
        .onChange(of: draft) { _, value in UserDefaults.standard.set(value, forKey: key); if let attemptedText, attemptedText != value, !sending { sendID = UUID(); self.attemptedText = nil; UserDefaults.standard.removeObject(forKey: key + ":command") } }
        .task(id: "\(scene):\(directID ?? "")") {
            guard scene == .active else { return }; await load()
            while !Task.isCancelled { do { try await Task.sleep(for: .seconds(4)) } catch { break }; await load() }
        }
        .toolbar {
            if agentID != nil { ToolbarItem(placement: .topBarTrailing) { Button("Chats") { Task { await listChats() } } } }
            #if os(iOS)
            ToolbarItem(placement: .topBarTrailing) { Button { createTask = true } label: { Image(systemName: "checklist") }.accessibilityLabel("Create task from conversation") }
            #endif
        }
        .sheet(isPresented: $createTask) { NavigationStack { NewTaskScreen(workspace: workspace, initialText: messages.suffix(6).map { $0["text"].text }.joined(separator: "\n\n")) } }
        .sheet(isPresented: $showChats) {
            NavigationStack { List {
                Button("Main conversation") { directID = nil; messages = []; showChats = false }
                ForEach(chatOptions) { chat in Button(chat["title"].text.isEmpty ? "Conversation" : chat["title"].text) { directID = chat.id; messages = []; draft = UserDefaults.standard.string(forKey: key) ?? ""; showChats = false } }
                Button("New conversation") { newChat = true; directID = nil; messages = []; draft = ""; showChats = false }
            }.navigationTitle("Conversations") }
        }
        #if os(iOS)
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item]) { result in
            Task { do { let url = try result.get(); let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }; let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0; guard size <= 25 * 1024 * 1024 else { throw MobileFailure.responseTooLarge }; let data = try Data(contentsOf: url); let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"; let file = try await model.client.upload(workspace, data: data, name: url.lastPathComponent, mime: mime, commandID: UUID()); attachments.append(file) } catch { self.error = error.localizedDescription } }
        }
        .quickLookPreview($previewURL)
        #endif
    }
    private func load(older: Bool = false) async {
        do {
            var q = query
            if older { q["before"] = messages.first?["createdAt"].text }
            let response = try await model.client.work(workspace, path: "chat", query: q)
            let incoming = response["messages"].items.map(WorkItem.init)
            if older { let ids = Set(messages.map(\.id)); messages = incoming.filter { !ids.contains($0.id) } + messages }
            else { let ids = Set(incoming.map(\.id)); messages = messages.filter { !ids.contains($0.id) } + incoming; messages.sort { $0["createdAt"].text < $1["createdAt"].text } }
            hasMore = response["hasMore"].flag
            var previewQuery = query; previewQuery["previews"] = "1"
            let live = try await model.client.work(workspace, path: "chat", query: previewQuery)
            previews = live["previews"].items.filter { $0["state"].text == "streaming" || $0["state"].text == "open" }.map { value in var map = ["id": JSONValue.string(value["responseId"].text)]; map["text"] = value["text"]; return WorkItem(.object(map)) }
            error = nil
        } catch { self.error = error.localizedDescription; if (error as? MobileFailure)?.invalidatesContent == true { messages = []; previews = [] } }
    }
    private func send() async {
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
            if newChat { directID = result["thread"]["id"].text; newChat = false }
            draft = ""; attachments = []; sendID = UUID(); error = nil; await load()
            UserDefaults.standard.removeObject(forKey: savedDraftKey)
            UserDefaults.standard.removeObject(forKey: savedDraftKey + ":command"); attemptedText = nil
        } catch { self.error = error.localizedDescription }
    }
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
                if !task["description"].text.isEmpty { Text(.init(task["description"].text)) }
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
            ForEach(["text", "note", "body", "summary", "status"], id: \.self) { field in if !entry[field].text.isEmpty { Text(.init(entry[field].text)) } }
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
                Text(.init(approval["rationale"].text))
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
        Text(item["title"].text).font(.headline); Text(item["reason"].text)
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
