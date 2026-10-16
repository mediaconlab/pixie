import Foundation

// MARK: - Envelope (PROTOCOL.md §2)

public enum ProtocolConstants {
    /// Envelope framing version (`v`).
    public static let version = 1
    /// Wire contract version sent as `hello.protocol` (PROTOCOL.md §0).
    public static let protocolVersion = 1
    /// WebSocket close code the brain uses after `update_required`.
    public static let closeUpdateRequired = 4002
    public static let defaultUpdateMessage = "Please update Pixie to keep using it."
    public static let appVersion = "1.0.0"
    public static let maxFrameBytes = 1_048_576
    public static let pingInterval: TimeInterval = 30
    public static let offlineQueueCap = 100
}

/// `{ "v": 1, "id": "evt_...", "ts": 1760607720000, "type": "...", "data": { ... } }`
/// `data` stays as a JSONValue and is decoded lazily by `type` (see `IncomingEvent`).
public struct Envelope: Codable, Equatable, Sendable {
    public var v: Int
    public var id: String
    public var ts: Int64
    public var type: String
    public var data: JSONValue

    public init(v: Int = ProtocolConstants.version, id: String = Envelope.makeID(), ts: Int64 = Envelope.nowMillis(), type: String, data: JSONValue) {
        self.v = v
        self.id = id
        self.ts = ts
        self.type = type
        self.data = data
    }

    enum CodingKeys: String, CodingKey { case v, id, ts, type, data }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        v = (try? c.decode(Int.self, forKey: .v)) ?? ProtocolConstants.version
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        if let t = try? c.decode(Int64.self, forKey: .ts) {
            ts = t
        } else if let d = try? c.decode(Double.self, forKey: .ts) {
            ts = Int64(d)
        } else {
            ts = Envelope.nowMillis()
        }
        type = try c.decode(String.self, forKey: .type)
        data = (try? c.decode(JSONValue.self, forKey: .data)) ?? .object([:])
    }

    public static func nowMillis() -> Int64 {
        Int64((Date().timeIntervalSince1970 * 1000).rounded())
    }

    /// "evt_" + 20 random base36 chars (well under the 64-char limit).
    public static func makeID() -> String {
        let alphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")
        var s = "evt_"
        for _ in 0..<20 { s.append(alphabet[Int.random(in: 0..<alphabet.count)]) }
        return s
    }

    /// Builds an envelope from any Encodable payload.
    public static func make<T: Encodable>(_ type: String, _ payload: T) -> Envelope? {
        guard let bytes = try? JSONEncoder().encode(payload),
              let value = try? JSONDecoder().decode(JSONValue.self, from: bytes) else { return nil }
        return Envelope(type: type, data: value)
    }

    public func decodeData<T: Decodable>(_ type: T.Type) -> T? {
        data.decode(T.self)
    }

    public func jsonString() -> String? {
        guard let bytes = try? JSONEncoder().encode(self) else { return nil }
        return String(data: bytes, encoding: .utf8)
    }

    public static func parse(_ text: String) -> Envelope? {
        guard let bytes = text.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(Envelope.self, from: bytes)
    }
}

// MARK: - Tolerant enums

/// String-backed enums that fall back to a default for unknown values from a newer brain.
/// Each enum implements `init(from:)` explicitly (calling `tolerant`) so there is no ambiguity with the
/// standard library's default RawRepresentable Codable implementation; `encode(to:)` uses that default.
public protocol TolerantStringEnum: RawRepresentable where RawValue == String {
    static var fallback: Self { get }
}

public extension TolerantStringEnum {
    static func tolerant(_ raw: String?) -> Self {
        guard let raw else { return fallback }
        return Self(rawValue: raw) ?? fallback
    }
}

public enum Emotion: String, Codable, CaseIterable, Sendable, TolerantStringEnum {
    case neutral, happy, excited, curious, concerned, sleepy, proud, shy, annoyed, sad, surprised, love, thinking
    public static var fallback: Emotion { .neutral }
    public init(from decoder: Decoder) throws {
        self = Emotion.tolerant(try? decoder.singleValueContainer().decode(String.self))
    }
}

public enum GestureKind: String, Codable, CaseIterable, Sendable, TolerantStringEnum {
    case none, wave, nod, shake, bounce, spin, hide, dance, jump
    case leanIn = "lean_in"
    public static var fallback: GestureKind { GestureKind.none }
    public init(from decoder: Decoder) throws {
        self = GestureKind.tolerant(try? decoder.singleValueContainer().decode(String.self))
    }
}

