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
    /// Open book held in front (`read_book`).
    var book = false
    /// Page turn progress 0 … 1 (0 = no page turning).
    var pageFlip: Double = 0
    /// Warm reading-lamp glow behind Pixie (evening light).
    var lampGlow = false
    /// Football centre (same units as `ball`) and its squash on a touch, 0 … 1.
    var football: CGPoint? = nil
    var footballSquash: Double = 0
    /// A paw idly tapping the floor, lift 0 … 1 (`bored`).
    var tapPaw: Double? = nil
    /// Faint "…" thought bubble (`bored`).
    var ellipsis = false
    /// Small grumpy cloud over a sulking Pixie.
    var sulkCloud = false
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
        case .readBook: return (4.2, 0.02)
        case .headFootball: return (2.2, 0.02)
        case .bored: return (5.0, 0.03)
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
            // The window stands to Pixie's left (fully visible); Pixie scoots right, sits a little smaller
            // and turns its face and gaze towards it.
            let style = m.windowStyle
            p.props.window = style
            p.offsetX += 0.17 * blend
            p.scaleX *= 1 - 0.14 * blend
            p.scaleY *= 1 - 0.14 * blend
            p.rotation -= 4 * blend
            p.faceShiftX = -0.07 * blend
            p.lookX = -0.95
            p.lookY = -0.3
            switch style {
            case .sunset:
                p.face.body = p.face.body.lerp(RGB(r: 1.0, g: 0.72, b: 0.5), 0.3)
            case .storm:
                p.offsetX += sin(t * 30) * 0.003
                p.eyeScaleY *= 1.1
            case .night:
                p.face.body = p.face.body.lerp(RGB(r: 0.55, g: 0.6, b: 0.85), 0.15)
            case .day, .rain, .snow:
                break
            }
        case .fanSelf:
            p.props.fanAngle = sin(e * 12) * 25
            p.armAngle = -70 + sin(e * 12) * 18
            p.eyeScaleY *= 0.75
            p.mouthOpen = max(p.mouthOpen, 0.18 + 0.08 * abs(sin(t * 3)))
            p.decoration = .sweat
        case .hide:
            // Paws over the eyes, trembling, now and then lowering one paw to peek out at the storm.
            let shiver = sin(t * 42)
            p.scaleY *= 0.86 + 0.012 * shiver
            p.scaleX *= 1.05
            p.offsetY += 0.03
            p.offsetX += shiver * 0.006
            p.rotation += sin(t * 37) * 1.2
            let c = e.truncatingRemainder(dividingBy: 4)
            var peek = 0.0
            if c > 2.4 && c < 3.6 {
                peek = sin((c - 2.4) / 1.2 * Double.pi)
            }
            p.pawsOverEyes = blend
            p.pawPeek = peek
            if peek > 0.3 {
                p.eyeScaleY = max(p.eyeScaleY, 1.15)
            } else {
                p.eyeScaleY = min(p.eyeScaleY, 1.0)
            }
            p.lookX = 0.45
            p.lookY = -0.35
            p.face.eyeSmile = 0
            p.face.heart = 0
            p.face.mouthCurve = -0.35
            p.face.mouthWidth = 0.5
            p.mouthOpen = max(p.mouthOpen, 0.1 + 0.04 * abs(shiver))
            p.face.browOpacity = max(p.face.browOpacity, 0.85)
            p.face.browAngle = 20
            p.props.stormCloud = true
            p.decoration = .sweat
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
            // Clearly grumpy, at full opacity: turned partly away, arms crossed, cheeks puffed, brows down,
            // a little cloud overhead and a "hmph" now and then.
            p.faceTurn = 0.5 * blend
            p.scaleX *= 1 - 0.1 * blend
            p.scaleY *= 1 + 0.03 * blend
            p.rotation += 5 * blend
            p.cheekPuff = max(p.cheekPuff, (0.85 + 0.15 * abs(sin(t * 1.3))) * blend)
            p.crossedArms = blend
            p.face.browOpacity = max(p.face.browOpacity, blend)
            p.face.browAngle = -20
            p.face.browLift = -0.3
            p.face.eyeSmile = 0
            p.face.heart = 0
            p.face.mouthCurve = -0.4
            p.face.mouthWidth = 0.4
            p.mouthOpen = 0
            p.eyeScaleY *= 0.7
            p.lookX = 0.9
            p.lookY = -0.1
            p.decoration = .none
            p.props.sulkCloud = true
            let hmph = e.truncatingRemainder(dividingBy: 4.5) / 4.5
            if hmph < 0.55 {
                p.props.hmph = hmph / 0.55
            }
        case .makeUp:
            let k = min(1, e / 4)
            p.rotation += sin(e * 14) * 10 * (1 - k)
            p.offsetY -= abs(sin(e * 7)) * 0.04 * (1 - k)
            p.face.eyeSmile = 1
            p.props.hearts = true
        case .readBook:
            applyReadBook(m, elapsed: e, to: &p)
        case .headFootball:
            applyHeadFootball(elapsed: e, to: &p)
        case .bored:
            applyBored(elapsed: e, blend: blend, to: &p)
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

    /// `read_book`: sitting with an open book and round glasses, eyes on the page, a slow contented blink
    /// and a page turn now and then.
    @MainActor
    static func applyReadBook(_ m: AvatarModel, elapsed e: Double, to p: inout Pose) {
        p.props.book = true
        p.glasses = true
        p.props.lampGlow = m.eveningLight
        // Reading line by line, left to right.
        let line = (e / 2.6).truncatingRemainder(dividingBy: 1)
        p.lookX = -0.45 + 0.9 * line
        p.lookY = 0.85
        p.eyeScaleY *= 0.8
        p.face.eyeSmile = min(p.face.eyeSmile, 0.4)
        p.face.heart = 0
        p.face.mouthCurve = max(p.face.mouthCurve, 0.45)
        p.face.blush = max(p.face.blush, 0.45)
        p.rotation += sin(e * 0.5) * 2
        p.offsetY += 0.02
        // A slow, contented blink.
        let b = e.truncatingRemainder(dividingBy: 7.5)
        if b > 6.6 {
            let k = sin((b - 6.6) / 0.9 * Double.pi)
            p.eyeScaleY *= 1 - 0.9 * k
        }
        // Turning a page.
        let f = e.truncatingRemainder(dividingBy: 6.5)
        if f > 5.6 {
            let k = (f - 5.6) / 0.9
            p.props.pageFlip = k
            p.rotation -= 3 * sin(k * Double.pi)
        }
        if m.eveningLight {
            p.face.body = p.face.body.lerp(RGB(r: 1.0, g: 0.82, b: 0.6), 0.2)
        }
    }

    /// `head_football`: keepy-uppy on the head with a squash on each touch; every 9 s a miss, the ball rolls
    /// away, Pixie hops over, pops it back onto its head and carries it home.
    static func applyHeadFootball(elapsed e: Double, to p: inout Pose) {
        let c = e.truncatingRemainder(dividingBy: 9)
        let headY = -0.52
        let groundY = 0.46
        var bx = 0.0
        var by = headY
        var squash = 0.0
        if c < 5.4 || c >= 8.0 {
            // A little header every 0.9 s (and one more after bringing the ball back).
            let b = c < 5.4 ? c.truncatingRemainder(dividingBy: 0.9) / 0.9 : c - 8.0
            let h = 4 * b * (1 - b)
            let touch = max(0, 1 - h * 5)
            let sway = 0.03 * sin(c * 2.1)
            bx = p.offsetX + sway
            by = headY - 0.2 * h
            squash = touch
            p.scaleY *= 1 - 0.08 * touch
            p.scaleX *= 1 + 0.05 * touch
            p.sproutSway += 14 * touch
            p.lookX = sway * 3
            p.lookY = -0.9
            p.face.eyeSmile = 0
            p.face.mouthCurve = max(p.face.mouthCurve, 0.6)
            p.mouthOpen = max(p.mouthOpen, 0.12 + 0.2 * touch)
        } else if c < 6.4 {
            // Missed: the ball drops off the side and rolls away.
            let k = c - 5.4
            let fall = min(1, k * 1.5)
            bx = 0.15 + 0.47 * k
            by = headY + (groundY - headY) * fall * fall
            if fall >= 1 {
                squash = max(0, 1 - (k - 0.667) * 6)
            }
            p.lookX = 0.9
            p.lookY = by > 0 ? 0.45 : -0.3
            p.eyeScaleY *= 1.15
            p.face.eyeSmile = 0
            p.face.mouthCurve = 0
            p.face.mouthWidth = 0.6
            p.mouthOpen = max(p.mouthOpen, 0.45)
        } else {
            // Fetch: hop over, scoop the ball back up onto the head, hop home.
            let k = (c - 6.4) / 1.6
            p.offsetX += 0.32 * sin(k * Double.pi)
            p.offsetY -= abs(sin(k * Double.pi * 4)) * 0.035
            p.rotation += 6 * cos(k * Double.pi)
            p.face.eyeSmile = 0
            p.face.mouthCurve = max(p.face.mouthCurve, 0.5)
            if k < 0.4 {
                bx = 0.62
                by = groundY
                p.lookX = 0.8
                p.lookY = 0.4
            } else if k < 0.6 {
                let j = (k - 0.4) / 0.2
                bx = 0.62 + (p.offsetX - 0.62) * j
                by = groundY + (headY - groundY) * j - 0.15 * sin(j * Double.pi)
                p.lookX = 0.3
                p.lookY = -0.6
            } else {
                bx = p.offsetX
                by = headY
                p.lookX = 0
                p.lookY = -0.9
            }
        }
        p.props.football = CGPoint(x: bx, y: by)
        p.props.footballSquash = squash
    }

    /// `bored`: flopped on the "floor" with a squished cheek and half-lidded eyes, rolling idly from side to
    /// side or tapping a paw, with a slow sigh and a faint "…" bubble.
    static func applyBored(elapsed e: Double, blend: Double, to p: inout Pose) {
        let c = e.truncatingRemainder(dividingBy: 12)
        p.scaleY *= 1 - 0.2 * blend
        p.scaleX *= 1 + 0.12 * blend
        p.offsetY += 0.05 * blend
        if c < 7 {
            let roll = sin(c / 7 * 2 * Double.pi)
            p.rotation += 9 * roll * blend
            p.offsetX += 0.04 * roll * blend
            p.lookX = 0.5 * roll
        } else {
            p.rotation -= 6 * blend
            p.props.tapPaw = abs(sin((c - 7) * 6))
            p.lookX = 0.5
        }
        p.lookY = 0.35
        p.eyeScaleY *= 0.42
        p.face.eyeSmile = 0
        p.face.heart = 0
        p.face.mouthCurve = min(p.face.mouthCurve, -0.1)
        p.face.mouthWidth = 0.5
        p.face.blush = min(p.face.blush, 0.2)
        // A slow sigh every few seconds.
        let sigh = e.truncatingRemainder(dividingBy: 6)
        if sigh > 4.2 {
            let k = sin((sigh - 4.2) / 1.8 * Double.pi)
            p.scaleY *= 1 + 0.06 * k
            p.scaleX *= 1 - 0.025 * k
            p.mouthOpen = max(p.mouthOpen, 0.14 * k)
            p.eyeScaleY *= 1 - 0.4 * k
        }
        p.decoration = .none
        p.props.ellipsis = true
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

/// The little "window" Pixie looks out of. Drawn beside the body (to its left), never behind it, so the
/// weather in it stays fully visible.
struct PetWindowView: View {
    let style: PetWindowStyle
    let time: Double
    let size: CGFloat

    private static let wood = Color(red: 0.62, green: 0.48, blue: 0.38)

    private var sky: [Color] {
        switch style {
        case .day: return [Color(red: 0.50, green: 0.77, blue: 1.0), Color(red: 0.80, green: 0.92, blue: 1.0)]
        case .night: return [Color(red: 0.07, green: 0.09, blue: 0.24), Color(red: 0.20, green: 0.20, blue: 0.42)]
        case .sunset: return [Color(red: 0.55, green: 0.38, blue: 0.70), Color(red: 0.98, green: 0.52, blue: 0.42), Color(red: 1.0, green: 0.80, blue: 0.45)]
        case .rain: return [Color(red: 0.36, green: 0.42, blue: 0.52), Color(red: 0.55, green: 0.61, blue: 0.70)]
        case .snow: return [Color(red: 0.48, green: 0.56, blue: 0.68), Color(red: 0.68, green: 0.74, blue: 0.84)]
        case .storm: return [Color(red: 0.14, green: 0.15, blue: 0.22), Color(red: 0.30, green: 0.32, blue: 0.40)]
        }
    }

    var body: some View {
        let s = size
        let w = s * 0.44
        let h = s * 0.5
        ZStack {
            ZStack {
                LinearGradient(colors: sky, startPoint: .top, endPoint: .bottom)
                weather(w: w, h: h)
            }
            .frame(width: w, height: h)
            .clipShape(RoundedRectangle(cornerRadius: s * 0.04))
            // Frame, cross bars and sill.
            RoundedRectangle(cornerRadius: s * 0.04)
                .stroke(Self.wood, lineWidth: s * 0.03)
            Rectangle()
                .fill(Self.wood)
                .frame(width: s * 0.018, height: h)
            Rectangle()
                .fill(Self.wood)
                .frame(width: w, height: s * 0.018)
            Capsule()
                .fill(Color(red: 0.55, green: 0.42, blue: 0.33))
                .frame(width: w * 1.15, height: s * 0.04)
                .offset(y: h / 2)
        }
        .frame(width: w, height: h)
        .allowsHitTesting(false)
    }

    @ViewBuilder
    private func weather(w: CGFloat, h: CGFloat) -> some View {
        switch style {
        case .day: dayScene(w: w, h: h)
        case .night: nightScene(w: w, h: h)
        case .sunset: sunsetScene(w: w, h: h)
        case .rain: precipitation(w: w, h: h, snow: false)
        case .snow: precipitation(w: w, h: h, snow: true)
        case .storm: stormScene(w: w, h: h)
        }
    }

    private func dayScene(w: CGFloat, h: CGFloat) -> some View {
        let s = size
        let drift = CGFloat(sin(time * 0.3)) * w * 0.08
        return ZStack {
            Circle()
                .fill(Color(red: 1.0, green: 0.88, blue: 0.4))
                .frame(width: s * 0.1, height: s * 0.1)
                .offset(x: w * 0.25, y: -h * 0.3)
            PixieCloudPuff(width: s * 0.18, color: Color.white.opacity(0.95))
                .offset(x: -w * 0.12 + drift, y: -h * 0.06)
        }
    }

    private func nightScene(w: CGFloat, h: CGFloat) -> some View {
        let s = size
        return ZStack {
            // Crescent moon: a pale disc with a sky-coloured disc over one side.
            Circle()
                .fill(Color(red: 1.0, green: 0.94, blue: 0.7))
                .frame(width: s * 0.12, height: s * 0.12)
                .offset(x: w * 0.2, y: -h * 0.24)
            Circle()
                .fill(Color(red: 0.08, green: 0.10, blue: 0.26))
                .frame(width: s * 0.11, height: s * 0.11)
                .offset(x: w * 0.2 + s * 0.04, y: -h * 0.24 - s * 0.02)
            ForEach(0..<6, id: \.self) { i in
                let twinkle: Double = 0.4 + 0.6 * abs(sin(time * 1.5 + Double(i) * 1.3))
                let sx: Double = (Double(i) / 5 - 0.5) * 0.8
                let sy: Double = i % 2 == 0 ? -0.05 : 0.18
                Circle()
                    .fill(Color.white.opacity(twinkle))
                    .frame(width: s * 0.022, height: s * 0.022)
                    .offset(x: CGFloat(sx) * w, y: CGFloat(sy) * h)
            }
        }
    }

    private func sunsetScene(w: CGFloat, h: CGFloat) -> some View {
        let s = size
        return ZStack {
            Circle()
                .fill(Color(red: 1.0, green: 0.86, blue: 0.45))
                .frame(width: s * 0.17, height: s * 0.17)
                .offset(y: h * 0.2)
            PixieCloudPuff(width: s * 0.14, color: Color(red: 1.0, green: 0.72, blue: 0.75).opacity(0.85))
                .offset(x: -w * 0.2, y: -h * 0.22)
            // Hills in front of the sinking sun.
            Ellipse()
                .fill(Color(red: 0.40, green: 0.26, blue: 0.42))
                .frame(width: w * 1.4, height: h * 0.4)
                .offset(y: h * 0.45)
        }
    }

    private func precipitation(w: CGFloat, h: CGFloat, snow: Bool) -> some View {
        let s = size
        let cloud = snow ? Color(red: 0.85, green: 0.88, blue: 0.93) : Color(red: 0.62, green: 0.65, blue: 0.72)
        return ZStack {
            if snow {
                // Snow settling on the ground.
                Ellipse()
                    .fill(Color.white)
                    .frame(width: w * 1.3, height: h * 0.3)
                    .offset(y: h * 0.5)
            }
            ForEach(0..<12, id: \.self) { i in
                let speed: Double = snow ? 0.22 : 1.3
                let phase: Double = (time * speed + Double(i) * 0.29).truncatingRemainder(dividingBy: 1)
                let column: Double = Double((i * 5) % 12) / 11
                let drift: Double = snow ? sin(time * 1.2 + Double(i)) * 0.03 : -phase * 0.06
                let x: Double = (column - 0.5) * 0.9 + drift
                let y: Double = phase - 0.4
                Group {
                    if snow {
                        Circle()
                            .fill(Color.white)
                            .frame(width: s * 0.03, height: s * 0.03)
                    } else {
                        Capsule()
                            .fill(Color.white.opacity(0.9))
                            .frame(width: s * 0.014, height: s * 0.065)
                            .rotationEffect(.degrees(12))
                    }
                }
                .offset(x: CGFloat(x) * w, y: CGFloat(y) * h)
            }
            PixieCloudPuff(width: w * 0.95, color: cloud)
                .offset(y: -h * 0.4)
        }
    }

    private func stormScene(w: CGFloat, h: CGFloat) -> some View {
        let s = size
        let flash = time.truncatingRemainder(dividingBy: 3.2) < 0.25
        return ZStack {
            precipitation(w: w, h: h, snow: false)
            Color.white.opacity(flash ? 0.45 : 0)
            Image(systemName: "bolt.fill")
                .font(.system(size: s * 0.15, weight: .bold))
                .foregroundStyle(Color(red: 1.0, green: 0.88, blue: 0.3))
                .offset(x: -w * 0.1, y: h * 0.02)
                .opacity(flash ? 1 : 0.8)
        }
    }
}

/// A simple puffy cloud (three bumps on a rounded base).
struct PixieCloudPuff: View {
    let width: CGFloat
    let color: Color

    var body: some View {
        ZStack {
            Capsule()
                .fill(color)
                .frame(width: width, height: width * 0.36)
                .offset(y: width * 0.1)
            Circle()
                .fill(color)
                .frame(width: width * 0.45, height: width * 0.45)
                .offset(x: -width * 0.17, y: -width * 0.02)
            Circle()
                .fill(color)
                .frame(width: width * 0.55, height: width * 0.55)
                .offset(x: width * 0.1, y: -width * 0.08)
        }
        .frame(width: width, height: width * 0.6)
    }
}

/// Props drawn in front of the body.
struct PetPropsView: View {
    let props: PetProps
    let time: Double
    let size: CGFloat
    /// Character body offset, so held props follow it.
    let bodyOffset: CGSize
    /// Body colour, for paws drawn with props.
    let bodyColor: RGB

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
            if props.book {
                PixieBookView(size: s, flip: props.pageFlip, paw: bodyColor)
                    .offset(x: bodyOffset.width, y: bodyOffset.height + s * 0.33)
            }
            if let f = props.football {
                PixieFootballView(size: s, time: time, squash: props.footballSquash)
                    .offset(x: f.x * s, y: f.y * s)
            }
            if let lift = props.tapPaw {
                Ellipse()
                    .fill(bodyColor.scaled(0.95).color)
                    .overlay(Ellipse().stroke(bodyColor.scaled(0.7).color.opacity(0.5), lineWidth: max(1, s * 0.01)))
                    .frame(width: s * 0.11, height: s * 0.07)
                    .rotationEffect(.degrees(-15 * lift))
                    .offset(x: bodyOffset.width + s * 0.34, y: bodyOffset.height + s * CGFloat(0.44 - 0.05 * lift))
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
            if props.sulkCloud {
                ZStack {
                    ForEach(0..<2, id: \.self) { i in
                        let fall: Double = (time * 0.9 + Double(i) * 0.5).truncatingRemainder(dividingBy: 1)
                        Capsule()
                            .fill(Color(red: 0.5, green: 0.6, blue: 0.8))
                            .frame(width: s * 0.012, height: s * 0.035)
                            .offset(x: s * CGFloat(Double(i) * 0.05 - 0.025), y: s * CGFloat(0.04 + fall * 0.07))
                            .opacity(1 - fall)
                    }
                    Image(systemName: "cloud.fill")
                        .font(.system(size: s * 0.13))
                        .foregroundStyle(Color(red: 0.42, green: 0.44, blue: 0.52))
                }
                .offset(x: bodyOffset.width - s * 0.3,
                        y: bodyOffset.height - s * 0.5 + CGFloat(sin(time * 1.6)) * s * 0.012)
            }
            if props.ellipsis {
                ZStack {
                    Capsule()
                        .fill(Color.white.opacity(0.92))
                        .overlay(Capsule().stroke(Color(red: 0.6, green: 0.62, blue: 0.7).opacity(0.6), lineWidth: 1))
                        .frame(width: s * 0.2, height: s * 0.12)
                    Text("…")
                        .font(.system(size: s * 0.09, weight: .bold, design: .rounded))
                        .foregroundStyle(Color(red: 0.45, green: 0.47, blue: 0.58))
                        .offset(y: -s * 0.012)
                    Circle()
                        .fill(Color.white.opacity(0.92))
                        .overlay(Circle().stroke(Color(red: 0.6, green: 0.62, blue: 0.7).opacity(0.6), lineWidth: 1))
                        .frame(width: s * 0.035, height: s * 0.035)
                        .offset(x: -s * 0.09, y: s * 0.085)
                }
                .opacity(0.55 + 0.2 * sin(time * 0.9))
                .offset(x: bodyOffset.width + s * 0.42, y: bodyOffset.height - s * 0.36)
            }
        }
    }
}

