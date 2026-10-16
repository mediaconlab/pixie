import AppKit
import PixieCore
import SwiftUI

/// Everything needed to draw one frame of Pixie, computed from the model + time.
struct Pose {
    var face = FaceParams()
    var eyeScaleY: Double = 1     // blink × openness
    var lookX: Double = 0         // −1 … 1
    var lookY: Double = 0         // −1 … 1 (down positive)
    var offsetX: Double = 0       // in units of size
    var offsetY: Double = 0
    var rotation: Double = 0      // degrees
    var scaleX: Double = 1
    var scaleY: Double = 1
    var spin: Double = 0          // degrees around the vertical axis
    var armAngle: Double? = nil   // waving arm, degrees
    var mouthOpen: Double = 0
    var sproutSway: Double = 0
    var decoration: Decoration = .none
    var dozing = false
    var time: Double = 0
    /// 0 = facing the user, 1 = turned away (sulking).
    var faceTurn: Double = 0
    /// Puffed cheeks (sulk / pout), 0 … 1.
    var cheekPuff: Double = 0
    var props = PetProps()

    @MainActor
    static func compute(_ m: AvatarModel, now: Date) -> Pose {
        var p = Pose()
        let t = now.timeIntervalSinceReferenceDate
        p.time = t
        p.dozing = m.dozing
        p.face = m.currentFace(at: now)
        p.decoration = EmotionStyle.decoration(for: m.displayedEmotion)
        if m.intensity < 0.25 && !m.dozing { p.decoration = .none }

        p.sproutSway = sin(t * 1.3) * 6 + (m.talking ? sin(t * 9) * 4 : 0)

        // Blink: closes over 0.07 s and reopens over 0.08 s.
        let sinceBlink = now.timeIntervalSince(m.blinkStart)
        var blink = 1.0
        if sinceBlink >= 0 && sinceBlink < 0.15 {
            blink = 1 - sin(sinceBlink / 0.15 * .pi) * 0.92
        }
        p.eyeScaleY = p.face.eyeOpen * blink

        // Gaze.
        var look = lookVector(for: m.gaze, model: m)
        if now < m.glanceUntil && m.gaze == .user {
            look = lookVector(for: .cursor, model: m)
        }
        if m.dozing { look = (0, 0.3) }
        p.lookX = look.0
        p.lookY = look.1

        // Talking mouth: flaps quickly, with a pop on each spoken word boundary.
        p.mouthOpen = p.face.mouthOpen
        if m.talking && !m.dozing {
            let flap = 0.18 + 0.32 * abs(sin(t * 13)) * (0.6 + 0.4 * abs(sin(t * 3.1)))
            let sinceWord = now.timeIntervalSince(m.lastWordAt)
            let pop = sinceWord < 0.18 ? (1 - sinceWord / 0.18) * 0.3 : 0
            p.mouthOpen = max(p.mouthOpen, min(1, flap + pop))
        }

        // Pet life: breathing variants, phase, behaviour, touch and cues (PetMotion.swift).
        applyPet(m, now: now, to: &p)
        if m.dozing {
            p.lookX = 0
            p.lookY = 0.3
        } else if m.gaze != .user {
            // A brain performance holding a gaze wins over the behaviour's own look direction.
            p.lookX = look.0
            p.lookY = look.1
        }

        // Brain gestures play on top.
        let duration = AvatarModel.duration(of: m.gesture)
        if m.gesture != GestureKind.none && duration > 0 {
            let e = now.timeIntervalSince(m.gestureStart)
            let k = min(1, max(0, e / duration))
            applyGesture(m.gesture, progress: k, elapsed: e, to: &p)
        }
        return p
    }

    @MainActor
    static func lookVector(for gaze: Gaze, model m: AvatarModel) -> (Double, Double) {
        switch gaze {
        case .user: return (0, 0.05)
        case .screen: return (-0.25, 0.55)
        case .phone: return (0.6, 0.7)
        case .away: return (-0.85, -0.35)
        case .cursor:
            let mouse = NSEvent.mouseLocation
            let dx = Double(mouse.x - m.screenCenter.x)
            let dy = Double(mouse.y - m.screenCenter.y)
            let len = max(1, (dx * dx + dy * dy).squareRoot())
            let reach = min(1, len / 260)
            return (dx / len * reach, -dy / len * reach)
        }
    }

