import * as React from "react";
import type { SvgNode } from "@/lib/character/draw";

/** React wants camelCase SVG attributes; our renderer emits SVG-spec names. */
function toReactAttrs(attrs: SvgNode["attrs"]): Record<string, string | number> {
    if (!attrs) return {};
    const out: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null) continue;
        if (key === "class") {
            out.className = value;
        } else if (key.startsWith("aria-") || key.startsWith("data-")) {
            out[key] = value;
        } else {
            out[key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
        }
    }
    return out;
}

/** Renders a character `SvgNode` tree as React elements. */
export function SvgNodeView({ node }: { node: SvgNode }): React.ReactElement {
    const props = toReactAttrs(node.attrs);
    const children: React.ReactNode[] = [];
    if (node.text !== undefined) children.push(node.text);
    for (const [i, child] of (node.children ?? []).entries()) {
        children.push(typeof child === "string" ? child : <SvgNodeView key={i} node={child} />);
    }
    return React.createElement(node.tag, props, children.length ? children : undefined);
}
