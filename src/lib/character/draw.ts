/**
 * Single source of truth for drawing Emperor Claw's characters. Both the React
 * dashboard and the server-rendered `/api/avatars/[id]` endpoint build the same
 * `SvgNode` tree; one serializes it to React elements, the other to an SVG
 * string. Keep this file free of React and DOM APIs.
 */

import {
    HAIR_COLORS, SKIN_TONES,
    type CharacterAppearance,
} from "./model";

export interface SvgNode {
    tag: string;
    attrs?: Record<string, string | number | undefined>;
    children?: SvgChild[];
    text?: string;
}

export type SvgChild = SvgNode | string;

export type CharacterMood = "online" | "busy" | "offline";

export interface FigureOptions {
    /** Unique per mounted figure: namespaces gradient ids. */
    idPrefix: string;
    mood?: CharacterMood;
    /** Seated hides the legs so a character reads as sitting at a desk. */
    seated?: boolean;
    /** What the eyes say; the body stays still, the face carries the state. */
    expression?: CharacterExpression;
}

export type CharacterExpression = "neutral" | "happy" | "focused" | "worried" | "sleepy" | "scanning";

const h = (hue: number, s: number, l: number) => `hsl(${hue} ${s}% ${l}%)`;

function n(tag: string, attrs?: SvgNode["attrs"], children?: SvgChild[]): SvgNode {
    const node: SvgNode = { tag };
    if (attrs) node.attrs = attrs;
    if (children && children.length) node.children = children;
    return node;
}

function gradient(id: string, from: string, to: string, vertical = true): SvgNode {
    return n("linearGradient", { id, x1: 0, y1: 0, x2: vertical ? 0 : 1, y2: 1 }, [
        n("stop", { offset: "0", stopColor: from }),
        n("stop", { offset: "1", stopColor: to }),
    ]);
}

const MOOD_LIGHT: Record<CharacterMood, string> = {
    online: "#a5f3fc",
    busy: "#fde68a",
    offline: "#64748b",
};

const INK = "#1e293b";

function accessoryNodes(appearance: CharacterAppearance, headTop: number, headHalf: number): Array<SvgNode | false> {
    const { accessory, hue } = appearance;
    return [
        accessory === "glasses" &&
            n("g", { fill: "#ffffff", fillOpacity: 0.12, stroke: INK, strokeWidth: 1.5 }, [
                n("rect", { x: -11.5, y: -61.5, width: 9.5, height: 8.5, rx: 3.2 }),
                n("rect", { x: 2, y: -61.5, width: 9.5, height: 8.5, rx: 3.2 }),
                n("path", { d: "M -2 -57.5 Q 0 -59 2 -57.5", fill: "none" }),
            ]),
        accessory === "headset" &&
            n("g", undefined, [
                n("path", { d: `M ${-headHalf} -56 Q ${-headHalf} ${headTop - 3} 0 ${headTop - 3} Q ${headHalf} ${headTop - 3} ${headHalf} -56`, fill: "none", stroke: "#334155", strokeWidth: 3, strokeLinecap: "round" }),
                n("rect", { x: -headHalf - 4, y: -62, width: 7, height: 11, rx: 3.2, fill: "#334155" }),
                n("rect", { x: -headHalf - 2.2, y: -60, width: 3, height: 7, rx: 1.4, fill: h(hue, 70, 62) }),
                n("path", { d: `M ${-headHalf - 1} -52 Q ${-headHalf + 1} -45 -8 -45.5`, fill: "none", stroke: "#334155", strokeWidth: 1.6, strokeLinecap: "round" }),
                n("circle", { cx: -7.5, cy: -45.5, r: 1.8, fill: "#334155" }),
            ]),
        accessory === "cap" &&
            n("g", undefined, [
                n("path", { d: `M ${-headHalf + 1} -64 Q ${-headHalf + 1} ${headTop - 5} 0 ${headTop - 5} Q ${headHalf - 1} ${headTop - 5} ${headHalf - 1} -64 Z`, fill: h(hue, 58, 50) }),
                n("path", { d: `M -6 -64.5 Q 8 -67.5 ${headHalf + 7} -63 Q ${headHalf + 7} -60.5 ${headHalf + 3} -60.5 Q 8 -63 -6 -62 Z`, fill: h(hue, 58, 38) }),
                n("circle", { cx: 0, cy: headTop - 5, r: 1.8, fill: h(hue, 58, 38) }),
            ]),
        accessory === "bow" &&
            n("g", { transform: `translate(${headHalf - 5} ${headTop + 2}) rotate(-14)` }, [
                n("path", { d: "M 0 0 Q -7 -6 -8 0 Q -7 6 0 0 Z", fill: "#f472b6" }),
                n("path", { d: "M 0 0 Q 7 -6 8 0 Q 7 6 0 0 Z", fill: "#f472b6" }),
                n("circle", { cx: 0, cy: 0, r: 2, fill: "#ec4899" }),
            ]),
    ];
}