    private static func applyGesture(_ g: GestureKind, progress k: Double, elapsed e: Double, to p: inout Pose) {
        let envelope = min(1, k * 5, (1 - k) * 5) // ease in/out for holds
        switch g {
        case .none:
            break
        case .wave:
            p.armAngle = -20 + sin(e * 11) * 28 * envelope - 40 * envelope
            p.rotation = -4 * envelope
        case .nod:
            p.offsetY += sin(k * .pi * 4) * 0.035
            p.lookY = 0.3
        case .shake:
            p.offsetX += sin(k * .pi * 6) * 0.045 * (1 - k)
            p.rotation += sin(k * .pi * 6) * 4 * (1 - k)
        case .bounce:
            let b = abs(sin(k * .pi * 2))
            p.offsetY -= b * 0.12
            p.scaleY *= 1 + (1 - b) * 0.05 * envelope
            p.scaleX *= 1 - (1 - b) * 0.03 * envelope
        case .leanIn:
            p.scaleX *= 1 + 0.1 * envelope
            p.scaleY *= 1 + 0.1 * envelope
            p.offsetY += 0.04 * envelope
            p.rotation += 3 * envelope
        case .spin:
            p.spin = k * 360
            p.offsetY -= sin(k * .pi) * 0.06
        case .hide:
            let h = envelope
            p.scaleY *= 1 - 0.62 * h
            p.scaleX *= 1 + 0.08 * h
            p.lookY = -0.4 * h
        case .dance:
            p.rotation += sin(e * 9) * 12
            p.offsetX += sin(e * 4.5) * 0.05
            p.offsetY -= abs(sin(e * 9)) * 0.06
            p.armAngle = -30 + sin(e * 9) * 30
        case .jump:
            let squash = k < 0.15 ? sin(k / 0.15 * .pi) : 0
            p.scaleY *= 1 - 0.12 * squash
            p.scaleX *= 1 + 0.08 * squash
            if k >= 0.15 {
                p.offsetY -= sin((k - 0.15) / 0.85 * .pi) * 0.32
            }
        }
    }
}

/// Pixie: a soft pastel blob with a sprout, glossy eyes, blush and a tiny mouth. Drawn only with shapes.
struct CharacterView: View {
    @ObservedObject var model: AvatarModel
    let size: CGFloat

    @State private var dragActive = false
    @State private var dragMoved = false

    init(model: AvatarModel, size: CGFloat) {
        _model = ObservedObject(wrappedValue: model)
        self.size = size
    }

    /// Modest frame rates: 24 fps awake, 12 fps while resting, paused while the panel is hidden.
    private var frameInterval: Double { model.dozing ? 1.0 / 12.0 : 1.0 / 24.0 }

    var body: some View {
        TimelineView(.animation(minimumInterval: frameInterval, paused: model.hidden)) { context in
            CharacterFrame(pose: Pose.compute(model, now: context.date), size: size,
                           eyeIndicator: model.eyeIndicator, listening: model.listening, connected: model.connected)
        }
        .frame(width: size * 1.25, height: size * 1.3)
        .contentShape(Rectangle())
        .gesture(
            // Press: hold still ≥ 0.5 s = petting, move > 3 pt = carry (drag), quick release = poke + chat.
            DragGesture(minimumDistance: 0)
                .onChanged { value in
                    if !dragActive {
                        dragActive = true
                        dragMoved = false
                        model.pressBegan()
                    }
                    let d = value.translation
                    if !dragMoved && (abs(d.width) > 3 || abs(d.height) > 3) {
                        dragMoved = true
                        model.pressBecameDrag()
                    }
                    if dragMoved { model.onDragChanged?() }
                }
                .onEnded { _ in
                    let wasDrag = dragMoved
                    dragActive = false
                    dragMoved = false
                    model.pressEnded(wasDrag: wasDrag)
                }
        )
        .contextMenu {
            Button("Give Pixie a snack") { model.onFeed?() }
        }
        .accessibilityElement()
        .accessibilityLabel("Pixie")
        .accessibilityAddTraits(.isButton)
    }
}

