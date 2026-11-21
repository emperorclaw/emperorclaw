import SwiftUI
import EmperorCore

/// Page 1: a living office that scales from 2 to 50 agents. Turn the Digital Crown
/// to walk through three zones: Working (desks, typing, thinking), Lounge
/// (available agents wandering) and Away (offline agents dozing). A caption
/// narrates what working agents are doing. Tap anyone to talk to them.
struct WatchOffice: View {
    let agents: [Agent]
    let company: String
    let needsYou: Int
    let open: (Agent) -> Void
    @Environment(\.isLuminanceReduced) private var dimmed
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var tapped = 0

    private var cast: [Agent] {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--qa-crowd") { return Self.crowd(from: agents) }
        #endif
        return agents
    }

    var body: some View {
        GeometryReader { geo in
            let layout = OfficePlan(width: geo.size.width, agents: cast)
            ZStack(alignment: .bottom) {
                ScrollView {
                    TimelineView(.animation(minimumInterval: 1.0 / 12, paused: dimmed || reduceMotion)) { tl in
                        let t = tl.date.timeIntervalSinceReferenceDate
                        Canvas { ctx, size in
                            drawFloor(&ctx, size: size, layout: layout, t: t)
                            for seat in layout.seats { drawSeat(&ctx, seat: seat, t: t, layout: layout) }
                        }
                        .frame(width: geo.size.width, height: layout.height)
                        .contentShape(Rectangle())
                        .gesture(SpatialTapGesture().onEnded { value in
                            if let agent = layout.hit(value.location, t: t) { tapped += 1; open(agent) }
                        })
                    }
                    .padding(.top, 18)
                    .padding(.bottom, 56)
                }
                .scrollIndicators(.hidden)
                #if DEBUG
                .defaultScrollAnchor(ProcessInfo.processInfo.arguments.contains("--qa-bottom") ? .bottom : .top)
                #endif
                caption(working: layout.seats.filter { $0.zone == .working }.map(\.agent))
            }
            .overlay(alignment: .topLeading) { header(counts: layout.counts) }
        }
        .ignoresSafeArea(edges: .bottom)
        .sensoryFeedback(.selection, trigger: tapped)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(company) office. \(cast.filter(\.isWorking).count) working of \(cast.count) agents.")
    }

    // MARK: header & caption

    private func header(counts: (working: Int, lounge: Int, away: Int)) -> some View {
        HStack(spacing: 5) {
            Image("Emblem").resizable().interpolation(.none).scaledToFit().frame(height: 11)
            Text(company).font(.system(.footnote, design: .rounded).weight(.semibold)).lineLimit(1)
            if needsYou > 0 {
                Text("\(needsYou)").font(.system(.caption2, design: .rounded).weight(.bold)).monospacedDigit()
                    .foregroundStyle(.black).padding(.horizontal, 5).background(Color.orange, in: Capsule())
            }
        }
        .padding(.horizontal, 6).padding(.vertical, 2)
        .background(Color.black.opacity(0.55), in: Capsule())
        .padding(.leading, 4)
        .accessibilityElement(children: .combine)
    }

