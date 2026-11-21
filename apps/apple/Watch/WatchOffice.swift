import SwiftUI
import EmperorCore

/// Page 1: a tiny living office. Working agents type at their desks and think out
/// loud; idle agents stretch their legs and wander; offline agents doze as ghosts.
/// Tap anyone to talk to them.
struct WatchOffice: View {
    let agents: [Agent]
    let company: String
    let needsYou: Int
    let open: (Agent) -> Void
    @Environment(\.isLuminanceReduced) private var dimmed
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var tapped = 0

    private var cast: [Agent] {
        Array(agents.sorted { a, b in
            if a.isWorking != b.isWorking { return a.isWorking }
            return a.name.localizedStandardCompare(b.name) == .orderedAscending
        }.prefix(8))
    }

    var body: some View {
        GeometryReader { geo in
            TimelineView(.animation(minimumInterval: 1.0 / 15, paused: dimmed || reduceMotion)) { tl in
                let t = tl.date.timeIntervalSinceReferenceDate
                let layout = OfficeLayout(size: geo.size, agents: cast)
                ZStack(alignment: .bottom) {
                    Canvas { ctx, size in
                        drawRoom(&ctx, size: size, t: t)
                        for (i, agent) in cast.enumerated() { drawAgent(&ctx, agent: agent, slot: layout.slots[i], t: t, layout: layout) }
                    }
                    .contentShape(Rectangle())
                    .gesture(SpatialTapGesture().onEnded { value in
                        if let i = layout.hit(value.location, t: t, agents: cast) { tapped += 1; open(cast[i]) }
                    })
                    caption(t: t, layout: layout)
                }
                .overlay(alignment: .topLeading) { header }
            }
        }
        .ignoresSafeArea(edges: .bottom)
        .sensoryFeedback(.selection, trigger: tapped)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(company) office. \(agents.filter(\.isWorking).count) agents working.")
    }

    // MARK: header & caption

    private var header: some View {
        HStack(spacing: 5) {
            Image("Emblem").resizable().interpolation(.none).scaledToFit().frame(height: 11)
            Text(company).font(.system(.footnote, design: .rounded).weight(.semibold)).lineLimit(1)
            if needsYou > 0 {
                Text("\(needsYou)").font(.system(.caption2, design: .rounded).weight(.bold)).monospacedDigit()
                    .foregroundStyle(.black).padding(.horizontal, 5).background(Color.orange, in: Capsule())
            }
        }
        .padding(.leading, 6).padding(.top, 2)
        .accessibilityElement(children: .combine)
    }