public enum Gaze: String, Codable, CaseIterable, Sendable, TolerantStringEnum {
    case user, screen, phone, away, cursor
    public static var fallback: Gaze { .user }
    public init(from decoder: Decoder) throws {
        self = Gaze.tolerant(try? decoder.singleValueContainer().decode(String.self))
    }
}

public enum PixieVoicePace: String, Codable, CaseIterable, Sendable, TolerantStringEnum {
    case slow, normal, fast
    public static var fallback: PixieVoicePace { .normal }
    public init(from decoder: Decoder) throws {
        self = PixieVoicePace.tolerant(try? decoder.singleValueContainer().decode(String.self))
    }
}

public enum Activity: String, Codable, CaseIterable, Sendable, TolerantStringEnum {
    case idle, coding, meeting, video, browsing, away
    public static var fallback: Activity { .idle }
    public init(from decoder: Decoder) throws {
        self = Activity.tolerant(try? decoder.singleValueContainer().decode(String.self))
    }
}

// MARK: - Device → brain payloads

public struct HelloData: Codable, Equatable, Sendable {
    public var kind: String
    public var name: String
    /// Encoded as `"protocol"` (a Swift keyword, hence the different property name).
    public var protocolVersion: Int
    public var app_version: String
    public var capabilities: [String]
    public init(kind: String = "mac", name: String, app_version: String = ProtocolConstants.appVersion, capabilities: [String] = ["screen", "audio", "voice", "notify"], protocolVersion: Int = ProtocolConstants.protocolVersion) {
        self.kind = kind
        self.name = name
        self.protocolVersion = protocolVersion
        self.app_version = app_version
        self.capabilities = capabilities
    }

    enum CodingKeys: String, CodingKey {
        case kind, name, app_version, capabilities
        case protocolVersion = "protocol"
    }
}

public struct UserSayData: Codable, Equatable, Sendable {
    public var text: String
    public var via: String // "typed" | "voice"
    public init(text: String, via: String) {
        self.text = text
        self.via = via
    }
}

public struct StateUpdateData: Codable, Equatable, Sendable {
    public var activity: Activity
    public var front_app: String
    public var focus_mode: Bool
    public var watching: Bool
    public init(activity: Activity, front_app: String, focus_mode: Bool, watching: Bool) {
        self.activity = activity
        self.front_app = front_app
        self.focus_mode = focus_mode
        self.watching = watching
    }
}

public struct ScreenFrameData: Codable, Equatable, Sendable {
    public var image: String
    public var width: Int
    public var height: Int
    public var front_app: String
    public var window: String
    public var ocr: String
    public var reason: String // "periodic" | "asked" | "watch"
    public init(image: String, width: Int, height: Int, front_app: String, window: String, ocr: String, reason: String) {
        self.image = image
        self.width = width
        self.height = height
        self.front_app = front_app
        self.window = window
        self.ocr = ocr
        self.reason = reason
    }
}

public struct AudioTranscriptData: Codable, Equatable, Sendable {
    public var text: String
    public var seconds: Int
    public var source: String // "system" | "mic"
    public init(text: String, seconds: Int, source: String) {
        self.text = text
        self.seconds = seconds
        self.source = source
    }
}

public struct UserFeedbackData: Codable, Equatable, Sendable {
    public var proposal_id: String
    public var verdict: String // "approve" | "reject" | "never"
    public var edited_text: String?
    /// PROTOCOL.md §5: "contact" | "group" | "like_this", used with `verdict: "never"`. Omitted when nil.
    public var scope: String?
    public init(proposal_id: String, verdict: String, edited_text: String? = nil, scope: String? = nil) {
        self.proposal_id = proposal_id
        self.verdict = verdict
        self.edited_text = edited_text
        self.scope = scope
    }

    // Omit optional fields entirely when nil (they are optional in the protocol).
    enum CodingKeys: String, CodingKey { case proposal_id, verdict, edited_text, scope }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        proposal_id = try c.decode(String.self, forKey: .proposal_id)
        verdict = try c.decode(String.self, forKey: .verdict)
        edited_text = try? c.decode(String.self, forKey: .edited_text)
        scope = try? c.decode(String.self, forKey: .scope)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(proposal_id, forKey: .proposal_id)
        try c.encode(verdict, forKey: .verdict)
        try c.encodeIfPresent(edited_text, forKey: .edited_text)
        try c.encodeIfPresent(scope, forKey: .scope)
    }
}

