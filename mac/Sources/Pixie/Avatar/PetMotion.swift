import AppKit
import PixieCore
import SwiftUI

/// What the "window" prop shows (`look_out_window`).
enum PetWindowStyle: Equatable {
    case day, night, sunset, rain, snow, storm
}

/// Small props drawn around the character for pet behaviours. All positions are in units of `size`,
/// relative to the character frame's centre (y grows downwards).
struct PetProps: Equatable {
    var ball: CGPoint? = nil
    /// Cookie left, 0 … 1.
    var snack: Double? = nil
    var crumbs = false
    var window: PetWindowStyle? = nil
    /// Hand fan angle in degrees.
    var fanAngle: Double? = nil
    var hat = false
    var confetti = false
    var notes = false
    var hearts = false
    /// "hmph" progress 0 … 1.
    var hmph: Double? = nil
    var whisper = false
    var stormCloud = false
}

extension Pose {
    static func duration(of c: PetCue) -> TimeInterval {
        switch c {
        case .glance: return 1.2
        case .hop: return 0.8
        case .pout: return 2.6
        case .squish: return 0.45
        case .whisper: return 3.5
        case .nuzzle: return 1.4
        }
    }

    /// Breathing period (s) and amplitude for the current phase/behaviour.
    @MainActor
    static func breathing(_ m: AvatarModel) -> (Double, Double) {
        switch m.petPhase {
        case .asleep: return (5.4, 0.04)
        case .napping: return (4.8, 0.035)
        case .sleepy: return (4.4, 0.03)
        case .waking: return (4.0, 0.03)
        case .awake: break
        }
        switch m.behaviour {
        case .watchUserWork: return (3.0, 0.014)
        case .sulk: return (2.2, 0.035)
        case .curlNearCursor: return (4.4, 0.03)
        case .selfPlay, .chaseCursor, .festiveWiggle, .makeUp: return (2.2, 0.02)
        case .fanSelf: return (1.8, 0.025)
        case .hide: return (1.4, 0.02)
        case .idleBreathe, .lookAtCursor, .exploreEdge, .peekWindow, .nap, .sleepCurled, .yawnStretch, .eatSnack,
             .lookOutWindow, .bobToMusic, .attentionBid:
            return (3.6, 0.025)
        }
    }

