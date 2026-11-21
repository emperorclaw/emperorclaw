import SwiftUI
import PhotosUI
import AVFoundation
import UniformTypeIdentifiers
import EmperorCore

/// Something attached to the draft: uploading, ready, or failed.
struct ComposerAttachment: Identifiable, Equatable {
    enum Kind: Equatable { case image(UIImage), document(String), voice(TimeInterval) }
    let id = UUID()
    let name: String
    let kind: Kind
    var uploaded: JSONValue?
    var failed: String?
    var isUploading: Bool { uploaded == nil && failed == nil }
}

/// The chat composer: text that accepts pasted images, a + menu for photos and
/// files, an attachment tray, and hold-free voice notes (tap to record, tap to send).
struct ChatComposer: View {
    @Binding var draft: String
    let placeholder: String
    let canWrite: Bool
    let sending: Bool
    let tray: [ComposerAttachment]
    let onSend: () -> Void
    let onAttach: (Data, String, String, ComposerAttachment.Kind) -> Void
    let onRemove: (UUID) -> Void
    let onPickFiles: () -> Void
    let onVoiceNote: (URL, TimeInterval) -> Void

    @StateObject private var recorder = VoiceRecorder()
    @State private var photos: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var textHeight: CGFloat = 36
    @State private var focused = false
    @State private var pulse = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var hasText: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var uploading: Bool { tray.contains { $0.isUploading } }
    private var canSend: Bool { canWrite && !sending && !uploading && (hasText || tray.contains { $0.uploaded != nil }) }
    private var showMic: Bool { !hasText && tray.isEmpty && canWrite }