/// Stateless renderer for a single pose.
struct CharacterFrame: View {
    let pose: Pose
    let size: CGFloat
    let eyeIndicator: Bool
    let listening: Bool
    let connected: Bool

    private var s: CGFloat { size }

    var body: some View {
        ZStack {
            // Ground shadow (not transformed with the body, shrinks while airborne).
            Ellipse()
                .fill(Color.black.opacity(0.16))
                .frame(width: s * 0.62 * CGFloat(1 + pose.offsetY * 1.5), height: s * 0.07)
                .blur(radius: 2)
                .offset(y: s * 0.53)

            if let style = pose.props.window {
                PetWindowView(style: style, time: pose.time, size: s)
                    .offset(x: -s * 0.36, y: -s * 0.08)
            }

            ZStack {
                SproutView(size: s, sway: pose.sproutSway, connected: connected)
                    .offset(y: -s * 0.40)
                BodyView(size: s, color: pose.face.body)
                    .offset(y: s * 0.08)
                if pose.cheekPuff > 0.01 {
                    CheekPuffView(amount: pose.cheekPuff, size: s, color: pose.face.body)
                        .offset(x: CGFloat(pose.faceTurn) * s * 0.18, y: s * 0.1)
                }
                if let arm = pose.armAngle {
                    Capsule()
                        .fill(pose.face.body.scaled(0.95).color)
                        .frame(width: s * 0.1, height: s * 0.22)
                        .rotationEffect(.degrees(arm), anchor: .bottom)
                        .offset(x: s * 0.43, y: s * 0.02)
                }
                // Turning away slides the face round to the side and lets it fade behind the body.
                FaceView(pose: pose, size: s)
                    .scaleEffect(x: CGFloat(1 - 0.45 * pose.faceTurn), y: 1)
                    .offset(x: CGFloat(pose.lookX) * s * 0.035 + CGFloat(pose.faceTurn) * s * 0.3,
                            y: s * 0.1 + CGFloat(pose.lookY) * s * 0.02)
                    .opacity(1 - 0.75 * pose.faceTurn)
            }
            .scaleEffect(x: CGFloat(pose.scaleX), y: CGFloat(pose.scaleY), anchor: .bottom)
            .rotation3DEffect(.degrees(pose.spin), axis: (x: 0, y: 1, z: 0))
            .rotationEffect(.degrees(pose.rotation), anchor: .bottom)
            .offset(x: CGFloat(pose.offsetX) * s, y: CGFloat(pose.offsetY) * s)

            DecorationView(decoration: pose.decoration, time: pose.time, size: s)
                .offset(x: CGFloat(pose.offsetX) * s, y: CGFloat(pose.offsetY) * s)

            PetPropsView(props: pose.props, time: pose.time, size: s,
                         bodyOffset: CGSize(width: CGFloat(pose.offsetX) * s, height: CGFloat(pose.offsetY) * s))

            BadgesView(size: s, eyeIndicator: eyeIndicator, listening: listening)
        }
        .frame(width: s * 1.25, height: s * 1.3)
    }
}

struct BodyView: View {
    let size: CGFloat
    let color: RGB

    var body: some View {
        let s = size
        ZStack {
            BlobShape()
                .fill(LinearGradient(colors: [color.lighter(0.45).color, color.color, color.scaled(0.88).color],
                                     startPoint: .top, endPoint: .bottom))
            BlobShape()
                .stroke(color.scaled(0.7).color.opacity(0.35), lineWidth: max(1, s * 0.012))
            // Soft glossy highlight.
            Ellipse()
                .fill(Color.white.opacity(0.45))
                .frame(width: s * 0.28, height: s * 0.14)
                .rotationEffect(.degrees(-24))
                .offset(x: -s * 0.2, y: -s * 0.24)
                .blur(radius: s * 0.012)
            Circle()
                .fill(Color.white.opacity(0.55))
                .frame(width: s * 0.05, height: s * 0.05)
                .offset(x: -s * 0.05, y: -s * 0.31)
        }
        .frame(width: s * 0.92, height: s * 0.8)
        .shadow(color: color.scaled(0.6).color.opacity(0.35), radius: s * 0.04, x: 0, y: s * 0.02)
    }
}