    /// Layers phase, behaviour, touch and cue motion onto a pose. Called before brain gestures are applied.
    @MainActor
    static func applyPet(_ m: AvatarModel, now: Date, to p: inout Pose) {
        let t = p.time
        let (period, amp) = breathing(m)
        let breath = sin(2 * Double.pi * t / period)
        p.scaleY = 1 + amp * breath
        p.scaleX = 1 - amp * 0.5 * breath

        // Phase.
        switch m.petPhase {
        case .sleepy:
            p.eyeScaleY *= 0.55
            // Now and then the head nods off for a moment.
            let c = t.truncatingRemainder(dividingBy: 11)
            if c > 8.5 {
                let k = sin((c - 8.5) / 2.5 * Double.pi)
                p.offsetY += 0.025 * k
                p.rotation += 3 * k
                p.eyeScaleY *= 1 - 0.8 * k
            }
        case .waking:
            // Groggy: eyes open slowly, a slight sway.
            let sinceWake = now.timeIntervalSince(m.phaseStart)
            let open = min(1, 0.15 + sinceWake / 8)
            p.eyeScaleY *= open
            p.rotation += sin(t * 1.6) * 4 * (1 - open * 0.7)
        case .awake, .asleep, .napping:
            break
        }

        let e = max(0, now.timeIntervalSince(m.behaviourStart))
        let blend = min(1, e / 0.6)
        let cursor = lookVector(for: .cursor, model: m)

        switch m.behaviour {
        case .idleBreathe:
            break
        case .lookAtCursor:
            p.lookX = cursor.0
            p.lookY = cursor.1
        case .watchUserWork:
            p.lookX = cursor.0 * 0.6 - 0.1
            p.lookY = max(0.2, cursor.1 * 0.6)
            p.rotation += 2 * blend
            if t.truncatingRemainder(dividingBy: 7) < 0.8 { p.offsetY += sin(t * 8) * 0.008 } // little nods
        case .selfPlay:
            // Tossing a ball and watching it.
            let h = abs(sin(e * 2.4))
            p.props.ball = CGPoint(x: 0.04, y: -0.5 - 0.32 * h)
            p.lookY = -0.7 * blend
            p.lookX = 0.1
            if h < 0.2 { p.offsetY -= (0.2 - h) * 0.12 }
        case .chaseCursor:
            p.offsetX += cursor.0 * 0.14 * blend
            p.offsetY -= abs(sin(e * 7)) * 0.035
            p.rotation += cursor.0 * 6
            p.lookX = cursor.0
            p.lookY = cursor.1
            p.props.ball = CGPoint(x: cursor.0 * 0.32, y: 0.5 - abs(sin(e * 7 + 1)) * 0.06)
        case .exploreEdge:
            let dir = cos(e * 0.45)
            p.offsetX += 0.17 * sin(e * 0.45)
            p.offsetY -= abs(sin(e * 6)) * 0.022
            p.rotation += dir * 4
            p.lookX = dir > 0 ? 0.85 : -0.85
            p.lookY = 0.1
        case .peekWindow:
            let c = e.truncatingRemainder(dividingBy: 4) / 4
            let up = c < 0.45 ? 0 : sin((c - 0.45) / 0.55 * Double.pi)
            p.scaleY *= 0.55 + 0.45 * up
            p.scaleX *= 1.08 - 0.08 * up
            p.lookX = sin(e * 0.8) > 0 ? 0.8 : -0.8
            p.lookY = -0.35
        case .nap:
            p.scaleY *= 0.86
            p.scaleX *= 1.06
            p.offsetY += 0.03
            p.rotation -= 3
        case .sleepCurled:
            p.scaleY *= 0.8
            p.scaleX *= 1.12
            p.offsetY += 0.05
            p.rotation -= 7
            p.sproutSway = sin(t * 0.7) * 4 - 18
        case .yawnStretch:
            let k = min(1, e / 4.5)
            if k < 0.45 {
                let s = sin(k / 0.45 * Double.pi)
                p.scaleY *= 1 + 0.14 * s
                p.scaleX *= 1 - 0.06 * s
                p.armAngle = -150 * s
            }
            if k > 0.15 && k < 0.65 {
                let y = sin((k - 0.15) / 0.5 * Double.pi)
                p.mouthOpen = max(p.mouthOpen, 0.95 * y)
                p.face.mouthWidth = 0.7
                p.face.mouthCurve = 0
                p.eyeScaleY = min(p.eyeScaleY, 1 - 0.9 * y)
            }
        case .eatSnack:
            let bites = floor(e / 2)
            p.props.snack = max(0.12, 1 - bites * 0.22)
            p.props.crumbs = bites >= 1
            p.mouthOpen = max(p.mouthOpen, 0.08 + 0.22 * abs(sin(e * 9)))
            p.face.eyeSmile = max(p.face.eyeSmile, 0.8)
            p.lookY = 0.35
        case .lookOutWindow:
            let style = m.windowStyle
            p.props.window = style
            p.lookX = -0.8
            p.lookY = -0.25
            p.offsetX += 0.06 * blend
            if style == .sunset {
                p.face.body = p.face.body.lerp(RGB(r: 1.0, g: 0.72, b: 0.5), 0.3)
            }
        case .fanSelf:
            p.props.fanAngle = sin(e * 12) * 25
            p.armAngle = -70 + sin(e * 12) * 18
            p.eyeScaleY *= 0.75
            p.mouthOpen = max(p.mouthOpen, 0.18 + 0.08 * abs(sin(t * 3)))
            p.decoration = .sweat
        case .hide:
            p.scaleY *= 0.6
            p.scaleX *= 1.08
            p.offsetY += 0.05
            p.offsetX += sin(t * 40) * 0.006
            p.lookY = -0.35
            p.lookX = -0.4
            p.props.stormCloud = true
        case .bobToMusic:
            let beat = t * 1.83
            p.offsetY -= abs(sin(beat * Double.pi)) * 0.04
            p.rotation += sin(beat * Double.pi) * 6
            p.sproutSway += sin(beat * Double.pi) * 10
            p.face.eyeSmile = max(p.face.eyeSmile, 0.7)
            p.props.notes = true
        case .festiveWiggle:
            p.rotation += sin(e * 10) * 8
            p.offsetX += sin(e * 5) * 0.03
            p.props.confetti = true
            p.face.eyeSmile = max(p.face.eyeSmile, 0.8)
        case .curlNearCursor:
            p.offsetX += cursor.0 * 0.08
            p.scaleY *= 0.88
            p.scaleX *= 1.05
            p.offsetY += 0.02
            p.lookX = cursor.0
            p.lookY = cursor.1
            p.eyeScaleY *= 0.6
        case .attentionBid:
            let c = e.truncatingRemainder(dividingBy: 1.4) / 1.4
            p.offsetY -= c < 0.35 ? sin(c / 0.35 * Double.pi) * 0.06 : 0
            p.lookX = 0
            p.lookY = 0.05
            p.armAngle = -30 + sin(e * 9) * 18
        case .sulk:
            p.faceTurn = 0.85 * blend
            p.scaleX *= 1 + 0.07 * blend
            p.scaleY *= 1 + 0.03 * blend
            p.rotation += 3 * blend
            p.cheekPuff = 0.6 * blend
            p.lookX = -0.9
            p.lookY = 0
        case .makeUp:
            let k = min(1, e / 4)
            p.rotation += sin(e * 14) * 10 * (1 - k)
            p.offsetY -= abs(sin(e * 7)) * 0.04 * (1 - k)
            p.face.eyeSmile = 1
            p.props.hearts = true
        }

        if m.festive { p.props.hat = true }

        // Touch.
        if m.carried {
            p.rotation += sin(t * 6) * 6
            p.scaleY *= 1.08
            p.scaleX *= 0.94
            p.eyeScaleY = max(p.eyeScaleY, 1.1)
            p.lookY = 0.4
        } else if m.pettingNow || now < m.strokeUntil {
            if m.dozing {
                p.face.mouthCurve = max(p.face.mouthCurve, 0.8)
            } else {
                p.face.eyeSmile = 1
                p.face.blush = max(p.face.blush, 0.9)
                p.rotation += sin(t * 5) * 4
                p.scaleY *= 0.97
            }
        }

        // One-shot cues.
        if let c = m.cue {
            let d = duration(of: c)
            let k = min(1, max(0, now.timeIntervalSince(m.cueStart) / d))
            let env = min(1, k * 5, (1 - k) * 5)
            switch c {
            case .glance:
                p.lookX = 0
                p.lookY = 0.05
                p.offsetY -= 0.02 * sin(k * Double.pi)
                p.eyeScaleY *= 1 + 0.12 * env
            case .hop:
                let squash = k < 0.15 ? sin(k / 0.15 * Double.pi) : 0
                p.scaleY *= 1 - 0.1 * squash
                p.scaleX *= 1 + 0.07 * squash
                if k >= 0.15 { p.offsetY -= sin((k - 0.15) / 0.85 * Double.pi) * 0.22 }
            case .pout:
                p.cheekPuff = max(p.cheekPuff, env)
                p.faceTurn = max(p.faceTurn, 0.35 * env)
                p.face.mouthCurve = -0.3
                p.face.mouthWidth = 0.45
                p.mouthOpen = 0
                p.face.browOpacity = max(p.face.browOpacity, 0.9 * env)
                p.face.browAngle = -15
                p.scaleX *= 1 + 0.05 * env
                p.props.hmph = k
            case .squish:
                let s = sin(k * Double.pi)
                p.scaleY *= 1 - 0.18 * s
                p.scaleX *= 1 + 0.12 * s
                p.eyeScaleY = min(p.eyeScaleY, 1 - 0.85 * s)
            case .whisper:
                p.props.whisper = true
                p.rotation -= 6 * env
                p.offsetX += 0.03 * env
                p.lookX = 0.6
                p.lookY = 0
            case .nuzzle:
                p.rotation += sin(k * Double.pi * 3) * 7
                p.face.eyeSmile = 1
                p.face.blush = max(p.face.blush, 0.8)
            }
        }
    }
}