    /// One working agent at a time narrates, typed out like the desk display's bubble.
    @ViewBuilder private func caption(t: TimeInterval, layout: OfficeLayout) -> some View {
        let speakers = cast.filter { $0.isWorking && !(($0.activity ?? $0.taskTitle) ?? "").isEmpty }
        if let i = speakers.isEmpty ? nil : Int(t / 5) % speakers.count {
            let agent = speakers[i]
            let line = ((agent.activity ?? agent.taskTitle) ?? "").replacingOccurrences(of: "\n", with: " ")
            let shown = dimmed || reduceMotion ? line : String(line.prefix(Int(t.truncatingRemainder(dividingBy: 5) * 34)))
            HStack(alignment: .top, spacing: 5) {
                PixelAvatar(look: CharacterLook.resolve(id: agent.id, appearance: agent.avatarAppearance), mood: .focused, size: 18, animated: false)
                VStack(alignment: .leading, spacing: 0) {
                    Text(agent.name).font(.system(.caption2, design: .rounded).weight(.bold)).foregroundStyle(Color(hue: Double(CharacterLook.resolve(id: agent.id, appearance: agent.avatarAppearance).hue) / 360, saturation: 0.55, brightness: 1))
                    Text(shown).font(.system(size: 11)).foregroundStyle(.white.opacity(0.9)).lineLimit(2)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .padding(.horizontal, 4).padding(.bottom, 4)
            .id(agent.id)
            .transition(.opacity.combined(with: .move(edge: .bottom)))
            .animation(.smooth(duration: 0.4), value: agent.id)
        }
    }

    // MARK: drawing

    private func drawRoom(_ ctx: inout GraphicsContext, size: CGSize, t: TimeInterval) {
        let c = PixelCharacterPainter.c
        ctx.fill(Path(CGRect(origin: .zero, size: size)), with: .color(c(0, 1)))
        // Checkered floor below the back wall.
        let tile: CGFloat = 14, wall = size.height * 0.2
        var y = wall
        var row = 0
        while y < size.height {
            var x: CGFloat = 0, col = row % 2
            while x < size.width {
                ctx.fill(Path(CGRect(x: x, y: y, width: tile, height: tile)), with: .color(col % 2 == 0 ? c(0, 2) : c(0, 3)))
                x += tile; col += 1
            }
            y += tile; row += 1
        }
        // Back wall with a window glow and the crown banner.
        ctx.fill(Path(CGRect(x: 0, y: 0, width: size.width, height: wall)), with: .color(c(0, 3)))
        ctx.fill(Path(CGRect(x: 0, y: wall - 2, width: size.width, height: 2)), with: .color(c(0, 5)))
        let pulse = 0.5 + 0.5 * sin(t * 2 * .pi / 4)
        ctx.fill(Path(ellipseIn: CGRect(x: size.width / 2 - 34, y: wall - 24, width: 68, height: 40)),
                 with: .radialGradient(Gradient(colors: [c(3, 12).opacity(0.18 + 0.12 * pulse), .clear]), center: CGPoint(x: size.width / 2, y: wall - 4), startRadius: 0, endRadius: 34))
    }

    private func drawAgent(_ ctx: inout GraphicsContext, agent: Agent, slot: CGPoint, t: TimeInterval, layout: OfficeLayout) {
        let c = PixelCharacterPainter.c
        let look = CharacterLook.resolve(id: agent.id, appearance: agent.avatarAppearance)
        let seed = CharacterLook.hash(agent.id)
        let s = layout.scale
        let offline = agent.statusLabel == "Offline"
        let rampHue = PixelCharacterPainter.hueRamp(look.hue)

        if agent.isWorking {
            // Desk with a glowing laptop; the agent sits behind it typing.
            let deskW = 18 * s, deskTop = slot.y - 5 * s
            ctx.fill(Path(CGRect(x: slot.x - deskW / 2, y: deskTop, width: deskW, height: 5 * s)), with: .color(c(0, 5)))
            ctx.fill(Path(CGRect(x: slot.x - deskW / 2, y: deskTop, width: deskW, height: s)), with: .color(c(0, 7)))
            let flicker = (UInt64(t * 6) + UInt64(seed)) % 5 == 0 ? 0.7 : 1.0
            ctx.fill(Path(CGRect(x: slot.x - 4 * s, y: deskTop - 5 * s, width: 8 * s, height: 5 * s)), with: .color(c(0, 2)))
            ctx.fill(Path(CGRect(x: slot.x - 3 * s, y: deskTop - 4 * s, width: 6 * s, height: 3 * s)), with: .color(c(rampHue, 12).opacity(flicker)))
            let pose = CharacterPose(mood: (seed % 4 == 0) ? .scanning : .focused, arms: .type, legs: .seated, frame: Int(t * 6 + Double(seed % 7)), flip: false)
            var layer = ctx
            layer.clip(to: Path(CGRect(x: slot.x - 12 * s, y: slot.y - 40 * s, width: 24 * s, height: 35 * s)))
            PixelCharacterPainter(look: look, pose: pose, cx: slot.x, footY: deskTop + 2 * s, scale: s, now: t, seed: seed).draw(in: &layer)
            // Thought puffs rising.
            let phase = (t + Double(seed % 10)).truncatingRemainder(dividingBy: 2.4) / 2.4
            for k in 0..<3 {
                let p = (phase + Double(k) / 3).truncatingRemainder(dividingBy: 1)
                let r = (1 + p * 1.6) * s
                ctx.fill(Path(ellipseIn: CGRect(x: slot.x + 6 * s + CGFloat(p) * 3 * s - r, y: deskTop - 22 * s - CGFloat(p) * 8 * s - r, width: 2 * r, height: 2 * r)),
                         with: .color(.white.opacity(0.55 * (1 - p))))
            }
        } else {
            // Wander: a new spot every few seconds, walking between them.
            let pos = layout.wanderPosition(slot: slot, seed: seed, t: t, still: offline)
            let pose = CharacterPose(mood: offline ? .sleepy : (agent.paused == true ? .worried : .happy), arms: .down,
                                     legs: pos.moving ? .walk : .stand, frame: Int(t * 8), flip: pos.facingLeft, ghost: offline)
            // Soft shadow.
            ctx.fill(Path(ellipseIn: CGRect(x: pos.point.x - 5 * s, y: pos.point.y - s, width: 10 * s, height: 2.5 * s)), with: .color(.black.opacity(0.35)))
            PixelCharacterPainter(look: look, pose: pose, cx: pos.point.x, footY: pos.point.y, scale: s, now: t, seed: seed).draw(in: &ctx)
            if offline {
                let z = (t + Double(seed % 5)).truncatingRemainder(dividingBy: 2) / 2
                ctx.draw(Text("z").font(.system(size: 7 + 4 * z, weight: .bold, design: .rounded)).foregroundColor(.white.opacity(0.6 * (1 - z))),
                         at: CGPoint(x: pos.point.x + 7 * s, y: pos.point.y - 22 * s - CGFloat(z) * 6 * s))
            }
        }
    }
}

/// Slots on the floor, character scale and wandering paths.
struct OfficeLayout {
    let size: CGSize
    let scale: CGFloat
    let slots: [CGPoint]

    init(size: CGSize, agents: [Agent]) {
        self.size = size
        let n = max(1, agents.count)
        let cols = n <= 4 ? 2 : (n <= 6 ? 3 : 4)
        let rows = Int(ceil(Double(n) / Double(cols)))
        let top = size.height * 0.2 + 4, bottom = size.height - 50
        let cellW = size.width / CGFloat(cols), cellH = (bottom - top) / CGFloat(max(rows, 1))
        scale = max(1.5, (min(cellW / 20, cellH / 26) * 2).rounded(.down) / 2)
        var points: [CGPoint] = []
        for i in 0..<n {
            let r = i / cols, col = i % cols
            let stagger: CGFloat = r % 2 == 1 ? cellW * 0.12 : 0
            points.append(CGPoint(x: cellW * (CGFloat(col) + 0.5) + stagger, y: top + cellH * CGFloat(r + 1) - 2))
        }
        slots = points
    }

    struct Wander { let point: CGPoint; let moving: Bool; let facingLeft: Bool }

    func wanderPosition(slot: CGPoint, seed: UInt32, t: TimeInterval, still: Bool) -> Wander {
        if still { return Wander(point: slot, moving: false, facingLeft: false) }
        let period = 6.0 + Double(seed % 4)
        let leg = floor((t + Double(seed % 13)) / period)
        func spot(_ k: Double) -> CGPoint {
            let h = CharacterLook.hash("\(seed)-\(Int(k))")
            let dx = (CGFloat(h % 100) / 100 - 0.5) * scale * 22
            let dy = (CGFloat((h >> 8) % 100) / 100 - 0.5) * scale * 6
            return CGPoint(x: min(max(slot.x + dx, 10 * scale), size.width - 10 * scale), y: slot.y + dy)
        }
        let a = spot(leg), b = spot(leg + 1)
        let local = ((t + Double(seed % 13)).truncatingRemainder(dividingBy: period)) / period
        let walk = 0.35  // walk during the first 35% of each leg, then pause
        let p = min(1, local / walk)
        let eased = p < 0.5 ? 2 * p * p : 1 - pow(-2 * p + 2, 2) / 2
        let point = CGPoint(x: a.x + (b.x - a.x) * eased, y: a.y + (b.y - a.y) * eased)
        return Wander(point: point, moving: local < walk && abs(b.x - a.x) > 2, facingLeft: b.x < a.x)
    }

    func hit(_ location: CGPoint, t: TimeInterval, agents: [Agent]) -> Int? {
        var best: (Int, CGFloat)?
        for (i, agent) in agents.enumerated() {
            let seed = CharacterLook.hash(agent.id)
            let foot = agent.isWorking ? CGPoint(x: slots[i].x, y: slots[i].y - 3 * scale)
                : wanderPosition(slot: slots[i], seed: seed, t: t, still: agent.statusLabel == "Offline").point
            let center = CGPoint(x: foot.x, y: foot.y - 10 * scale)
            let d = hypot(location.x - center.x, location.y - center.y)
            if d < 16 * scale, d < (best?.1 ?? .infinity) { best = (i, d) }
        }
        return best?.0
    }
}