/// A small open book held in both paws (`read_book`). `flip` 0 … 1 turns the right-hand page over.
struct PixieBookView: View {
    let size: CGFloat
    let flip: Double
    let paw: RGB

    var body: some View {
        let s = size
        let pageW = s * 0.17
        let pageH = s * 0.19
        let turning = flip > 0.001 && flip < 0.999
        ZStack {
            // Cover.
            RoundedRectangle(cornerRadius: s * 0.02)
                .fill(Color(red: 0.36, green: 0.55, blue: 0.78))
                .frame(width: pageW * 2 + s * 0.03, height: pageH + s * 0.03)
            HStack(spacing: s * 0.004) {
                PixieBookPage(size: s)
                    .frame(width: pageW, height: pageH)
                PixieBookPage(size: s)
                    .frame(width: pageW, height: pageH)
            }
            // Spine.
            Rectangle()
                .fill(Color(red: 0.25, green: 0.40, blue: 0.60).opacity(0.6))
                .frame(width: s * 0.006, height: pageH)
            if turning {
                PixieBookPage(size: s)
                    .frame(width: pageW, height: pageH)
                    .scaleEffect(x: CGFloat(cos(flip * Double.pi)), y: 1, anchor: .leading)
                    .offset(x: pageW / 2 + s * 0.002)
                    .shadow(color: Color.black.opacity(0.15), radius: 1)
            }
            // Paws holding the covers.
            Ellipse()
                .fill(paw.scaled(0.95).color)
                .overlay(Ellipse().stroke(paw.scaled(0.7).color.opacity(0.5), lineWidth: max(1, s * 0.01)))
                .frame(width: s * 0.09, height: s * 0.07)
                .offset(x: -pageW - s * 0.01, y: pageH * 0.22)
            Ellipse()
                .fill(paw.scaled(0.95).color)
                .overlay(Ellipse().stroke(paw.scaled(0.7).color.opacity(0.5), lineWidth: max(1, s * 0.01)))
                .frame(width: s * 0.09, height: s * 0.07)
                .offset(x: pageW + s * 0.01, y: pageH * 0.22)
        }
        .allowsHitTesting(false)
    }
}