    var body: some View {
        VStack(spacing: 8) {
            if !tray.isEmpty { trayView.transition(.move(edge: .bottom).combined(with: .opacity)) }
            Group {
                if recorder.isRecording { recordingBar.transition(.asymmetric(insertion: .push(from: .trailing), removal: .push(from: .leading))) }
                else { inputRow.transition(.asymmetric(insertion: .push(from: .leading), removal: .push(from: .trailing))) }
            }
            if let message = recorder.error { Text(message).font(.caption).foregroundStyle(.orange).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 6) }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(.bar)
        .animation(.smooth(duration: 0.35), value: recorder.isRecording)
        .animation(.snappy(duration: 0.3), value: tray.map(\.id))
        .animation(.snappy(duration: 0.25), value: showMic)
        .photosPicker(isPresented: $showPhotos, selection: $photos, maxSelectionCount: 6, matching: .images)
        .onChange(of: photos) { _, items in
            guard !items.isEmpty else { return }
            Task {
                for item in items {
                    if let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) {
                        let jpeg = image.jpegData(compressionQuality: 0.85) ?? data
                        onAttach(jpeg, "Photo \(Date().formatted(.dateTime.hour().minute().second())).jpg", "image/jpeg", .image(image))
                    }
                }
                photos = []
            }
        }
        .sensoryFeedback(.impact(weight: .medium), trigger: recorder.isRecording)
    }

    // MARK: Input row

    private var inputRow: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Menu {
                Button { showPhotos = true } label: { Label("Photos", systemImage: "photo.on.rectangle") }
                Button { onPickFiles() } label: { Label("Files", systemImage: "doc") }
                if UIPasteboard.general.hasImages {
                    Button { pasteImages(UIPasteboard.general.images ?? []) } label: { Label("Paste image", systemImage: "doc.on.clipboard") }
                }
            } label: {
                Image(systemName: "plus").font(.body.weight(.semibold)).foregroundStyle(.secondary)
                    .frame(width: 36, height: 36).background(Color.cardSurface, in: Circle())
            }
            .frame(minWidth: 44, minHeight: 44).disabled(sending || !canWrite).accessibilityLabel("Add attachment")

            HStack(alignment: .bottom, spacing: 6) {
                ZStack(alignment: .topLeading) {
                    if draft.isEmpty {
                        Text(placeholder).foregroundStyle(.tertiary).padding(.top, 8).padding(.leading, 5).allowsHitTesting(false).lineLimit(1)
                    }
                    PasteableTextView(text: $draft, height: $textHeight, isFocused: $focused, onPasteImages: pasteImages)
                        .frame(height: textHeight)
                        .disabled(sending || !canWrite)
                        .accessibilityLabel("Message")
                }
                .padding(.leading, 10)
                trailingButton.padding(4)
            }
            .background(Color.cardSurface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(focused ? Color.accentColor.opacity(0.45) : Color.secondary.opacity(0.18)))
            .animation(.smooth(duration: 0.25), value: focused)
            .animation(.smooth(duration: 0.3), value: textHeight)
        }
    }

    @ViewBuilder private var trailingButton: some View {
        if showMic {
            Button { Task { await recorder.start() } } label: {
                Image(systemName: "mic.fill").font(.body.weight(.semibold)).foregroundStyle(.secondary)
                    .frame(width: 30, height: 30)
            }
            .accessibilityLabel("Record voice note")
            .transition(.scale(scale: 0.6).combined(with: .opacity))
        } else {
            Button(action: onSend) {
                Image(systemName: sending || uploading ? "ellipsis" : "arrow.up").font(.body.weight(.bold))
                    .foregroundStyle(canSend ? Color.white : Color.secondary)
                    .frame(width: 30, height: 30).background(canSend ? Color.accentColor : Color.secondary.opacity(0.2), in: Circle())
                    .symbolEffect(.variableColor.iterative, isActive: sending || uploading)
                    .contentTransition(.symbolEffect(.replace))
            }
            .disabled(!canSend).accessibilityLabel(uploading ? "Uploading attachments" : "Send message")
            .transition(.scale(scale: 0.6).combined(with: .opacity))
        }
    }

    // MARK: Recording

    private var recordingBar: some View {
        HStack(spacing: 12) {
            Button { recorder.cancel() } label: {
                Image(systemName: "trash").font(.body.weight(.semibold)).foregroundStyle(.red)
                    .frame(width: 36, height: 36).background(Color.red.opacity(0.12), in: Circle())
            }.frame(minWidth: 44, minHeight: 44).accessibilityLabel("Discard voice note")

            HStack(spacing: 10) {
                Circle().fill(Color.red).frame(width: 9, height: 9)
                    .opacity(pulse || reduceMotion ? 1 : 0.3)
                    .onAppear { withAnimation(.easeInOut(duration: 0.8).repeatForever()) { pulse = true } }
                    .onDisappear { pulse = false }
                if recorder.isLive {
                    Text(Duration.seconds(recorder.elapsed), format: .time(pattern: .minuteSecond))
                        .font(.body.weight(.semibold)).fontDesign(.rounded).monospacedDigit()
                        .contentTransition(.numericText())
                    VoiceLevels(levels: recorder.levels).frame(height: 26)
                } else {
                    Text("Starting…").font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                }
            }
            .padding(.horizontal, 14).frame(maxWidth: .infinity, minHeight: 44)
            .background(Color.cardSurface, in: Capsule())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Recording, \(Int(recorder.elapsed)) seconds")

            Button {
                if let note = recorder.stop() { onVoiceNote(note.url, note.duration) }
            } label: {
                Image(systemName: "arrow.up").font(.body.weight(.bold)).foregroundStyle(.white)
                    .frame(width: 36, height: 36).background(recorder.isLive ? Color.accentColor : Color.secondary.opacity(0.4), in: Circle())
            }.frame(minWidth: 44, minHeight: 44).disabled(!recorder.isLive).accessibilityLabel("Send voice note")
        }
    }

    // MARK: Tray

    private var trayView: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(tray) { item in
                    AttachmentChip(item: item) { onRemove(item.id) }
                        .transition(.scale(scale: 0.85).combined(with: .opacity))
                }
            }.padding(.horizontal, 4).padding(.top, 4)
        }.scrollIndicators(.hidden)
    }

    private func pasteImages(_ images: [UIImage]) {
        for image in images.prefix(6) {
            guard let data = image.jpegData(compressionQuality: 0.85) else { continue }
            onAttach(data, "Pasted image \(Date().formatted(.dateTime.hour().minute().second())).jpg", "image/jpeg", .image(image))
        }
    }
}