/// Scopes for `user.feedback` with `verdict: "never"` (PROTOCOL.md §5).
public enum FeedbackScope {
    public static let contact = "contact"
    public static let group = "group"
    public static let likeThis = "like_this"
}

public struct ExecResultData: Codable, Equatable, Sendable {
    public var proposal_id: String
    public var ok: Bool
    public var error: String?
    public init(proposal_id: String, ok: Bool, error: String? = nil) {
        self.proposal_id = proposal_id
        self.ok = ok
        self.error = error
    }
}

// MARK: - Brain → device payloads

public struct PixieVoiceSpec: Codable, Equatable, Sendable {
    public var pace: PixieVoicePace
    public var pitch: Int
    public init(pace: PixieVoicePace = .normal, pitch: Int = 0) {
        self.pace = pace
        self.pitch = pitch
    }
    enum CodingKeys: String, CodingKey { case pace, pitch }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pace = (try? c.decode(PixieVoicePace.self, forKey: .pace)) ?? .normal
        if let i = try? c.decode(Int.self, forKey: .pitch) {
            pitch = i
        } else if let d = try? c.decode(Double.self, forKey: .pitch) {
            pitch = Int(d.rounded())
        } else {
            pitch = 0
        }
        pitch = max(-2, min(2, pitch))
    }
}

public struct Performance: Codable, Equatable, Sendable {
    public var say: String
    public var emotion: Emotion
    public var intensity: Double
    public var gesture: GestureKind
    public var gaze: Gaze
    public var voice: PixieVoiceSpec
    public var speak: Bool
    public var reply_to: String?

    public init(say: String = "", emotion: Emotion = .neutral, intensity: Double = 0.5, gesture: GestureKind = GestureKind.fallback, gaze: Gaze = .user, voice: PixieVoiceSpec = PixieVoiceSpec(), speak: Bool = false, reply_to: String? = nil) {
        self.say = say
        self.emotion = emotion
        self.intensity = intensity
        self.gesture = gesture
        self.gaze = gaze
        self.voice = voice
        self.speak = speak
        self.reply_to = reply_to
    }

    enum CodingKeys: String, CodingKey { case say, emotion, intensity, gesture, gaze, voice, speak, reply_to }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        say = (try? c.decode(String.self, forKey: .say)) ?? ""
        emotion = (try? c.decode(Emotion.self, forKey: .emotion)) ?? .neutral
        let i = (try? c.decode(Double.self, forKey: .intensity)) ?? 0.5
        intensity = max(0, min(1, i))
        gesture = (try? c.decode(GestureKind.self, forKey: .gesture)) ?? GestureKind.fallback
        gaze = (try? c.decode(Gaze.self, forKey: .gaze)) ?? .user
        voice = (try? c.decode(PixieVoiceSpec.self, forKey: .voice)) ?? PixieVoiceSpec()
        speak = (try? c.decode(Bool.self, forKey: .speak)) ?? false
        reply_to = try? c.decode(String.self, forKey: .reply_to)
    }
}

public struct WelcomeData: Codable, Equatable, Sendable {
    public struct Persona: Codable, Equatable, Sendable {
        public var name: String?
    }
    public struct Mood: Codable, Equatable, Sendable {
        public var valence: Double?
        public var energy: Double?
    }
    public struct DeviceInfo: Codable, Equatable, Sendable {
        public var id: String?
        public var kind: String?
        public var name: String?
        public var online: Bool?
    }
    public var user_name: String?
    public var persona: Persona?
    public var mood: Mood?
    public var devices: [DeviceInfo]?
}

public struct NoticeData: Codable, Equatable, Sendable {
    public var kind: String?          // "call" | "message"
    public var from: String?
    public var preview: String?
    public var app: String?
    public var urgency: Double?
    public var summary: String?
    public var interrupt: Bool?
    public init(kind: String? = nil, from: String? = nil, preview: String? = nil, app: String? = nil, urgency: Double? = nil, summary: String? = nil, interrupt: Bool? = nil) {
        self.kind = kind
        self.from = from
        self.preview = preview
        self.app = app
        self.urgency = urgency
        self.summary = summary
        self.interrupt = interrupt
    }
}

public struct DigestItem: Codable, Equatable, Sendable {
    public var from: String?
    public var app: String?
    public var summary: String?
    public var urgency: Double?
    public var ts: Double?
    public init(from: String? = nil, app: String? = nil, summary: String? = nil, urgency: Double? = nil, ts: Double? = nil) {
        self.from = from
        self.app = app
        self.summary = summary
        self.urgency = urgency
        self.ts = ts
    }
}

