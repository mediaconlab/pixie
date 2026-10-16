import Foundation

// Context signals (PROTOCOL.md §4.1: `signals.update`, `location.update`). Pure value types and math so the
// app-side monitors stay thin and this part is unit-tested.

public enum PixieAppSwitchRate: String, Codable, CaseIterable, Sendable {
    case low, high
}

/// `music` in `signals.update`: which player and whether it is playing. Never track names.
public struct PixieMusicSignal: Codable, Equatable, Sendable {
    public var app: String
    public var playing: Bool

    public init(app: String, playing: Bool) {
        self.app = app
        self.playing = playing
    }
}

/// `signals.update`. `music` and `next_busy_in_min` are always encoded, as `null` when unknown.
public struct PixieSignalsData: Codable, Equatable, Sendable {
    public var mic_in_use: Bool
    public var camera_in_use: Bool
    public var music: PixieMusicSignal?
    public var calendar_busy_now: Bool
    public var next_busy_in_min: Int?
    public var typing_rate: PetTypingRate
    public var app_switch_rate: PixieAppSwitchRate
    public var screen_locked: Bool

    public init(mic_in_use: Bool = false, camera_in_use: Bool = false, music: PixieMusicSignal? = nil,
                calendar_busy_now: Bool = false, next_busy_in_min: Int? = nil,
                typing_rate: PetTypingRate = PetTypingRate.none, app_switch_rate: PixieAppSwitchRate = .low,
                screen_locked: Bool = false) {
        self.mic_in_use = mic_in_use
        self.camera_in_use = camera_in_use
        self.music = music
        self.calendar_busy_now = calendar_busy_now
        self.next_busy_in_min = next_busy_in_min
        self.typing_rate = typing_rate
        self.app_switch_rate = app_switch_rate
        self.screen_locked = screen_locked
    }

    enum CodingKeys: String, CodingKey {
        case mic_in_use, camera_in_use, music, calendar_busy_now, next_busy_in_min, typing_rate, app_switch_rate, screen_locked
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(mic_in_use, forKey: .mic_in_use)
        try c.encode(camera_in_use, forKey: .camera_in_use)
        if let music {
            try c.encode(music, forKey: .music)
        } else {
            try c.encodeNil(forKey: .music)
        }
        try c.encode(calendar_busy_now, forKey: .calendar_busy_now)
        if let next_busy_in_min {
            try c.encode(next_busy_in_min, forKey: .next_busy_in_min)
        } else {
            try c.encodeNil(forKey: .next_busy_in_min)
        }
        try c.encode(typing_rate, forKey: .typing_rate)
        try c.encode(app_switch_rate, forKey: .app_switch_rate)
        try c.encode(screen_locked, forKey: .screen_locked)
    }
}

/// `location.update`. Build it with `PixieLocationData.rounded` so coordinates never leave at full precision.
public struct PixieLocationData: Codable, Equatable, Sendable {
    public var lat: Double
    public var lon: Double
    public var accuracy_m: Int
    public var source: String

    public init(lat: Double, lon: Double, accuracy_m: Int, source: String) {
        self.lat = lat
        self.lon = lon
        self.accuracy_m = accuracy_m
        self.source = source
    }

    /// Coordinates rounded to 2 decimals (~1 km); accuracy reported as at least 1 km because of that rounding.
    public static func rounded(lat: Double, lon: Double, accuracy: Double, source: String) -> PixieLocationData {
        let acc = accuracy.isFinite && accuracy > 0 ? accuracy : 1000
        return PixieLocationData(lat: PixieSignalMath.round2(lat), lon: PixieSignalMath.round2(lon),
                                 accuracy_m: Int(max(1000, acc.rounded())), source: source)
    }
}

/// A busy stretch from the calendar: times only, nothing else about the event.
public struct PixieBusyInterval: Equatable, Sendable {
    public var start: Date
    public var end: Date

    public init(start: Date, end: Date) {
        self.start = start
        self.end = end
    }
}

public enum PixieSignalMath {
    /// Key presses in the last minute below this are "none"; at or above `typingHighPerMinute` "high".
    public static let typingLowPerMinute = 5
    public static let typingHighPerMinute = 150
    /// App activations in the last 5 minutes at or above this are "high".
    public static let appSwitchHighPer5Min = 10

    public static func round2(_ v: Double) -> Double {
        (v * 100).rounded() / 100
    }

    public static func typingRate(keysLastMinute n: Int) -> PetTypingRate {
        if n >= typingHighPerMinute { return .high }
        if n >= typingLowPerMinute { return .low }
        return PetTypingRate.none
    }

    public static func appSwitchRate(switchesLast5Min n: Int) -> PixieAppSwitchRate {
        n >= appSwitchHighPer5Min ? .high : .low
    }

    /// Drops timestamps (seconds since 1970) older than `window` seconds before `now`.
    public static func prune(_ times: [Double], now: Double, window: Double) -> [Double] {
        let cutoff = now - window
        return times.filter { $0 > cutoff }
    }

    /// Great-circle distance in kilometres.
    public static func distanceKm(lat1: Double, lon1: Double, lat2: Double, lon2: Double) -> Double {
        let r = 6371.0
        let dLat = (lat2 - lat1) * Double.pi / 180
        let dLon = (lon2 - lon1) * Double.pi / 180
        let a = sin(dLat / 2) * sin(dLat / 2)
            + cos(lat1 * Double.pi / 180) * cos(lat2 * Double.pi / 180) * sin(dLon / 2) * sin(dLon / 2)
        return 2 * r * asin(min(1, sqrt(a)))
    }

    /// Whether a location fix should be sent now: always the first one; afterwards only when it moved more
    /// than `minKm` from the last sent fix and at least `minInterval` seconds have passed.
    public static func shouldSendLocation(lastLat: Double?, lastLon: Double?, lastSentAt: Double?,
                                          lat: Double, lon: Double, now: Double,
                                          minKm: Double = 2, minInterval: Double = 15 * 60) -> Bool {
        guard let lastLat, let lastLon, let lastSentAt else { return true }
        guard now - lastSentAt >= minInterval else { return false }
        return distanceKm(lat1: lastLat, lon1: lastLon, lat2: lat, lon2: lon) > minKm
    }

    /// Busy now, and whole minutes until the next busy stretch that starts after `now` (nil if none).
    public static func calendarStatus(_ intervals: [PixieBusyInterval], now: Date) -> (busyNow: Bool, nextBusyInMin: Int?) {
        var busy = false
        var next: Date?
        for i in intervals where i.end > i.start {
            if i.start <= now && now < i.end { busy = true }
            if i.start > now {
                if let n = next {
                    if i.start < n { next = i.start }
                } else {
                    next = i.start
                }
            }
        }
        var minutes: Int?
        if let next { minutes = Int(next.timeIntervalSince(now) / 60) }
        return (busy, minutes)
    }
}