// MARK: - Props

/// Hand-drawn party hat (a triangle with a rounded base).
struct PartyHatShape: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: r.midX, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX, y: r.maxY))
        p.addQuadCurve(to: CGPoint(x: r.minX, y: r.maxY), control: CGPoint(x: r.midX, y: r.maxY + r.height * 0.15))
        p.closeSubpath()
        return p
    }
}

/// The little "window" Pixie looks out of. Drawn behind the body.
struct PetWindowView: View {
    let style: PetWindowStyle
    let time: Double
    let size: CGFloat

    private var sky: [Color] {
        switch style {
        case .day: return [Color(red: 0.55, green: 0.80, blue: 1.0), Color(red: 0.80, green: 0.92, blue: 1.0)]
        case .night: return [Color(red: 0.10, green: 0.12, blue: 0.30), Color(red: 0.22, green: 0.22, blue: 0.45)]
        case .sunset: return [Color(red: 0.98, green: 0.55, blue: 0.45), Color(red: 1.0, green: 0.80, blue: 0.45)]
        case .rain, .snow: return [Color(red: 0.55, green: 0.62, blue: 0.72), Color(red: 0.72, green: 0.78, blue: 0.85)]
        case .storm: return [Color(red: 0.25, green: 0.27, blue: 0.36), Color(red: 0.40, green: 0.42, blue: 0.50)]
        }
    }

