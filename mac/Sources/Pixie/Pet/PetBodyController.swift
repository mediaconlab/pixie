import AppKit
import Foundation
import PixieCore

/// Runs the PixieCore `PetEngine` at 1 Hz on the main actor: builds the sensed `PetContext`, feeds brain
/// events and user interactions in, persists the engine state in UserDefaults, and turns `PetOutput`s into
/// animation (via `AvatarModel`), local lines and wire messages (via the callbacks below).
@MainActor
final class PetBodyController {
    /// Sends (or queues) an envelope to the brain.
    var send: ((Envelope) -> Void)?
    /// Shows a pre-written local line as a bubble.
    var showLine: ((PetLine) -> Void)?
    /// Supplies the latest `state.update` activity.
    var currentActivity: () -> Activity = { .idle }
    /// Whether the link is open (pet.state is only sent live; it is re-sent after reconnecting).
    var isOnline: () -> Bool = { false }
    /// The latest context signals (mic, camera, music, calendar), or nil when not available.
    var signals: () -> PixieSignalsData? = { nil }
    /// The frontmost app changed (the observer here is shared with the signals monitor).
    var onAppSwitch: (() -> Void)?
    /// The screen was locked or unlocked (the observers here are shared with the signals monitor).
    var onScreenLockChanged: (() -> Void)?

    /// Whether the screen is locked right now.
    var isScreenLocked: Bool { screenLocked }

    private let avatar: AvatarModel
    private let clock: () -> Date
    private var engine: PetEngine
    private var timer: Timer?
    private var saveCountdown = 30
    private var sceneCountdown = 60
    private var lastAppSwitch = Date.distantPast
    private var screenLocked = false
    private var typingTicks: [Bool] = []
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
    /// pet.speak envelope id → request, so the brain's `bot.perform` (reply_to) can be matched.
    private var pendingSpeaks: [String: (PetSpeakData, Date)] = [:]

    static let defaultsKey = "petBody.v1"

    init(avatar: AvatarModel, clock: @escaping () -> Date = { Date() }) {
        self.avatar = avatar
        self.clock = clock
        var state = PetBodyState()
        if let data = UserDefaults.standard.data(forKey: Self.defaultsKey), let saved = PetBodyState.decoded(data) {
            state = saved
        } else {
            state.rng = PixieRandom(seed: UInt64.random(in: 1...UInt64.max))
        }
        engine = PetEngine(state: state)
        // Show the restored body straight away.
        avatar.setPetPhase(engine.phase)
        avatar.setPetBehaviour(engine.behaviour)
        avatar.setBaseline(engine.emotion, intensity: engine.state.feeling.intensity)
        refreshScene()
    }

