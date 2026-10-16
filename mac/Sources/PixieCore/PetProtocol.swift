import Foundation

// Pet life wire shapes (PROTOCOL.md §4). Every decoder here is tolerant: unknown fields are ignored,
// unknown enum values fall back, wrong types fall back to defaults, malformed list entries are dropped.

// MARK: - Decoding helpers

extension KeyedDecodingContainer {
    func pixieDouble(_ key: K) -> Double? {
        if let d = try? decode(Double.self, forKey: key) { return d }
        if let s = try? decode(String.self, forKey: key) { return Double(s) }
        return nil
    }

    func pixieBool(_ key: K) -> Bool? {
        try? decode(Bool.self, forKey: key)
    }

    func pixieString(_ key: K) -> String? {
        try? decode(String.self, forKey: key)
    }
}

func pixieClamp(_ x: Double, _ lo: Double = 0, _ hi: Double = 1) -> Double {
    if x.isNaN { return lo }
    return max(lo, min(hi, x))
}

/// Rounds to 2 decimals for the wire (`"sleep_pressure": 0.42`).
func pixieRound2(_ x: Double) -> Double {
    (x * 100).rounded() / 100
}

// MARK: - pet.profile

public struct PetTraits: Codable, Equatable, Sendable {
    public var curiosity: Double = 0.6
    public var chattiness: Double = 0.5
    public var agreeableness: Double = 0.7
    public var sensitivity: Double = 0.4
    public var sass: Double = 0.5
    public var clinginess: Double = 0.4

    public init() {}

    enum CodingKeys: String, CodingKey { case curiosity, chattiness, agreeableness, sensitivity, sass, clinginess }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = PetTraits()
        curiosity = pixieClamp(c.pixieDouble(.curiosity) ?? d.curiosity)
        chattiness = pixieClamp(c.pixieDouble(.chattiness) ?? d.chattiness)
        agreeableness = pixieClamp(c.pixieDouble(.agreeableness) ?? d.agreeableness)
        sensitivity = pixieClamp(c.pixieDouble(.sensitivity) ?? d.sensitivity)
        sass = pixieClamp(c.pixieDouble(.sass) ?? d.sass)
        clinginess = pixieClamp(c.pixieDouble(.clinginess) ?? d.clinginess)
    }
}

/// Learned daily rhythm in local decimal hours.
public struct PetRhythm: Codable, Equatable, Sendable {
    public var wake_hour: Double = 8.5
    public var sleep_hour: Double = 0.5
    public var lunch_hour: Double = 13.5
    public var dinner_hour: Double = 20.5

    public init() {}

    public init(wake_hour: Double, sleep_hour: Double, lunch_hour: Double = 13.5, dinner_hour: Double = 20.5) {
        self.wake_hour = wake_hour
        self.sleep_hour = sleep_hour
        self.lunch_hour = lunch_hour
        self.dinner_hour = dinner_hour
    }

    enum CodingKeys: String, CodingKey { case wake_hour, sleep_hour, lunch_hour, dinner_hour }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = PetRhythm()
        wake_hour = PetRhythm.hour(c.pixieDouble(.wake_hour)) ?? d.wake_hour
        sleep_hour = PetRhythm.hour(c.pixieDouble(.sleep_hour)) ?? d.sleep_hour
        lunch_hour = PetRhythm.hour(c.pixieDouble(.lunch_hour)) ?? d.lunch_hour
        dinner_hour = PetRhythm.hour(c.pixieDouble(.dinner_hour)) ?? d.dinner_hour
    }

    private static func hour(_ v: Double?) -> Double? {
        guard let v, v.isFinite, v >= 0, v < 24 else { return nil }
        return v
    }
}