private struct AttachmentChip: View {
    let item: ComposerAttachment
    let remove: () -> Void
    var body: some View {
        HStack(spacing: 8) {
            preview.frame(width: 40, height: 40).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.footnote.weight(.semibold)).lineLimit(1)
                Text(status).font(.caption2).foregroundStyle(item.failed != nil ? Color.red : .secondary).lineLimit(1)
            }.frame(maxWidth: 140, alignment: .leading)
            Button(action: remove) { Image(systemName: "xmark.circle.fill").font(.body).foregroundStyle(.secondary).symbolRenderingMode(.hierarchical) }
                .accessibilityLabel("Remove \(item.name)")
        }
        .padding(6).padding(.trailing, 4)
        .background(Color.cardSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(alignment: .topLeading) { if item.isUploading { ProgressView().controlSize(.mini).padding(17) } }
    }
    @ViewBuilder private var preview: some View {
        switch item.kind {
        case .image(let image): Image(uiImage: image).resizable().scaledToFill().opacity(item.isUploading ? 0.45 : 1)
        case .document: Image(systemName: "doc.fill").font(.title3).foregroundStyle(Color.accentColor).frame(maxWidth: .infinity, maxHeight: .infinity).background(Color.accentColor.opacity(0.12))
        case .voice: Image(systemName: "waveform").font(.title3).foregroundStyle(.orange).frame(maxWidth: .infinity, maxHeight: .infinity).background(Color.orange.opacity(0.14))
        }
    }
    private var title: String {
        if case .voice(let duration) = item.kind { return "Voice note · \(Duration.seconds(duration).formatted(.time(pattern: .minuteSecond)))" }
        return item.name
    }
    private var status: String { item.failed ?? (item.isUploading ? "Uploading…" : "Ready") }
}

/// Live input level bars for the recorder.
private struct VoiceLevels: View {
    let levels: [CGFloat]
    var body: some View {
        GeometryReader { geo in
            let count = max(1, Int(geo.size.width / 5))
            let shown = Array(levels.suffix(count))
            HStack(alignment: .center, spacing: 2) {
                ForEach(Array(shown.enumerated()), id: \.offset) { _, level in
                    Capsule().fill(Color.accentColor).frame(width: 3, height: max(3, level * geo.size.height))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
            .animation(.smooth(duration: 0.12), value: levels.count)
        }
    }
}

/// A UITextView that grows with its content (up to six lines) and accepts
/// pasted images, which SwiftUI's TextField cannot.
struct PasteableTextView: UIViewRepresentable {
    @Binding var text: String
    @Binding var height: CGFloat
    @Binding var isFocused: Bool
    let onPasteImages: ([UIImage]) -> Void

    func makeUIView(context: Context) -> ImagePasteTextView {
        let view = ImagePasteTextView()
        view.delegate = context.coordinator
        view.onPasteImages = onPasteImages
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(top: 8, left: 0, bottom: 8, right: 0)
        view.isScrollEnabled = false
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }
    func updateUIView(_ view: ImagePasteTextView, context: Context) {
        if view.text != text { view.text = text }
        view.onPasteImages = onPasteImages
        DispatchQueue.main.async { recalc(view) }
    }
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    private func recalc(_ view: UITextView) {
        guard view.bounds.width > 0 else { return }
        let line = view.font?.lineHeight ?? 20
        let maxHeight = line * 6 + view.textContainerInset.top + view.textContainerInset.bottom
        let fitting = view.sizeThatFits(CGSize(width: view.bounds.width, height: .greatestFiniteMagnitude)).height
        let next = min(maxHeight, max(36, fitting))
        view.isScrollEnabled = fitting > maxHeight
        if abs(next - height) > 0.5 { height = next }
    }
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: PasteableTextView
        init(_ parent: PasteableTextView) { self.parent = parent }
        func textViewDidChange(_ view: UITextView) { parent.text = view.text; parent.recalc(view) }
        func textViewDidBeginEditing(_ view: UITextView) { parent.isFocused = true }
        func textViewDidEndEditing(_ view: UITextView) { parent.isFocused = false }
    }
}

final class ImagePasteTextView: UITextView {
    var onPasteImages: (([UIImage]) -> Void)?
    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)) && UIPasteboard.general.hasImages { return true }
        return super.canPerformAction(action, withSender: sender)
    }
    override func paste(_ sender: Any?) {
        let board = UIPasteboard.general
        if board.hasImages, let images = board.images, !images.isEmpty {
            onPasteImages?(images)
            if board.hasStrings, let string = board.string, !string.isEmpty { super.paste(sender) }
        } else { super.paste(sender) }
    }
}

