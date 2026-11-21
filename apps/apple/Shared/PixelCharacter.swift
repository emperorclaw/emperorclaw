import SwiftUI
import EmperorCore

/// Pixel-art agents, ported from the throne display firmware
/// (devices/throne-display/src/character.cpp), which mirrors the web model
/// (src/lib/character): robot or human, 4 variants, 6 skin tones, 8 hair colours,
/// accessories and expressions on a 16x20 grid with a 1-pixel outline.
struct CharacterLook: Equatable, Sendable {
    enum Kind: Sendable { case robot, human }
    enum Accessory: Sendable { case none, glasses, headset, cap, bow }
    var kind: Kind
    var hue: Int
    var variant: Int
    var skin: Int
    var hairColor: Int
    var hairStyle: Int
    var accessory: Accessory

    static let hues = [190, 205, 265, 150, 38, 340, 210, 95, 20, 300, 170, 250]
    static let accessories: [Accessory] = [.none, .glasses, .headset, .cap, .bow, .none, .none]

    /// FNV-1a over UTF-16 code units, same as the web's hashString().
    static func hash(_ text: String) -> UInt32 {
        var h: UInt32 = 2166136261
        for unit in text.utf16 { h ^= UInt32(unit); h = h &* 16777619 }
        return h
    }

    /// deriveAppearance() on the web; hair style mapping as in the firmware.
    static func derived(from seed: String) -> CharacterLook {
        let key = seed.trimmingCharacters(in: .whitespaces).isEmpty ? "agent" : seed.trimmingCharacters(in: .whitespaces)
        let h = hash(key)
        let variant = Int((h >> 3) % 4), hair = Int((h >> 9) % 6)
        return CharacterLook(kind: h % 3 == 0 ? .human : .robot, hue: hues[Int(h % 12)], variant: variant,
                             skin: Int((h >> 6) % 6), hairColor: hair, hairStyle: (hair + variant) % 4,
                             accessory: accessories[Int((h >> 12) % 7)])
    }

    /// resolveAppearance(): explicit override, else derived from the agent id.
    static func resolve(id: String, appearance: JSONValue?) -> CharacterLook {
        guard let a = appearance, case .object = a,
              let kind = ["robot": Kind.robot, "human": Kind.human][a["kind"].text] else { return derived(from: id) }
        func int(_ key: String, _ max: Int) -> Int? { if case .number(let v) = a[key], v >= 0, Int(v) <= max { return Int(v) }; return nil }
        let acc: [String: Accessory] = ["none": .none, "glasses": .glasses, "headset": .headset, "cap": .cap, "bow": .bow]
        guard let hue = int("hue", 359), let variant = int("variant", 3), let skin = int("skin", 5), let hair = int("hair", 5),
              let accessory = acc[a["accessory"].text] else { return derived(from: id) }
        return CharacterLook(kind: kind, hue: hue, variant: variant, skin: skin, hairColor: hair, hairStyle: (hair + variant) % 4, accessory: accessory)
    }
}

struct CharacterPose: Equatable {
    enum Mood { case neutral, happy, focused, worried, sleepy, scanning }
    enum Arms { case down, type, up, point, hold }
    enum Legs { case stand, walk, seated }
    var mood: Mood = .neutral
    var arms: Arms = .down
    var legs: Legs = .stand
    var frame = 0
    var flip = false
    var ghost = false
}

/// Draws one character into a Canvas with its feet at (cx, footY).
struct PixelCharacterPainter {
    let look: CharacterLook
    let pose: CharacterPose
    let cx: CGFloat, footY: CGFloat, scale: CGFloat
    let now: TimeInterval
    let seed: UInt32