public struct DigestData: Codable, Equatable, Sendable {
    public var items: [DigestItem]
}

/// One-tap "never" shortcut on a smart reply card (PROTOCOL.md §5).
public struct ProposalQuickAction: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var label: String

    public init(id: String, label: String) {
        self.id = id
        self.label = label
    }

    /// The `user.feedback` scope this action sends with `verdict: "never"`; nil for ids this app doesn't know.
    public var scope: String? {
        switch id {
        case "never_contact": return FeedbackScope.contact
        case "never_group": return FeedbackScope.group
        default: return nil
        }
    }
}

public struct ProposeData: Codable, Equatable, Sendable {
    public var proposal_id: String
    public var kind: String?
    public var title: String?
    public var detail: String?
    public var payload: JSONValue?
    public var executor: String?
    public var expires_at: Double?
    /// PROTOCOL.md §5: one line explaining why the card was shown.
    public var why: String?
    /// PROTOCOL.md §5: true for a labelled "trying this out" card.
    public var exploration: Bool?
    /// PROTOCOL.md §5: malformed entries are dropped; unknown ids are kept here (see `knownQuickActions`).
    public var quick_actions: [ProposalQuickAction]?

    public init(proposal_id: String, kind: String? = nil, title: String? = nil, detail: String? = nil, payload: JSONValue? = nil, executor: String? = nil, expires_at: Double? = nil, why: String? = nil, exploration: Bool? = nil, quick_actions: [ProposalQuickAction]? = nil) {
        self.proposal_id = proposal_id
        self.kind = kind
        self.title = title
        self.detail = detail
        self.payload = payload
        self.executor = executor
        self.expires_at = expires_at
        self.why = why
        self.exploration = exploration
        self.quick_actions = quick_actions
    }

    enum CodingKeys: String, CodingKey { case proposal_id, kind, title, detail, payload, executor, expires_at, why, exploration, quick_actions }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        proposal_id = try c.decode(String.self, forKey: .proposal_id)
        kind = try? c.decode(String.self, forKey: .kind)
        title = try? c.decode(String.self, forKey: .title)
        detail = try? c.decode(String.self, forKey: .detail)
        if let v = try? c.decode(JSONValue.self, forKey: .payload), v != .null {
            payload = v
        } else {
            payload = nil
        }
        executor = try? c.decode(String.self, forKey: .executor)
        expires_at = try? c.decode(Double.self, forKey: .expires_at)
        why = try? c.decode(String.self, forKey: .why)
        exploration = try? c.decode(Bool.self, forKey: .exploration)
        if let raw = try? c.decode([JSONValue].self, forKey: .quick_actions) {
            quick_actions = raw.compactMap { v -> ProposalQuickAction? in
                guard let id = v["id"]?.stringValue, !id.isEmpty,
                      let label = v["label"]?.stringValue, !label.isEmpty else { return nil }
                return ProposalQuickAction(id: id, label: label)
            }
        } else {
            quick_actions = nil
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(proposal_id, forKey: .proposal_id)
        try c.encodeIfPresent(kind, forKey: .kind)
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(detail, forKey: .detail)
        try c.encodeIfPresent(payload, forKey: .payload)
        try c.encodeIfPresent(executor, forKey: .executor)
        try c.encodeIfPresent(expires_at, forKey: .expires_at)
        try c.encodeIfPresent(why, forKey: .why)
        try c.encodeIfPresent(exploration, forKey: .exploration)
        try c.encodeIfPresent(quick_actions, forKey: .quick_actions)
    }

    /// The editable draft text for this proposal (payload.text for whatsapp.reply / reminder).
    public var draftText: String? {
        payload?["text"]?.stringValue
    }