    func start() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        let ws: NotificationCenter = NSWorkspace.shared.notificationCenter
        let o1 = ws.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.lastAppSwitch = Date()
                self?.onAppSwitch?()
            }
        }
        observers.append((ws, o1))
        let dn: NotificationCenter = DistributedNotificationCenter.default()
        let o2 = dn.addObserver(forName: NSNotification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.screenLocked = true
                self?.onScreenLockChanged?()
            }
        }
        let o3 = dn.addObserver(forName: NSNotification.Name("com.apple.screenIsUnlocked"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.screenLocked = false
                self?.onScreenLockChanged?()
            }
        }
        observers.append((dn, o2))
        observers.append((dn, o3))
        tick()
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        for (center, o) in observers { center.removeObserver(o) }
        observers.removeAll()
        save()
    }

    // MARK: Context

    private func context() -> PetContext {
        var c = PetContext()
        c.activity = currentActivity()
        c.idleSeconds = AvatarModel.systemIdleSeconds()
        let sinceKey = AvatarModel.secondsSinceKeyDown()
        typingTicks.append(sinceKey < 1.0)
        if typingTicks.count > 10 { typingTicks.removeFirst(typingTicks.count - 10) }
        let busy = typingTicks.filter { $0 }.count
        if busy >= 6 {
            c.typing = .high
        } else if sinceKey < 15 {
            c.typing = .low
        } else {
            c.typing = PetTypingRate.none
        }
        c.secondsSinceAppSwitch = max(0, Date().timeIntervalSince(lastAppSwitch))
        c.screenLocked = screenLocked
        applySignals(to: &c)
        return c
    }

    /// Mic, camera, calendar and music from `PixieSignalsMonitor`. Typing stays on the finer 1 Hz measure above.
    private func applySignals(to c: inout PetContext) {
        guard let s = signals() else { return }
        c.micInUse = s.mic_in_use
        c.cameraInUse = s.camera_in_use
        // Busy now, or a meeting starts within 5 minutes: don't start anything that interrupts.
        var soon = false
        if let n = s.next_busy_in_min, n <= 5 { soon = true }
        c.calendarBusy = s.calendar_busy_now || soon
        if let m = s.music {
            c.musicPlaying = m.playing
        } else {
            c.musicPlaying = nil
        }
    }

    // MARK: Tick

    private func tick() {
        let now = clock()
        let out = engine.step(context(), now: now)
        apply(out)
        let cutoff = now.addingTimeInterval(-90)
        pendingSpeaks = pendingSpeaks.filter { $0.value.1 > cutoff }
        saveCountdown -= 1
        if saveCountdown <= 0 {
            saveCountdown = 30
            save()
        }
        sceneCountdown -= 1
        if sceneCountdown <= 0 {
            sceneCountdown = 60
            refreshScene()
        }
    }

    @discardableResult
    private func post<T: Encodable>(_ type: String, _ payload: T) -> String? {
        guard let env = Envelope.make(type, payload) else { return nil }
        send?(env)
        return env.id
    }

    private func save() {
        if let data = engine.state.encoded() {
            UserDefaults.standard.set(data, forKey: Self.defaultsKey)
        }
    }

    private func apply(_ outputs: [PetOutput]) {
        for o in outputs {
            switch o {
            case .state(let s):
                if isOnline() {
                    post("pet.state", s)
                } else {
                    engine.resendState()
                }
            case .event(let e):
                post("pet.event", e)
            case .speak(let req):
                // Never queue a line for later: offline, the moment simply passes.
                guard isOnline() else {
                    apply(engine.speakAnswered(req, said: false, now: clock()))
                    break
                }
                if let id = post("pet.speak", req) {
                    pendingSpeaks[id] = (req, clock())
                }
            case .localLine(let line, _):
                showLine?(line)
            case .behaviour(let b):
                avatar.setPetBehaviour(b)
            case .phase(let p):
                avatar.setPetPhase(p)
                save()
            case .emotion(let e, let i):
                avatar.setBaseline(e, intensity: i)
            case .cue(let c):
                avatar.playCue(c)
            }
        }
    }

    private var ctxNow: PetContext {
        var c = PetContext()
        c.activity = currentActivity()
        c.idleSeconds = AvatarModel.systemIdleSeconds()
        c.screenLocked = screenLocked
        applySignals(to: &c)
        return c
    }

    // MARK: Inputs

    func interact(_ kind: PetInteraction) {
        apply(engine.interact(kind, ctx: ctxNow, now: clock()))
    }

    func userChatted() {
        apply(engine.userChatted(now: clock()))
        interact(.chat)
    }

    func bubbleDismissedByUser() {
        apply(engine.bubbleDismissed(now: clock()))
    }

    func connected() {
        engine.resendState()
    }

    func profile(_ p: PetProfileData) {
        engine.setProfile(p)
    }

    func env(_ e: PetEnvData) {
        engine.setEnv(e, now: clock())
        refreshScene()
    }

    func thoughts(_ t: PetThoughtsData) {
        engine.setThoughts(t)
    }

    func lines(_ l: PetLinesData) {
        engine.setLines(l)
    }

    func obey(_ o: PetObeyData) {
        apply(engine.obey(o, ctx: ctxNow, now: clock()))
        save()
    }

    func appraisal(_ a: PetAppraisalData) {
        apply(engine.appraise(a, now: clock()))
    }

    /// A `bot.perform` arrived. Returns true when it answers one of our `pet.speak` requests.
    func performanceArrived(_ p: Performance) -> Bool {
        guard let rt = p.reply_to, let pending = pendingSpeaks.removeValue(forKey: rt) else { return false }
        let said = !p.say.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        apply(engine.speakAnswered(pending.0, said: said, now: clock()))
        return true
    }

    // MARK: Scene

    /// Window view and festive accessory from the latest env.update.
    private func refreshScene() {
        let env = engine.state.knowledge.env
        avatar.festive = env?.holiday != nil
        let now = clock()
        var style = PetWindowStyle.day
        switch env?.weather?.condition {
        case .some(.rain): style = .rain
        case .some(.storm): style = .storm
        case .some(.snow): style = .snow
        case .some(.clear), .some(.cloudy), .some(.fog), .some(.hot), .some(.other), .none:
            if engine.nearSunset(now) {
                style = .sunset
            } else if env?.weather?.is_day == false {
                style = .night
            } else {
                let h = engine.localHour(now)
                style = (h >= 7 && h < 19) ? .day : .night
            }
        }
        if avatar.windowStyle != style { avatar.windowStyle = style }
    }
}