function shadowAndLegs(seated: boolean, pants: string, shoes: string): SvgNode[] {
    const shadow = n("ellipse", { cx: 0, cy: seated ? 2 : 3, rx: 17, ry: 5.5, fill: "#020617", opacity: 0.4 });
    if (seated) return [shadow];
    return [
        shadow,
        n("rect", { x: -8, y: -13, width: 6.5, height: 12, rx: 3, fill: pants }),
        n("rect", { x: 1.5, y: -13, width: 6.5, height: 12, rx: 3, fill: pants }),
        n("ellipse", { cx: -5.2, cy: -1.2, rx: 4.6, ry: 2.6, fill: shoes }),
        n("ellipse", { cx: 5.2, cy: -1.2, rx: 4.6, ry: 2.6, fill: shoes }),
    ];
}

/**
 * Eyes for every expression, centred on (±dx, cy). Blink lives on the inner
 * group; "scanning" adds a slow left-right glance on an outer group so the two
 * transforms never fight.
 */
function expressiveEyes(expression: CharacterExpression, dx: number, cy: number, rx: number, ry: number, color: string, highlight: boolean): SvgNode[] {
    const line = { fill: "none", stroke: color, strokeWidth: 2.2, strokeLinecap: "round" };
    if (expression === "sleepy") {
        return [n("g", line, [
            n("path", { d: `M ${-dx - rx} ${cy} Q ${-dx} ${cy + 2.2} ${-dx + rx} ${cy}` }),
            n("path", { d: `M ${dx - rx} ${cy} Q ${dx} ${cy + 2.2} ${dx + rx} ${cy}` }),
        ])];
    }
    if (expression === "happy") {
        return [n("g", { ...line, class: "office-eyes" }, [
            n("path", { d: `M ${-dx - rx - 0.4} ${cy + 1.2} Q ${-dx} ${cy - ry - 0.6} ${-dx + rx + 0.4} ${cy + 1.2}` }),
            n("path", { d: `M ${dx - rx - 0.4} ${cy + 1.2} Q ${dx} ${cy - ry - 0.6} ${dx + rx + 0.4} ${cy + 1.2}` }),
        ])];
    }
    const eyeRy = expression === "focused" ? ry * 0.62 : ry;
    const eyes = n("g", { class: "office-eyes" }, [
        n("ellipse", { cx: -dx, cy, rx, ry: eyeRy, fill: color }),
        n("ellipse", { cx: dx, cy, rx, ry: eyeRy, fill: color }),
        ...(highlight ? [
            n("circle", { cx: -dx + rx * 0.35, cy: cy - eyeRy * 0.4, r: Math.min(1, eyeRy * 0.38), fill: "#ffffff", opacity: 0.9 }),
            n("circle", { cx: dx + rx * 0.35, cy: cy - eyeRy * 0.4, r: Math.min(1, eyeRy * 0.38), fill: "#ffffff", opacity: 0.9 }),
        ] : []),
    ]);
    const nodes: SvgNode[] = [expression === "scanning" ? n("g", { class: "office-scan" }, [eyes]) : eyes];
    if (expression === "worried") {
        // Brows tilt up toward the middle: concerned, not angry.
        nodes.push(n("g", { fill: "none", stroke: color, strokeWidth: 1.4, strokeLinecap: "round" }, [
            n("path", { d: `M ${-dx - rx - 0.6} ${cy - ry - 2.6} L ${-dx + rx} ${cy - ry - 4.4}` }),
            n("path", { d: `M ${dx + rx + 0.6} ${cy - ry - 2.6} L ${dx - rx} ${cy - ry - 4.4}` }),
        ]));
    }
    return nodes;
}

