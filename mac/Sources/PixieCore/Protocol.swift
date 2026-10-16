import Foundation

// MARK: - Envelope (PROTOCOL.md §2)

public enum ProtocolConstants {
    public static let version = 1
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

public enum VoicePace: String, Codable, CaseIterable, Sendable, TolerantStringEnum {
    case slow, normal, fast
    public static var fallback: VoicePace { .normal }
    public init(from decoder: Decoder) throws {
        self = VoicePace.tolerant(try? decoder.singleValueContainer().decode(String.self))
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
    public var app_version: String
    public var capabilities: [String]
    public init(kind: String = "mac", name: String, app_version: String = ProtocolConstants.appVersion, capabilities: [String] = ["screen", "audio", "voice", "notify"]) {
        self.kind = kind
        self.name = name
        self.app_version = app_version
        self.capabilities = capabilities
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
    public init(proposal_id: String, verdict: String, edited_text: String? = nil) {
        self.proposal_id = proposal_id
        self.verdict = verdict
        self.edited_text = edited_text
    }

    // Omit edited_text entirely when nil (it is optional in the protocol).
    enum CodingKeys: String, CodingKey { case proposal_id, verdict, edited_text }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(proposal_id, forKey: .proposal_id)
        try c.encode(verdict, forKey: .verdict)
        try c.encodeIfPresent(edited_text, forKey: .edited_text)
    }
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

public struct VoiceSpec: Codable, Equatable, Sendable {
    public var pace: VoicePace
    public var pitch: Int
    public init(pace: VoicePace = .normal, pitch: Int = 0) {
        self.pace = pace
        self.pitch = pitch
    }
    enum CodingKeys: String, CodingKey { case pace, pitch }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pace = (try? c.decode(VoicePace.self, forKey: .pace)) ?? .normal
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
    public var voice: VoiceSpec
    public var speak: Bool
    public var reply_to: String?

    public init(say: String = "", emotion: Emotion = .neutral, intensity: Double = 0.5, gesture: GestureKind = GestureKind.fallback, gaze: Gaze = .user, voice: VoiceSpec = VoiceSpec(), speak: Bool = false, reply_to: String? = nil) {
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
        voice = (try? c.decode(VoiceSpec.self, forKey: .voice)) ?? VoiceSpec()
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

public struct ProposeData: Codable, Equatable, Sendable {
    public var proposal_id: String
    public var kind: String?
    public var title: String?
    public var detail: String?
    public var payload: JSONValue?
    public var executor: String?
    public var expires_at: Double?

    /// The editable draft text for this proposal (payload.text for whatsapp.reply / reminder).
    public var draftText: String? {
        payload?["text"]?.stringValue
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