/// Records AAC voice notes with live metering. Audio setup runs off the main
/// thread with a timeout, so a stalled input device can never freeze the UI.
@MainActor final class VoiceRecorder: NSObject, ObservableObject {
    @Published private(set) var isRecording = false   // recording bar visible (starting or live)
    @Published private(set) var isLive = false        // microphone actually capturing
    @Published private(set) var elapsed: TimeInterval = 0
    @Published private(set) var levels: [CGFloat] = []
    @Published var error: String?
    private var recorder: AVAudioRecorder?
    private var timer: Timer?
    private var attempt = UUID()
    private let maxDuration: TimeInterval = 10 * 60

    private final class Box: @unchecked Sendable { let recorder: AVAudioRecorder; init(_ recorder: AVAudioRecorder) { self.recorder = recorder } }

    func start() async {
        error = nil
        guard await AVAudioApplication.requestRecordPermission() else {
            error = "Allow microphone access in Settings to record voice notes."; return
        }
        let current = UUID(); attempt = current
        elapsed = 0; levels = []; isLive = false; isRecording = true
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("voice-\(UUID().uuidString).m4a")
        let setup = Task.detached(priority: .userInitiated) { () throws -> Box in
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.defaultToSpeaker, .allowBluetoothHFP])
            try session.setActive(true)
            let recorder = try AVAudioRecorder(url: url, settings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44_100, AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 64_000, AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
            ])
            recorder.isMeteringEnabled = true
            guard recorder.record() else { throw CocoaError(.fileWriteUnknown) }
            return Box(recorder)
        }
        let timeout = Task { try? await Task.sleep(for: .seconds(5)); setup.cancel() }
        let result = await setup.result
        timeout.cancel()
        guard attempt == current, isRecording else {
            // Cancelled while starting: discard whatever started late.
            if case .success(let box) = result { box.recorder.stop(); box.recorder.deleteRecording() }
            return
        }
        switch result {
        case .success(let box) where !setup.isCancelled:
            recorder = box.recorder; isLive = true
            timer = Timer.scheduledTimer(withTimeInterval: 0.06, repeats: true) { [weak self] _ in Task { @MainActor in self?.tick() } }
        case .success(let box):
            box.recorder.stop(); box.recorder.deleteRecording(); fail("The microphone didn’t respond. Try again.")
        case .failure:
            fail(setup.isCancelled ? "The microphone didn’t respond. Try again." : "Recording could not start.")
        }
    }
    private func fail(_ message: String) { error = message; finish() }
    private func tick() {
        guard let recorder, recorder.isRecording else { return }
        recorder.updateMeters()
        let power = recorder.averagePower(forChannel: 0) // -160...0 dB
        levels.append(CGFloat(max(0.05, min(1, pow(10, power / 40)))))
        if levels.count > 120 { levels.removeFirst(levels.count - 120) }
        elapsed = recorder.currentTime
        if elapsed >= maxDuration { _ = stop() }
    }
    func stop() -> (url: URL, duration: TimeInterval)? {
        guard let recorder else { cancel(); return nil }
        let duration = recorder.currentTime
        recorder.stop(); finish()
        guard duration >= 0.5 else { try? FileManager.default.removeItem(at: recorder.url); return nil }
        return (recorder.url, duration)
    }
    func cancel() {
        attempt = UUID()
        if let recorder { recorder.stop(); recorder.deleteRecording() }
        finish()
    }
    private func finish() {
        timer?.invalidate(); timer = nil; recorder = nil; isRecording = false; isLive = false
        Task.detached { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
    }
}