/// One page with a few lines of "text".
struct PixieBookPage: View {
    let size: CGFloat

    var body: some View {
        let s = size
        ZStack {
            RoundedRectangle(cornerRadius: s * 0.012)
                .fill(Color(red: 0.99, green: 0.97, blue: 0.92))
            VStack(alignment: .leading, spacing: s * 0.018) {
                ForEach(0..<5, id: \.self) { i in
                    Capsule()
                        .fill(Color(red: 0.62, green: 0.60, blue: 0.66).opacity(0.7))
                        .frame(width: i == 4 ? s * 0.07 : s * 0.12, height: s * 0.008)
                }
            }
        }
    }
}

/// A little black-and-white football. `squash` 0 … 1 flattens it against whatever it touches.
struct PixieFootballView: View {
    let size: CGFloat
    let time: Double
    let squash: Double

    var body: some View {
        let d = size * 0.14
        let ink = Color(red: 0.2, green: 0.2, blue: 0.24)
        ZStack {
            Circle()
                .fill(Color.white)
            Circle()
                .fill(ink)
                .frame(width: d * 0.34, height: d * 0.34)
            ForEach(0..<5, id: \.self) { i in
                let a: Double = Double(i) / 5 * 2 * Double.pi
                Circle()
                    .fill(ink)
                    .frame(width: d * 0.3, height: d * 0.3)
                    .offset(x: CGFloat(cos(a)) * d * 0.5, y: CGFloat(sin(a)) * d * 0.5)
            }
        }
        .frame(width: d, height: d)
        .clipShape(Circle())
        .overlay(Circle().stroke(ink.opacity(0.6), lineWidth: max(1, size * 0.008)))
        .rotationEffect(.degrees(time * 160))
        .scaleEffect(x: CGFloat(1 + 0.22 * squash), y: CGFloat(1 - 0.22 * squash), anchor: .bottom)
        .allowsHitTesting(false)
    }
}