/// A "keep quiet" rule from `pet.profile.quiet_when`. Accepted shapes (all optional, tolerant):
/// a string naming an activity (`"meeting"`, `"coding"`), or an object
/// `{ "from_hour": 22, "to_hour": 7 }` (local hours, wraps past midnight) and/or `{ "activity": "video" }`.
public struct PetQuietWindow: Codable, Equatable, Sendable {
    public var activity: String?
    public var from_hour: Double?
    public var to_hour: Double?

    public init(activity: String? = nil, from_hour: Double? = nil, to_hour: Double? = nil) {
        self.activity = activity
        self.from_hour = from_hour
        self.to_hour = to_hour
    }

    public func covers(hour: Double, activity current: Activity) -> Bool {
        if let a = activity, !a.isEmpty, a == current.rawValue { return true }
        if let f = from_hour, let t = to_hour, f != t {
            if f < t { return hour >= f && hour < t }
            return hour >= f || hour < t
        }
        return false
    }

    static func parse(_ value: JSONValue?) -> [PetQuietWindow] {
        guard let value else { return [] }
        let items: [JSONValue]
        switch value {
        case .array(let a): items = a
        case .object, .string: items = [value]
        default: return []
        }
        var out: [PetQuietWindow] = []
        for item in items {
            switch item {
            case .string(let s):
                let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
                if !t.isEmpty { out.append(PetQuietWindow(activity: t)) }
            case .object:
                let w = PetQuietWindow(activity: item["activity"]?.stringValue,
                                       from_hour: item["from_hour"]?.doubleValue ?? item["from"]?.doubleValue,
                                       to_hour: item["to_hour"]?.doubleValue ?? item["to"]?.doubleValue)
                if w.activity != nil || (w.from_hour != nil && w.to_hour != nil) { out.append(w) }
            default:
                continue
            }
        }
        return out
    }
}

public struct PetProfileData: Codable, Equatable, Sendable {
    public var traits = PetTraits()
    public var bond: Double = 0
    public var familiarity: Double = 0
    public var day_mood: Double = 0
    public var first_week: Bool = false
    /// Multiplies the Mac's speech caps.
    public var talk_scale: Double = 1
    public var less_needy: Double = 0
    /// Unix ms; 0 = not quiet.
    public var quiet_until: Double = 0
    public var quiet_when: [PetQuietWindow] = []
    public var gossip_enabled: Bool = true
    public var rhythm = PetRhythm()

    public init() {}

    enum CodingKeys: String, CodingKey {
        case traits, bond, familiarity, day_mood, first_week, talk_scale, less_needy, quiet_until, quiet_when, gossip_enabled, rhythm
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = PetProfileData()
        traits = (try? c.decode(PetTraits.self, forKey: .traits)) ?? d.traits
        bond = c.pixieDouble(.bond) ?? d.bond
        familiarity = pixieClamp(c.pixieDouble(.familiarity) ?? d.familiarity)
        day_mood = pixieClamp(c.pixieDouble(.day_mood) ?? d.day_mood, -1, 1)
        first_week = c.pixieBool(.first_week) ?? d.first_week
        talk_scale = pixieClamp(c.pixieDouble(.talk_scale) ?? d.talk_scale, 0, 2)
        less_needy = pixieClamp(c.pixieDouble(.less_needy) ?? d.less_needy)
        quiet_until = max(0, c.pixieDouble(.quiet_until) ?? 0)
        quiet_when = PetQuietWindow.parse(try? c.decode(JSONValue.self, forKey: .quiet_when))
        gossip_enabled = c.pixieBool(.gossip_enabled) ?? d.gossip_enabled
        rhythm = (try? c.decode(PetRhythm.self, forKey: .rhythm)) ?? d.rhythm
    }
}

// MARK: - env.update

public enum PetWeatherCondition: String, Codable, CaseIterable, Sendable, TolerantStringEnum {
    case clear, cloudy, rain, storm, fog, snow, hot, other
    public static var fallback: PetWeatherCondition { .other }
    public init(from decoder: Decoder) throws {
        self = PetWeatherCondition.tolerant(try? decoder.singleValueContainer().decode(String.self))
    }
}

