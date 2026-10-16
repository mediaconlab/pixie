import AppKit
import SwiftUI
import PixieCore

/// A plain RGB triple so colours can be interpolated without SwiftUI animation machinery.
struct RGB: Equatable {
    var r: Double
    var g: Double
    var b: Double

    func lerp(_ o: RGB, _ t: Double) -> RGB {
        RGB(r: r + (o.r - r) * t, g: g + (o.g - g) * t, b: b + (o.b - b) * t)
    }

    func scaled(_ k: Double) -> RGB {
        RGB(r: min(1, r * k), g: min(1, g * k), b: min(1, b * k))
    }

    func lighter(_ k: Double) -> RGB {
        RGB(r: r + (1 - r) * k, g: g + (1 - g) * k, b: b + (1 - b) * k)
    }

    var color: Color { Color(red: r, green: g, blue: b) }
}

/// Every face parameter the character renderer understands. All values are blendable.
struct FaceParams: Equatable {
    var eyeOpen: Double = 1        // vertical eye scale (0.25 sleepy … 1.25 surprised)
    var eyeSmile: Double = 0       // 0 = round eyes, 1 = happy "^" arcs
    var pupil: Double = 1          // eye size scale
    var browAngle: Double = 0      // degrees; + = inner ends up (sad/worried), − = inner ends down (cross)
    var browLift: Double = 0       // −1…1 vertical offset
    var browOpacity: Double = 0    // brows are hidden on the neutral face for a softer look
    var mouthCurve: Double = 0.35  // −1 frown … 1 big smile
    var mouthOpen: Double = 0      // 0 closed … 1 wide open
    var mouthWidth: Double = 1     // relative width
    var blush: Double = 0.35
    var heart: Double = 0          // love-heart eyes
    var body: RGB = RGB(r: 0.72, g: 0.80, b: 1.00)

    static let neutral = FaceParams()

    static func lerp(_ a: FaceParams, _ b: FaceParams, _ t: Double) -> FaceParams {
        func l(_ x: Double, _ y: Double) -> Double { x + (y - x) * t }
        var o = FaceParams()
        o.eyeOpen = l(a.eyeOpen, b.eyeOpen)
        o.eyeSmile = l(a.eyeSmile, b.eyeSmile)
        o.pupil = l(a.pupil, b.pupil)
        o.browAngle = l(a.browAngle, b.browAngle)
        o.browLift = l(a.browLift, b.browLift)
        o.browOpacity = l(a.browOpacity, b.browOpacity)
        o.mouthCurve = l(a.mouthCurve, b.mouthCurve)
        o.mouthOpen = l(a.mouthOpen, b.mouthOpen)
        o.mouthWidth = l(a.mouthWidth, b.mouthWidth)
        o.blush = l(a.blush, b.blush)
        o.heart = l(a.heart, b.heart)
        o.body = a.body.lerp(b.body, t)
        return o
    }
}

/// Decorations floating around the character for some emotions.
enum Decoration {
    case none, sparkles, hearts, question, exclaim, sweat, zzz, dots, anger
}

enum EmotionStyle {
    /// The full-intensity face for an emotion. The renderer blends from `.neutral` by intensity.
    static func params(for e: Emotion) -> FaceParams {
        var p = FaceParams()
        switch e {
        case .neutral:
            break
        case .happy:
            p.eyeSmile = 1; p.mouthCurve = 1; p.mouthOpen = 0.35; p.blush = 0.6
            p.body = RGB(r: 1.00, g: 0.84, b: 0.58)
        case .excited:
            p.eyeOpen = 1.15; p.pupil = 1.1; p.mouthCurve = 1; p.mouthOpen = 0.8; p.mouthWidth = 1.2; p.blush = 0.7
            p.browOpacity = 0.6; p.browLift = 0.6
            p.body = RGB(r: 1.00, g: 0.72, b: 0.48)
        case .curious:
            p.eyeOpen = 1.1; p.pupil = 1.1; p.mouthCurve = 0.1; p.mouthOpen = 0.15; p.mouthWidth = 0.7
            p.browOpacity = 0.7; p.browLift = 0.5; p.browAngle = 8
            p.body = RGB(r: 0.62, g: 0.90, b: 0.84)
        case .concerned:
            p.eyeOpen = 0.95; p.mouthCurve = -0.45; p.mouthWidth = 0.8; p.blush = 0.2
            p.browOpacity = 0.9; p.browAngle = 18; p.browLift = 0.2
            p.body = RGB(r: 0.70, g: 0.76, b: 0.96)
        case .sleepy:
            p.eyeOpen = 0.28; p.mouthCurve = 0.1; p.mouthOpen = 0.12; p.mouthWidth = 0.6; p.blush = 0.25
            p.body = RGB(r: 0.72, g: 0.69, b: 0.92)
        case .proud:
            p.eyeSmile = 0.85; p.mouthCurve = 0.9; p.mouthWidth = 1.1; p.blush = 0.5
            p.browOpacity = 0.6; p.browLift = 0.4; p.browAngle = -6
            p.body = RGB(r: 1.00, g: 0.80, b: 0.42)
        case .shy:
            p.eyeOpen = 0.8; p.eyeSmile = 0.4; p.mouthCurve = 0.4; p.mouthWidth = 0.55; p.blush = 1
            p.body = RGB(r: 1.00, g: 0.76, b: 0.84)
        case .annoyed:
            p.eyeOpen = 0.6; p.mouthCurve = -0.35; p.mouthWidth = 0.9; p.blush = 0.15
            p.browOpacity = 1; p.browAngle = -22; p.browLift = -0.4
            p.body = RGB(r: 1.00, g: 0.62, b: 0.58)
        case .sad:
            p.eyeOpen = 0.85; p.pupil = 1.05; p.mouthCurve = -0.8; p.mouthWidth = 0.8; p.blush = 0.1
            p.browOpacity = 0.9; p.browAngle = 24; p.browLift = 0.1
            p.body = RGB(r: 0.60, g: 0.70, b: 0.95)
        case .surprised:
            p.eyeOpen = 1.28; p.pupil = 0.9; p.mouthCurve = 0; p.mouthOpen = 0.9; p.mouthWidth = 0.55
            p.browOpacity = 0.9; p.browLift = 1
            p.body = RGB(r: 0.93, g: 0.84, b: 1.00)
        case .love:
            p.heart = 1; p.mouthCurve = 0.9; p.mouthOpen = 0.25; p.blush = 1
            p.body = RGB(r: 1.00, g: 0.68, b: 0.80)
        case .thinking:
            p.eyeOpen = 0.85; p.mouthCurve = -0.05; p.mouthWidth = 0.55; p.blush = 0.25
            p.browOpacity = 0.8; p.browAngle = -10; p.browLift = 0.3
            p.body = RGB(r: 0.76, g: 0.86, b: 0.96)
        }
        return p
    }

    static func decoration(for e: Emotion) -> Decoration {
        switch e {
        case .excited, .proud: return .sparkles
        case .love: return .hearts
        case .curious: return .question
        case .surprised: return .exclaim
        case .concerned, .shy: return .sweat
        case .sleepy: return .zzz
        case .thinking: return .dots
        case .annoyed: return .anger
        default: return .none
        }
    }
}