    /// One working agent at a time narrates, typed out like the desk display's bubble.
    private func caption(working: [Agent]) -> some View {
        TimelineView(.animation(minimumInterval: 1.0 / 20, paused: dimmed || reduceMotion)) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate
            let speakers = working.filter { !(($0.activity ?? $0.taskTitle) ?? "").isEmpty }
            if !speakers.isEmpty {
                let agent = speakers[Int(t / 5) % speakers.count]
                let look = CharacterLook.resolve(id: agent.id, appearance: agent.avatarAppearance)
                let line = ((agent.activity ?? agent.taskTitle) ?? "").replacingOccurrences(of: "\n", with: " ")
                let shown = dimmed || reduceMotion ? line : String(line.prefix(Int(t.truncatingRemainder(dividingBy: 5) * 34)))
                HStack(alignment: .top, spacing: 5) {
                    PixelAvatar(look: look, mood: .focused, size: 18, animated: false)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(agent.name).font(.system(.caption2, design: .rounded).weight(.bold))
                            .foregroundStyle(Color(hue: Double(look.hue) / 360, saturation: 0.55, brightness: 1)).lineLimit(1)
                        Text(shown).font(.system(size: 11)).foregroundStyle(.white.opacity(0.9)).lineLimit(2)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 8).padding(.vertical, 5)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .padding(.horizontal, 4).padding(.bottom, 4)
            }
        }
        .allowsHitTesting(false)
    }

    // MARK: drawing

    private func drawFloor(_ ctx: inout GraphicsContext, size: CGSize, layout: OfficePlan, t: TimeInterval) {
        let c = PixelCharacterPainter.c
        for zone in layout.zones {
            let r = zone.rect
            // Each zone is its own room: tinted floor tiles and a label with a count.
            let (a, b): (Color, Color) = switch zone.kind {
            case .working: (c(0, 2), c(0, 3))
            case .lounge: (c(9, 2).opacity(0.55), c(9, 3).opacity(0.55))
            case .away: (c(0, 1), c(0, 2))
            }
            let path = Path(roundedRect: r, cornerRadius: 10)
            ctx.fill(path, with: .color(c(0, 1)))
            var room = ctx
            room.clip(to: path)
            let tile: CGFloat = 12
            var y = r.minY, row = 0
            while y < r.maxY {
                var x = r.minX, col = row % 2
                while x < r.maxX { room.fill(Path(CGRect(x: x, y: y, width: tile, height: tile)), with: .color(col % 2 == 0 ? a : b)); x += tile; col += 1 }
                y += tile; row += 1
            }
            ctx.stroke(path, with: .color(c(0, 5)), lineWidth: 1)
            let label = zone.kind == .working ? "WORKING" : zone.kind == .lounge ? "LOUNGE" : "AWAY"
            let tint: Color = zone.kind == .working ? .green : zone.kind == .lounge ? Color(hue: 0.55, saturation: 0.5, brightness: 1) : .gray
            ctx.draw(Text("\(label)  \(zone.count)").font(.system(size: 9, weight: .bold, design: .rounded)).foregroundColor(tint),
                     at: CGPoint(x: r.minX + 8, y: r.minY + 8), anchor: .leading)
        }
        _ = t
    }

    private func drawSeat(_ ctx: inout GraphicsContext, seat: OfficePlan.Seat, t: TimeInterval, layout: OfficePlan) {
        let c = PixelCharacterPainter.c
        let agent = seat.agent
        let look = CharacterLook.resolve(id: agent.id, appearance: agent.avatarAppearance)
        let seed = CharacterLook.hash(agent.id)
        let s = seat.scale
        switch seat.zone {
        case .working:
            let rampHue = PixelCharacterPainter.hueRamp(look.hue)
            let deskW = 18 * s, deskTop = seat.anchor.y - 5 * s
            let x = seat.anchor.x
            let pose = CharacterPose(mood: (seed % 4 == 0) ? .scanning : .focused, arms: .type, legs: .seated, frame: Int(t * 6 + Double(seed % 7)))
            PixelCharacterPainter(look: look, pose: pose, cx: x, footY: deskTop + 2 * s, scale: s, now: t, seed: seed).draw(in: &ctx)
            ctx.fill(Path(CGRect(x: x - deskW / 2, y: deskTop, width: deskW, height: 5 * s)), with: .color(c(0, 5)))
            ctx.fill(Path(CGRect(x: x - deskW / 2, y: deskTop, width: deskW, height: s)), with: .color(c(0, 7)))
            let flicker = (UInt64(t * 6) + UInt64(seed)) % 5 == 0 ? 0.7 : 1.0
            ctx.fill(Path(CGRect(x: x - 4 * s, y: deskTop - 4 * s, width: 8 * s, height: 4 * s)), with: .color(c(0, 2)))
            ctx.fill(Path(CGRect(x: x - 3 * s, y: deskTop - 3 * s, width: 6 * s, height: 2 * s)), with: .color(c(rampHue, 12).opacity(flicker)))
            let phase = (t + Double(seed % 10)).truncatingRemainder(dividingBy: 2.4) / 2.4
            for k in 0..<3 {
                let p = (phase + Double(k) / 3).truncatingRemainder(dividingBy: 1)
                let r = (0.8 + p * 1.4) * s
                ctx.fill(Path(ellipseIn: CGRect(x: x + 6 * s + CGFloat(p) * 3 * s - r, y: deskTop - 22 * s - CGFloat(p) * 7 * s - r, width: 2 * r, height: 2 * r)),
                         with: .color(.white.opacity(0.55 * (1 - p))))
            }
            nameTag(&ctx, agent.name, at: CGPoint(x: x, y: deskTop + 5 * s + 6), color: .white)
        case .lounge:
            let pos = layout.wander(seat, t: t)
            let pose = CharacterPose(mood: agent.paused == true ? .worried : .happy, arms: .down, legs: pos.moving ? .walk : .stand, frame: Int(t * 8), flip: pos.facingLeft)
            ctx.fill(Path(ellipseIn: CGRect(x: pos.point.x - 5 * s, y: pos.point.y - s, width: 10 * s, height: 2.5 * s)), with: .color(.black.opacity(0.35)))
            PixelCharacterPainter(look: look, pose: pose, cx: pos.point.x, footY: pos.point.y, scale: s, now: t, seed: seed).draw(in: &ctx)
        case .away:
            let pose = CharacterPose(mood: .sleepy, ghost: true)
            PixelCharacterPainter(look: look, pose: pose, cx: seat.anchor.x, footY: seat.anchor.y, scale: s, now: t, seed: seed).draw(in: &ctx)
            let z = (t + Double(seed % 5)).truncatingRemainder(dividingBy: 2.4) / 2.4
            ctx.draw(Text("z").font(.system(size: 6 + 3 * z, weight: .bold, design: .rounded)).foregroundColor(.white.opacity(0.5 * (1 - z))),
                     at: CGPoint(x: seat.anchor.x + 6 * s, y: seat.anchor.y - 20 * s - CGFloat(z) * 5 * s))
        }
    }

    private func nameTag(_ ctx: inout GraphicsContext, _ name: String, at point: CGPoint, color: Color) {
        let short = name.count > 9 ? String(name.prefix(8)) + "…" : name
        ctx.draw(Text(short).font(.system(size: 8, weight: .semibold, design: .rounded)).foregroundColor(color.opacity(0.85)), at: point)
    }

    #if DEBUG
    /// QA: twenty agents (real ones plus derived extras) to check how the office scales.
    static func crowd(from agents: [Agent]) -> [Agent] {
        guard let template = agents.first else { return agents }
        var all = agents
        let names = ["Atlas", "Nova", "Pixel", "Sage", "Echo", "Orbit", "Quill", "Rune", "Tide", "Vale", "Wren", "Zed", "Lumen", "Mira"]
        for (i, name) in names.enumerated() where all.count < 20 {
            var a = template
            a.id = "qa-\(name)"; a.name = name; a.avatarAppearance = nil
            a.state = ["working", "idle", "offline", "offline"][i % 4]
            a.activity = a.state == "working" ? "Reviewing pull request #\(40 + i)" : nil
            a.paused = false
            all.append(a)
        }
        return all
    }
    #endif
}