    /// Trimmed `why`, or nil when absent/blank.
    public var whyText: String? {
        let t = (why ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    public var isExploration: Bool { exploration ?? false }

    /// Quick actions this app knows how to send (unknown ids are hidden).
    public var knownQuickActions: [ProposalQuickAction] {
        (quick_actions ?? []).filter { $0.scope != nil }
    }

    /// A card is a group card when the brain offered a `never_group` action.
    public var isGroupCard: Bool {
        (quick_actions ?? []).contains { $0.id == "never_group" }
    }
}

public struct ExecuteData: Codable, Equatable, Sendable {
    public var proposal_id: String
    public var kind: String?
    public var payload: JSONValue?
}

public struct AutoData: Codable, Equatable, Sendable {
    public var action: String?
    public var detail: String?
}

public struct CaptureRequestData: Codable, Equatable, Sendable {
    public var reason: String?
}

public struct ErrorData: Codable, Equatable, Sendable {
    public var code: String?
    public var message: String?
}

/// `update_required` (PROTOCOL.md §0): this app's protocol is older than the brain's `min_protocol`.
public struct UpdateRequiredData: Codable, Equatable, Sendable {
    public var min_protocol: Int?
    public var latest_protocol: Int?
    public var message: String?

    public init(min_protocol: Int? = nil, latest_protocol: Int? = nil, message: String? = nil) {
        self.min_protocol = min_protocol
        self.latest_protocol = latest_protocol
        self.message = message
    }

    enum CodingKeys: String, CodingKey { case min_protocol, latest_protocol, message }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        min_protocol = UpdateRequiredData.int(c, .min_protocol)
        latest_protocol = UpdateRequiredData.int(c, .latest_protocol)
        message = try? c.decode(String.self, forKey: .message)
    }

    private static func int(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> Int? {
        if let i = try? c.decode(Int.self, forKey: key) { return i }
        if let d = try? c.decode(Double.self, forKey: key) { return Int(d) }
        return nil
    }

    /// The text to show the user (the brain's message, or the default wording).
    public var displayMessage: String {
        let m = (message ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return m.isEmpty ? ProtocolConstants.defaultUpdateMessage : m
    }
}

/// Typed view of a brain → device envelope. `data` is decoded only for the matching type.
public enum IncomingEvent: Equatable, Sendable {
    case welcome(WelcomeData)
    case perform(Performance)
    case notice(NoticeData)
    case digest(DigestData)
    case propose(ProposeData)
    case execute(ExecuteData)
    case auto(AutoData)
    case captureRequest(CaptureRequestData)
    case error(ErrorData)
    case updateRequired(UpdateRequiredData)
    // Pet life (PROTOCOL.md §4.2)
    case petProfile(PetProfileData)
    case envUpdate(PetEnvData)
    case petThoughts(PetThoughtsData)
    case petLines(PetLinesData)
    case petObey(PetObeyData)
    case petAppraisal(PetAppraisalData)
    case unknown(type: String)

    public init(_ env: Envelope) {
        switch env.type {
        case "welcome":
            self = env.decodeData(WelcomeData.self).map { .welcome($0) } ?? .unknown(type: env.type)
        case "bot.perform":
            self = env.decodeData(Performance.self).map { .perform($0) } ?? .unknown(type: env.type)
        case "bot.notice":
            self = env.decodeData(NoticeData.self).map { .notice($0) } ?? .unknown(type: env.type)
        case "bot.digest":
            self = env.decodeData(DigestData.self).map { .digest($0) } ?? .unknown(type: env.type)
        case "bot.propose":
            self = env.decodeData(ProposeData.self).map { .propose($0) } ?? .unknown(type: env.type)
        case "bot.execute":
            self = env.decodeData(ExecuteData.self).map { .execute($0) } ?? .unknown(type: env.type)
        case "bot.auto":
            self = env.decodeData(AutoData.self).map { .auto($0) } ?? .unknown(type: env.type)
        case "capture.request":
            self = .captureRequest(env.decodeData(CaptureRequestData.self) ?? CaptureRequestData(reason: "asked"))
        case "error":
            self = .error(env.decodeData(ErrorData.self) ?? ErrorData(code: nil, message: nil))
        case "update_required":
            self = .updateRequired(env.decodeData(UpdateRequiredData.self) ?? UpdateRequiredData())
        case "pet.profile":
            self = env.decodeData(PetProfileData.self).map { .petProfile($0) } ?? .unknown(type: env.type)
        case "env.update":
            self = env.decodeData(PetEnvData.self).map { .envUpdate($0) } ?? .unknown(type: env.type)
        case "pet.thoughts":
            self = env.decodeData(PetThoughtsData.self).map { .petThoughts($0) } ?? .unknown(type: env.type)
        case "pet.lines":
            self = env.decodeData(PetLinesData.self).map { .petLines($0) } ?? .unknown(type: env.type)
        case "pet.obey":
            self = env.decodeData(PetObeyData.self).map { .petObey($0) } ?? .unknown(type: env.type)
        case "pet.appraisal":
            self = env.decodeData(PetAppraisalData.self).map { .petAppraisal($0) } ?? .unknown(type: env.type)
        default:
            self = .unknown(type: env.type)
        }
    }
}

// MARK: - REST models (PROTOCOL.md §1)

public struct DeviceDescriptor: Codable, Equatable, Sendable {
    public var kind: String
    public var name: String
    public init(kind: String, name: String) {
        self.kind = kind
        self.name = name
    }
}

public struct RegisterRequest: Codable, Equatable, Sendable {
    public var name: String
    public var device: DeviceDescriptor
    public init(name: String, device: DeviceDescriptor) {
        self.name = name
        self.device = device
    }
}

public struct RegisterResponse: Codable, Equatable, Sendable {
    public var user_id: String
    public var device_id: String
    public var token: String
}

public struct PairStartResponse: Codable, Equatable, Sendable {
    public var code: String
    public var expires_at: Double
    public var link: String
}

public struct DeviceRecord: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var kind: String?
    public var name: String?
    public var last_seen: Double?
    public var online: Bool?
}

public struct DevicesResponse: Codable, Equatable, Sendable {
    public var devices: [DeviceRecord]
}

public struct OKResponse: Codable, Equatable, Sendable {
    public var ok: Bool?
}

public struct APIErrorBody: Codable, Equatable, Sendable {
    public var error: String
    public var message: String?
}

// MARK: - Reply rules (PROTOCOL.md §5)

public struct ReplyRule: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var effect: String          // "always" | "never" | "only"
    public var subject_type: String    // "contact" | "group" | "relation" | "all_groups" | "all_dms" | "all"
    public var subject_label: String?
    public var conditions: JSONValue?
    public var expires_at: Double?     // ms since epoch
    public var source: String?
    public var utterance: String?
    public var created_at: Double?

    public init(id: String, effect: String, subject_type: String, subject_label: String? = nil, conditions: JSONValue? = nil, expires_at: Double? = nil, source: String? = nil, utterance: String? = nil, created_at: Double? = nil) {
        self.id = id
        self.effect = effect
        self.subject_type = subject_type
        self.subject_label = subject_label
        self.conditions = conditions
        self.expires_at = expires_at
        self.source = source
        self.utterance = utterance
        self.created_at = created_at
    }

    enum CodingKeys: String, CodingKey { case id, effect, subject_type, subject_label, conditions, expires_at, source, utterance, created_at }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        effect = (try? c.decode(String.self, forKey: .effect)) ?? ""
        subject_type = (try? c.decode(String.self, forKey: .subject_type)) ?? ""
        subject_label = try? c.decode(String.self, forKey: .subject_label)
        if let v = try? c.decode(JSONValue.self, forKey: .conditions), v != .null {
            conditions = v
        } else {
            conditions = nil
        }
        expires_at = try? c.decode(Double.self, forKey: .expires_at)
        source = try? c.decode(String.self, forKey: .source)
        utterance = try? c.decode(String.self, forKey: .utterance)
        created_at = try? c.decode(Double.self, forKey: .created_at)
    }