public struct PetWeather: Codable, Equatable, Sendable {
    public var temp_c: Double?
    public var condition: PetWeatherCondition
    public var is_day: Bool?

    public init(temp_c: Double? = nil, condition: PetWeatherCondition = .clear, is_day: Bool? = nil) {
        self.temp_c = temp_c
        self.condition = condition
        self.is_day = is_day
    }

    enum CodingKeys: String, CodingKey { case temp_c, condition, is_day }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        temp_c = c.pixieDouble(.temp_c)
        condition = (try? c.decode(PetWeatherCondition.self, forKey: .condition)) ?? .other
        is_day = c.pixieBool(.is_day)
    }
}

public struct PetHoliday: Codable, Equatable, Sendable {
    public var name: String?
    public init(name: String? = nil) {
        self.name = name
    }
}

public struct PetEnvData: Codable, Equatable, Sendable {
    public var weather: PetWeather?
    /// Unix ms.
    public var sunrise: Double?
    public var sunset: Double?
    public var holiday: PetHoliday?
    public var weekend: Bool = false
    public var tz: String?

    public init(weather: PetWeather? = nil, sunrise: Double? = nil, sunset: Double? = nil, holiday: PetHoliday? = nil, weekend: Bool = false, tz: String? = nil) {
        self.weather = weather
        self.sunrise = sunrise
        self.sunset = sunset
        self.holiday = holiday
        self.weekend = weekend
        self.tz = tz
    }

    enum CodingKeys: String, CodingKey { case weather, sunrise, sunset, holiday, weekend, tz }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        weather = try? c.decode(PetWeather.self, forKey: .weather)
        sunrise = c.pixieDouble(.sunrise)
        sunset = c.pixieDouble(.sunset)
        holiday = try? c.decode(PetHoliday.self, forKey: .holiday)
        weekend = c.pixieBool(.weekend) ?? false
        tz = c.pixieString(.tz)
    }

    /// "hot" condition or ≥ 32 °C.
    public var isHot: Bool {
        guard let w = weather else { return false }
        return w.condition == .hot || (w.temp_c ?? 0) >= 32
    }
}

// MARK: - pet.thoughts

public enum PetThoughtKind: String, Codable, CaseIterable, Sendable, TolerantStringEnum {
    case gossip, world, callback, other
    public static var fallback: PetThoughtKind { .other }
    public init(from decoder: Decoder) throws {
        self = PetThoughtKind.tolerant(try? decoder.singleValueContainer().decode(String.self))
    }
}

public struct PetThought: Codable, Equatable, Sendable {
    public var id: String
    public var kind: PetThoughtKind
    public var salience: Double
    /// Unix ms, nil = no expiry.
    public var expires_at: Double?

    public init(id: String, kind: PetThoughtKind, salience: Double, expires_at: Double? = nil) {
        self.id = id
        self.kind = kind
        self.salience = salience
        self.expires_at = expires_at
    }

    enum CodingKeys: String, CodingKey { case id, kind, salience, expires_at }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = (try? c.decode(PetThoughtKind.self, forKey: .kind)) ?? .other
        salience = pixieClamp(c.pixieDouble(.salience) ?? 0.5)
        expires_at = c.pixieDouble(.expires_at)
    }
}

public struct PetThoughtsData: Codable, Equatable, Sendable {
    public var items: [PetThought]

    public init(items: [PetThought]) {
        self.items = items
    }

    enum CodingKeys: String, CodingKey { case items }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let raw = (try? c.decode([JSONValue].self, forKey: .items)) ?? []
        items = raw.compactMap { v -> PetThought? in
            guard let t = v.decode(PetThought.self), !t.id.isEmpty else { return nil }
            return t
        }
    }
}

// MARK: - pet.lines

