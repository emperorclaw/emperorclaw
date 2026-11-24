#if DEBUG
import Foundation
import EmperorCore

/// Explicit simulator-only sample mode. Never reads or writes server data.
enum ViewDesignPreview {
    static var enabled: Bool { ProcessInfo.processInfo.arguments.contains("--views-design-preview") }
    static let views: [WorkItem] = [
        summary("operations", title: "Operations, in focus.", scope: "Company", metric: .number(128), metricTitle: "Tasks delivered", pinned: true),
        summary("launch", title: "Ready for what's next.", scope: "Project Aurora", metric: .string("92%"), metricTitle: "Launch readiness"),
        summary("studio", title: "The studio pulse.", scope: "Company", metric: .number(24), metricTitle: "Active projects")
    ]
    static func detail(_ id: String) -> JSONValue {
        let summary = views.first { $0.id == id } ?? views[0]
        return .object(["title": summary["title"], "access": .string("full"), "description": .string("A considered view of the work moving forward. Kept current by your team."), "scopeLabel": .string("DESIGN PREVIEW · SAMPLE DATA"), "createdAt": .string(Date.now.ISO8601Format()), "maintainer": .object(["name": .string("Atlas")]), "panels": .array(panels)])
    }
    private static func summary(_ id: String, title: String, scope: String, metric: JSONValue, metricTitle: String, pinned: Bool = false) -> WorkItem {
        WorkItem(.object(["id": .string(id), "title": .string(title), "description": .string(pinned ? "The work, the momentum, the bigger picture." : "A little context. A clearer next step."), "scopeLabel": .string(scope), "scopeType": .string(scope == "Company" ? "company" : "project"), "access": .string("full"), "pinned": .bool(pinned), "panelCount": .number(7), "keyMetric": .object(["title": .string(metricTitle), "data": .object(["value": metric])]), "dataUpdatedAt": .string(Date.now.addingTimeInterval(-180).ISO8601Format()), "maintainer": .object(["name": .string("Atlas")])]))
    }
    private static var panels: [JSONValue] {
        let chart: JSONValue = .object(["series": .array([.object(["name": .string("Delivered"), "points": .array([point("Mon", 18), point("Tue", 27), point("Wed", 22), point("Thu", 36), point("Fri", 48)])])])])
        return [
            panel("delivered", "metric", "Tasks delivered", .object(["value": .number(128), "delta": .number(12), "deltaLabel": .string("vs last week"), "trend": .array([12, 18, 15, 27, 36, 48].map { .number(Double($0)) })]), w: 6, h: 2),
            panel("readiness", "progress", "Launch readiness", .object(["value": .number(92), "max": .number(100), "unit": .string("%"), "label": .string("A few finishing touches.")]), w: 6, h: 2),
            panel("momentum", "line", "A week of momentum", chart, w: 8, h: 3),
            panel("notes", "markdown", "The bigger picture", .object(["text": .string("**A strong week.**\n\nThe release is taking shape. Quality checks are complete; the team is refining the last details.\n\n- Core flows verified\n- Design review in progress")]), w: 4, h: 3),
            panel("activity", "bar", "Delivery by day", chart, w: 6, h: 3),
            panel("next", "list", "Up next", .object(["items": .array([.object(["title": .string("Final review"), "subtitle": .string("Design and quality"), "value": .string("Today")]), .object(["title": .string("Release preparation"), "value": .string("Tomorrow")])])]), w: 6, h: 3),
            panel("work", "table", "Work in motion", .object(["columns": .array([.object(["key": .string("name"), "label": .string("Project")]), .object(["key": .string("state"), "label": .string("Status")])]), "rows": .array([.object(["name": .string("Aurora"), "state": .string("In review")]), .object(["name": .string("Studio"), "state": .string("On track")])])]), w: 12, h: 3)
        ]
    }
    private static func point(_ x: String, _ y: Double) -> JSONValue { .object(["x": .string(x), "y": .number(y)]) }
    private static func panel(_ id: String, _ type: String, _ title: String, _ data: JSONValue, w: Double, h: Double) -> JSONValue {
        .object(["id": .string(id), "type": .string(type), "title": .string(title), "data": data, "w": .number(w), "h": .number(h), "updatedAt": .string(Date.now.addingTimeInterval(-180).ISO8601Format()), "updatedBy": .object(["type": .string("agent"), "name": .string("Atlas")])])
    }
}
#endif