/// Zones, seats and wandering paths for any number of agents.
struct OfficePlan {
    enum Zone { case working, lounge, away }
    struct Seat { let agent: Agent; let zone: Zone; let anchor: CGPoint; let scale: CGFloat; let cell: CGRect }
    struct ZoneRect { let kind: Zone; let rect: CGRect; let count: Int }

    let width: CGFloat
    private(set) var seats: [Seat] = []
    private(set) var zones: [ZoneRect] = []
    private(set) var height: CGFloat = 0
    var counts: (working: Int, lounge: Int, away: Int) {
        (seats.filter { $0.zone == .working }.count, seats.filter { $0.zone == .lounge }.count, seats.filter { $0.zone == .away }.count)
    }

    init(width: CGFloat, agents: [Agent]) {
        self.width = width
        let sorted = agents.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        let working = sorted.filter(\.isWorking)
        let away = sorted.filter { !$0.isWorking && $0.statusLabel == "Offline" }
        let lounge = sorted.filter { !$0.isWorking && $0.statusLabel != "Offline" }
        let inset: CGFloat = 4, gap: CGFloat = 8, labelH: CGFloat = 16
        var y: CGFloat = 0

        func zone(_ kind: Zone, _ list: [Agent], cols: Int, scale: CGFloat, rowH: CGFloat, footFromTop: CGFloat) {
            guard !list.isEmpty else { return }
            let rows = Int(ceil(Double(list.count) / Double(cols)))
            let rect = CGRect(x: inset, y: y, width: width - 2 * inset, height: labelH + CGFloat(rows) * rowH + 4)
            zones.append(ZoneRect(kind: kind, rect: rect, count: list.count))
            let cellW = rect.width / CGFloat(cols)
            for (i, agent) in list.enumerated() {
                let r = i / cols, c = i % cols
                // Center a short last row.
                let inRow = r == rows - 1 ? list.count - r * cols : cols
                let offset = CGFloat(cols - inRow) * cellW / 2
                let cell = CGRect(x: rect.minX + offset + CGFloat(c) * cellW, y: rect.minY + labelH + CGFloat(r) * rowH, width: cellW, height: rowH)
                seats.append(Seat(agent: agent, zone: kind, anchor: CGPoint(x: cell.midX, y: cell.minY + footFromTop), scale: scale, cell: cell))
            }
            y = rect.maxY + gap
        }
        zone(.working, working, cols: 3, scale: 2, rowH: 66, footFromTop: 50)
        zone(.lounge, lounge, cols: 4, scale: 1.5, rowH: 40, footFromTop: 36)
        zone(.away, away, cols: 5, scale: 1, rowH: 26, footFromTop: 23)
        height = max(y, 40)
    }

