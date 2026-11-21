import WidgetKit
import SwiftUI
import AppIntents
import EmperorCore

struct WorkspaceEntity: AppEntity {
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Workspace"
    static var defaultQuery = WorkspaceQuery()
    let id: String
    let name: String
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}
struct WorkspaceQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [WorkspaceEntity] { WidgetCache.read().filter { identifiers.contains($0.id) }.map { .init(id: $0.id, name: $0.name) } }
    func suggestedEntities() async throws -> [WorkspaceEntity] { WidgetCache.read().map { .init(id: $0.id, name: $0.name) } }
}
struct WorkspaceIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Fleet workspace"
    static var description = IntentDescription("Choose a connected instance and company. This widget stays pinned when you switch the app.")
    @Parameter(title: "Workspace") var workspace: WorkspaceEntity?
}
struct FleetEntry: TimelineEntry { let date: Date; let snapshot: WidgetSnapshot? }
struct FleetProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> FleetEntry { .init(date: Date(), snapshot: nil) }
    func snapshot(for configuration: WorkspaceIntent, in context: Context) async -> FleetEntry { entry(configuration) }
    func timeline(for configuration: WorkspaceIntent, in context: Context) async -> Timeline<FleetEntry> { Timeline(entries: [entry(configuration)], policy: .after(Date().addingTimeInterval(15 * 60))) }
    func recommendations() -> [AppIntentRecommendation<WorkspaceIntent>] {
        WidgetCache.read().map { snapshot in let intent = WorkspaceIntent(); intent.workspace = .init(id: snapshot.id, name: snapshot.name); return .init(intent: intent, description: snapshot.name) }
    }
    private func entry(_ intent: WorkspaceIntent) -> FleetEntry { .init(date: Date(), snapshot: WidgetCache.read().first { $0.id == intent.workspace?.id }) }
}
struct FleetWidgetView: View {
    let entry: FleetEntry
    @Environment(\.widgetFamily) var family
    var body: some View {
        Group {
            if let snapshot = entry.snapshot {
                if family == .accessoryInline { Text("\(snapshot.name): \(snapshot.needsYou ?? snapshot.working)") }
                else {
                VStack(alignment: .leading, spacing: 4) {
                    if family != .accessoryCircular { Text(snapshot.name).font(.caption.bold()).lineLimit(1) }
                    if let count = snapshot.needsYou { Label("\(count)", systemImage: "tray.fill").font(.headline) }
                    else { Label("\(snapshot.working)", systemImage: "bolt.fill").font(.headline) }
                    if family != .accessoryCircular {
                        Text("\(snapshot.working) working · \(snapshot.total) agents").font(.caption2)
                        Text(snapshot.date, style: .relative).font(.caption2).foregroundStyle(.secondary)
                    }
                }.widgetURL(WorkspaceLink.url(installationID: snapshot.installationID, companyID: snapshot.companyID, kind: "inbox", id: snapshot.companyID)).privacySensitive()
                }
            } else { VStack { Image(systemName: "person.3"); Text("Choose workspace").font(.caption2) } }
        }.containerBackground(.background, for: .widget)
    }
}
@main
struct EmperorFleetWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "EmperorFleet", intent: WorkspaceIntent.self, provider: FleetProvider()) { FleetWidgetView(entry: $0) }
            .configurationDisplayName("EmperorClaw fleet").description("A pinned workspace snapshot. Open the app for current status.")
            #if os(watchOS)
            .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline])
            #else
            .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular])
            #endif
    }
}