    public var effectLabel: String {
        switch effect {
        case "always": return "Always"
        case "never": return "Never"
        case "only": return "Only"
        default: return effect.isEmpty ? "Rule" : effect.capitalized
        }
    }

    public var subjectLabel: String {
        let label = (subject_label ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        switch subject_type {
        case "all_groups": return label.isEmpty ? "All groups" : label
        case "all_dms": return label.isEmpty ? "All direct chats" : label
        case "all": return label.isEmpty ? "Everyone" : label
        case "group":
            if label.isEmpty { return "A group" }
            return label.lowercased().hasSuffix("group") ? label : label + " group"
        default:
            return label.isEmpty ? (subject_type.isEmpty ? "Someone" : subject_type) : label
        }
    }

    /// e.g. "Always · Mom", "Never · Office group".
    public var displayLabel: String { "\(effectLabel) · \(subjectLabel)" }

    public var expiresDate: Date? {
        guard let ms = expires_at else { return nil }
        return Date(timeIntervalSince1970: ms / 1000)
    }
}

/// `GET /v1/reply-rules`. Malformed rules are dropped instead of failing the whole list.
public struct ReplyRulesResponse: Decodable, Equatable, Sendable {
    public var rules: [ReplyRule]

    public init(rules: [ReplyRule]) {
        self.rules = rules
    }

    enum CodingKeys: String, CodingKey { case rules }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let raw = (try? c.decode([JSONValue].self, forKey: .rules)) ?? []
        rules = raw.compactMap { $0.decode(ReplyRule.self) }
    }
}
