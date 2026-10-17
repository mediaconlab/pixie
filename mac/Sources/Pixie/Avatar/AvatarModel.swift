import AppKit
import CoreGraphics
import PixieCore
import SwiftUI

/// Drives the character. Discrete events (blinks, glances, gestures, emotion changes, pet behaviours and
/// cues) are stored as timestamps here; `CharacterView` turns them into continuous motion inside a
/// TimelineView. The pet's phase, behaviour, baseline emotion and cues come from the PixieCore engine via
/// `PetBodyController`; brain performances layer on top while they hold.
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

    // Pet body (from the engine)
    @Published private(set) var petPhase: PetPhase = .awake
    @Published private(set) var phaseStart: Date = .distantPast
    @Published private(set) var behaviour: PetBehaviour = .idleBreathe
    @Published private(set) var behaviourStart: Date = Date()
    @Published private(set) var cue: PetCue?
    @Published private(set) var cueStart: Date = .distantPast
    @Published var windowStyle: PetWindowStyle = .day
    /// Evening or night locally: `read_book` gets a warm reading-lamp glow.
    @Published var eveningLight = false
    @Published var festive = false
    /// True while the panel is fully covered or off-screen: the animation timeline pauses.
    @Published var hidden = false
    @Published private(set) var carried = false
    @Published private(set) var pettingNow = false
    /// A hover stroke keeps the "being petted" face until then (read per frame, so not published).
    private(set) var strokeUntil: Date = .distantPast

    // Status badges
    @Published private(set) var dozing = false
    @Published var eyeIndicator = false
    @Published var listening = false
    @Published var connected = false

    /// Character centre in screen coordinates (set by the panel controller) for cursor gaze.
    var screenCenter: CGPoint = .zero

    // Interaction hooks wired by the panel controller and the app controller.
    var onTap: (() -> Void)?
    var onDragBegan: (() -> Void)?
    var onDragChanged: (() -> Void)?
    var onDragEnded: (() -> Void)?
    /// A press ended without dragging (the panel stops capturing the mouse).
    var onPressEnded: (() -> Void)?
    var onPoke: (() -> Void)?
    var onPet: (() -> Void)?
    var onCarry: (() -> Void)?
    var onFeed: (() -> Void)?
    /// Something needs Pixie (a notice, a performance): wakes it unless the user sent it to sleep.
    var onWake: (() -> Void)?

    private var ttsTalking = false
    private var typingTalking = false
    private var nextBlink = Date().addingTimeInterval(3)
    private var nextGlance = Date().addingTimeInterval(12)
    private var emotionHoldUntil: Date = .distantPast
    private var gazeHoldUntil: Date = .distantPast
    private var baseEmotion: Emotion = .neutral
    private var baseIntensity: Double = 0.5
    private var timer: Timer?
    private var pressTimer: Timer?
    private var pressTicks = 0

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

    /// Something wants Pixie's attention. The pet engine decides whether that wakes it.
    func wake() {
        onWake?()
    }

    private func updateTalking() {
        let v = ttsTalking || typingTalking
        if v != talking { talking = v }
    }

    // MARK: Pet body

    func setPetPhase(_ p: PetPhase) {
        guard p != petPhase else { return }
        let now = Date()
        fromFace = currentFace(at: now)
        faceChangedAt = now
        petPhase = p
        phaseStart = now
        dozing = p == .asleep || p == .napping
    }

    func setPetBehaviour(_ b: PetBehaviour) {
        guard b != behaviour else { return }
        behaviour = b
        behaviourStart = Date()
    }

    func playCue(_ c: PetCue) {
        cue = c
        cueStart = Date()
    }

    /// The engine's resting emotion. Shown whenever no performance is holding the face.
    func setBaseline(_ e: Emotion, intensity i: Double) {
        baseEmotion = e
        baseIntensity = max(0, min(1, i))
        if Date() >= emotionHoldUntil && !talking && (emotion != e || abs(intensity - baseIntensity) > 0.05) {
            setEmotion(e, intensity: baseIntensity)
        }
    }

    /// A back-and-forth hover over the character (detected by the panel controller).
    func hoverStroke() {
        strokeUntil = Date().addingTimeInterval(1.6)
        onPet?()
    }

    // MARK: Press gestures (see mac/README.md "Touching Pixie")

    /// Mouse down on the character. Holding still for 0.5 s pets; moving drags (carry); a quick
    /// release pokes and toggles the chat.
    func pressBegan() {
        pressTimer?.invalidate()
        pressTicks = 0
        pettingNow = false
        carried = false
        onDragBegan?()
        pressTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.pressTick() }
        }
    }

    private func pressTick() {
        pressTicks += 1
        if pressTicks == 2 {
            pettingNow = true
            onPet?()
        } else if pressTicks > 2 && pressTicks % 8 == 2 {
            onPet?() // keep stroking every 2 s while held
        }
    }

    func pressBecameDrag() {
        pressTimer?.invalidate()
        pressTimer = nil
        pettingNow = false
        carried = true
        onCarry?()
    }

    func pressEnded(wasDrag: Bool) {
        pressTimer?.invalidate()
        pressTimer = nil
        let held = pettingNow
        pettingNow = false
        carried = false
        if wasDrag {
            onDragEnded?()
            return
        }
        onPressEnded?()
        if !held {
            onPoke?()
            onTap?()
        }
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

        if let c = cue, now.timeIntervalSince(cueStart) > Pose.duration(of: c) {
            cue = nil
        }

        if (emotion != baseEmotion || abs(intensity - baseIntensity) > 0.05) && now >= emotionHoldUntil && !talking {
            setEmotion(baseEmotion, intensity: baseIntensity)
        }
        if gaze != .user && now >= gazeHoldUntil {
            gaze = .user
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

    /// Seconds since the last key press anywhere (no permission needed; no key contents).
    nonisolated static func secondsSinceKeyDown() -> Double {
        CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .keyDown)
    }
}
