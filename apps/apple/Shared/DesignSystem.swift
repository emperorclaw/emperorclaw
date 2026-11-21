import SwiftUI
import EmperorCore

/// EmperorClaw's visual vocabulary, shared by iPhone and Watch.
///
/// Typography uses SF's design axes rather than custom fonts:
/// - `.rounded` for names, titles and numbers (the team's friendly voice)
/// - `.serif` for editorial moments (Views)
/// - small caps for structural labels
/// - `.monospacedDigit()` for any count that changes
/// Colour encodes meaning only: teal = interactive/working, orange = decide,
/// red = blocked/failing, green = done/clear, indigo = in review.
enum DS {
    enum Space { static let xs: CGFloat = 4, s: CGFloat = 8, m: CGFloat = 12, l: CGFloat = 16, xl: CGFloat = 24, xxl: CGFloat = 32 }
    enum Radius { static let tile: CGFloat = 12, row: CGFloat = 16, card: CGFloat = 22 }
}

/// Small-caps structural label used above every group.
struct SectionLabel: View {
    let text: String
    var systemImage: String? = nil
    var tint: Color = .secondary
    var body: some View {
        HStack(spacing: 6) {
            if let systemImage { Image(systemName: systemImage).imageScale(.small) }
            Text(text)
        }
        .font(.footnote.weight(.semibold).smallCaps()).tracking(0.6)
        .foregroundStyle(tint)
        .accessibilityAddTraits(.isHeader)
    }
}

/// How a task state looks everywhere it appears.
struct TaskStateStyle {
    let label: String, symbol: String, color: Color
    init(_ raw: String) {
        switch raw {
        case "done", "completed": (label, symbol, color) = ("Done", "checkmark.circle.fill", .green)
        case "cancelled", "canceled": (label, symbol, color) = ("Cancelled", "xmark.circle.fill", .secondary)
        case "blocked", "failed": (label, symbol, color) = (raw == "failed" ? "Failed" : "Blocked", "exclamationmark.octagon.fill", .red)
        case "review", "in_review", "awaiting_review": (label, symbol, color) = ("In review", "eye.circle.fill", .indigo)
        case "in_progress", "running", "claimed", "working": (label, symbol, color) = ("In progress", "circle.dotted.circle.fill", .teal)
        case "waiting", "awaiting_approval", "pending_approval": (label, symbol, color) = ("Waiting", "hourglass.circle.fill", .orange)
        default: (label, symbol, color) = (raw.isEmpty ? "Queued" : raw.replacingOccurrences(of: "_", with: " ").capitalized, "circle.dashed", .secondary)
        }
    }
}

/// Capsule metadata tag with a coloured dot.
struct StatusPill: View {
    let text: String
    let color: Color
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(text).font(.caption.weight(.semibold)).foregroundStyle(.primary.opacity(0.85))
        }
        .padding(.horizontal, 8).padding(.vertical, 3)
        .background(color.opacity(0.14), in: Capsule())
        .accessibilityElement(children: .combine)
    }
}

extension Agent {
    var isWorking: Bool { statusLabel == "Working" && paused != true }
    var statusColor: Color {
        if paused == true { return .orange }
        switch statusLabel {
        case "Working": return .green
        case "Blocked", "Waiting": return .orange
        case "Offline": return .secondary.opacity(0.6)
        default: return .secondary
        }
    }
    /// Stable per-agent hue so the same person always has the same colour.
    var hue: Double { stableHue(id) }
}

/// Monogram avatar with the agent's hue and a live status badge.
struct AgentMonogram: View {
    let agent: Agent
    var size: CGFloat = 44
    var body: some View {
        let base = Color(hue: agent.hue, saturation: 0.55, brightness: 0.85)
        Text(String(agent.name.prefix(1)).uppercased())
            .font(.system(size: size * 0.44, weight: .bold, design: .rounded))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(LinearGradient(colors: [base, Color(hue: agent.hue, saturation: 0.7, brightness: 0.55)], startPoint: .topLeading, endPoint: .bottomTrailing),
                        in: RoundedRectangle(cornerRadius: size * 0.32, style: .continuous))
            .overlay(alignment: .bottomTrailing) {
                Circle().fill(agent.statusColor).frame(width: size * 0.28, height: size * 0.28)
                    .overlay(Circle().stroke(Color.groupedBackground, lineWidth: 2.5))
                    .offset(x: 3, y: 3)
            }
            .accessibilityHidden(true)
    }
}

extension Color {
    static var groupedBackground: Color {
        #if os(iOS)
        Color(.systemGroupedBackground)
        #else
        Color.black
        #endif
    }
    static var cardSurface: Color {
        #if os(iOS)
        Color(.secondarySystemGroupedBackground)
        #else
        Color.white.opacity(0.08)
        #endif
    }
}

/// Hairline that fades at both ends, instead of a plain Divider.
struct SoftDivider: View {
    var body: some View {
        LinearGradient(colors: [.clear, .secondary.opacity(0.35), .clear], startPoint: .leading, endPoint: .trailing).frame(height: 1)
    }
}

extension ISO8601DateFormatter {
    static let fractional: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
}

/// Stable hue for any id (agents, members): the same person keeps the same colour everywhere.
func stableHue(_ id: String) -> Double {
    var hash: UInt64 = 1469598103934665603
    for byte in id.utf8 { hash = (hash ^ UInt64(byte)) &* 1099511628211 }
    return Double(hash % 360) / 360
}

/// Monogram for anyone with a name and id (group members, people).
struct MemberMonogram: View {
    let name: String
    let id: String
    var size: CGFloat = 32
    var isHuman = false
    var body: some View {
        let hue = stableHue(id)
        Text(String(name.prefix(1)).uppercased())
            .font(.system(size: size * 0.44, weight: .bold, design: .rounded))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(LinearGradient(colors: isHuman ? [Color.gray, Color.gray.opacity(0.7)] : [Color(hue: hue, saturation: 0.55, brightness: 0.85), Color(hue: hue, saturation: 0.7, brightness: 0.55)],
                                       startPoint: .topLeading, endPoint: .bottomTrailing),
                        in: isHuman ? AnyShape(Circle()) : AnyShape(RoundedRectangle(cornerRadius: size * 0.32, style: .continuous)))
            .accessibilityHidden(true)
    }
}

/// Up to three overlapping member avatars, ringed by the surface colour.
struct AvatarStack: View {
    let members: [(name: String, id: String, human: Bool)]
    var size: CGFloat = 30
    var body: some View {
        let shown = Array(members.prefix(3))
        ZStack(alignment: .leading) {
            ForEach(Array(shown.enumerated()), id: \.offset) { index, member in
                MemberMonogram(name: member.name, id: member.id, size: size, isHuman: member.human)
                    .overlay(RoundedRectangle(cornerRadius: size * 0.32, style: .continuous).stroke(Color.cardSurface, lineWidth: 2))
                    .offset(x: CGFloat(index) * size * 0.4, y: index.isMultiple(of: 2) ? 0 : size * 0.18)
            }
        }
        .frame(width: size + CGFloat(max(0, shown.count - 1)) * size * 0.4, height: size * 1.18, alignment: .leading)
        .accessibilityHidden(true)
    }
}