    var body: some View {
        let s = size
        let w = s * 0.46
        let h = s * 0.5
        ZStack {
            RoundedRectangle(cornerRadius: s * 0.04)
                .fill(LinearGradient(colors: sky, startPoint: .top, endPoint: .bottom))
            if style == .sunset {
                Circle()
                    .fill(Color(red: 1.0, green: 0.88, blue: 0.5))
                    .frame(width: s * 0.13, height: s * 0.13)
                    .offset(y: h * 0.28)
            }
            if style == .rain || style == .storm || style == .snow {
                ForEach(0..<7, id: \.self) { i in
                    let speed: Double = style == .snow ? 0.25 : 0.9
                    let phase: Double = (time * speed + Double(i) * 0.37).truncatingRemainder(dividingBy: 1)
                    let drift: Double = style == .snow ? sin(time + Double(i)) * 3 : 0
                    let x: Double = (Double(i) / 6 - 0.5) * Double(w) * 0.8 + drift
                    let y: Double = (phase - 0.5) * Double(h)
                    Group {
                        if style == .snow {
                            Circle().fill(Color.white).frame(width: s * 0.025, height: s * 0.025)
                        } else {
                            Capsule().fill(Color.white.opacity(0.75)).frame(width: s * 0.012, height: s * 0.05)
                        }
                    }
                    .offset(x: CGFloat(x), y: CGFloat(y))
                }
            }
            if style == .storm && time.truncatingRemainder(dividingBy: 5) < 0.12 {
                RoundedRectangle(cornerRadius: s * 0.04).fill(Color.white.opacity(0.7))
            }
            if style == .night {
                ForEach(0..<4, id: \.self) { i in
                    let twinkle: Double = 0.5 + 0.5 * abs(sin(time * 1.5 + Double(i)))
                    let sx: Double = (Double(i) - 1.5) * 0.09
                    let sy: Double = i % 2 == 0 ? -0.12 : -0.04
                    Circle()
                        .fill(Color.white.opacity(twinkle))
                        .frame(width: s * 0.018, height: s * 0.018)
                        .offset(x: CGFloat(sx) * s, y: CGFloat(sy) * s)
                }
            }
            // Frame and cross bars.
            RoundedRectangle(cornerRadius: s * 0.04)
                .stroke(Color(red: 0.62, green: 0.48, blue: 0.38), lineWidth: s * 0.03)
            Rectangle()
                .fill(Color(red: 0.62, green: 0.48, blue: 0.38))
                .frame(width: s * 0.018, height: h)
            Rectangle()
                .fill(Color(red: 0.62, green: 0.48, blue: 0.38))
                .frame(width: w, height: s * 0.018)
            Capsule()
                .fill(Color(red: 0.55, green: 0.42, blue: 0.33))
                .frame(width: w * 1.15, height: s * 0.04)
                .offset(y: h / 2)
        }
        .frame(width: w, height: h)
        .allowsHitTesting(false)
    }
}