function robotFace(appearance: CharacterAppearance, mood: CharacterMood, expression: CharacterExpression): SvgNode[] {
    const glow = mood === "offline" ? "#475569" : mood === "busy" ? "#fde68a" : h(appearance.hue, 90, 78);
    if (mood === "offline") return expressiveEyes("sleepy", 6.5, -58, 3, 3.8, glow, false);
    const smile = expression === "worried" ? "M -2.6 -50.6 Q 0 -52.6 2.6 -50.6" : expression === "focused" ? "M -2.2 -51.6 L 2.2 -51.6" : "M -3 -52.4 Q 0 -49.6 3 -52.4";
    return [
        ...expressiveEyes(expression, 6.5, -58, 3, 3.8, glow, true),
        n("ellipse", { cx: -10.5, cy: -52.2, rx: 2.6, ry: 1.5, fill: "#fb7185", opacity: expression === "happy" ? 0.75 : 0.5 }),
        n("ellipse", { cx: 10.5, cy: -52.2, rx: 2.6, ry: 1.5, fill: "#fb7185", opacity: expression === "happy" ? 0.75 : 0.5 }),
        n("path", { d: smile, fill: "none", stroke: glow, strokeWidth: 1.6, strokeLinecap: "round" }),
    ];
}

function robot(appearance: CharacterAppearance, mood: CharacterMood, idPrefix: string, seated: boolean, expression: CharacterExpression): SvgNode[] {
    const { hue, variant } = appearance;
    const off = mood === "offline";
    const shellLight = off ? "#94a3b8" : h(hue, 30, 96);
    const shellDark = off ? "#64748b" : h(hue, 22, 80);
    const accent = off ? "#64748b" : h(hue, 62, 56);
    const accentDark = off ? "#475569" : h(hue, 55, 42);
    const shellId = `${idPrefix}-shell`;
    const visorId = `${idPrefix}-visor`;
    const headRx = [15, 19, 11, 15][variant % 4];
    const visorRx = Math.max(7, headRx - 5);
    const headTop = -79;
    const headHalf = 19.5;

    const antenna =
        variant === 1
            ? n("g", undefined, [
                  n("path", { d: "M -7 -78 L -10 -86", stroke: accentDark, strokeWidth: 2, strokeLinecap: "round" }),
                  n("path", { d: "M 7 -78 L 10 -86", stroke: accentDark, strokeWidth: 2, strokeLinecap: "round" }),
                  n("circle", { cx: -10.5, cy: -87, r: 2.6, fill: MOOD_LIGHT[mood], class: "office-antenna" }),
                  n("circle", { cx: 10.5, cy: -87, r: 2.6, fill: MOOD_LIGHT[mood], class: "office-antenna" }),
              ])
            : n("g", undefined, [
                  n("line", { x1: 0, y1: -78.5, x2: 0, y2: -85, stroke: accentDark, strokeWidth: 2.2, strokeLinecap: "round" }),
                  n("circle", { cx: 0, cy: -87.5, r: 3.4, fill: MOOD_LIGHT[mood], class: "office-antenna" }),
                  n("circle", { cx: -1, cy: -88.6, r: 1, fill: "#ffffff", opacity: 0.8 }),
              ]);

    const parts: Array<SvgNode | false> = [
        n("defs", undefined, [
            gradient(shellId, shellLight, shellDark),
            n("linearGradient", { id: visorId, x1: 0, y1: 0, x2: 0, y2: 1 }, [
                n("stop", { offset: "0", stopColor: off ? "#1e293b" : h(hue, 45, 16) }),
                n("stop", { offset: "1", stopColor: "#070b14" }),
            ]),
        ]),
        ...shadowAndLegs(seated, shellDark, accentDark),
        // arms
        n("rect", { x: -20, y: -36, width: 7.5, height: 17, rx: 3.75, fill: `url(#${shellId})` }),
        n("rect", { x: 12.5, y: -36, width: 7.5, height: 17, rx: 3.75, fill: `url(#${shellId})` }),
        n("circle", { cx: -16.25, cy: -19.5, r: 3.8, fill: accent }),
        n("circle", { cx: 16.25, cy: -19.5, r: 3.8, fill: accent }),
        // torso
        n("rect", { x: -13.5, y: -41, width: 27, height: 32, rx: 12, fill: `url(#${shellId})` }),
        n("path", { d: "M -9 -38 Q 0 -41 9 -38", fill: "none", stroke: "#ffffff", strokeWidth: 2, strokeLinecap: "round", opacity: 0.7 }),
        n("rect", { x: -6.5, y: -31, width: 13, height: 10, rx: 4, fill: accent }),
        n("circle", { cx: 0, cy: -26, r: 2.4, fill: MOOD_LIGHT[mood], class: "office-chest" }),
        // ear discs
        n("circle", { cx: -headHalf - 0.5, cy: -59, r: 5, fill: accent }),
        n("circle", { cx: headHalf + 0.5, cy: -59, r: 5, fill: accent }),
        n("circle", { cx: -headHalf - 0.5, cy: -59, r: 2, fill: accentDark }),
        n("circle", { cx: headHalf + 0.5, cy: -59, r: 2, fill: accentDark }),
        antenna,
        // head shell + visor
        n("rect", { x: -headHalf, y: headTop, width: headHalf * 2, height: 38, rx: headRx, fill: `url(#${shellId})` }),
        n("path", { d: `M ${-headHalf + 6} ${headTop + 4} Q 0 ${headTop + 0.5} ${headHalf - 6} ${headTop + 4}`, fill: "none", stroke: "#ffffff", strokeWidth: 2.4, strokeLinecap: "round", opacity: 0.8 }),
        n("rect", { x: -15, y: -71, width: 30, height: 25, rx: visorRx, fill: `url(#${visorId})` }),
        n("rect", { x: -15, y: -71, width: 30, height: 25, rx: visorRx, fill: "none", stroke: off ? "#334155" : h(hue, 70, 60), strokeOpacity: 0.45, strokeWidth: 1 }),
        n("path", { d: "M -11 -68 Q -4 -70 3 -68.5", fill: "none", stroke: "#ffffff", strokeWidth: 1.2, strokeLinecap: "round", opacity: 0.18 }),
        ...robotFace(appearance, mood, expression),
        ...accessoryNodes(appearance, headTop, headHalf),
    ];
    return parts.filter((part): part is SvgNode => Boolean(part));
}

