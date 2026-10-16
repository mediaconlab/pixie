import AppKit
import CoreGraphics
import PixieCore
import SwiftUI

/// Drives the character. Discrete events (blinks, glances, gestures, emotion changes) are stored as
/// timestamps here; `CharacterView` turns them into continuous motion inside a TimelineView, so
/// idle life (breathing, blinking, glancing, dozing) runs with zero network.
@MainActor
final class AvatarModel: ObservableObject {
    // Expression
    @Published private(set) var emotion: Emotion = .neutral
    @Published private(set) var intensity: Double = 0.5
    @Published private(set) var fromFace: FaceParams = .neutral
    @Published private(set) var faceChangedAt: Date = .distantPast

    // Motion
    @Published private(set) var gesture: GestureKind = GestureKind.none
    @Published private(set) var gestureStart: Date = .distantPast
    @Published private(set) var gaze: Gaze = .user
    @Published private(set) var glanceUntil: Date = .distantPast
    @Published private(set) var blinkStart: Date = .distantPast

    // Talking: `talking` is true while TTS speaks or the bubble types; word boundaries pulse the mouth.
    @Published private(set) var talking = false
    @Published private(set) var lastWordAt: Date = .distantPast

    // Status badges
    @Published private(set) var dozing = false
    @Published var eyeIndicator = false
    @Published var listening = false
    @Published var connected = false

    /// Character centre in screen coordinates (set by the panel controller) for cursor gaze.
    var screenCenter: CGPoint = .zero

    // Interaction hooks wired by the panel controller.
    var onTap: (() -> Void)?
    var onDragBegan: (() -> Void)?
    var onDragChanged: (() -> Void)?
    var onDragEnded: (() -> Void)?

    private var ttsTalking = false
    private var typingTalking = false
    private var nextBlink = Date().addingTimeInterval(3)
    private var nextGlance = Date().addingTimeInterval(12)
    private var emotionHoldUntil: Date = .distantPast
    private var gazeHoldUntil: Date = .distantPast
    private var lastPixieActivity = Date()
    private var timer: Timer?

    static let dozeAfter: TimeInterval = 10 * 60

    init() {
        timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
    }

    // MARK: Performance

    func play(_ p: Performance) {
        wake()
        setEmotion(p.emotion, intensity: p.intensity)
        let sayDuration = Double(p.say.count) * 0.07
        emotionHoldUntil = Date().addingTimeInterval(max(6, sayDuration + 4))
        if p.gesture != GestureKind.none { playGesture(p.gesture) }
        gaze = p.gaze
        gazeHoldUntil = Date().addingTimeInterval(max(4, sayDuration + 2))
    }

    func setEmotion(_ e: Emotion, intensity i: Double, hold: TimeInterval? = nil) {
        let now = Date()
        fromFace = currentFace(at: now)
        faceChangedAt = now
        emotion = e
        intensity = max(0, min(1, i))
        if let hold { emotionHoldUntil = now.addingTimeInterval(hold) }
    }

    func playGesture(_ g: GestureKind) {
        gesture = g
        gestureStart = Date()
    }

    func setTTSTalking(_ on: Bool) {
        ttsTalking = on
        updateTalking()
    }

    func setTypingTalking(_ on: Bool) {
        typingTalking = on
        updateTalking()
    }

    func wordSpoken() {
        lastWordAt = Date()
    }

    /// Any user interaction with Pixie (click, chat, notices) wakes it up.
    func wake() {
        lastPixieActivity = Date()
        if dozing {
            dozing = false
            setEmotion(.surprised, intensity: 0.5, hold: 1.5)
            playGesture(.jump)
        }
    }

    private func updateTalking() {
        let v = ttsTalking || typingTalking
        if v != talking { talking = v }
    }

    // MARK: Face

    func targetFace() -> FaceParams {
        if dozing {
            var f = EmotionStyle.params(for: .sleepy)
            f.eyeOpen = 0.08
            return f
        }
        return FaceParams.lerp(.neutral, EmotionStyle.params(for: emotion), intensity)
    }

    func currentFace(at now: Date) -> FaceParams {
        let t = min(1, max(0, now.timeIntervalSince(faceChangedAt) / 0.35))
        let eased = t * t * (3 - 2 * t)
        return FaceParams.lerp(fromFace, targetFace(), eased)
    }

    var displayedEmotion: Emotion { dozing ? .sleepy : emotion }

    // MARK: Idle life

    private func tick() {
        let now = Date()

        if now >= nextBlink {
            blinkStart = now
            // Occasionally a double blink.
            let double = Double.random(in: 0...1) < 0.15
            nextBlink = now.addingTimeInterval(double ? 0.35 : Double.random(in: 2...6))
        }

        if now >= nextGlance && !dozing {
            glanceUntil = now.addingTimeInterval(1.4)
            nextGlance = now.addingTimeInterval(Double.random(in: 9...22))
        }

        if gesture != GestureKind.none && now.timeIntervalSince(gestureStart) > Self.duration(of: gesture) {
            gesture = GestureKind.none
        }

        if emotion != .neutral && now >= emotionHoldUntil && !talking {
            setEmotion(.neutral, intensity: 0.5)
        }
        if gaze != .user && now >= gazeHoldUntil {
            gaze = .user
        }

        let systemIdle = AvatarModel.systemIdleSeconds()
        let pixieIdle = now.timeIntervalSince(lastPixieActivity)
        let shouldDoze = min(systemIdle, pixieIdle) >= Self.dozeAfter && !talking
        if shouldDoze && !dozing {
            fromFace = currentFace(at: now)
            faceChangedAt = now
            dozing = true
        } else if !shouldDoze && dozing {
            wake()
        }
    }

    nonisolated static func duration(of g: GestureKind) -> TimeInterval {
        switch g {
        case .none: return 0
        case .wave: return 1.6
        case .nod: return 1.0
        case .shake: return 1.0
        case .bounce: return 1.0
        case .leanIn: return 2.4
        case .spin: return 0.9
        case .hide: return 2.6
        case .dance: return 2.4
        case .jump: return 0.7
        }
    }

    /// Seconds since the last keyboard/mouse input anywhere (no permission needed).
    nonisolated static func systemIdleSeconds() -> Double {
        let types: [CGEventType] = [.mouseMoved, .keyDown, .leftMouseDown, .rightMouseDown, .scrollWheel, .flagsChanged]
        var best = Double.greatestFiniteMagnitude
        for t in types {
            let s = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: t)
            if s < best { best = s }
        }
        return best == .greatestFiniteMagnitude ? 0 : best
    }
}