/// Props drawn in front of the body.
struct PetPropsView: View {
    let props: PetProps
    let time: Double
    let size: CGFloat
    /// Character body offset, so held props follow it.
    let bodyOffset: CGSize

    var body: some View {
        ZStack {
            heldProps
            ambientProps
        }
        .allowsHitTesting(false)
    }

    /// Things Pixie holds or plays with.
    private var heldProps: some View {
        let s = size
        return ZStack {
            if let b = props.ball {
                Circle()
                    .fill(RadialGradient(colors: [Color(red: 1.0, green: 0.55, blue: 0.55), Color(red: 0.9, green: 0.3, blue: 0.4)],
                                         center: .topLeading, startRadius: 1, endRadius: s * 0.1))
                    .frame(width: s * 0.13, height: s * 0.13)
                    .overlay(Capsule().fill(Color.white.opacity(0.8)).frame(width: s * 0.13, height: s * 0.025))
                    .rotationEffect(.degrees(time * 200))
                    .offset(x: b.x * s, y: b.y * s)
            }
            if let left = props.snack {
                ZStack {
                    Circle()
                        .trim(from: 0, to: CGFloat(left))
                        .fill(Color(red: 0.85, green: 0.62, blue: 0.36))
                    ForEach(0..<3, id: \.self) { i in
                        Circle()
                            .fill(Color(red: 0.4, green: 0.25, blue: 0.15))
                            .frame(width: s * 0.022, height: s * 0.022)
                            .offset(x: CGFloat(i - 1) * s * 0.03, y: CGFloat(i % 2) * s * 0.02)
                            .opacity(left > Double(i) * 0.3 ? 1 : 0)
                    }
                }
                .frame(width: s * 0.15, height: s * 0.15)
                .rotationEffect(.degrees(-90))
                .offset(x: bodyOffset.width + s * 0.2, y: bodyOffset.height + s * 0.28)
            }
            if props.crumbs {
                ForEach(0..<3, id: \.self) { i in
                    let fall = (time * 0.8 + Double(i) * 0.33).truncatingRemainder(dividingBy: 1)
                    Circle()
                        .fill(Color(red: 0.75, green: 0.55, blue: 0.32))
                        .frame(width: s * 0.018, height: s * 0.018)
                        .offset(x: bodyOffset.width + s * CGFloat(0.12 + Double(i) * 0.04),
                                y: bodyOffset.height + s * CGFloat(0.3 + fall * 0.2))
                        .opacity(1 - fall)
                }
            }
            if let angle = props.fanAngle {
                ZStack {
                    Circle()
                        .trim(from: 0.5, to: 1)
                        .fill(Color(red: 0.98, green: 0.6, blue: 0.7))
                        .frame(width: s * 0.2, height: s * 0.2)
                    Capsule()
                        .fill(Color(red: 0.55, green: 0.4, blue: 0.3))
                        .frame(width: s * 0.02, height: s * 0.12)
                        .offset(y: s * 0.05)
                }
                .rotationEffect(.degrees(angle), anchor: .bottom)
                .offset(x: bodyOffset.width + s * 0.5, y: bodyOffset.height - s * 0.12)
            }
            if props.hat {
                ZStack {
                    PartyHatShape()
                        .fill(LinearGradient(colors: [Color(red: 0.6, green: 0.45, blue: 0.95), Color(red: 1.0, green: 0.5, blue: 0.7)],
                                             startPoint: .top, endPoint: .bottom))
                    Circle()
                        .fill(Color(red: 1.0, green: 0.85, blue: 0.35))
                        .frame(width: s * 0.05, height: s * 0.05)
                        .offset(y: -s * 0.09)
                }
                .frame(width: s * 0.16, height: s * 0.18)
                .rotationEffect(.degrees(14))
                .offset(x: bodyOffset.width + s * 0.17, y: bodyOffset.height - s * 0.36)
            }
        }
    }