function humanHair(style: number, color: string, back: boolean): SvgNode | false {
    if (back) {
        if (style === 1) return n("path", { d: "M -19 -60 Q -20 -80 0 -80 Q 20 -80 19 -60 L 19 -44 Q 14 -40 10 -44 L -10 -44 Q -14 -40 -19 -44 Z", fill: color });
        if (style === 3) return n("circle", { cx: 0, cy: -80, r: 6.5, fill: color });
        return false;
    }
    switch (style) {
        case 1: // long with curtain bangs
            return n("path", { d: "M -17.5 -58 Q -19 -78 0 -78.5 Q 19 -78 17.5 -58 Q 14 -66 4 -68 Q 0 -63 -4 -68 Q -14 -66 -17.5 -58 Z", fill: color });
        case 2: // short spiky
            return n("path", { d: "M -17.5 -60 Q -18 -77 -6 -79 L -3 -83 L 1 -79 L 5 -82.5 L 7 -78.5 Q 18 -76 17.5 -60 Q 12 -68 4 -67 L 0 -70 L -4 -66.5 Q -12 -68 -17.5 -60 Z", fill: color });
        case 3: // bun with a neat fringe
            return n("path", { d: "M -17.5 -59 Q -18 -78 0 -78 Q 18 -78 17.5 -59 Q 9 -69 -2 -67.5 Q -11 -66 -17.5 -59 Z", fill: color });
        default: // side-swept
            return n("path", { d: "M -17.5 -57 Q -19 -79 1 -78.5 Q 19 -77.5 17.5 -58 Q 15 -64 10 -66 Q 2 -61 -8 -66.5 Q -13 -63 -17.5 -57 Z", fill: color });
    }
}

