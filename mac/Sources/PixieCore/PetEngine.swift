import Foundation

// The pet "body" (PROTOCOL.md §4): a pure, deterministic engine stepped at 1 Hz. Time always comes in as an
// explicit `now` (injectable clock) and every random choice goes through a seeded `PixieRandom`, so a given
// seed + input sequence always produces the same outputs. The app turns `PetOutput`s into animation,
// bubbles and wire messages; the engine never touches the UI or the network.

// MARK: - Seeded RNG

/// SplitMix64. Persisted as a decimal string so the full 64-bit state survives JSON round trips.
public struct PixieRandom: Codable, Equatable, Sendable {
    public private(set) var state: UInt64

    public init(seed: UInt64) {
        state = seed
    }

    public mutating func next() -> UInt64 {
        state = state &+ 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }

    /// Uniform in [0, 1).
    public mutating func unit() -> Double {
        Double(next() >> 11) / 9_007_199_254_740_992.0
    }

    public mutating func range(_ lo: Double, _ hi: Double) -> Double {
        lo + (hi - lo) * unit()
    }

    public mutating func chance(_ p: Double) -> Bool {
        unit() < p
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self), let v = UInt64(s) {
            state = v
        } else {
            state = 0x5EED
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(String(state))
    }
}

// MARK: - Inputs

public enum PetTypingRate: String, Codable, CaseIterable, Sendable {
    case none, low, high
}

/// What the app senses right now. Everything has a neutral default.
public struct PetContext: Equatable, Sendable {
    public var activity: Activity = .idle
    /// Seconds since the last keyboard/mouse input.
    public var idleSeconds: Double = 0
    public var typing: PetTypingRate = PetTypingRate.none
    public var secondsSinceAppSwitch: Double = 1_000_000
    public var micInUse = false
    public var cameraInUse = false
    public var screenLocked = false
    public var calendarBusy = false
    /// nil = unknown (no music signal), so `bob_to_music` is never picked.
    public var musicPlaying: Bool? = nil

    public init() {}

    public init(activity: Activity, idleSeconds: Double = 0, typing: PetTypingRate = PetTypingRate.none, secondsSinceAppSwitch: Double = 1_000_000) {
        self.activity = activity
        self.idleSeconds = idleSeconds
        self.typing = typing
        self.secondsSinceAppSwitch = secondsSinceAppSwitch
    }

    public var present: Bool { activity != .away && !screenLocked }
    /// Meeting, call or camera: never talk, never pout, keep motion small.
    public var inCall: Bool { activity == .meeting || micInUse || cameraInUse }
    /// Present and not occupied by something Pixie should not interrupt.
    public var available: Bool { present && !inCall && activity != .video && !calendarBusy }
    /// Available and not in a burst of focused work: the attention ladder only builds now.
    public var free: Bool {
        guard available, typing != .high else { return false }
        if activity == .coding && typing != PetTypingRate.none { return false }
        return true
    }
}

public enum PetInteraction: String, Codable, CaseIterable, Sendable {
    /// Hover strokes or click-and-hold.
    case petting
    /// Quick click.
    case poke
    /// Context-menu snack.
    case feed
    /// Drag started.
    case carry
    /// The user sent a chat message.
    case chat
    /// Some other direct user action (opened chat, hotkey, menu).
    case attention
    /// Not the user: a notice, proposal or reminder needs Pixie awake. Wakes, but does not soothe the ladder.
    case alert
}

// MARK: - Behaviours and cues

public enum PetBehaviour: String, Codable, CaseIterable, Sendable, TolerantStringEnum {
    case idleBreathe = "idle_breathe"
    case lookAtCursor = "look_at_cursor"
    case watchUserWork = "watch_user_work"
    case selfPlay = "self_play"
    case chaseCursor = "chase_cursor"
    case exploreEdge = "explore_edge"
    case peekWindow = "peek_window"
    case nap
    case sleepCurled = "sleep_curled"
    case yawnStretch = "yawn_stretch"
    case eatSnack = "eat_snack"
    case lookOutWindow = "look_out_window"
    case fanSelf = "fan_self"
    case hide
    case bobToMusic = "bob_to_music"
    case festiveWiggle = "festive_wiggle"
    case curlNearCursor = "curl_near_cursor"
    case attentionBid = "attention_bid"
    case sulk
    case makeUp = "make_up"
    /// Leisure: sitting with a small book and round glasses.
    case readBook = "read_book"
    /// Leisure: keepy-uppy with a little football on its head.
    case headFootball = "head_football"
    /// Leisure: nothing appeals and boredom is high. Not an attention bid and not a sulk.
    case bored

    public static var fallback: PetBehaviour { .idleBreathe }

    public init(from decoder: Decoder) throws {
        self = PetBehaviour.tolerant(try? decoder.singleValueContainer().decode(String.self))
    }

    /// Energetic play that fast typing, meetings and sleepiness suppress.
    public var isPlay: Bool {
        switch self {
        case .selfPlay, .chaseCursor, .exploreEdge, .peekWindow, .festiveWiggle, .headFootball:
            return true
        case .idleBreathe, .lookAtCursor, .watchUserWork, .nap, .sleepCurled, .yawnStretch, .eatSnack,
             .lookOutWindow, .fanSelf, .hide, .bobToMusic, .curlNearCursor, .attentionBid, .sulk, .makeUp,
             .readBook, .bored:
            return false
        }
    }

    /// Minimum seconds before the picker may replace it.
    public var minHold: Double {
        switch self {
        case .idleBreathe, .lookAtCursor: return 8
        case .watchUserWork: return 15
        case .selfPlay, .chaseCursor: return 10
        case .exploreEdge, .peekWindow: return 9
        case .nap, .sleepCurled: return 60
        case .yawnStretch: return 5
        case .eatSnack: return 9
        case .lookOutWindow: return 25
        case .fanSelf: return 12
        case .hide: return 20
        case .bobToMusic: return 15
        case .festiveWiggle: return 8
        case .curlNearCursor: return 40
        case .attentionBid: return 6
        case .sulk: return 40
        case .makeUp: return 4
        case .readBook: return 30
        case .headFootball: return 14
        case .bored: return 20
        }
    }
}

/// One-shot animations layered over the current behaviour.
public enum PetCue: String, Codable, CaseIterable, Sendable {
    case glance, hop, pout, squish, whisper, nuzzle
}

// MARK: - Outputs

public enum PetOutput: Equatable, Sendable {
    /// Send `pet.state`.
    case state(PetStateData)
    /// Send `pet.event`.
    case event(PetEventData)
    /// Send `pet.speak` (the brain voices it and answers with `bot.perform`).
    case speak(PetSpeakData)
    /// Show this pre-written line from `pet.lines` now (already counted as shown).
    case localLine(PetLine, intent: PetIntent)
    case behaviour(PetBehaviour)
    case phase(PetPhase)
    /// Baseline emotion and intensity (brain performances still override it while they hold).
    case emotion(Emotion, Double)
    case cue(PetCue)
}

// MARK: - Persisted state

public struct PetNeeds: Codable, Equatable, Sendable {
    public var sleepPressure: Double = 0.2
    public var energy: Double = 0.8
    public var social: Double = 0.2
    public var boredom: Double = 0.2
    /// Cosmetic only: low snack never hurts anything.
    public var snack: Double = 0.7
    public var mood = PetMood(p: 0.15, a: 0, d: 0)
    public init() {}
}

public struct PetFeeling: Codable, Equatable, Sendable {
    public var emotion: Emotion = .neutral
    public var intensity: Double = 0.4
    public var setAt: Double = 0
    public init() {}
}

