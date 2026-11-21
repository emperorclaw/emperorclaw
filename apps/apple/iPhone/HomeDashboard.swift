import SwiftUI
import EmperorCore

/// The crown emblem from the web's branding, used as the app's signature mark.
struct BrandMark: View {
    var size: CGFloat = 22
    var body: some View {
        Image("Emblem").resizable().interpolation(.high).scaledToFit()
            .frame(height: size).accessibilityLabel("EmperorClaw")
    }
}

/// Greeting, workspace switcher and a live team pulse — the first thing a
/// person reads, so it answers "is my team OK?" in one glance.
struct HomeHeader: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let snapshot: FleetSnapshot?
    let switchWorkspace: () -> Void
    @State private var pulse = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(greeting).font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
            Button(action: switchWorkspace) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(model.companyName).font(.largeTitle.weight(.bold)).fontDesign(.rounded).tracking(-0.5)
                        .foregroundStyle(.primary).lineLimit(1).minimumScaleFactor(0.7)
                    Image(systemName: "chevron.down").font(.subheadline.weight(.bold)).foregroundStyle(.tint)
                }
            }.buttonStyle(.plain).accessibilityHint("Switch instance or company")
            if let snapshot {
                HStack(spacing: 10) {
                    HStack(spacing: 7) {
                        Circle().fill(snapshot.workingCount > 0 ? Color.green : Color.secondary).frame(width: 8, height: 8)
                            .overlay { if snapshot.workingCount > 0 && !reduceMotion { Circle().fill(Color.green.opacity(0.45)).scaleEffect(pulse ? 2.6 : 1).opacity(pulse ? 0 : 0.8) } }
                        Text(snapshot.workingCount == 0 ? "Team is idle" : "\(snapshot.workingCount) working").contentTransition(.numericText())
                    }
                    Text("·").foregroundStyle(.tertiary)
                    Text("\(snapshot.agents.count) agents")
                }
                .font(.subheadline.weight(.medium)).monospacedDigit().foregroundStyle(.secondary)
                .accessibilityElement(children: .combine)
                .onAppear { withAnimation(.easeOut(duration: 1.6).repeatForever(autoreverses: false)) { pulse = true } }
            }
        }
    }
    private var greeting: String {
        switch Calendar.current.component(.hour, from: Date()) {
        case 5..<12: "Good morning"
        case 12..<19: "Good afternoon"
        default: "Good evening"
        }
    }
}

