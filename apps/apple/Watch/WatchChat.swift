import SwiftUI
import AVFoundation
import EmperorCore

/// Page 2: everyone you can talk to, like Messages on iPhone.
struct WatchAgentList: View {
    let agents: [Agent]
    let open: (Agent) -> Void
    let openTeam: () -> Void
    @Environment(\.isLuminanceReduced) private var dimmed
    var body: some View {
        List {
            Button(action: openTeam) {
                HStack(spacing: 10) {
                    Image(systemName: "person.3.sequence.fill").font(.body.weight(.semibold)).foregroundStyle(.black)
                        .frame(width: 34, height: 34).background(EmperorTheme.brightAccent, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Team room").font(.system(.headline, design: .rounded))
                        Text("Everyone at once").font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            ForEach(agents.sorted { a, b in a.isWorking != b.isWorking ? a.isWorking : a.name.localizedStandardCompare(b.name) == .orderedAscending }) { agent in
                Button { open(agent) } label: {
                    HStack(spacing: 10) {
                        PixelAvatar(look: CharacterLook.resolve(id: agent.id, appearance: agent.avatarAppearance),
                                    mood: agent.isWorking ? .focused : (agent.statusLabel == "Offline" ? .sleepy : .happy),
                                    ghost: agent.statusLabel == "Offline", size: 34, animated: agent.isWorking && !dimmed, seed: CharacterLook.hash(agent.id))
                            .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .overlay(alignment: .bottomTrailing) { Circle().fill(agent.statusColor).frame(width: 9, height: 9).overlay(Circle().stroke(Color.black, lineWidth: 2)).offset(x: 2, y: 2) }
                        VStack(alignment: .leading, spacing: 1) {
                            Text(agent.name).font(.system(.headline, design: .rounded)).lineLimit(1)
                            Text(line(agent)).font(.caption2).foregroundStyle(agent.isWorking ? Color.green : .secondary).lineLimit(2)
                        }
                    }.padding(.vertical, 2)
                }
            }
        }
        .listStyle(.carousel)
        .navigationTitle("Agents")
    }
    private func line(_ agent: Agent) -> String {
        if agent.paused == true { return "Paused" }
        if agent.isWorking, let work = agent.activity ?? agent.taskTitle, !work.isEmpty { return work }
        return agent.statusLabel
    }
}

/// An agent's conversation on the wrist: readable bubbles, live "thinking",
/// and replies by voice note, dictation or a quick tap.
struct WatchAgentChat: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var scene
    let workspace: Installation
    let agent: Agent?
    @State private var transcript = ChatTranscript()
    @State private var draft = ""
    @State private var sending = false
    @State private var error: String?
    @State private var recording = false
    @State private var sentTick = 0

    private var title: String { agent?.name ?? "Team" }
    private var query: [String: String] { var q = ["limit": "30"]; if let agent { q["targetAgentId"] = agent.id }; return q }
    private var working: Bool { transcript.liveRuns.contains { $0["status"].text == "running" } || !transcript.previews.isEmpty }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    if let agent {
                        HStack(spacing: 8) {
                            PixelAvatar(look: CharacterLook.resolve(id: agent.id, appearance: agent.avatarAppearance), mood: working ? .focused : .happy, size: 40, seed: CharacterLook.hash(agent.id))
                            VStack(alignment: .leading, spacing: 1) {
                                Text(agent.name).font(.system(.headline, design: .rounded)).lineLimit(1)
                                Text(working ? "Working…" : agent.statusLabel).font(.caption2).foregroundStyle(working ? Color.green : .secondary)
                            }
                        }.padding(.bottom, 2)
                    }
                    if !transcript.loaded { ProgressView().frame(maxWidth: .infinity) }
                    ForEach(transcript.messages.suffix(20)) { message in bubble(message).id(message.id) }
                    if working { thinking.id("thinking").transition(.opacity.combined(with: .scale(scale: 0.9, anchor: .leading))) }
                    if let error { Text(error).font(.caption2).foregroundStyle(.orange) }
                    replyBar.id("bottom").padding(.top, 4)
                }
                .padding(.horizontal, 2)
                .animation(.smooth(duration: 0.35), value: transcript.messages.count)
                .animation(.smooth(duration: 0.35), value: working)
            }
            .defaultScrollAnchor(.bottom)
            .onChange(of: transcript.messages.count) { _, _ in withAnimation(.smooth) { proxy.scrollTo("bottom", anchor: .bottom) } }
        }
        .navigationTitle(title)
        .sheet(isPresented: $recording) { WatchVoiceRecorder { url, duration in Task { await sendVoice(url, duration) } } }
        .sensoryFeedback(.success, trigger: sentTick)
        .sensoryFeedback(.error, trigger: error)
        .task(id: "\(scene)") {
            guard scene == .active else { return }
            await load()
            while !Task.isCancelled { do { try await Task.sleep(for: .seconds(working ? 2 : 4)) } catch { break }; await load() }
        }
    }

    @ViewBuilder private func bubble(_ message: WorkItem) -> some View {
        let mine = message["senderType"].text == "human"
        let text = message["text"].text
        let files = message["metadataJson"]["attachments"].items
        if !mine, text.range(of: #"^\s*\[no-reply\]\s*$"#, options: .regularExpression) != nil { EmptyView() } else {
            HStack {
                if mine { Spacer(minLength: 18) }
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(files.enumerated()), id: \.offset) { _, file in
                        Label(file["name"].text.lowercased().hasPrefix("voice note") ? "Voice note" : file["name"].text,
                              systemImage: file["contentType"].text.hasPrefix("audio") ? "waveform" : file["contentType"].text.hasPrefix("image") ? "photo" : "doc")
                            .font(.caption2.weight(.semibold)).lineLimit(1)
                    }
                    if !text.isEmpty && !(files.count > 0 && text.hasPrefix("Voice note (")) {
                        Text(Self.readable(text)).font(.system(size: 14)).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.horizontal, 9).padding(.vertical, 6)
                .background(mine ? EmperorTheme.brightAccent.opacity(0.28) : Color.white.opacity(0.1), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                if !mine { Spacer(minLength: 12) }
            }
        }
    }

    /// Inline Markdown on the watch; long replies are trimmed to stay glanceable.
    static func readable(_ text: String) -> AttributedString {
        var t = text.replacingOccurrences(of: #"```[\s\S]*?```"#, with: "[code]", options: .regularExpression)
        t = t.replacingOccurrences(of: #"(?m)^#{1,6}\s*"#, with: "", options: .regularExpression)
        if t.count > 700 { t = String(t.prefix(700)) + "…" }
        return (try? AttributedString(markdown: t, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(t)
    }

    private var thinking: some View {
        let summary = transcript.liveRuns.first { $0["status"].text == "running" }?["current"]["summary"].text ?? ""
        return HStack(spacing: 6) {
            TimelineView(.animation(minimumInterval: 1.0 / 12)) { tl in
                HStack(spacing: 3) {
                    ForEach(0..<3, id: \.self) { i in
                        let p = (tl.date.timeIntervalSinceReferenceDate * 2.4 - Double(i) * 0.25).truncatingRemainder(dividingBy: 1.2)
                        Circle().fill(Color.white.opacity(p < 0.6 ? 0.4 + p : 0.4)).frame(width: 5, height: 5).offset(y: p < 0.6 ? -3 * sin(p / 0.6 * .pi) : 0)
                    }
                }
            }
            if !summary.isEmpty { Text(summary).font(.caption2).foregroundStyle(.secondary).lineLimit(1) }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(Color.white.opacity(0.08), in: Capsule())
    }

    private var replyBar: some View {
        VStack(spacing: 6) {
            HStack(spacing: 6) {
                Button { recording = true } label: {
                    Image(systemName: "mic.fill").font(.title3.weight(.semibold)).foregroundStyle(.black)
                        .frame(maxWidth: .infinity, minHeight: 40).background(EmperorTheme.brightAccent, in: Capsule())
                }.buttonStyle(.plain).accessibilityLabel("Record voice message").disabled(sending || !model.mayWrite)
                TextField("Reply", text: $draft).frame(minHeight: 40).accessibilityLabel("Reply by dictation or scribble")
                    .onSubmit { Task { await send(draft) } }.disabled(sending || !model.mayWrite)
            }
            HStack(spacing: 6) {
                ForEach(["👍", "Go ahead", "OK"], id: \.self) { quick in
                    Button { Task { await send(quick) } } label: { Text(quick).lineLimit(1).minimumScaleFactor(0.7) }
                        .font(.caption2.weight(.semibold)).buttonStyle(.bordered).controlSize(.mini).disabled(sending || !model.mayWrite)
                }
            }
            if sending { ProgressView().controlSize(.small) }
        }
    }

    // MARK: network

    private func load() async {
        do {
            let response = try await model.client.work(workspace, path: "chat", query: query)
            guard !Task.isCancelled else { return }
            transcript.receive(response)
            var live = query; live["previews"] = "1"
            transcript.receivePreviews(try await model.client.work(workspace, path: "chat", query: live))
            error = nil
        } catch is CancellationError { } catch { self.error = error.localizedDescription }
    }

    private func send(_ text: String, attachments: [String] = []) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty, !sending else { return }
        sending = true; defer { sending = false }
        let id = UUID()
        var body: [String: JSONValue] = ["text": .string(trimmed), "clientMessageId": .string(id.uuidString), "attachments": .array(attachments.map(JSONValue.string))]
        if let agent { body["targetAgentId"] = .string(agent.id) }
        do {
            _ = try await model.client.work(workspace, path: "chat", method: "POST", body: .object(body), commandID: id)
            draft = ""; error = nil; sentTick += 1
            await load()
        } catch { self.error = error.localizedDescription }
    }

    private func sendVoice(_ url: URL, _ duration: TimeInterval) async {
        defer { try? FileManager.default.removeItem(at: url) }
        guard let data = try? Data(contentsOf: url) else { error = "The voice message could not be read."; return }
        let length = Duration.seconds(duration).formatted(.time(pattern: .minuteSecond))
        sending = true
        do {
            let file = try await model.client.upload(workspace, data: data, name: "Voice note \(length).m4a", mime: "audio/mp4", commandID: UUID())
            sending = false
            await send("Voice note (\(length))", attachments: [file["id"].text])
        } catch { sending = false; self.error = error.localizedDescription }
    }
}

/// Full-screen recorder: breathing ring that follows your voice, timer, cancel / send.
struct WatchVoiceRecorder: View {
    let done: (URL, TimeInterval) -> Void
    @Environment(\.dismiss) private var dismiss
    @StateObject private var recorder = WristRecorder()
    var body: some View {
        VStack(spacing: 8) {
            ZStack {
                Circle().fill(Color.red.opacity(0.18)).scaleEffect(1 + recorder.level * 0.35).animation(.smooth(duration: 0.12), value: recorder.level)
                Circle().stroke(Color.red.opacity(0.6), lineWidth: 2).scaleEffect(1 + recorder.level * 0.2)
                Image(systemName: "mic.fill").font(.system(size: 26, weight: .semibold)).foregroundStyle(.red)
                    .symbolEffect(.pulse, isActive: recorder.isRecording)
            }.frame(width: 84, height: 84)
            Text(Duration.seconds(recorder.elapsed), format: .time(pattern: .minuteSecond))
                .font(.system(.title3, design: .rounded).weight(.semibold)).monospacedDigit().contentTransition(.numericText())
            if let message = recorder.error { Text(message).font(.caption2).foregroundStyle(.orange).multilineTextAlignment(.center) }
            HStack(spacing: 10) {
                Button { recorder.cancel(); dismiss() } label: { Image(systemName: "xmark").frame(maxWidth: .infinity) }.tint(.gray).accessibilityLabel("Discard")
                Button {
                    if let note = recorder.stop() { done(note.url, note.duration) }
                    dismiss()
                } label: { Image(systemName: "arrow.up").frame(maxWidth: .infinity) }.tint(EmperorTheme.brightAccent).disabled(!recorder.isRecording).accessibilityLabel("Send voice message")
            }
        }
        .task { await recorder.start() }
        .sensoryFeedback(.start, trigger: recorder.isRecording)
    }
}

@MainActor final class WristRecorder: ObservableObject {
    @Published private(set) var isRecording = false
    @Published private(set) var elapsed: TimeInterval = 0
    @Published private(set) var level: CGFloat = 0
    @Published var error: String?
    private var recorder: AVAudioRecorder?
    private var timer: Timer?

    func start() async {
        guard await AVAudioApplication.requestRecordPermission() else { error = "Allow the microphone in Settings."; return }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .spokenAudio)
            try session.setActive(true)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("voice-\(UUID().uuidString).m4a")
            let recorder = try AVAudioRecorder(url: url, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 22_050, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 32_000])
            recorder.isMeteringEnabled = true
            guard recorder.record() else { error = "Recording could not start."; return }
            self.recorder = recorder; isRecording = true
            timer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { [weak self] _ in Task { @MainActor in self?.tick() } }
        } catch { self.error = "Recording could not start." }
    }
    private func tick() {
        guard let recorder, recorder.isRecording else { return }
        recorder.updateMeters()
        level = CGFloat(max(0, min(1, pow(10, recorder.averagePower(forChannel: 0) / 40))))
        elapsed = recorder.currentTime
        if elapsed >= 120 { _ = stop() }
    }
    func stop() -> (url: URL, duration: TimeInterval)? {
        guard let recorder else { return nil }
        let duration = recorder.currentTime
        recorder.stop(); finish()
        return duration >= 0.5 ? (recorder.url, duration) : nil
    }
    func cancel() { recorder?.stop(); recorder?.deleteRecording(); finish() }
    private func finish() { timer?.invalidate(); timer = nil; recorder = nil; isRecording = false; level = 0; try? AVAudioSession.sharedInstance().setActive(false) }
}