public struct PetLife: Codable, Equatable, Sendable {
    public var phase: PetPhase = .awake
    public var phaseSince: Double = 0
    public var napUntil: Double = 0
    public var behaviour: PetBehaviour = .idleBreathe
    public var behaviourSince: Double = 0
    public var holdUntil: Double = 0
    public var nextPickAt: Double = 0
    public var lastPresentAt: Double = 0
    public var lastInteractionAt: Double = 0
    public var lastPettedEventAt: Double = 0
    public var pokeTimes: [Double] = []
    public var greetedDay = ""
    public var lateNightKey = ""
    public var sunsetDay = ""
    public var lastWeather: PetWeatherCondition? = nil
    public init() {}
}

public struct PetAttention: Codable, Equatable, Sendable {
    public var ladder: Int = 0
    public var stepAt: Double = 0
    public var gaveUpUntil: Double = 0
    public var snoozeUntil: Double = 0
    public init() {}
}

public struct PetPendingLine: Codable, Equatable, Sendable {
    public var intent: PetIntent
    public var thoughtID: String?
    public var hint: String?
    public var desire: Double
    public var expiresAt: Double
    public init(intent: PetIntent, thoughtID: String? = nil, hint: String? = nil, desire: Double, expiresAt: Double) {
        self.intent = intent
        self.thoughtID = thoughtID
        self.hint = hint
        self.desire = desire
        self.expiresAt = expiresAt
    }
}

public struct PetShownBubble: Codable, Equatable, Sendable {
    public var intent: PetIntent
    public var thoughtID: String?
    public var shownAt: Double
}

public struct PetSpeech: Codable, Equatable, Sendable {
    /// Per-user threshold a line's desire must reach. Rises when lines are ignored/dismissed, falls on replies.
    public var threshold: Double = 0.45
    public var lastAskAt: Double = 0
    public var lastShownAt: Double = 0
    public var awaitingSince: Double = 0
    public var shownTimes: [Double] = []
    public var dayKey = ""
    public var linesToday = 0
    public var gossipToday = 0
    public var theatricalToday = 0
    public var consecutiveIgnored = 0
    public var pausedUntil: Double = 0
    public var lastThoughtCheckAt: Double = 0
    public var pending: [PetPendingLine] = []
    public var bubble: PetShownBubble? = nil
    public var usedThoughts: [String] = []
    public init() {}
}

public struct PetObeyState: Codable, Equatable, Sendable {
    /// Seconds since 1970 (local "quiet" / "not now" / "stop").
    public var quietUntil: Double = 0
    public var sleepUntil: Double = 0
    public var calmUntil: Double = 0
    public var gossipOverride: Bool? = nil
    public var lessNeedy: Double = 0
    public var talkBoost: Double = 0
    public init() {}
}

public struct PetKnowledge: Codable, Equatable, Sendable {
    public var profile = PetProfileData()
    public var env: PetEnvData? = nil
    public var thoughts: [PetThought] = []
    public var lines: [String: [PetLine]] = [:]
    public init() {}
}

public struct PetTelemetry: Codable, Equatable, Sendable {
    public var lastStateSentAt: Double = 0
    public var lastStateKey = ""
    public init() {}
}

/// Everything the engine persists (UserDefaults). Decoding is tolerant per group, so a newer or older
/// app keeps whatever groups still decode and resets only the rest.
public struct PetBodyState: Codable, Equatable, Sendable {
    public var needs = PetNeeds()
    public var feeling = PetFeeling()
    public var life = PetLife()
    public var attention = PetAttention()
    public var speech = PetSpeech()
    public var obey = PetObeyState()
    public var knowledge = PetKnowledge()
    public var telemetry = PetTelemetry()
    public var rng = PixieRandom(seed: 0x5EED_CAFE)
    public var lastStepAt: Double = 0

    public init() {}

    enum CodingKeys: String, CodingKey { case needs, feeling, life, attention, speech, obey, knowledge, telemetry, rng, lastStepAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        needs = (try? c.decode(PetNeeds.self, forKey: .needs)) ?? PetNeeds()
        feeling = (try? c.decode(PetFeeling.self, forKey: .feeling)) ?? PetFeeling()
        life = (try? c.decode(PetLife.self, forKey: .life)) ?? PetLife()
        attention = (try? c.decode(PetAttention.self, forKey: .attention)) ?? PetAttention()
        speech = (try? c.decode(PetSpeech.self, forKey: .speech)) ?? PetSpeech()
        obey = (try? c.decode(PetObeyState.self, forKey: .obey)) ?? PetObeyState()
        knowledge = (try? c.decode(PetKnowledge.self, forKey: .knowledge)) ?? PetKnowledge()
        telemetry = (try? c.decode(PetTelemetry.self, forKey: .telemetry)) ?? PetTelemetry()
        rng = (try? c.decode(PixieRandom.self, forKey: .rng)) ?? PixieRandom(seed: 0x5EED_CAFE)
        lastStepAt = (try? c.decode(Double.self, forKey: .lastStepAt)) ?? 0
    }

    public func encoded() -> Data? {
        try? JSONEncoder().encode(self)
    }

    public static func decoded(_ data: Data) -> PetBodyState? {
        try? JSONDecoder().decode(PetBodyState.self, from: data)
    }
}

// MARK: - Engine

public struct PetEngine: Sendable {
    public var state: PetBodyState
    public var timeZone: TimeZone {
        didSet { calendar.timeZone = timeZone }
    }
    private var calendar: Calendar

    // Tunables (seconds).
    static let sleepRiseTau: Double = 16 * 3600
    static let sleepDecayTau: Double = 3 * 3600
    static let napDecayTau: Double = 2.5 * 3600
    static let replyWindow: Double = 120
    static let minLineGap: Double = 20 * 60
    static let ignorePause: Double = 90 * 60
    static let stateMinGap: Double = 60
    static let stateHeartbeat: Double = 10 * 60

    public init(state: PetBodyState = PetBodyState(), seed: UInt64? = nil, timeZone: TimeZone = TimeZone.current) {
        var s = state
        if let seed { s.rng = PixieRandom(seed: seed) }
        self.state = s
        // A restored env.update's zone wins over the device's own (see setEnv).
        let zone = PetEngine.zone(s.knowledge.env?.tz) ?? timeZone
        self.timeZone = zone
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = zone
        calendar = cal
    }

    /// A valid IANA zone from `env.update.tz`, or nil.
    static func zone(_ tz: String?) -> TimeZone? {
        guard let tz, !tz.isEmpty else { return nil }
        return TimeZone(identifier: tz)
    }

    // MARK: Derived values

    public var phase: PetPhase { state.life.phase }
    public var behaviour: PetBehaviour { state.life.behaviour }
    public var ladder: Int { state.attention.ladder }
    public var emotion: Emotion { state.feeling.emotion }

    var traits: PetTraits { state.knowledge.profile.traits }

    public var lessNeedy: Double {
        pixieClamp(max(state.knowledge.profile.less_needy, state.obey.lessNeedy))
    }

    public var talkScale: Double {
        pixieClamp(state.knowledge.profile.talk_scale * (1 + state.obey.talkBoost), 0, 2)
    }

    public var gossipEnabled: Bool {
        state.obey.gossipOverride ?? state.knowledge.profile.gossip_enabled
    }

    public var dailyLineCap: Int {
        Int((10 * talkScale).rounded(.down))
    }

    public func localHour(_ now: Date) -> Double {
        let c = calendar.dateComponents([.hour, .minute, .second], from: now)
        return Double(c.hour ?? 0) + Double(c.minute ?? 0) / 60 + Double(c.second ?? 0) / 3600
    }