    /// Floating effects around Pixie.
    private var ambientProps: some View {
        let s = size
        return ZStack {
            if props.confetti {
                ForEach(0..<6, id: \.self) { i in
                    let fall = (time * 0.5 + Double(i) * 0.17).truncatingRemainder(dividingBy: 1)
                    let hue = Double(i) / 6
                    Rectangle()
                        .fill(Color(hue: hue, saturation: 0.6, brightness: 1))
                        .frame(width: s * 0.025, height: s * 0.04)
                        .rotationEffect(.degrees(time * 120 + Double(i) * 50))
                        .offset(x: s * CGFloat((Double(i) - 2.5) * 0.16), y: s * CGFloat(-0.55 + fall * 0.8))
                        .opacity(1 - fall)
                }
            }
            if props.notes {
                ForEach(0..<2, id: \.self) { i in
                    let rise: Double = (time * 0.45 + Double(i) * 0.5).truncatingRemainder(dividingBy: 1)
                    let side: Double = i == 0 ? 0.42 : -0.44
                    let nx: Double = side + sin(time * 3 + Double(i)) * 0.03
                    let ny: Double = -(0.2 + rise * 0.3)
                    Image(systemName: "music.note")
                        .font(.system(size: s * 0.11, weight: .bold))
                        .foregroundStyle(Color(red: 0.55, green: 0.45, blue: 0.95))
                        .offset(x: s * CGFloat(nx), y: s * CGFloat(ny))
                        .opacity(1 - rise)
                }
            }
            if props.hearts {
                ForEach(0..<3, id: \.self) { i in
                    let rise = (time * 0.7 + Double(i) * 0.33).truncatingRemainder(dividingBy: 1)
                    HeartShape()
                        .fill(Color(red: 1.0, green: 0.42, blue: 0.58))
                        .frame(width: s * 0.09, height: s * 0.08)
                        .offset(x: s * CGFloat((Double(i) - 1) * 0.35), y: -s * CGFloat(0.3 + rise * 0.3))
                        .opacity(1 - rise)
                }
            }
            if let k = props.hmph {
                Text("hmph")
                    .font(.system(size: s * 0.1, weight: .heavy, design: .rounded))
                    .foregroundStyle(Color(red: 0.85, green: 0.35, blue: 0.4))
                    .rotationEffect(.degrees(-8))
                    .offset(x: bodyOffset.width + s * 0.42, y: bodyOffset.height - s * CGFloat(0.32 + k * 0.06))
                    .opacity(min(1, min(k * 6, (1 - k) * 4)))
            }
            if props.whisper {
                ZStack {
                    Capsule()
                        .fill(Color(red: 0.72, green: 0.80, blue: 1.0).opacity(0.95))
                        .frame(width: s * 0.08, height: s * 0.16)
                        .rotationEffect(.degrees(-20))
                        .offset(x: s * 0.2, y: s * 0.18)
                    Text("psst…")
                        .font(.system(size: s * 0.075, weight: .semibold, design: .rounded))
                        .foregroundStyle(Color(red: 0.45, green: 0.45, blue: 0.6))
                        .offset(x: s * 0.42, y: -s * 0.05)
                }
                .offset(bodyOffset)
            }
            if props.stormCloud {
                Image(systemName: "cloud.bolt.fill")
                    .font(.system(size: s * 0.16))
                    .foregroundStyle(Color(red: 0.45, green: 0.48, blue: 0.6))
                    .offset(x: s * 0.4, y: -s * 0.42 + CGFloat(sin(time * 2)) * s * 0.01)
                    .opacity(time.truncatingRemainder(dividingBy: 3) < 0.15 ? 1 : 0.75)
            }
        }
    }
}

/// Puffed cheeks for sulking and pouting.
struct CheekPuffView: View {
    let amount: Double
    let size: CGFloat
    let color: RGB

    var body: some View {
        let s = size
        let d = s * CGFloat(0.1 + 0.06 * amount)
        ZStack {
            Circle().fill(color.lighter(0.25).color)
                .overlay(Circle().fill(Color(red: 1.0, green: 0.5, blue: 0.6).opacity(0.45 * amount)))
                .frame(width: d, height: d)
                .offset(x: -s * 0.28, y: s * 0.11)
            Circle().fill(color.lighter(0.25).color)
                .overlay(Circle().fill(Color(red: 1.0, green: 0.5, blue: 0.6).opacity(0.45 * amount)))
                .frame(width: d, height: d)
                .offset(x: s * 0.28, y: s * 0.11)
        }
        .opacity(min(1, amount * 1.5))
        .allowsHitTesting(false)
    }
}