/// Little crossed arms for a sulk.
struct PixieCrossedArmsView: View {
    let size: CGFloat
    let color: RGB

    var body: some View {
        let s = size
        let fill = color.scaled(0.93).color
        let edge = color.scaled(0.68).color.opacity(0.55)
        let lw = max(1, s * 0.01)
        ZStack {
            Capsule()
                .fill(fill)
                .overlay(Capsule().stroke(edge, lineWidth: lw))
                .frame(width: s * 0.36, height: s * 0.1)
                .rotationEffect(.degrees(12))
            Capsule()
                .fill(fill)
                .overlay(Capsule().stroke(edge, lineWidth: lw))
                .frame(width: s * 0.36, height: s * 0.1)
                .rotationEffect(.degrees(-12))
        }
        .allowsHitTesting(false)
    }
}

/// Two little paws over the eyes (`hide`). `peek` 0 … 1 lowers the right paw so one eye peeks out.
/// Positioned in face coordinates (the eyes sit at x ±0.165, y −0.02).
struct PixieEyePawsView: View {
    let size: CGFloat
    let color: RGB
    let peek: Double

    var body: some View {
        let s = size
        let pawW = s * 0.22
        let pawH = s * 0.21
        ZStack {
            PixiePaw(width: pawW, height: pawH, color: color, line: s)
                .rotationEffect(.degrees(12))
                .offset(x: -s * 0.15, y: -s * 0.02)
            PixiePaw(width: pawW, height: pawH, color: color, line: s)
                .rotationEffect(.degrees(-12 - 10 * peek))
                .offset(x: s * 0.15 + CGFloat(peek) * s * 0.03, y: -s * 0.02 + CGFloat(peek) * s * 0.1)
        }
        .allowsHitTesting(false)
    }
}