struct SproutView: View {
    let size: CGFloat
    let sway: Double
    let connected: Bool

    var body: some View {
        let s = size
        let leaf = connected ? Color(red: 0.42, green: 0.80, blue: 0.47) : Color(red: 0.62, green: 0.68, blue: 0.62)
        let leafDark = connected ? Color(red: 0.30, green: 0.66, blue: 0.38) : Color(red: 0.52, green: 0.56, blue: 0.52)
        ZStack {
            Capsule()
                .fill(leafDark)
                .frame(width: s * 0.035, height: s * 0.15)
                .offset(y: s * 0.03)
            Ellipse()
                .fill(LinearGradient(colors: [leaf, leafDark], startPoint: .top, endPoint: .bottom))
                .frame(width: s * 0.15, height: s * 0.075)
                .rotationEffect(.degrees(-28))
                .offset(x: -s * 0.065, y: -s * 0.045)
            Ellipse()
                .fill(LinearGradient(colors: [leaf, leafDark], startPoint: .top, endPoint: .bottom))
                .frame(width: s * 0.13, height: s * 0.065)
                .rotationEffect(.degrees(30))
                .offset(x: s * 0.06, y: -s * 0.06)
        }
        .frame(width: s * 0.3, height: s * 0.2)
        .rotationEffect(.degrees(sway), anchor: .bottom)
    }
}

struct FaceView: View {
    let pose: Pose
    let size: CGFloat

    private static let ink = Color(red: 0.17, green: 0.16, blue: 0.27)

    var body: some View {
        let s = size
        let f = pose.face
        ZStack {
            BlushView(size: s, amount: f.blush)
            EyeView(pose: pose, size: s)
                .offset(x: -s * 0.165, y: -s * 0.02)
            EyeView(pose: pose, size: s)
                .offset(x: s * 0.165, y: -s * 0.02)
            BrowView(size: s, angle: -f.browAngle)
                .offset(x: -s * 0.165, y: -s * 0.15 - CGFloat(f.browLift) * s * 0.03)
                .opacity(f.browOpacity)
            BrowView(size: s, angle: f.browAngle)
                .offset(x: s * 0.165, y: -s * 0.15 - CGFloat(f.browLift) * s * 0.03)
                .opacity(f.browOpacity)
            MouthView(curve: f.mouthCurve, open: pose.mouthOpen, width: f.mouthWidth, size: s)
                .offset(y: s * 0.12)
        }
    }
}

struct BrowView: View {
    let size: CGFloat
    let angle: Double
    var body: some View {
        Capsule()
            .fill(Color(red: 0.17, green: 0.16, blue: 0.27).opacity(0.85))
            .frame(width: size * 0.1, height: size * 0.022)
            .rotationEffect(.degrees(angle))
    }
}

struct BlushView: View {
    let size: CGFloat
    let amount: Double
    var body: some View {
        let s = size
        let pink = Color(red: 1.0, green: 0.48, blue: 0.6)
        ZStack {
            Ellipse().fill(pink.opacity(0.75 * amount))
                .frame(width: s * 0.13, height: s * 0.07)
                .offset(x: -s * 0.29, y: s * 0.08)
            Ellipse().fill(pink.opacity(0.75 * amount))
                .frame(width: s * 0.13, height: s * 0.07)
                .offset(x: s * 0.29, y: s * 0.08)
        }
        .blur(radius: s * 0.012)
    }
}

struct EyeView: View {
    let pose: Pose
    let size: CGFloat

    private static let ink = Color(red: 0.17, green: 0.16, blue: 0.27)