function human(appearance: CharacterAppearance, mood: CharacterMood, idPrefix: string, seated: boolean, expression: CharacterExpression): SvgNode[] {
    const { hue, skin: skinIndex, hair: hairIndex, variant } = appearance;
    const off = mood === "offline";
    const skin = SKIN_TONES[skinIndex % SKIN_TONES.length];
    const hair = HAIR_COLORS[hairIndex % HAIR_COLORS.length];
    const style = (hairIndex + variant) % 4;
    const shirtLight = h(hue, off ? 10 : 46, off ? 44 : 58);
    const shirtDark = h(hue, off ? 10 : 42, off ? 30 : 40);
    const shirtId = `${idPrefix}-shirt`;
    const headTop = -76;
    const headHalf = 18;
    const eyeColor = off ? "#94a3b8" : INK;
    const eyeRy = mood === "busy" ? 2.4 : 3.1;

    const parts: Array<SvgNode | false> = [
        n("defs", undefined, [gradient(shirtId, shirtLight, shirtDark)]),
        ...shadowAndLegs(seated, "#334155", "#1e293b"),
        // arms
        n("rect", { x: -19.5, y: -37, width: 7, height: 17, rx: 3.5, fill: `url(#${shirtId})` }),
        n("rect", { x: 12.5, y: -37, width: 7, height: 17, rx: 3.5, fill: `url(#${shirtId})` }),
        n("circle", { cx: -16, cy: -19.5, r: 3.4, fill: skin }),
        n("circle", { cx: 16, cy: -19.5, r: 3.4, fill: skin }),
        // torso, collar and a lanyard badge
        n("path", { d: "M -13.5 -9 L -13.5 -31 Q -13.5 -41 -4 -41 L 4 -41 Q 13.5 -41 13.5 -31 L 13.5 -9 Z", fill: `url(#${shirtId})` }),
        n("path", { d: "M -5.5 -41 L 0 -35 L 5.5 -41 Z", fill: "#f8fafc", opacity: 0.92 }),
        n("path", { d: "M -4 -39 L 3 -26", stroke: h(hue, 60, 30), strokeWidth: 1.1 }),
        n("rect", { x: 1, y: -27, width: 6, height: 7.5, rx: 1.4, fill: "#f8fafc" }),
        n("rect", { x: 2.2, y: -25.5, width: 3.6, height: 1.4, rx: 0.7, fill: h(hue, 60, 50) }),
        // neck
        n("rect", { x: -4.5, y: -44, width: 9, height: 5, rx: 2, fill: skin }),
        humanHair(style, hair, true),
        // ears + head
        n("circle", { cx: -headHalf, cy: -56, r: 3.6, fill: skin }),
        n("circle", { cx: headHalf, cy: -56, r: 3.6, fill: skin }),
        n("ellipse", { cx: 0, cy: -59, rx: headHalf, ry: 17, fill: skin }),
        n("ellipse", { cx: 0, cy: -47.5, rx: 12, ry: 4, fill: "#7c2d12", opacity: 0.08 }),
        humanHair(style, hair, false),
        // face
        ...expressiveEyes(off ? "sleepy" : expression, 6.6, -56, 2.5, eyeRy, eyeColor, true),
        n("ellipse", { cx: -11, cy: -50.5, rx: 3, ry: 1.8, fill: "#fb7185", opacity: expression === "happy" ? 0.6 : 0.4 }),
        n("ellipse", { cx: 11, cy: -50.5, rx: 3, ry: 1.8, fill: "#fb7185", opacity: expression === "happy" ? 0.6 : 0.4 }),
        n("path", {
            d: expression === "worried" ? "M -2.4 -49.4 Q 0 -51.2 2.4 -49.4" : mood === "busy" || expression === "focused" ? "M -2.2 -50 L 2.2 -50" : "M -2.8 -50.8 Q 0 -48 2.8 -50.8",
            stroke: "#9a3412",
            strokeWidth: 1.4,
            fill: "none",
            strokeLinecap: "round",
        }),
        ...accessoryNodes(appearance, headTop, headHalf),
    ];
    return parts.filter((part): part is SvgNode => Boolean(part));
}