    // MARK: palette (firmware pal::build)
    static func hsv(_ h: Double, _ s: Double, _ v: Double) -> Color {
        var hh = h.truncatingRemainder(dividingBy: 360); if hh < 0 { hh += 360 }
        let c = v * s, x = c * (1 - abs((hh / 60).truncatingRemainder(dividingBy: 2) - 1)), m = v - c
        let (r, g, b): (Double, Double, Double) = hh < 60 ? (c, x, 0) : hh < 120 ? (x, c, 0) : hh < 180 ? (0, c, x) : hh < 240 ? (0, x, c) : hh < 300 ? (x, 0, c) : (c, 0, x)
        return Color(red: r + m, green: g + m, blue: b + m)
    }
    /// ramp 0 = neutral navy→white; 1...15 = hue ramps every 24°.
    static func c(_ ramp: Int, _ level: Int) -> Color {
        let L = Double(max(0, min(15, level)))
        if ramp == 0 {
            let t = L / 15, v = L == 0 ? 0 : 0.035 + 0.965 * pow(t, 1.55), s = 0.42 * (1 - t) + 0.04
            return hsv(228, s, v)
        }
        let hue = Double(ramp - 1) * 24
        return L <= 10 ? hsv(hue, 0.9, 0.05 + 0.95 * pow(L / 10, 1.3)) : hsv(hue, 0.9 * (1 - (L - 10) / 6), 1)
    }
    static func hueRamp(_ deg: Int) -> Int { var r = ((deg % 360 + 360) % 360 + 12) / 24; if r >= 15 { r = 0 }; return 1 + r }
    static let skinRGB: [UInt32] = [0xf7d7bd, 0xecc19c, 0xd8a074, 0xb97e52, 0x8a5738, 0x5f3a25]
    static let hairRGB: [UInt32] = [0x241a15, 0x4b2f1e, 0x8a5a2b, 0xd9a441, 0xe9d29a, 0x6f2f2f, 0x334155, 0x9b8aa6]
    static func rgb(_ v: UInt32, shade: Double = 1) -> Color {
        Color(red: Double((v >> 16) & 255) / 255 * shade, green: Double((v >> 8) & 255) / 255 * shade, blue: Double(v & 255) / 255 * shade)
    }

    private struct Cell { let x, y, w, h: Int; let color: Color; let detail: Bool }

