import SwiftUI
import EmperorCore

/// Use the shared rich renderer for block content; keep short inline notes lightweight.
struct RichTextBlock: View {
    let text: String
    let workspace: Installation
    @State private var height = 80.0
    var body: some View {
        #if os(iOS)
        if needsBlockRenderer {
            PhoneSurface(workspace: workspace, values: ["mode": .string("document"), "embedded": .bool(true), "text": .string(text)], contentHeight: { measured in
                if abs(height - measured) > 1 { height = measured }
            }).frame(height: height).accessibilityLabel("Formatted content")
        } else { Text(.init(text)).textSelection(.enabled) }
        #else
        Text(.init(text))
        #endif
    }
    private var needsBlockRenderer: Bool {
        text.contains("\n") || text.contains("```") || text.contains("<") || text.contains("![") || text.hasPrefix("#") || text.hasPrefix("- ") || text.hasPrefix("> ")
    }
}