public struct PetLine: Codable, Equatable, Sendable {
    public var text: String
    public var emotion: Emotion
    public var gesture: GestureKind

    public init(text: String, emotion: Emotion = .neutral, gesture: GestureKind = GestureKind.none) {
        self.text = text
        self.emotion = emotion
        self.gesture = gesture
    }

    enum CodingKeys: String, CodingKey { case text, emotion, gesture }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = try c.decode(String.self, forKey: .text)
        emotion = (try? c.decode(Emotion.self, forKey: .emotion)) ?? .neutral
        gesture = (try? c.decode(GestureKind.self, forKey: .gesture)) ?? GestureKind.none
    }
}

public struct PetLinesData: Codable, Equatable, Sendable {
    /// intent → lines. Intents with no usable line are dropped.
    public var lines: [String: [PetLine]]

    public init(lines: [String: [PetLine]]) {
        self.lines = lines
    }

    enum CodingKeys: String, CodingKey { case lines }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let raw = (try? c.decode([String: JSONValue].self, forKey: .lines)) ?? [:]
        var out: [String: [PetLine]] = [:]
        for (intent, value) in raw {
            guard case .array(let arr) = value else { continue }
            let ls = arr.compactMap { v -> PetLine? in
                guard let l = v.decode(PetLine.self) else { return nil }
                let t = l.text.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !t.isEmpty else { return nil }
                return PetLine(text: t, emotion: l.emotion, gesture: l.gesture)
            }
            if !ls.isEmpty { out[intent] = ls }
        }
        lines = out
    }
}

// MARK: - pet.obey / pet.appraisal

public enum PetObeyInstruction: String, Codable, CaseIterable, Sendable, TolerantStringEnum {
    case quiet, sleep, stop, unknown
    case noGossip = "no_gossip"
    case gossipOK = "gossip_ok"
    case lessNeedy = "less_needy"
    case moreChatty = "more_chatty"
    case notNow = "not_now"
    public static var fallback: PetObeyInstruction { .unknown }
    public init(from decoder: Decoder) throws {
        self = PetObeyInstruction.tolerant(try? decoder.singleValueContainer().decode(String.self))
    }
}

public struct PetObeyData: Codable, Equatable, Sendable {
    public var instruction: PetObeyInstruction
    /// Unix ms or nil.
    public var until: Double?
    public var pout: Bool

    public init(instruction: PetObeyInstruction, until: Double? = nil, pout: Bool = false) {
        self.instruction = instruction
        self.until = until
        self.pout = pout
    }

    enum CodingKeys: String, CodingKey { case instruction, until, pout }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        instruction = (try? c.decode(PetObeyInstruction.self, forKey: .instruction)) ?? .unknown
        until = c.pixieDouble(.until)
        pout = c.pixieBool(.pout) ?? false
    }
}

public enum PetAppraisalKind: String, Codable, CaseIterable, Sendable, TolerantStringEnum {
    case praise, scold, tease, affection, apology, thanks, goodbye, unknown
    public static var fallback: PetAppraisalKind { .unknown }
    public init(from decoder: Decoder) throws {
        self = PetAppraisalKind.tolerant(try? decoder.singleValueContainer().decode(String.self))
    }
}

public struct PetAppraisalData: Codable, Equatable, Sendable {
    public var event: PetAppraisalKind
    public var intensity: Double

    public init(event: PetAppraisalKind, intensity: Double = 0.5) {
        self.event = event
        self.intensity = intensity
    }

    enum CodingKeys: String, CodingKey { case event, intensity }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        event = (try? c.decode(PetAppraisalKind.self, forKey: .event)) ?? .unknown
        intensity = pixieClamp(c.pixieDouble(.intensity) ?? 0.5)
    }
}

// MARK: - Device → brain: pet.state, pet.event, pet.speak