/// What needs a person right now, from the same Inbox rules as the web:
/// decisions first, then blockers. One tap opens the decision itself.
struct NeedsYouCard: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var scene
    let workspace: Installation
    var refreshKey = 0
    @State private var entries: [WorkItem] = []
    @State private var counts: JSONValue = .null
    @State private var loaded = false
    @State private var failed = false
    private static let actionKinds: Set<String> = ["approval", "decision", "incident", "agent", "paused", "run_failed", "task_blocked", "request", "stalled"]

    private var urgent: [WorkItem] {
        entries.filter { entry in
            if case .bool(let required) = entry["actionRequired"] { return required }
            return Self.actionKinds.contains(entry["kind"].text)
        }.sorted { isDecision($0) && !isDecision($1) }
    }
    private func isDecision(_ entry: WorkItem) -> Bool { ["approval", "decision"].contains(entry["kind"].text) }

    var body: some View {
        Group {
            if !loaded { placeholder }
            else if urgent.isEmpty { allClear }
            else { needsYou }
        }
        .animation(.snappy, value: urgent.map(\.id))
        .task(id: "\(refreshKey):\(scene)") {
            guard scene == .active else { return }
            await load()
            while !Task.isCancelled { do { try await Task.sleep(for: .seconds(20)) } catch { break }; await load() }
        }
    }

    private var needsYou: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Label { Text("Needs you").font(.title3.weight(.bold)).fontDesign(.rounded) } icon: { Image(systemName: "bell.badge.fill").foregroundStyle(.orange).symbolRenderingMode(.hierarchical).symbolEffect(.bounce, value: urgent.count) }
                Spacer()
                HStack(spacing: 6) {
                    if counts["decide"].count > 0 { CountChip(value: counts["decide"].count, label: "to decide", color: .orange) }
                    if counts["blocked"].count > 0 { CountChip(value: counts["blocked"].count, label: "blocked", color: .red) }
                }
            }.padding(.bottom, 12)
            ForEach(Array(urgent.prefix(3).enumerated()), id: \.element.id) { index, entry in
                if index > 0 { SoftDivider().padding(.leading, 52) }
                NavigationLink { destination(entry) } label: { NeedsYouRow(entry: entry, decision: isDecision(entry)) }.buttonStyle(QuietCardPress())
            }
            if urgent.count > 3 || counts["fyi"].count > 0 {
                SoftDivider().padding(.top, 4)
                Button { model.tab = 1 } label: {
                    HStack { Text(urgent.count > 3 ? "See all \(urgent.count) in Inbox" : "Open Inbox"); Spacer(); Image(systemName: "chevron.right").font(.footnote.weight(.semibold)) }
                        .font(.subheadline.weight(.semibold)).foregroundStyle(.tint).frame(minHeight: 44)
                }.buttonStyle(.plain)
            }
        }
        .padding(18)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(Color.orange.opacity(0.35), lineWidth: 1))
    }

    private var allClear: some View {
        Button { model.tab = 1 } label: {
            HStack(spacing: 14) {
                Image(systemName: "checkmark.seal.fill").font(.title2).foregroundStyle(.green).symbolRenderingMode(.hierarchical).symbolEffect(.bounce, value: loaded)
                    .frame(width: 44, height: 44).background(Color.green.opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text("All clear").font(.headline).fontDesign(.rounded).foregroundStyle(.primary)
                    Text(failed ? "Couldn’t check your Inbox. Pull to refresh." : "Nothing needs you right now.").font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
            }
            .padding(16)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        }.buttonStyle(QuietCardPress()).accessibilityHint("Opens Inbox")
    }

    private var placeholder: some View {
        RoundedRectangle(cornerRadius: 24, style: .continuous).fill(Color(.secondarySystemGroupedBackground)).frame(height: 76)
            .overlay(alignment: .leading) { ProgressView().padding(.leading, 28) }
    }

    @ViewBuilder private func destination(_ entry: WorkItem) -> some View {
        if !entry["approvalId"].text.isEmpty { ApprovalScreen(workspace: workspace, id: entry["approvalId"].text) }
        else if !entry["taskId"].text.isEmpty { TaskScreen(workspace: workspace, id: entry["taskId"].text) }
        else { AttentionDetail(workspace: workspace, item: entry) }
    }

    private func load() async {
        do {
            let result = try await model.client.work(workspace, path: "inbox")
            guard !Task.isCancelled else { return }
            entries = result["entries"].items.map(WorkItem.init); counts = result["counts"]; failed = false
            model.setNeedsYou(urgent.count, for: workspace)
        } catch is CancellationError { return }
        catch { failed = true; if (error as? MobileFailure)?.invalidatesContent == true { entries = [] } }
        loaded = true
    }
}

private struct NeedsYouRow: View {
    let entry: WorkItem
    let decision: Bool
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: decision ? "hand.raised.fill" : "exclamationmark.triangle.fill")
                .font(.body.weight(.semibold)).foregroundStyle(decision ? Color.orange : Color.red)
                .frame(width: 40, height: 40).background((decision ? Color.orange : Color.red).opacity(0.14), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text(entry["title"].text).font(.subheadline.weight(.semibold)).foregroundStyle(.primary).lineLimit(2).multilineTextAlignment(.leading)
                if !subtitle.isEmpty { Text(subtitle).font(.footnote).foregroundStyle(.secondary).lineLimit(1) }
            }
            Spacer(minLength: 0)
            Text(decision ? "Decide" : "Review").font(.footnote.weight(.semibold)).foregroundStyle(.tint)
        }
        .padding(.vertical, 10).contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
    private var subtitle: String {
        var parts = [entry["memberName"].text, entry["area"].text].filter { !$0.isEmpty }
        if let date = ISO8601DateFormatter.fractional.date(from: entry["at"].text) ?? ISO8601DateFormatter().date(from: entry["at"].text) {
            parts.append(date.formatted(.relative(presentation: .named)))
        }
        return parts.joined(separator: " · ")
    }
}

private struct CountChip: View {
    let value: Int; let label: String; let color: Color
    var body: some View {
        Text("\(value) \(label)").font(.caption.weight(.semibold)).monospacedDigit()
            .foregroundStyle(.primary).padding(.horizontal, 9).padding(.vertical, 4)
            .background(color.opacity(0.18), in: Capsule())
    }
}