    public func dayKey(_ now: Date) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: now)
        return "\(c.year ?? 0)-\(c.month ?? 0)-\(c.day ?? 0)"
    }

    /// A "night" runs noon to noon, so 23:30 and 00:30 belong to the same night.
    func nightKey(_ now: Date) -> String {
        dayKey(now.addingTimeInterval(-12 * 3600))
    }

    /// Circadian alertness, −1 (deep night) … 1 (mid-day), from the learned rhythm.
    public func circadian(hour: Double) -> Double {
        let r = state.knowledge.profile.rhythm
        var span = r.sleep_hour - r.wake_hour
        if span <= 0 { span += 24 }
        if span < 8 || span > 22 { span = 16 }
        var x = (hour - r.wake_hour).truncatingRemainder(dividingBy: 24)
        if x < 0 { x += 24 }
        return cos(2 * Double.pi * (x - span / 2) / 24)
    }

    /// Sleep drive: homeostatic pressure minus circadian alertness.
    public func sleepDrive(_ now: Date) -> Double {
        state.needs.sleepPressure - 0.35 * circadian(hour: localHour(now))
    }

    func isAwakeHour(_ hour: Double) -> Bool {
        let r = state.knowledge.profile.rhythm
        var span = r.sleep_hour - r.wake_hour
        if span <= 0 { span += 24 }
        var x = (hour - r.wake_hour).truncatingRemainder(dividingBy: 24)
        if x < 0 { x += 24 }
        return x < span
    }

    public func nearSunset(_ now: Date) -> Bool {
        guard let ss = state.knowledge.env?.sunset, ss > 0 else { return false }
        let t = now.timeIntervalSince1970
        let s = ss / 1000
        return t >= s - 20 * 60 && t <= s + 25 * 60
    }

    func nearMeal(_ hour: Double) -> Bool {
        let r = state.knowledge.profile.rhythm
        return abs(hour - r.lunch_hour) < 0.5 || abs(hour - r.dinner_hour) < 0.5
    }

    var isResting: Bool { state.life.phase == .asleep || state.life.phase == .napping }

    // MARK: Brain inputs

    public mutating func setProfile(_ p: PetProfileData) {
        state.knowledge.profile = p
        // The brain's profile is authoritative for preferences it learned from instructions.
        state.obey.gossipOverride = nil
    }

    public mutating func setEnv(_ e: PetEnvData, now: Date) {
        let t = now.timeIntervalSince1970
        let old = state.knowledge.env?.weather?.condition
        var env = e
        // Keep the last valid zone when an update has none (or an invalid one), so a restart restores it.
        if PetEngine.zone(env.tz) == nil { env.tz = state.knowledge.env?.tz }
        state.knowledge.env = env
        if let zone = PetEngine.zone(env.tz), zone.identifier != timeZone.identifier { timeZone = zone }
        guard let cond = e.weather?.condition, cond != old else { return }
        state.life.lastWeather = cond
        guard old != nil else { return } // the first report after launch is not news
        let hint: String?
        switch cond {
        case .rain: hint = "it started raining"
        case .storm: hint = "a storm is starting"
        case .snow: hint = "it started snowing"
        case .hot: hint = "it got really hot"
        case .fog: hint = "it got foggy"
        case .clear, .cloudy, .other: hint = nil
        }
        if let hint {
            queue(.weather, hint: hint, desire: 0.6, ttl: 20 * 60, t: t)
        }
    }

    public mutating func setThoughts(_ d: PetThoughtsData) {
        state.knowledge.thoughts = d.items
        let ids = Set(d.items.map { $0.id })
        state.speech.pending.removeAll { p in
            guard let id = p.thoughtID else { return false }
            return !ids.contains(id)
        }
    }

    public mutating func setLines(_ d: PetLinesData) {
        state.knowledge.lines = d.lines
    }

    // MARK: Tick

    public mutating func step(_ ctx: PetContext, now: Date) -> [PetOutput] {
        var out: [PetOutput] = []
        let t = now.timeIntervalSince1970
        if state.lastStepAt <= 0 {
            bootstrap(now)
            state.lastStepAt = t - 1
        }
        var dt = t - state.lastStepAt
        if dt < 0 { dt = 0 }
        state.lastStepAt = t
        if dt > 3600 {
            // The Mac was off or asleep: Pixie rested too.
            state.needs.sleepPressure *= exp(-min(dt, 12 * 3600) / PetEngine.sleepDecayTau)
            state.needs.energy = 1
            state.needs.boredom = 0.2
            state.attention.ladder = 0
            if state.life.phase != .awake {
                enterPhase(sleepDrive(now) > 0.68 ? PetPhase.sleepy : PetPhase.awake, t: t, out: &out)
            }
            dt = 1
        }

        rollDay(now)
        trackPresence(ctx, t: t, now: now, out: &out)
        updateNeeds(ctx, dt: dt)
        updatePhase(ctx, now: now, out: &out)
        updateMood(dt: dt, now: now)
        updateEmotion(dt: dt, t: t, out: &out)
        resolveBubble(t: t, out: &out)
        updateAttention(ctx, dt: dt, now: now, out: &out)
        pickBehaviour(ctx, now: now, out: &out)
        noticeMoments(ctx, now: now)
        considerSpeaking(ctx, now: now, out: &out)
        maybeSendState(t: t, out: &out)
        return out
    }

    /// Fresh install: start with a sleep pressure that fits the time of day ("fully grown from day one").
    mutating func bootstrap(_ now: Date) {
        let hour = localHour(now)
        let r = state.knowledge.profile.rhythm
        if isAwakeHour(hour) {
            var x = (hour - r.wake_hour).truncatingRemainder(dividingBy: 24)
            if x < 0 { x += 24 }
            state.needs.sleepPressure = 0.05 + 0.95 * (1 - exp(-x * 3600 / PetEngine.sleepRiseTau))
        } else {
            state.needs.sleepPressure = 0.55
        }
        state.needs.energy = 0.15 + 0.85 * (1 - state.needs.sleepPressure)
        let t = now.timeIntervalSince1970
        state.life.phaseSince = t
        state.life.behaviourSince = t
        state.life.lastPresentAt = t
        state.feeling.setAt = t
    }

    mutating func rollDay(_ now: Date) {
        let key = dayKey(now)
        if key != state.speech.dayKey {
            state.speech.dayKey = key
            state.speech.linesToday = 0
            state.speech.gossipToday = 0
            state.speech.theatricalToday = 0
        }
    }

    mutating func trackPresence(_ ctx: PetContext, t: Double, now: Date, out: inout [PetOutput]) {
        if ctx.present {
            let away = t - state.life.lastPresentAt
            if away >= 30 * 60 && state.life.lastPresentAt > 0 {
                out.append(.event(PetEventData(kind: .reunion)))
                if state.life.phase == .napping {
                    enterPhase(.waking, t: t, out: &out)
                }
                if !isResting {
                    let key = dayKey(now)
                    if state.life.greetedDay != key && localHour(now) < 12 {
                        state.life.greetedDay = key
                        queue(.greetMorning, desire: 0.8, ttl: 10 * 60, t: t)
                    } else {
                        queue(.reunion, desire: 0.75, ttl: 10 * 60, t: t)
                    }
                }
            }
            state.life.lastPresentAt = t
        }
    }

    mutating func updateNeeds(_ ctx: PetContext, dt: Double) {
        var n = state.needs
        let resting = isResting
        if resting {
            let tau = state.life.phase == .napping ? PetEngine.napDecayTau : PetEngine.sleepDecayTau
            n.sleepPressure *= exp(-dt / tau)
        } else {
            n.sleepPressure += (1 - n.sleepPressure) * (1 - exp(-dt / PetEngine.sleepRiseTau))
        }

        let energyTarget = resting ? 1.0 : 0.15 + 0.85 * (1 - n.sleepPressure)
        let energyTau: Double = resting ? 3600 : 1800
        n.energy += (energyTarget - n.energy) * (1 - exp(-dt / energyTau))
        if !resting && state.life.behaviour.isPlay { n.energy -= 0.0004 * dt }

        // Social need rises only while the user is here and available.
        if ctx.available && !resting {
            let tau = 2.5 * 3600 / (0.5 + traits.clinginess) * (1 + lessNeedy)
            n.social += (1 - n.social) * (1 - exp(-dt / tau))
        }

        if resting {
            n.boredom *= exp(-dt / 1800)
        } else if state.life.behaviour.isPlay || state.life.behaviour == .bobToMusic || state.life.behaviour == .lookOutWindow
                    || state.life.behaviour == .readBook {
            n.boredom *= exp(-dt / 300)
        } else {
            let tau = 2700 / (0.5 + traits.curiosity)
            n.boredom += (1 - n.boredom) * (1 - exp(-dt / tau))
        }

        n.snack = max(0, n.snack - dt / (7 * 3600))

        n.sleepPressure = pixieClamp(n.sleepPressure)
        n.energy = pixieClamp(n.energy)
        n.social = pixieClamp(n.social)
        n.boredom = pixieClamp(n.boredom)
        state.needs = n
    }

    // MARK: Phases

    mutating func enterPhase(_ p: PetPhase, t: Double, out: inout [PetOutput]) {
        let old = state.life.phase
        guard p != old else { return }
        state.life.phase = p
        state.life.phaseSince = t
        out.append(.phase(p))
        switch p {
        case .asleep:
            out.append(.event(PetEventData(kind: .fellAsleep)))
            setBehaviour(.sleepCurled, t: t, out: &out)
            state.attention.ladder = 0
            state.speech.pending.removeAll()
        case .napping:
            if state.life.napUntil <= t {
                let napLength = state.rng.range(15 * 60, 35 * 60)
                state.life.napUntil = t + napLength
            }
            setBehaviour(.nap, t: t, out: &out)
            state.speech.pending.removeAll()
        case .waking:
            if old == .asleep { out.append(.event(PetEventData(kind: .woke))) }
            state.life.napUntil = 0
            setBehaviour(.yawnStretch, t: t, out: &out)
        case .sleepy:
            queue(.sleepy, desire: 0.5, ttl: 20 * 60, t: t)
        case .awake:
            if old == .waking { queue(.waking, desire: 0.5, ttl: 5 * 60, t: t) }
        }
        let base = moodEmotion()
        state.feeling.emotion = base.0
        state.feeling.intensity = base.1
        state.feeling.setAt = t
        out.append(.emotion(base.0, base.1))
    }

    mutating func updatePhase(_ ctx: PetContext, now: Date, out: inout [PetOutput]) {
        let t = now.timeIntervalSince1970
        let d = sleepDrive(now)
        let forced = t < state.obey.sleepUntil
        switch state.life.phase {
        case .awake:
            if forced || (d > 0.8 && !ctx.present) {
                enterPhase(.asleep, t: t, out: &out)
            } else if d > 0.68 {
                enterPhase(.sleepy, t: t, out: &out)
            }
        case .sleepy:
            if forced || (d > 0.8 && !ctx.present) || (d > 0.97 && ctx.idleSeconds > 600) {
                enterPhase(.asleep, t: t, out: &out)
            } else if d < 0.6 {
                enterPhase(.awake, t: t, out: &out)
            }
        case .napping:
            if forced || (d > 0.8 && !ctx.present) {
                enterPhase(.asleep, t: t, out: &out)
            } else if t >= state.life.napUntil {
                enterPhase(.waking, t: t, out: &out)
            }
        case .asleep:
            if forced { break }
            if d < 0.3 || (ctx.present && ctx.idleSeconds < 60 && d < 0.45) {
                enterPhase(.waking, t: t, out: &out)
                if ctx.present {
                    let key = dayKey(now)
                    if state.life.greetedDay != key && localHour(now) < 12 {
                        state.life.greetedDay = key
                        queue(.greetMorning, desire: 0.8, ttl: 15 * 60, t: t)
                    }
                }
            }
        case .waking:
            if forced {
                enterPhase(.asleep, t: t, out: &out)
            } else if t - state.life.phaseSince >= 25 {
                enterPhase(d > 0.68 ? PetPhase.sleepy : PetPhase.awake, t: t, out: &out)
            }
        }
    }

    // MARK: Mood & emotion

    func moodDefault(_ now: Date) -> PetMood {
        let tr = traits
        let prof = state.knowledge.profile
        let n = state.needs
        let tired: Double = max(0, sleepDrive(now) - 0.3)
        var p: Double = 0.1
        p += 0.25 * (tr.agreeableness - 0.5)
        p -= 0.15 * (tr.sensitivity - 0.5)
        p += 0.4 * prof.day_mood
        p += 0.1 * min(1, max(0, prof.bond) / 100)
        p -= 0.2 * max(0, n.social - 0.7)
        p -= 0.1 * max(0, n.boredom - 0.7)
        var a: Double = 0.3 * (tr.curiosity - 0.5)
        a -= 0.5 * tired
        a += 0.1 * (n.energy - 0.5)
        var d: Double = 0.25 * (tr.sass - 0.5)
        d -= 0.15 * (tr.sensitivity - 0.5)
        return PetMood(p: pixieClamp(p, -1, 1), a: pixieClamp(a, -1, 1), d: pixieClamp(d, -1, 1))
    }

    mutating func updateMood(dt: Double, now: Date) {
        let target = moodDefault(now)
        let k = 1 - exp(-dt / 1200)
        var m = state.needs.mood
        m.p += (target.p - m.p) * k
        m.a += (target.a - m.a) * k
        m.d += (target.d - m.d) * k
        state.needs.mood = m
    }

    /// The resting emotion that mood and phase imply.
    func moodEmotion() -> (Emotion, Double) {
        switch state.life.phase {
        case .asleep, .napping, .sleepy: return (.sleepy, 0.55)
        case .waking: return (.sleepy, 0.35)
        case .awake: break
        }
        if state.life.behaviour == .sulk { return (.annoyed, 0.4) }
        let m = state.needs.mood
        if m.p > 0.45 && m.a > 0.3 { return (.excited, 0.45) }
        if m.p > 0.25 { return (.happy, 0.4) }
        if m.p < -0.35 && m.d > 0.15 { return (.annoyed, 0.35) }
        if m.p < -0.3 { return (.sad, 0.35) }
        if m.a > 0.35 { return (.curious, 0.35) }
        return (.neutral, 0.5)
    }

    mutating func feel(_ e: Emotion, _ i: Double, t: Double, out: inout [PetOutput]) {
        state.feeling.emotion = e
        state.feeling.intensity = pixieClamp(i)
        state.feeling.setAt = t
        out.append(.emotion(e, state.feeling.intensity))
    }

    /// The current emotion fades into the mood.
    mutating func updateEmotion(dt: Double, t: Double, out: inout [PetOutput]) {
        let base = moodEmotion()
        if state.feeling.emotion == base.0 {
            state.feeling.intensity = base.1
            return
        }
        state.feeling.intensity *= exp(-dt / 45)
        if state.feeling.intensity < 0.18 {
            feel(base.0, base.1, t: t, out: &out)
        }
    }

    // MARK: Behaviour picker

    /// Scores for every candidate in this context (0 = not eligible). Public for tests and debugging.
    public func behaviourScores(_ ctx: PetContext, now: Date) -> [PetBehaviour: Double] {
        switch state.life.phase {
        case .asleep: return [.sleepCurled: 1]
        case .napping: return [.nap: 1]
        case .waking: return [.yawnStretch: 1, .idleBreathe: 0.5]
        case .awake, .sleepy: break
        }
        let t = now.timeIntervalSince1970
        let hour = localHour(now)
        let n = state.needs
        let tr = traits
        let sleepy = state.life.phase == .sleepy
        let env = state.knowledge.env
        let cond = env?.weather?.condition

        var playDamp: Double
        switch ctx.typing {
        case .high: playDamp = 0.1
        case .low: playDamp = 0.5
        case PetTypingRate.none: playDamp = 1
        }
        if ctx.inCall || ctx.activity == .video { playDamp *= 0.15 }
        if sleepy { playDamp *= 0.2 }
        if t < state.obey.calmUntil { playDamp *= 0.1 }
        let e = max(0.05, n.energy)

        var s: [PetBehaviour: Double] = [:]
        s[.idleBreathe] = 1.0
        s[.lookAtCursor] = ctx.present ? 0.5 + 0.4 * tr.curiosity : 0
        let working = ctx.activity == .coding || ctx.activity == .browsing
        s[.watchUserWork] = ctx.present && working ? (ctx.typing == .high ? 1.3 : 0.9) : 0.15
        s[.selfPlay] = (0.3 + n.boredom) * e * playDamp
        s[.chaseCursor] = ctx.present && ctx.idleSeconds < 5 ? (0.2 + 0.8 * n.boredom) * e * playDamp * 0.8 : 0
        s[.exploreEdge] = (0.2 + 0.6 * tr.curiosity) * (0.3 + n.boredom) * e * playDamp
        s[.peekWindow] = ctx.present ? (0.2 + 0.5 * tr.curiosity) * playDamp * 0.7 : 0

        let napOK = (!ctx.present || ctx.idleSeconds > 600) && isAwakeHour(hour)
        if napOK && (n.energy < 0.45 || sleepDrive(now) > 0.5) {
            s[.nap] = 1.2 + max(0, 0.45 - n.energy) * 3
        } else if sleepy && !ctx.present {
            s[.nap] = 1.5
        } else if napOK && !ctx.present {
            s[.nap] = 0.5 // alone for a while: pets doze
        } else {
            s[.nap] = 0
        }

        s[.yawnStretch] = sleepy ? 0.9 : (sleepDrive(now) > 0.5 ? 0.3 : 0.05)
        s[.eatSnack] = n.snack < 0.3 ? 1.0 : (nearMeal(hour) && n.snack < 0.7 ? 0.9 : 0)

        var window = 0.0
        if let cond {
            switch cond {
            case .rain, .snow, .fog: window = 0.9
            case .storm: window = 0.2
            case .clear, .cloudy, .hot, .other: window = 0
            }
        }
        if nearSunset(now) { window = max(window, 1.0) }
        s[.lookOutWindow] = window
        s[.fanSelf] = (env?.isHot ?? false) ? 1.4 : 0
        s[.hide] = cond == PetWeatherCondition.storm ? 1.3 : 0
        s[.bobToMusic] = ctx.musicPlaying == true ? 1.3 * (ctx.typing == .high ? 0.6 : 1) : 0
        s[.festiveWiggle] = env?.holiday != nil ? 0.8 * playDamp : 0
        s[.curlNearCursor] = sleepy && ctx.present ? 1.4 : 0

        // Leisure: the user is here and unoccupied (idle, browsing or paused for a while), not in a meeting,
        // call, video or busy calendar slot, and not typing fast.
        let leisure = ctx.available && ctx.typing != .high
            && (ctx.activity == .idle || ctx.activity == .browsing || ctx.idleSeconds >= 120)
        let weekend = env?.weekend ?? false
        let evening = hour >= 18 && hour < 23.5
        let wet = cond == PetWeatherCondition.rain || cond == PetWeatherCondition.snow
            || cond == PetWeatherCondition.storm || cond == PetWeatherCondition.fog

        // Reading is calm: best at moderate energy, still fine when a little tired, never when exhausted.
        var book = 0.0
        if leisure && n.energy >= 0.2 {
            let calm = 1 - min(1, abs(n.energy - 0.5) * 1.6)
            book = (0.3 + 0.45 * tr.curiosity) * (0.5 + 0.5 * calm) * (0.6 + 0.6 * n.boredom)
            if evening { book *= 1.7 }
            if wet { book *= 1.6 }
            if sleepy { book *= 0.6 }
        }
        s[.readBook] = book

        // Keepy-uppy is energetic play: needs good energy, damped like other play, likelier on weekends.
        var football = 0.0
        if leisure && !sleepy && n.energy >= 0.45 {
            football = (0.15 + n.boredom) * n.energy * playDamp * (weekend ? 1.5 : 1) * 1.1
        }
        s[.headFootball] = football

        // Bored: the fallback when boredom is high and nothing more interesting scores well.
        var boredScore = 0.0
        if leisure && n.boredom >= 0.6 {
            let options: [PetBehaviour] = [.selfPlay, .chaseCursor, .exploreEdge, .peekWindow, .readBook, .headFootball,
                                           .lookOutWindow, .fanSelf, .hide, .bobToMusic, .festiveWiggle, .eatSnack, .nap]
            var best = 0.0
            for o in options {
                best = max(best, s[o] ?? 0)
            }
            boredScore = (0.7 + 1.5 * (n.boredom - 0.6)) * max(0.15, 1.3 - best)
            if sleepy { boredScore *= 0.5 }
        }
        s[.bored] = boredScore

        // Ladder-driven only.
        s[.attentionBid] = 0
        s[.sulk] = 0
        s[.makeUp] = 0
        return s
    }

    mutating func setBehaviour(_ b: PetBehaviour, t: Double, hold: Double? = nil, out: inout [PetOutput]) {
        let holdEnd = t + (hold ?? b.minHold)
        let jitter = state.rng.range(0, 4)
        state.life.holdUntil = holdEnd
        state.life.nextPickAt = holdEnd + jitter
        guard b != state.life.behaviour else { return }
        state.life.behaviour = b
        state.life.behaviourSince = t
        out.append(.behaviour(b))
    }

    mutating func pickBehaviour(_ ctx: PetContext, now: Date, out: inout [PetOutput]) {
        let t = now.timeIntervalSince1970
        // Phases own the body while resting.
        switch state.life.phase {
        case .asleep:
            if state.life.behaviour != .sleepCurled { setBehaviour(.sleepCurled, t: t, out: &out) }
            return
        case .napping:
            if state.life.behaviour != .nap { setBehaviour(.nap, t: t, out: &out) }
            return
        case .awake, .sleepy, .waking:
            break
        }
        guard t >= state.life.holdUntil, t >= state.life.nextPickAt else { return }

        let scores = behaviourScores(ctx, now: now)
        let ranked = scores.filter { $0.value > 0 }
            .sorted { a, b in a.value == b.value ? a.key.rawValue < b.key.rawValue : a.value > b.value }
        let top = Array(ranked.prefix(3))
        guard !top.isEmpty else { return }
        let total = top.reduce(0.0) { $0 + $1.value }
        let r = state.rng.unit()
        var roll = r * total
        var chosen = top[0].key
        for item in top {
            roll -= item.value
            if roll <= 0 {
                chosen = item.key
                break
            }
        }
        switch chosen {
        case .nap:
            enterPhase(.napping, t: t, out: &out)
        case .eatSnack:
            setBehaviour(.eatSnack, t: t, out: &out)
            state.needs.snack = 1
            out.append(.event(PetEventData(kind: .ate)))
            queue(.ate, desire: 0.45, ttl: 90, t: t)
        case .idleBreathe, .lookAtCursor, .watchUserWork, .selfPlay, .chaseCursor, .exploreEdge, .peekWindow,
             .sleepCurled, .yawnStretch, .lookOutWindow, .fanSelf, .hide, .bobToMusic, .festiveWiggle,
             .curlNearCursor, .attentionBid, .sulk, .makeUp, .readBook, .headFootball, .bored:
            setBehaviour(chosen, t: t, out: &out)
        }
    }

    // MARK: Attention ladder

    /// glance → hop → gentle spoken bid → short sulk → (one theatrical line a day) → give up and nap.
    mutating func updateAttention(_ ctx: PetContext, dt: Double, now: Date, out: inout [PetOutput]) {
        let t = now.timeIntervalSince1970
        guard state.life.phase == .awake else {
            if state.attention.ladder != 0 && isResting { state.attention.ladder = 0 }
            return
        }
        guard ctx.free else {
            // Nothing builds while the user is busy: push the step clock forward.
            state.attention.stepAt += dt
            return
        }
        if t < state.attention.snoozeUntil || t < state.attention.gaveUpUntil || t < state.obey.quietUntil
            || t * 1000 < state.knowledge.profile.quiet_until {
            return
        }
        let need = state.needs.social * (0.6 + 0.8 * traits.clinginess) * (1 - 0.8 * lessNeedy)
        let interval = 180 * (1 + 2 * lessNeedy)
        switch state.attention.ladder {
        case 0:
            if need > 0.55 {
                state.attention.ladder = 1
                state.attention.stepAt = t
                out.append(.cue(.glance))
            }
        default:
            guard t - state.attention.stepAt >= interval else { return }
            if need < 0.3 {
                state.attention.ladder = 0
                return
            }
            state.attention.stepAt = t
            switch state.attention.ladder {
            case 1:
                state.attention.ladder = 2
                out.append(.cue(.hop))
                setBehaviour(.attentionBid, t: t, hold: 60, out: &out)
            case 2:
                state.attention.ladder = 3
                queue(.playfulBid, desire: 0.65, ttl: interval, t: t)
            case 3:
                state.attention.ladder = 4
                setBehaviour(.sulk, t: t, out: &out)
                out.append(.event(PetEventData(kind: .sulked)))
                feel(.annoyed, 0.45, t: t, out: &out)
            case 4:
                state.attention.ladder = 5
                // Optional theatrical line: once a day, only when things are relaxed and Pixie has some sass.
                let relaxed = ctx.activity == .idle || ctx.activity == .browsing || (state.knowledge.env?.weekend ?? false)
                if relaxed && traits.sass >= 0.3 && state.speech.theatricalToday < 1 && lessNeedy < 0.5 {
                    queue(.sulkLine, desire: 0.7, ttl: interval, t: t)
                }
            default:
                // Give up: a nap, then leave the user alone for a while.
                state.attention.ladder = 0
                state.attention.gaveUpUntil = t + 45 * 60 * (1 + lessNeedy)
                state.needs.social *= 0.6
                enterPhase(.napping, t: t, out: &out)
            }
        }
    }

    /// Any interaction soothes the ladder; past the hop it ends with a happy make-up.
    mutating func soothe(t: Double, out: inout [PetOutput]) {
        let wasUpset = state.attention.ladder >= 2 || state.life.behaviour == .sulk
        state.attention.ladder = 0
        state.attention.stepAt = t
        state.speech.pending.removeAll { $0.intent == .playfulBid || $0.intent == .sulkLine }
        if wasUpset && !isResting {
            setBehaviour(.makeUp, t: t, out: &out)
            feel(.love, 0.7, t: t, out: &out)
            out.append(.event(PetEventData(kind: .madeUp)))
        }
    }

    // MARK: Interactions

    public mutating func interact(_ kind: PetInteraction, ctx: PetContext, now: Date) -> [PetOutput] {
        var out: [PetOutput] = []
        let t = now.timeIntervalSince1970
        if kind != .alert { state.life.lastInteractionAt = t }

        // Waking up.
        switch state.life.phase {
        case .asleep, .napping:
            let forced = t < state.obey.sleepUntil
            switch kind {
            case .petting:
                break // a gentle stroke keeps a sleeping Pixie asleep
            case .attention, .alert:
                if !forced { enterPhase(.waking, t: t, out: &out) }
            case .poke, .feed, .carry, .chat:
                state.obey.sleepUntil = 0
                enterPhase(.waking, t: t, out: &out)
            }
        case .awake, .sleepy, .waking:
            break
        }
        if kind == .alert { return out }

        soothe(t: t, out: &out)
        var n = state.needs
        switch kind {
        case .petting:
            n.social = max(0, n.social - 0.12)
            n.boredom = max(0, n.boredom - 0.05)
            n.mood.p = min(1, n.mood.p + 0.08)
            if !isResting {
                feel(n.mood.p > 0.4 ? Emotion.love : Emotion.happy, 0.65, t: t, out: &out)
                out.append(.cue(.nuzzle))
            }
            if t - state.life.lastPettedEventAt >= 30 {
                state.life.lastPettedEventAt = t
                out.append(.event(PetEventData(kind: .petted)))
                let react = state.rng.chance(0.25)
                if react && !isResting {
                    queue(.reaction, hint: "being petted", desire: 0.5, ttl: 60, t: t)
                }
            }
        case .poke:
            n.social = max(0, n.social - 0.05)
            state.life.pokeTimes = state.life.pokeTimes.filter { t - $0 < 8 } + [t]
            out.append(.event(PetEventData(kind: .poked)))
            out.append(.cue(.squish))
            if state.life.pokeTimes.count >= 3 {
                n.mood.p = max(-1, n.mood.p - 0.1)
                feel(.annoyed, 0.5, t: t, out: &out)
            } else if state.life.phase == .awake {
                feel(.surprised, 0.5, t: t, out: &out)
            }
        case .feed:
            n.snack = 1
            n.energy = min(1, n.energy + 0.08)
            n.social = max(0, n.social - 0.1)
            n.mood.p = min(1, n.mood.p + 0.1)
            out.append(.event(PetEventData(kind: .fed)))
            setBehaviour(.eatSnack, t: t, out: &out)
            feel(.happy, 0.75, t: t, out: &out)
            queue(.ate, desire: 0.5, ttl: 90, t: t)
        case .carry:
            n.boredom = max(0, n.boredom - 0.1)
            out.append(.event(PetEventData(kind: .carried)))
            feel(n.mood.p > 0.2 ? Emotion.excited : Emotion.surprised, 0.6, t: t, out: &out)
        case .chat:
            n.social = max(0, n.social - 0.25)
            n.boredom = max(0, n.boredom - 0.1)
        case .attention:
            n.social = max(0, n.social - 0.05)
        case .alert:
            break
        }
        state.needs = n
        return out
    }

    public mutating func appraise(_ a: PetAppraisalData, now: Date) -> [PetOutput] {
        var out: [PetOutput] = []
        let t = now.timeIntervalSince1970
        let k = a.intensity * (0.5 + traits.sensitivity)
        var m = state.needs.mood
        switch a.event {
        case .praise:
            m.p += 0.35 * k; m.d += 0.15 * k; m.a += 0.1 * k
            feel(.proud, 0.4 + 0.5 * a.intensity, t: t, out: &out)
        case .scold:
            m.p -= 0.35 * k; m.d -= 0.2 * k; m.a += 0.15 * k
            feel(traits.sass > 0.6 ? Emotion.annoyed : Emotion.sad, 0.3 + 0.5 * a.intensity, t: t, out: &out)
        case .tease:
            m.a += 0.2 * k
            m.p += traits.sass > 0.5 ? 0.05 * k : -0.1 * k
            feel(traits.sass > 0.5 ? Emotion.annoyed : Emotion.shy, 0.35 + 0.3 * a.intensity, t: t, out: &out)
        case .affection:
            m.p += 0.4 * k; m.a += 0.05 * k
            state.needs.social = max(0, state.needs.social - 0.2)
            soothe(t: t, out: &out)
            feel(.love, 0.5 + 0.4 * a.intensity, t: t, out: &out)
        case .apology:
            m.p += 0.25 * k
            soothe(t: t, out: &out)
            feel(.shy, 0.4 + 0.3 * a.intensity, t: t, out: &out)
        case .thanks:
            m.p += 0.25 * k; m.d += 0.1 * k
            feel(.happy, 0.4 + 0.4 * a.intensity, t: t, out: &out)
        case .goodbye:
            // Never argue with a goodbye: a warm, small reaction and nothing more.
            m.a -= 0.1 * k
            state.speech.pending.removeAll()
            feel(.happy, 0.35, t: t, out: &out)
        case .unknown:
            break
        }
        m.p = pixieClamp(m.p, -1, 1)
        m.a = pixieClamp(m.a, -1, 1)
        m.d = pixieClamp(m.d, -1, 1)
        state.needs.mood = m
        return out
    }

    // MARK: Obey (the user always wins, immediately)

    public mutating func obey(_ o: PetObeyData, ctx: PetContext, now: Date) -> [PetOutput] {
        var out: [PetOutput] = []
        let t = now.timeIntervalSince1970
        let until: Double? = o.until.map { $0 / 1000 }
        switch o.instruction {
        case .quiet:
            state.obey.quietUntil = max(until ?? t + 2 * 3600, t)
            state.speech.pending.removeAll()
            state.attention.ladder = 0
            state.attention.snoozeUntil = state.obey.quietUntil
        case .noGossip:
            state.obey.gossipOverride = false
            state.speech.pending.removeAll { $0.intent == .gossip }
        case .gossipOK:
            state.obey.gossipOverride = true
        case .sleep:
            state.obey.sleepUntil = until ?? t + 8 * 3600
            state.speech.pending.removeAll()
            enterPhase(.asleep, t: t, out: &out)
        case .lessNeedy:
            state.obey.lessNeedy = min(1, max(state.obey.lessNeedy, state.knowledge.profile.less_needy) + 0.3)
            state.obey.talkBoost = 0
            state.attention.ladder = 0
            state.attention.snoozeUntil = t + 60 * 60
            state.speech.pending.removeAll { $0.intent == .playfulBid || $0.intent == .sulkLine }
        case .moreChatty:
            state.obey.lessNeedy = 0
            state.obey.talkBoost = min(1, state.obey.talkBoost + 0.25)
            state.obey.quietUntil = 0
            state.speech.threshold = max(0.3, state.speech.threshold - 0.08)
            state.speech.pausedUntil = 0
        case .notNow:
            let u = max(until ?? t + 60 * 60, t)
            state.attention.ladder = 0
            state.attention.snoozeUntil = u
            state.obey.quietUntil = max(state.obey.quietUntil, min(u, t + 30 * 60))
            state.speech.pending.removeAll()
        case .stop:
            state.attention.ladder = 0
            state.attention.snoozeUntil = t + 30 * 60
            state.obey.quietUntil = max(state.obey.quietUntil, until ?? t + 30 * 60)
            state.obey.calmUntil = t + 10 * 60
            state.speech.pending.removeAll()
            if !isResting && state.life.phase != .waking {
                setBehaviour(.idleBreathe, t: t, hold: 20, out: &out)
            }
        case .unknown:
            return out
        }
        if o.pout && !ctx.inCall && !isResting {
            out.append(.cue(.pout))
        }
        return out
    }

    // MARK: Speech

    mutating func queue(_ intent: PetIntent, thoughtID: String? = nil, hint: String? = nil, desire: Double, ttl: Double, t: Double) {
        state.speech.pending.removeAll { $0.intent == intent && $0.thoughtID == thoughtID }
        state.speech.pending.append(PetPendingLine(intent: intent, thoughtID: thoughtID, hint: hint, desire: desire, expiresAt: t + ttl))
        if state.speech.pending.count > 8 { state.speech.pending.removeFirst(state.speech.pending.count - 8) }
    }

    /// Why Pixie must not start talking now (nil = allowed).
    public func speechBlocker(_ ctx: PetContext, now: Date) -> String? {
        let t = now.timeIntervalSince1970
        let prof = state.knowledge.profile
        if !ctx.present { return "away" }
        if ctx.inCall { return "call" }
        if ctx.activity == .video { return "video" }
        if ctx.calendarBusy { return "busy" }
        if isResting { return "resting" }
        if t * 1000 < prof.quiet_until || t < state.obey.quietUntil { return "quiet" }
        let hour = localHour(now)
        if prof.quiet_when.contains(where: { $0.covers(hour: hour, activity: ctx.activity) }) { return "quiet_when" }
        if t < state.speech.pausedUntil { return "ignored" }
        if dailyLineCap <= 0 { return "talk_scale" }
        if state.speech.bubble != nil { return "bubble_open" }
        if state.speech.awaitingSince > 0 && t - state.speech.awaitingSince < 60 { return "awaiting" }
        return nil
    }

    /// App switch or a short idle pause.
    public func isNaturalBreak(_ ctx: PetContext) -> Bool {
        ctx.secondsSinceAppSwitch <= 30 || (ctx.idleSeconds >= 8 && ctx.idleSeconds <= 180)
    }

    /// Spacing and per-hour/day caps for one more line of this intent.
    public func capsAllow(_ intent: PetIntent, now: Date) -> Bool {
        let t = now.timeIntervalSince1970
        let sp = state.speech
        if t - max(sp.lastAskAt, sp.lastShownAt) < PetEngine.minLineGap { return false }
        if sp.shownTimes.filter({ t - $0 < 3600 }).count >= 2 { return false }
        if sp.linesToday >= dailyLineCap { return false }
        switch intent {
        case .gossip:
            if !gossipEnabled || sp.gossipToday >= 2 { return false }
        case .sulkLine, .rant:
            if sp.theatricalToday >= 1 { return false }
        case .greetMorning, .playfulBid, .world, .callback, .sleepy, .weather, .reunion, .lateNight, .reaction,
             .waking, .ate:
            break
        }
        return true
    }

    /// Opportunities that come from time and surroundings rather than discrete events.
    mutating func noticeMoments(_ ctx: PetContext, now: Date) {
        let t = now.timeIntervalSince1970
        guard !isResting, ctx.present else { return }
        // Sunset outside the "window".
        if nearSunset(now) {
            let key = dayKey(now)
            if state.life.sunsetDay != key {
                state.life.sunsetDay = key
                queue(.weather, hint: "the sun is setting", desire: 0.5, ttl: 20 * 60, t: t)
            }
        }
        // Drowsy company: the user is still working past bedtime.
        if state.life.phase == .sleepy && !isAwakeHour(localHour(now)) && (ctx.activity == .coding || ctx.typing != PetTypingRate.none) {
            let key = nightKey(now)
            if state.life.lateNightKey != key {
                state.life.lateNightKey = key
                queue(.lateNight, desire: 0.55, ttl: 30 * 60, t: t)
            }
        }
        // Thought reservoir: something to share when bored and the user is free.
        if state.speech.pending.isEmpty && ctx.free && state.life.phase == .awake && state.needs.boredom > 0.35
            && t - state.speech.lastThoughtCheckAt >= 120 {
            state.speech.lastThoughtCheckAt = t
            let used = Set(state.speech.usedThoughts)
            let candidates = state.knowledge.thoughts.filter { th in
                if used.contains(th.id) { return false }
                if let exp = th.expires_at, exp / 1000 <= t { return false }
                switch th.kind {
                case .gossip: return gossipEnabled && state.speech.gossipToday < 2
                case .world, .callback: return true
                case .other: return false
                }
            }
            if let best = candidates.max(by: { $0.salience < $1.salience }) {
                let intent: PetIntent
                let base: Double
                switch best.kind {
                case .gossip: intent = .gossip; base = 0.45
                case .callback: intent = .callback; base = 0.4
                case .world, .other: intent = .world; base = 0.35
                }
                queue(intent, thoughtID: best.id, desire: base + 0.4 * best.salience, ttl: 5 * 60, t: t)
            }
        }
    }

    mutating func considerSpeaking(_ ctx: PetContext, now: Date, out: inout [PetOutput]) {
        let t = now.timeIntervalSince1970
        state.speech.pending.removeAll { $0.expiresAt <= t }
        guard !state.speech.pending.isEmpty else { return }
        guard speechBlocker(ctx, now: now) == nil, isNaturalBreak(ctx) else { return }

        let prof = state.knowledge.profile
        let scale = 0.75 + 0.5 * traits.chattiness
        // The strongest wish the caps still allow; the rest wait until they expire.
        var best: Int? = nil
        for i in state.speech.pending.indices where capsAllow(state.speech.pending[i].intent, now: now) {
            if let b = best, state.speech.pending[b].desire >= state.speech.pending[i].desire { continue }
            best = i
        }
        guard let idx = best else { return }
        let item = state.speech.pending.remove(at: idx)
        let desire = item.desire * scale + 0.1 * prof.day_mood
        // Not strong enough for this user's threshold: the moment passes silently.
        guard desire >= state.speech.threshold else { return }

        // A hinted moment (weather change, sunset…) is about something specific: let the brain voice it.
        // The local bank is only for hint-less routine moments (or intents pet.speak cannot carry).
        let useBank = item.hint == nil || !item.intent.brainVoiced
        if useBank, item.intent.isRoutine, let bank = state.knowledge.lines[item.intent.rawValue], !bank.isEmpty {
            let r = state.rng.unit()
            let i = min(bank.count - 1, Int(r * Double(bank.count)))
            recordShown(intent: item.intent, thoughtID: nil, t: t)
            out.append(.localLine(bank[i], intent: item.intent))
        } else if item.intent.brainVoiced {
            state.speech.lastAskAt = t
            state.speech.awaitingSince = t
            if let id = item.thoughtID { markThoughtUsed(id) }
            out.append(.speak(PetSpeakData(intent: item.intent.rawValue, thought_id: item.thoughtID, hint: item.hint)))
        }
    }

    mutating func markThoughtUsed(_ id: String) {
        state.speech.usedThoughts.append(id)
        if state.speech.usedThoughts.count > 60 {
            state.speech.usedThoughts.removeFirst(state.speech.usedThoughts.count - 60)
        }
    }

    mutating func recordShown(intent: PetIntent, thoughtID: String?, t: Double) {
        var sp = state.speech
        sp.lastShownAt = t
        sp.awaitingSince = 0
        sp.shownTimes = sp.shownTimes.filter { t - $0 < 3600 } + [t]
        sp.linesToday += 1
        switch intent {
        case .gossip: sp.gossipToday += 1
        case .sulkLine, .rant: sp.theatricalToday += 1
        case .greetMorning, .playfulBid, .world, .callback, .sleepy, .weather, .reunion, .lateNight, .reaction,
             .waking, .ate:
            break
        }
        sp.bubble = PetShownBubble(intent: intent, thoughtID: thoughtID, shownAt: t)
        state.speech = sp
    }

    /// The brain answered a `pet.speak`. `said` is false when it declined (`say: ""`).
    public mutating func speakAnswered(_ req: PetSpeakData, said: Bool, now: Date) -> [PetOutput] {
        let t = now.timeIntervalSince1970
        state.speech.awaitingSince = 0
        guard said, let intent = PetIntent(rawValue: req.intent) else { return [] }
        recordShown(intent: intent, thoughtID: req.thought_id, t: t)
        if intent == .gossip { return [PetOutput.cue(.whisper)] }
        return []
    }

    /// The user sent a chat message: a proactive bubble shown in the last 2 minutes counts as replied.
    public mutating func userChatted(now: Date) -> [PetOutput] {
        let t = now.timeIntervalSince1970
        guard let b = state.speech.bubble, t - b.shownAt <= PetEngine.replyWindow else { return [] }
        state.speech.bubble = nil
        state.speech.threshold = max(0.3, state.speech.threshold - 0.05)
        state.speech.consecutiveIgnored = 0
        return [.event(PetEventData(kind: .bubbleReplied, intent: b.intent.rawValue, thought_id: b.thoughtID))]
    }

    /// The user closed the proactive bubble.
    public mutating func bubbleDismissed(now: Date) -> [PetOutput] {
        guard let b = state.speech.bubble else { return [] }
        state.speech.bubble = nil
        state.speech.threshold = min(0.95, state.speech.threshold + 0.07)
        return [.event(PetEventData(kind: .bubbleDismissed, intent: b.intent.rawValue, thought_id: b.thoughtID))]
    }

    mutating func resolveBubble(t: Double, out: inout [PetOutput]) {
        guard let b = state.speech.bubble, t - b.shownAt > PetEngine.replyWindow else { return }
        state.speech.bubble = nil
        state.speech.threshold = min(0.95, state.speech.threshold + 0.04)
        state.speech.consecutiveIgnored += 1
        if state.speech.consecutiveIgnored >= 2 {
            state.speech.consecutiveIgnored = 0
            state.speech.pausedUntil = t + PetEngine.ignorePause
        }
        out.append(.event(PetEventData(kind: .bubbleIgnored, intent: b.intent.rawValue, thought_id: b.thoughtID)))
    }

    // MARK: pet.state

    public func snapshot() -> PetStateData {
        let n = state.needs
        return PetStateData(phase: state.life.phase,
                            sleep_pressure: pixieRound2(n.sleepPressure),
                            energy: pixieRound2(n.energy),
                            social: pixieRound2(n.social),
                            boredom: pixieRound2(n.boredom),
                            snack: pixieRound2(n.snack),
                            mood: PetMood(p: pixieRound2(n.mood.p), a: pixieRound2(n.mood.a), d: pixieRound2(n.mood.d)),
                            emotion: state.feeling.emotion,
                            ladder: state.attention.ladder)
    }

    mutating func maybeSendState(t: Double, out: inout [PetOutput]) {
        let key = "\(state.life.phase.rawValue)|\(state.attention.ladder)|\(state.feeling.emotion.rawValue)"
        let since = t - state.telemetry.lastStateSentAt
        if (key != state.telemetry.lastStateKey && since >= PetEngine.stateMinGap) || since >= PetEngine.stateHeartbeat {
            state.telemetry.lastStateKey = key
            state.telemetry.lastStateSentAt = t
            out.append(.state(snapshot()))
        }
    }

    /// Forces the next tick to send `pet.state` (e.g. after reconnecting).
    public mutating func resendState() {
        state.telemetry.lastStateSentAt = 0
    }
}