    struct Wander { let point: CGPoint; let moving: Bool; let facingLeft: Bool }

    /// Lounge agents stroll inside their own cell, then pause.
    func wander(_ seat: Seat, t: TimeInterval) -> Wander {
        let seed = CharacterLook.hash(seat.agent.id)
        let period = 5.0 + Double(seed % 4)
        let shifted = t + Double(seed % 13)
        let leg = floor(shifted / period)
        func spot(_ k: Double) -> CGPoint {
            let h = CharacterLook.hash("\(seed)-\(Int(k))")
            let span = max(0, seat.cell.width / 2 - 7 * seat.scale)
            return CGPoint(x: seat.anchor.x + (CGFloat(h % 100) / 50 - 1) * span, y: seat.anchor.y + (CGFloat((h >> 8) % 100) / 100 - 0.5) * 3)
        }
        let a = spot(leg), b = spot(leg + 1)
        let local = shifted.truncatingRemainder(dividingBy: period) / period
        let walk = 0.4
        let p = min(1, local / walk)
        let eased = p < 0.5 ? 2 * p * p : 1 - pow(-2 * p + 2, 2) / 2
        return Wander(point: CGPoint(x: a.x + (b.x - a.x) * eased, y: a.y + (b.y - a.y) * eased),
                      moving: local < walk && abs(b.x - a.x) > 2, facingLeft: b.x < a.x)
    }

    func hit(_ location: CGPoint, t: TimeInterval) -> Agent? {
        seats.first { $0.cell.contains(location) }?.agent
    }
}