    func draw(in ctx: inout GraphicsContext) {
        var cells: [Cell] = []
        func R(_ x: Int, _ y: Int, _ w: Int, _ h: Int, _ col: Color) { if w > 0 && h > 0 { cells.append(Cell(x: x, y: y, w: w, h: h, color: col, detail: false)) } }
        func D(_ x: Int, _ y: Int, _ w: Int, _ h: Int, _ col: Color) { if w > 0 && h > 0 { cells.append(Cell(x: x, y: y, w: w, h: h, color: col, detail: true)) } }
        func RR(_ x: Int, _ y: Int, _ w: Int, _ h: Int, _ cut: Int, _ col: Color, detail: Bool = false) {
            for j in 0..<h {
                var inset = 0
                if cut >= 1 && (j == 0 || j == h - 1) { inset = cut } else if cut >= 2 && (j == 1 || j == h - 2) { inset = 1 }
                if detail { D(x + inset, y + j, w - 2 * inset, 1, col) } else { R(x + inset, y + j, w - 2 * inset, 1, col) }
            }
        }
        let c = Self.c
        let ghost = pose.ghost
        let rp = ghost ? 0 : Self.hueRamp(look.hue)
        let ms = UInt64(now * 1000)

        func eyes(_ lx: Int, _ rx: Int, _ ey: Int, _ col: Color) {
            var shift = 0
            if pose.mood == .scanning { let s = sin(Double((ms / 3 + UInt64(seed)) & 1023) / 1024 * 2 * .pi); shift = s > 0.7 ? 1 : (s < -0.7 ? -1 : 0) }
            let blink = (ms + UInt64(seed & 0xFFF)) % 3700 < 120
            switch pose.mood {
            case .happy:
                for x0 in [lx, rx] { D(x0 - 1, ey + 1, 1, 1, col); D(x0, ey, 2, 1, col); D(x0 + 2, ey + 1, 1, 1, col) }
                return
            case .sleepy: D(lx, ey + 1, 2, 1, col); D(rx, ey + 1, 2, 1, col); return
            case .focused:
                D(lx, ey - 1, 2, 1, col); D(rx, ey - 1, 2, 1, col); D(lx, ey + 1, 2, 1, col); D(rx, ey + 1, 2, 1, col); return
            default: break
            }
            if blink { D(lx + shift, ey + 1, 2, 1, col); D(rx + shift, ey + 1, 2, 1, col) }
            else { D(lx + shift, ey, 2, 2, col); D(rx + shift, ey, 2, 2, col) }
            if pose.mood == .worried { D(lx, ey - 1, 1, 1, col); D(lx + 1, ey - 2, 1, 1, col); D(rx, ey - 2, 1, 1, col); D(rx + 1, ey - 1, 1, 1, col) }
        }
        func mouth(_ my: Int, _ col: Color) {
            switch pose.mood {
            case .happy: D(-3, my - 1, 1, 1, col); D(-2, my, 4, 1, col); D(2, my - 1, 1, 1, col)
            case .worried: D(-2, my, 1, 1, col); D(-1, my - 1, 2, 1, col); D(1, my, 1, 1, col)
            case .focused, .scanning, .sleepy: D(-1, my, 2, 1, col)
            default: D(-2, my - 1, 1, 1, col); D(-1, my, 2, 1, col); D(1, my - 1, 1, 1, col)
            }
        }
        func arms(_ arm: Color, _ hand: Color) {
            let f = pose.frame & 1
            switch pose.arms {
            case .up: R(-8, -12 - f, 2, 5, arm); R(-8, -13 - f, 2, 1, hand)
            case .type: R(-7, -8, 2, 3, arm); R(-6, -5 - f, 2, 1, hand)
            default: R(-7, -8, 2, 4, arm); R(-7, -4, 2, 1, hand)
            }
            switch pose.arms {
            case .up: R(6, -12 - (f ^ 1), 2, 5, arm); R(6, -13 - (f ^ 1), 2, 1, hand)
            case .type: R(5, -8, 2, 3, arm); R(4, -5 - (f ^ 1), 2, 1, hand)
            case .point: R(5, -8, 4, 2, arm); R(9, -8, 1, 2, hand)
            case .hold: R(5, -8, 2, 2, arm); R(4, -7, 2, 1, hand)
            default: R(5, -8, 2, 4, arm); R(5, -4, 2, 1, hand)
            }
        }
        func legs(_ leg: Color, _ shoe: Color) {
            if pose.legs == .seated { return }
            let f = pose.legs == .walk ? (pose.frame & 3) : 0
            let liftL = f == 1 ? 1 : 0, liftR = f == 3 ? 1 : 0
            R(-4, -2 - liftL, 3, 1, leg); R(-4, -1 - liftL, 3, 1, shoe)
            R(1, -2 - liftR, 3, 1, leg); R(1, -1 - liftR, 3, 1, shoe)
        }
        func accessory(_ robot: Bool, _ ey: Int) {
            switch look.accessory {
            case .glasses:
                let fr = robot ? c(0, 14) : c(0, 2)
                for x in [-5, 1] { D(x, ey - 1, 4, 1, fr); D(x, ey + 2, 4, 1, fr); D(x, ey, 1, 2, fr); D(x + 3, ey, 1, 2, fr) }
                D(-1, ey, 2, 1, fr)
            case .headset:
                let dark = c(0, 4)
                R(-6, -19, 12, 1, dark); R(-8, -15, 2, 4, dark); D(-8, -14, 1, 2, c(rp, 11)); D(-6, -11, 1, 1, dark); D(-5, -10, 2, 1, dark)
            case .cap:
                R(-6, -20, 12, 3, c(rp, 9)); D(-6, -18, 12, 1, c(rp, 6)); R(5, -18, 4, 1, c(rp, 6)); D(-1, -20, 2, 1, c(rp, 6))
            case .bow:
                R(1, -20, 2, 2, c(15, 11)); R(4, -20, 2, 2, c(15, 11)); D(3, -20, 1, 2, c(15, 7))
            case .none: break
            }
        }
        let armsOver = pose.arms == .up

        if look.kind == .robot {
            let shell = ghost ? c(0, 9) : c(rp, 14), shellHi = c(0, 15), shellShade = ghost ? c(0, 7) : c(0, 11)
            let accent = ghost ? c(0, 7) : c(rp, 9), accentDark = ghost ? c(0, 5) : c(rp, 6)
            let visor = ghost ? c(0, 3) : c(rp, 1), glow = ghost ? c(0, 8) : c(rp, 12)
            var light = pose.mood == .focused ? c(3, 13) : glow
            if !ghost && (ms + UInt64(seed)) % 2400 < 1200 { light = pose.mood == .focused ? c(3, 11) : c(rp, 10) }
            let v = look.variant & 3
            legs(shellShade, accentDark)
            if v == 1 { R(-5, -19, 1, 1, accentDark); R(4, -19, 1, 1, accentDark); R(-6, -20, 2, 1, light); R(4, -20, 2, 1, light) }
            else { R(-1, -19, 2, 1, accentDark); R(-1, -20, 2, 1, light) }
            if !armsOver { arms(shell, accent) }
            RR(-5, -8, 10, 6, 1, shell); D(-4, -3, 8, 1, shellShade); D(-2, -7, 4, 3, accent); D(-1, -6, 2, 1, light)
            R(-8, -15, 1, 3, accent); R(7, -15, 1, 3, accent)
            RR(-7, -18, 14, 10, [1, 2, 0, 1][v], shell)
            D(-4, -17, 8, 1, shellHi); D(-6, -10, 12, 1, shellShade)
            RR(-5, -16, 10, 6, v == 2 ? 0 : 1, visor, detail: true)
            eyes(-4, 2, -15, glow)
            if !ghost && pose.mood != .sleepy { let blush = c(15, pose.mood == .happy ? 11 : 8); D(-5, -12, 1, 1, blush); D(4, -12, 1, 1, blush) }
            mouth(-11, glow)
            if armsOver { arms(shell, accent) }
            accessory(true, -15)
        } else {
            let skinRGB = Self.skinRGB[look.skin % 6], hairRGB = Self.hairRGB[look.hairColor % 8]
            let skin = ghost ? c(0, 10) : Self.rgb(skinRGB), skinShade = ghost ? c(0, 8) : Self.rgb(skinRGB, shade: 0.82)
            let hair = ghost ? c(0, 6) : Self.rgb(hairRGB), hairShade = ghost ? c(0, 5) : Self.rgb(hairRGB, shade: 0.7)
            let shirt = ghost ? c(0, 8) : c(rp, 8), shirtShade = ghost ? c(0, 6) : c(rp, 6)
            let ink = ghost ? c(0, 4) : c(0, 1), white = c(0, ghost ? 11 : 15)
            let style = look.hairStyle % 6
            legs(c(0, 5), c(0, 2))
            switch style { case 1: R(-7, -17, 14, 9, hair); case 3: R(-2, -20, 4, 2, hair); case 5: R(-8, -18, 16, 8, hair); default: break }
            if !armsOver { arms(shirt, skin) }
            RR(-5, -8, 10, 6, 1, shirt); D(-4, -3, 8, 1, shirtShade); D(-2, -8, 4, 1, white); D(-1, -7, 2, 1, white); D(2, -5, 2, 1, c(rp, 11)); D(2, -4, 2, 1, white)
            R(-7, -13, 1, 2, skin); R(6, -13, 1, 2, skin)
            RR(-6, -17, 12, 9, 2, skin); D(-3, -9, 6, 1, skinShade)
            switch style {
            case 1: R(-4, -18, 8, 1, hair); R(-6, -17, 12, 2, hair); R(-6, -15, 3, 1, hair); R(3, -15, 3, 1, hair); R(-7, -15, 1, 7, hair); R(6, -15, 1, 7, hair)
            case 2: R(-4, -19, 1, 1, hair); R(-1, -20, 1, 2, hair); R(2, -19, 1, 1, hair); R(-4, -18, 8, 1, hair); R(-6, -17, 12, 2, hair); R(-6, -15, 2, 1, hair); R(-2, -15, 1, 1, hair); R(3, -15, 3, 1, hair)
            case 3: R(-4, -18, 8, 1, hair); R(-6, -17, 12, 3, hair); D(-4, -15, 8, 1, hairShade)
            case 4: R(-4, -18, 8, 1, hair); R(-6, -17, 12, 1, hair)
            case 5: R(-5, -20, 10, 1, hair); R(-7, -19, 14, 1, hair); R(-8, -18, 16, 3, hair); R(-8, -15, 2, 4, hair); R(6, -15, 2, 4, hair); D(-5, -19, 1, 1, hairShade); D(1, -18, 1, 1, hairShade); D(-3, -17, 1, 1, hairShade); D(4, -16, 1, 1, hairShade)
            default: R(-4, -18, 8, 1, hair); R(-6, -17, 12, 2, hair); R(-6, -15, 5, 1, hair); R(-6, -14, 1, 2, hair); R(5, -15, 1, 2, hair)
            }
            eyes(-4, 2, -13, ink)
            if !ghost { let blush = c(15, pose.mood == .happy ? 12 : 13); D(-5, -11, 1, 1, blush); D(4, -11, 1, 1, blush) }
            mouth(-10, ghost ? ink : c(1, 5))
            if armsOver { arms(shirt, skin) }
            accessory(false, -13)
        }

        let s = scale
        func rect(_ cell: Cell, grow: CGFloat) -> CGRect {
            let x = pose.flip ? -cell.x - cell.w : cell.x
            return CGRect(x: cx + CGFloat(x) * s - grow, y: footY + CGFloat(cell.y) * s - grow, width: CGFloat(cell.w) * s + 2 * grow, height: CGFloat(cell.h) * s + 2 * grow)
        }
        if ghost { ctx.opacity = 0.45 }
        else { for cell in cells where !cell.detail { ctx.fill(Path(rect(cell, grow: max(1, s * 0.34))), with: .color(c(0, 1))) } }
        for cell in cells { ctx.fill(Path(rect(cell, grow: 0)), with: .color(cell.color)) }
        if ghost { ctx.opacity = 1 }
    }
}

/// A single animated character, e.g. as an avatar.
struct PixelAvatar: View {
    let look: CharacterLook
    var mood: CharacterPose.Mood = .neutral
    var ghost = false
    var size: CGFloat = 32
    var animated = true
    var seed: UInt32 = 0
    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 8, paused: !animated)) { tl in
            Canvas { ctx, sz in
                let scale = floor(sz.height / 21 * 2) / 2
                PixelCharacterPainter(look: look, pose: CharacterPose(mood: mood, ghost: ghost), cx: sz.width / 2, footY: sz.height - scale * 0.5, scale: scale,
                                      now: tl.date.timeIntervalSinceReferenceDate, seed: seed).draw(in: &ctx)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