/** The full character as SVG nodes, origin at the feet, height ≈ 86 units. */
export function figureNodes(appearance: CharacterAppearance, options: FigureOptions): SvgNode[] {
    const mood = options.mood ?? "online";
    const expression = options.expression ?? "neutral";
    const parts = appearance.kind === "robot" ? robot(appearance, mood, options.idPrefix, options.seated ?? true, expression) : human(appearance, mood, options.idPrefix, options.seated ?? true, expression);
    return [n("g", { class: mood === "offline" ? "office-offline" : undefined }, parts)];
}

export interface TileOptions {
    size: number;
    idPrefix: string;
    /** Accessible name; omit for decorative avatars. */
    label?: string;
    mood?: CharacterMood;
}

const TILE_VIEWBOX = "-31 -94 62 62";

/** A square head-and-shoulders avatar tile as a standalone `<svg>` node. */
export function tileNode(appearance: CharacterAppearance, options: TileOptions): SvgNode {
    const { size, idPrefix, label, mood = "online" } = options;
    const bgId = `${idPrefix}-bg`;
    const attrs: Record<string, string | number> = {
        viewBox: TILE_VIEWBOX,
        width: size,
        height: size,
        role: "img",
        class: "character-avatar",
    };
    if (label !== undefined) attrs["aria-label"] = label;
    else attrs["aria-hidden"] = "true";

    return n("svg", attrs, [
        n("defs", undefined, [
            n(
                "radialGradient",
                { id: bgId, cx: "0.5", cy: "0.28", r: "0.85" },
                [
                    n("stop", { offset: "0", stopColor: h(appearance.hue, mood === "offline" ? 10 : 50, mood === "offline" ? 26 : 38) }),
                    n("stop", { offset: "1", stopColor: h(appearance.hue, mood === "offline" ? 10 : 45, 12) }),
                ],
            ),
        ]),
        n("rect", { x: -31, y: -94, width: 62, height: 62, rx: 18, fill: `url(#${bgId})` }),
        n("g", undefined, figureNodes(appearance, { idPrefix, mood, seated: true })),
    ]);
}

function escapeText(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** SVG attributes that are camelCase in the spec itself and must stay that way. */
const NATIVE_CAMEL = new Set(["viewBox", "preserveAspectRatio", "gradientUnits", "gradientTransform", "patternUnits", "stdDeviation"]);

function svgAttrName(key: string): string {
    return NATIVE_CAMEL.has(key) ? key : key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function serializeAttrs(attrs: SvgNode["attrs"]): string {
    if (!attrs) return "";
    let out = "";
    for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null) continue;
        const escaped = String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
        out += ` ${svgAttrName(key)}="${escaped}"`;
    }
    return out;
}

/** Serialize an SvgNode tree to a standalone SVG string (server endpoint). */
export function serializeSvgNode(node: SvgNode): string {
    const attrs = serializeAttrs(node.attrs);
    if (node.text !== undefined && (!node.children || node.children.length === 0)) {
        return `<${node.tag}${attrs}>${escapeText(node.text)}</${node.tag}>`;
    }
    const inner = (node.children ?? []).map((child) => (typeof child === "string" ? escapeText(child) : serializeSvgNode(child))).join("");
    return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}

/** The avatar drawing returned by GET /api/avatars/[id]. */
export function renderAvatarSvg(appearance: CharacterAppearance, size: number): string {
    const tile = tileNode(appearance, { size, idPrefix: "a", label: "Agent avatar" });
    tile.attrs = { xmlns: "http://www.w3.org/2000/svg", ...tile.attrs };
    return serializeSvgNode(tile);
}
