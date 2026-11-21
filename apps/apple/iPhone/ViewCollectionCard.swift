import SwiftUI
import EmperorCore

struct ViewCollectionCard: View {
    let view: WorkItem
    var featured = false
    private var restricted: Bool { view["access"].text == "metadata" }
    private var metric: JSONValue { restricted ? .null : view["keyMetric"] }
    private var scope: String { view["scopeLabel"].text.isEmpty ? view["scopeType"].text.capitalized : view["scopeLabel"].text }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(spacing: 8) {
                Image(systemName: restricted ? "lock" : view["scopeType"].text == "project" ? "square.stack.3d.up" : "rectangle.3.group")
                Text(scope.isEmpty ? "Workspace" : scope).lineLimit(1)
                Spacer(minLength: 4)
                if view["pinned"].flag { Image(systemName: "pin.fill").accessibilityLabel("Pinned") }
                Image(systemName: "arrow.up.right").accessibilityHidden(true)
            }.font(.caption.weight(.medium)).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 8) {
                Text(view["title"].text).font(featured ? .title.bold() : .title3.weight(.semibold)).fontDesign(.rounded)
                    .foregroundStyle(.primary).lineLimit(3).fixedSize(horizontal: false, vertical: true)
                if !restricted && !view["description"].text.isEmpty {
                    Text(.init(view["description"].text)).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            if metric != .null {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(metricValue).font(featured ? .largeTitle.weight(.medium) : .title.weight(.medium)).fontDesign(.rounded).tracking(-1).monospacedDigit().foregroundStyle(.primary)
                        if !metric["data"]["unit"].text.isEmpty { Text(metric["data"]["unit"].text).font(.subheadline).foregroundStyle(.secondary) }
                    }
                    Text(metric["title"].text).font(.caption).foregroundStyle(.secondary)
                }.padding(.vertical, 4)
            }
            Rectangle().fill(Color.primary.opacity(0.07)).frame(height: 1).accessibilityHidden(true)
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    if restricted { Label("Private view", systemImage: "lock").font(.caption) }
                    else {
                        if let date = ISO8601DateFormatter().date(from: view["dataUpdatedAt"].text) {
                            Text("Updated \(relativeAge(date))").font(.caption)
                        } else { Text("Awaiting first update").font(.caption) }
                        if !view["maintainer"]["name"].text.isEmpty { Text(view["maintainer"]["name"].text).font(.caption2).lineLimit(1) }
                    }
                }.foregroundStyle(.secondary)
                Spacer()
                if !restricted { Text("\(view["panelCount"].count) panels").font(.caption).monospacedDigit().foregroundStyle(.secondary) }
            }
        }
        .padding(featured ? 24 : 20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 28).fill(Color(.secondarySystemGroupedBackground))
                .overlay(alignment: .topLeading) {
                    if featured { RoundedRectangle(cornerRadius: 28).fill(LinearGradient(colors: [Color.teal.opacity(0.08), .clear], startPoint: .topLeading, endPoint: .bottomTrailing)) }
                }
        }
        .overlay { RoundedRectangle(cornerRadius: 28).strokeBorder(Color.primary.opacity(0.06), lineWidth: 0.5) }
        .shadow(color: .black.opacity(0.025), radius: 12, y: 5)
        .contentShape(RoundedRectangle(cornerRadius: 28))
    }
    private func relativeAge(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter(); formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: .now)
    }
    private var metricValue: String {
        switch metric["data"]["value"] {
        case .number(let value): return value.formatted(.number.precision(.fractionLength(0...2)))
        case .string(let value): return value
        default: return "—"
        }
    }
}

struct QuietCardPress: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.scaleEffect(configuration.isPressed && !reduceMotion ? 0.985 : 1)
            .opacity(configuration.isPressed ? 0.84 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: configuration.isPressed)
    }
}
