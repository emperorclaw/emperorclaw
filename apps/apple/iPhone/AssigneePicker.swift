import SwiftUI
import EmperorCore

/// One person or agent a task can be assigned to.
struct AssigneeOption: Identifiable, Hashable {
    enum Kind: String { case agent, human }
    let kind: Kind
    let id: String
    let name: String
    var detail: String = ""
    var working = false
    var key: String { "\(kind.rawValue):\(id)" }
}

/// Searchable assignee sheet that scales to dozens of agents and people:
/// search field, People / Agents sections, current owner marked, unassign.
struct AssigneePicker: View {
    let options: [AssigneeOption]
    let current: String?   // "agent:<id>" or "human:<id>"
    let choose: (AssigneeOption?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var filter: AssigneeOption.Kind?

    private var matching: [AssigneeOption] {
        options.filter { option in
            (filter == nil || option.kind == filter) &&
            (query.isEmpty || option.name.localizedCaseInsensitiveContains(query) || option.detail.localizedCaseInsensitiveContains(query))
        }
        .sorted { a, b in
            if a.key == current { return true }
            if b.key == current { return false }
            return a.name.localizedStandardCompare(b.name) == .orderedAscending
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if options.contains(where: { $0.kind == .human }) && options.contains(where: { $0.kind == .agent }) && query.isEmpty {
                    Section {
                        Picker("Show", selection: $filter) {
                            Text("All").tag(AssigneeOption.Kind?.none)
                            Text("Agents").tag(AssigneeOption.Kind?.some(.agent))
                            Text("People").tag(AssigneeOption.Kind?.some(.human))
                        }.pickerStyle(.segmented).listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                    }
                }
                let agents = matching.filter { $0.kind == .agent }
                let people = matching.filter { $0.kind == .human }
                if !agents.isEmpty { Section { ForEach(agents) { row($0) } } header: { SectionLabel(text: "Agents", systemImage: "sparkles").textCase(nil) } }
                if !people.isEmpty { Section { ForEach(people) { row($0) } } header: { SectionLabel(text: "People", systemImage: "person.fill").textCase(nil) } }
                if matching.isEmpty { ContentUnavailableView.search(text: query) }
                if current != nil && query.isEmpty {
                    Section { Button("Unassign", systemImage: "person.crop.circle.badge.xmark", role: .destructive) { choose(nil); dismiss() } }
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search \(options.count) agents and people")
            .navigationTitle("Assign to").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .sensoryFeedback(.selection, trigger: filter)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func row(_ option: AssigneeOption) -> some View {
        Button { choose(option); dismiss() } label: {
            HStack(spacing: 12) {
                MemberMonogram(name: option.name, id: option.id, size: 34, isHuman: option.kind == .human)
                    .overlay(alignment: .bottomTrailing) {
                        if option.working { Circle().fill(Color.green).frame(width: 10, height: 10).overlay(Circle().stroke(Color.cardSurface, lineWidth: 2)).offset(x: 2, y: 2) }
                    }
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.name).font(.body.weight(.medium)).foregroundStyle(.primary)
                    if !option.detail.isEmpty { Text(option.detail).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                }
                Spacer()
                if option.key == current { Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(Color.accentColor) }
            }.contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(option.key == current ? .isSelected : [])
    }
}