public enum PetPhase: String, Codable, CaseIterable, Sendable, TolerantStringEnum {
    case awake, napping, sleepy, asleep, waking
    public static var fallback: PetPhase { .awake }
    public init(from decoder: Decoder) throws {
        self = PetPhase.tolerant(try? decoder.singleValueContainer().decode(String.self))
    }
}

/// Pleasure / arousal / dominance, each −1 … 1.
public struct PetMood: Codable, Equatable, Sendable {
    public var p: Double
    public var a: Double
    public var d: Double
    public init(p: Double = 0, a: Double = 0, d: Double = 0) {
        self.p = p
        self.a = a
        self.d = d
    }
}

public struct PetStateData: Codable, Equatable, Sendable {
    public var phase: PetPhase
    public var sleep_pressure: Double
    public var energy: Double
    public var social: Double
    public var boredom: Double
    public var snack: Double
    public var mood: PetMood
    public var emotion: Emotion
    public var ladder: Int

    public init(phase: PetPhase, sleep_pressure: Double, energy: Double, social: Double, boredom: Double, snack: Double, mood: PetMood, emotion: Emotion, ladder: Int) {
        self.phase = phase
        self.sleep_pressure = sleep_pressure
        self.energy = energy
        self.social = social
        self.boredom = boredom
        self.snack = snack
        self.mood = mood
        self.emotion = emotion
        self.ladder = ladder
    }
}

public enum PetEventKind: String, Codable, CaseIterable, Sendable, TolerantStringEnum {
    case petted, poked, fed, carried, woke, ate, sulked, reunion, unknown
    case bubbleReplied = "bubble_replied"
    case bubbleDismissed = "bubble_dismissed"
    case bubbleIgnored = "bubble_ignored"
    case fellAsleep = "fell_asleep"
    case madeUp = "made_up"
    public static var fallback: PetEventKind { .unknown }
    public init(from decoder: Decoder) throws {
        self = PetEventKind.tolerant(try? decoder.singleValueContainer().decode(String.self))
    }
}

/// `pet.event`. Optional fields are omitted when nil (synthesized `encodeIfPresent`).
public struct PetEventData: Codable, Equatable, Sendable {
    public var kind: PetEventKind
    public var intent: String?
    public var thought_id: String?

    public init(kind: PetEventKind, intent: String? = nil, thought_id: String? = nil) {
        self.kind = kind
        self.intent = intent
        self.thought_id = thought_id
    }
}

/// Moments Pixie may want to say something about. The first group is voiced by the brain (`pet.speak`);
/// `waking` and `ate` only ever use the local `pet.lines` bank.
public enum PetIntent: String, Codable, CaseIterable, Sendable {
    case greetMorning = "greet_morning"
    case playfulBid = "playful_bid"
    case sulkLine = "sulk_line"
    case rant
    case gossip
    case world
    case callback
    case sleepy
    case weather
    case reunion
    case lateNight = "late_night"
    case reaction
    case waking
    case ate

    /// Routine moments use `pet.lines` when the bank has a line for them.
    public var isRoutine: Bool {
        switch self {
        case .sleepy, .waking, .ate, .weather, .reaction, .playfulBid: return true
        case .greetMorning, .sulkLine, .rant, .gossip, .world, .callback, .reunion, .lateNight: return false
        }
    }

    /// Whether `pet.speak` may carry this intent.
    public var brainVoiced: Bool {
        switch self {
        case .waking, .ate: return false
        case .greetMorning, .playfulBid, .sulkLine, .rant, .gossip, .world, .callback, .sleepy, .weather,
             .reunion, .lateNight, .reaction:
            return true
        }
    }
}

/// `pet.speak`. Optional fields are omitted when nil.
public struct PetSpeakData: Codable, Equatable, Sendable {
    public var intent: String
    public var thought_id: String?
    public var hint: String?

    public init(intent: String, thought_id: String? = nil, hint: String? = nil) {
        self.intent = intent
        self.thought_id = thought_id
        self.hint = hint
    }
}