    var body: some View {
        let s = size
        let f = pose.face
        let w = s * 0.15 * CGFloat(f.pupil)
        let h = s * 0.19 * CGFloat(f.pupil)
        Group {
            if f.heart > 0.5 {
                HeartShape()
                    .fill(Color(red: 1.0, green: 0.36, blue: 0.52))
                    .frame(width: w * 1.15, height: w * 1.05)
                    .scaleEffect(1 + 0.08 * CGFloat(sin(pose.time * 6)))
            } else if pose.dozing || pose.eyeScaleY < 0.16 {
                ClosedEyeShape()
                    .stroke(Self.ink, style: StrokeStyle(lineWidth: s * 0.024, lineCap: .round))
                    .frame(width: w * 0.9, height: h * 0.25)
            } else if f.eyeSmile > 0.5 {
                SmileEyeShape()
                    .stroke(Self.ink, style: StrokeStyle(lineWidth: s * 0.028, lineCap: .round))
                    .frame(width: w * 0.95, height: h * 0.3)
            } else {
                ZStack {
                    Ellipse()
                        .fill(LinearGradient(colors: [Self.ink, Color(red: 0.30, green: 0.27, blue: 0.48)],
                                             startPoint: .top, endPoint: .bottom))
                    Circle()
                        .fill(Color.white)
                        .frame(width: w * 0.42, height: w * 0.42)
                        .offset(x: w * 0.14, y: -h * 0.18)
                    Circle()
                        .fill(Color.white.opacity(0.85))
                        .frame(width: w * 0.18, height: w * 0.18)
                        .offset(x: -w * 0.16, y: h * 0.2)
                }
                .frame(width: w, height: h)
                .scaleEffect(x: 1, y: CGFloat(max(0.05, pose.eyeScaleY)), anchor: .center)
                .offset(x: CGFloat(pose.lookX) * s * 0.025, y: CGFloat(pose.lookY) * s * 0.025)
            }
        }
    }
}

struct MouthView: View {
    let curve: Double
    let open: Double
    let width: Double
    let size: CGFloat

    var body: some View {
        let s = size
        let w = s * 0.15 * CGFloat(width)
        let ink = Color(red: 0.17, green: 0.16, blue: 0.27)
        Group {
            if open > 0.08 {
                ZStack {
                    MouthOpenShape(curve: curve, open: open)
                        .fill(Color(red: 0.48, green: 0.18, blue: 0.26))
                    MouthOpenShape(curve: curve, open: open)
                        .stroke(ink, style: StrokeStyle(lineWidth: s * 0.014, lineJoin: .round))
                }
                .frame(width: w, height: s * 0.07)
            } else {
                MouthLineShape(curve: curve)
                    .stroke(ink, style: StrokeStyle(lineWidth: s * 0.022, lineCap: .round))
                    .frame(width: w, height: s * 0.06)
            }
        }
    }
}

struct DecorationView: View {
    let decoration: Decoration
    let time: Double
    let size: CGFloat