/// A round paw with three little toe marks.
struct PixiePaw: View {
    let width: CGFloat
    let height: CGFloat
    let color: RGB
    /// Character size, for line widths.
    let line: CGFloat

    var body: some View {
        ZStack {
            Ellipse()
                .fill(color.scaled(0.96).color)
            Ellipse()
                .stroke(color.scaled(0.7).color.opacity(0.55), lineWidth: max(1, line * 0.01))
            ForEach(0..<3, id: \.self) { i in
                Capsule()
                    .fill(color.scaled(0.72).color.opacity(0.6))
                    .frame(width: max(1, line * 0.01), height: height * 0.25)
                    .offset(x: CGFloat(i - 1) * width * 0.22, y: -height * 0.26)
            }
        }
        .frame(width: width, height: height)
    }
}

/// Round reading glasses, in face coordinates (centred on the eyes).
struct PixieGlassesView: View {
    let size: CGFloat

    var body: some View {
        let s = size
        let rim = Color(red: 0.35, green: 0.25, blue: 0.2)
        let d = s * 0.2
        let lw = max(1, s * 0.016)
        ZStack {
            Circle()
                .fill(Color.white.opacity(0.18))
                .frame(width: d, height: d)
                .offset(x: -s * 0.165)
            Circle()
                .fill(Color.white.opacity(0.18))
                .frame(width: d, height: d)
                .offset(x: s * 0.165)
            Circle()
                .stroke(rim, lineWidth: lw)
                .frame(width: d, height: d)
                .offset(x: -s * 0.165)
            Circle()
                .stroke(rim, lineWidth: lw)
                .frame(width: d, height: d)
                .offset(x: s * 0.165)
            Capsule()
                .fill(rim)
                .frame(width: s * 0.13, height: lw)
                .offset(y: -s * 0.01)
            Capsule()
                .fill(rim)
                .frame(width: s * 0.08, height: lw)
                .offset(x: -s * 0.3, y: -s * 0.02)
            Capsule()
                .fill(rim)
                .frame(width: s * 0.08, height: lw)
                .offset(x: s * 0.3, y: -s * 0.02)
        }
        .allowsHitTesting(false)
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