    var body: some View {
        let s = size
        let bob = CGFloat(sin(time * 2.4)) * s * 0.02
        let rise = CGFloat((time * 0.6).truncatingRemainder(dividingBy: 1))
        Group {
            switch decoration {
            case .none:
                EmptyView()
            case .sparkles:
                ZStack {
                    Image(systemName: "sparkle")
                        .font(.system(size: s * 0.13, weight: .bold))
                        .foregroundStyle(Color(red: 1.0, green: 0.82, blue: 0.3))
                        .offset(x: s * 0.46, y: -s * 0.36 + bob)
                        .opacity(0.6 + 0.4 * abs(sin(time * 3)))
                    Image(systemName: "sparkle")
                        .font(.system(size: s * 0.09, weight: .bold))
                        .foregroundStyle(Color(red: 1.0, green: 0.9, blue: 0.5))
                        .offset(x: -s * 0.46, y: -s * 0.24 - bob)
                        .opacity(0.6 + 0.4 * abs(cos(time * 3)))
                }
            case .hearts:
                ZStack {
                    HeartShape()
                        .fill(Color(red: 1.0, green: 0.4, blue: 0.56))
                        .frame(width: s * 0.11, height: s * 0.1)
                        .offset(x: s * 0.42, y: -s * 0.3 - rise * s * 0.2)
                        .opacity(Double(1 - rise))
                    HeartShape()
                        .fill(Color(red: 1.0, green: 0.55, blue: 0.68))
                        .frame(width: s * 0.08, height: s * 0.07)
                        .offset(x: -s * 0.44, y: -s * 0.2 - rise * s * 0.16)
                        .opacity(Double(1 - rise))
                }
            case .question:
                Text("?")
                    .font(.system(size: s * 0.2, weight: .heavy, design: .rounded))
                    .foregroundStyle(Color(red: 0.36, green: 0.62, blue: 0.95))
                    .rotationEffect(.degrees(12))
                    .offset(x: s * 0.46, y: -s * 0.38 + bob)
            case .exclaim:
                Text("!")
                    .font(.system(size: s * 0.22, weight: .heavy, design: .rounded))
                    .foregroundStyle(Color(red: 1.0, green: 0.52, blue: 0.3))
                    .offset(x: s * 0.45, y: -s * 0.4 + bob)
            case .sweat:
                Image(systemName: "drop.fill")
                    .font(.system(size: s * 0.1))
                    .foregroundStyle(Color(red: 0.55, green: 0.8, blue: 1.0))
                    .offset(x: s * 0.4, y: -s * 0.22 + rise * s * 0.06)
            case .zzz:
                ZStack {
                    Text("z")
                        .font(.system(size: s * 0.11, weight: .bold, design: .rounded))
                        .offset(x: s * 0.36 + rise * s * 0.06, y: -s * 0.3 - rise * s * 0.12)
                        .opacity(Double(1 - rise))
                    Text("z")
                        .font(.system(size: s * 0.16, weight: .bold, design: .rounded))
                        .offset(x: s * 0.48 + rise * s * 0.06, y: -s * 0.46 - rise * s * 0.12)
                        .opacity(Double(0.8 - rise * 0.6))
                }
                .foregroundStyle(Color(red: 0.55, green: 0.5, blue: 0.85))
            case .dots:
                HStack(spacing: s * 0.025) {
                    ForEach(0..<3, id: \.self) { i in
                        Circle()
                            .fill(Color(red: 0.5, green: 0.55, blue: 0.7))
                            .frame(width: s * 0.04, height: s * 0.04)
                            .opacity(0.35 + 0.65 * abs(sin(time * 3 + Double(i) * 0.6)))
                    }
                }
                .offset(x: s * 0.42, y: -s * 0.38)
            case .anger:
                Image(systemName: "bolt.fill")
                    .font(.system(size: s * 0.11))
                    .foregroundStyle(Color(red: 1.0, green: 0.4, blue: 0.35))
                    .offset(x: s * 0.42, y: -s * 0.32 + bob)
            }
        }
        .allowsHitTesting(false)
    }
}

struct BadgesView: View {
    let size: CGFloat
    let eyeIndicator: Bool
    let listening: Bool

    var body: some View {
        let s = size
        ZStack {
            if eyeIndicator {
                badge(symbol: "eye.fill", tint: Color(red: 0.45, green: 0.4, blue: 0.95))
                    .offset(x: -s * 0.46, y: s * 0.38)
                    .help("Pixie can see your screen")
            }
            if listening {
                badge(symbol: "mic.fill", tint: Color(red: 1.0, green: 0.4, blue: 0.45))
                    .offset(x: s * 0.46, y: s * 0.38)
            }
        }
    }

    private func badge(symbol: String, tint: Color) -> some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.08, weight: .semibold))
            .foregroundStyle(Color.white)
            .frame(width: size * 0.16, height: size * 0.16)
            .background(Circle().fill(tint))
            .overlay(Circle().stroke(Color.white, lineWidth: 1.5))
            .shadow(color: Color.black.opacity(0.2), radius: 2, y: 1)
    }
}
