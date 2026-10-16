import Foundation
import CoreGraphics
import PixieCore

enum CharacterSize: String, CaseIterable, Identifiable {
    case small = "S"
    case medium = "M"
    case large = "L"

    var id: String { rawValue }

    /// Character diameter in points.
    var points: CGFloat {
        switch self {
        case .small: return 104
        case .medium: return 136
        case .large: return 176
        }
    }
}

/// "Use this Mac's location for weather": `auto` = on only while no Android phone is paired.
enum PixieLocationChoice: String {
    case auto, on, off
}

/// UserDefaults-backed settings. Secrets (the device token) live in the Keychain, not here.
@MainActor
final class Preferences: ObservableObject {
    static let defaultBrainURL = "https://pixie-orchestrator.<subdomain>.workers.dev"

    private let defaults = UserDefaults.standard

    private enum Key {
        static let brainURL = "brainURL"
        static let userName = "userName"
        static let voiceEnabled = "voiceEnabled"
        static let characterSize = "characterSize"
        static let screenInterval = "screenInterval"
        static let blocklist = "blocklist"
        static let screenSharing = "screenSharing"
        static let panelX = "panelX"
        static let panelY = "panelY"
        static let deviceID = "deviceID"
        static let useCalendar = "useCalendar"
        static let macLocationChoice = "macLocationChoice"
        static let androidPaired = "androidPaired"
    }

    @Published var brainURL: String { didSet { defaults.set(brainURL, forKey: Key.brainURL) } }
    @Published var userName: String { didSet { defaults.set(userName, forKey: Key.userName) } }
    @Published var voiceEnabled: Bool { didSet { defaults.set(voiceEnabled, forKey: Key.voiceEnabled) } }
    @Published var characterSize: CharacterSize { didSet { defaults.set(characterSize.rawValue, forKey: Key.characterSize) } }
    /// Seconds between periodic screen frames while "Let Pixie see my screen" is on.
    @Published var screenInterval: Double { didSet { defaults.set(screenInterval, forKey: Key.screenInterval) } }
    @Published var blocklist: [String] { didSet { defaults.set(blocklist, forKey: Key.blocklist) } }
    /// Off by default. Remembered once the user opts in.
    @Published var screenSharing: Bool { didSet { defaults.set(screenSharing, forKey: Key.screenSharing) } }
    @Published var deviceID: String { didSet { defaults.set(deviceID, forKey: Key.deviceID) } }
    /// "Use my calendar to avoid interrupting before meetings". Off by default; busy/free times only.
    @Published var useCalendar: Bool { didSet { defaults.set(useCalendar, forKey: Key.useCalendar) } }
    /// A `PixieLocationChoice` raw value. Defaults to `auto`.
    @Published var macLocationChoice: String { didSet { defaults.set(macLocationChoice, forKey: Key.macLocationChoice) } }
    /// Whether an Android phone is paired (from `GET /v1/devices`, cached so the default works offline).
    @Published var androidPaired: Bool { didSet { defaults.set(androidPaired, forKey: Key.androidPaired) } }

    init() {
        let defaults = UserDefaults.standard
        brainURL = defaults.string(forKey: Key.brainURL) ?? Preferences.defaultBrainURL
        userName = defaults.string(forKey: Key.userName) ?? ""
        voiceEnabled = defaults.object(forKey: Key.voiceEnabled) as? Bool ?? true
        characterSize = CharacterSize(rawValue: defaults.string(forKey: Key.characterSize) ?? "") ?? .medium
        let interval = defaults.double(forKey: Key.screenInterval)
        screenInterval = interval > 0 ? interval : 5
        blocklist = defaults.stringArray(forKey: Key.blocklist) ?? CaptureGuard.defaultBlockedBundleIDs
        screenSharing = defaults.bool(forKey: Key.screenSharing)
        deviceID = defaults.string(forKey: Key.deviceID) ?? ""
        useCalendar = defaults.bool(forKey: Key.useCalendar)
        macLocationChoice = defaults.string(forKey: Key.macLocationChoice) ?? PixieLocationChoice.auto.rawValue
        androidPaired = defaults.bool(forKey: Key.androidPaired)
    }

    /// The Settings toggle: shows the effective value; flipping it stores an explicit choice.
    var macLocationEnabled: Bool {
        get { useMacLocation }
        set { macLocationChoice = newValue ? PixieLocationChoice.on.rawValue : PixieLocationChoice.off.rawValue }
    }

    /// Whether `androidPaired` has ever been learned from the device list.
    var androidPairedKnown: Bool { defaults.object(forKey: Key.androidPaired) != nil }

    /// Whether the Mac reports its own location: on by default only while no Android phone is paired.
    var useMacLocation: Bool {
        switch PixieLocationChoice(rawValue: macLocationChoice) ?? .auto {
        case .on: return true
        case .off: return false
        case .auto: return androidPairedKnown && !androidPaired
        }
    }

    var panelOrigin: CGPoint? {
        get {
            guard defaults.object(forKey: Key.panelX) != nil else { return nil }
            return CGPoint(x: defaults.double(forKey: Key.panelX), y: defaults.double(forKey: Key.panelY))
        }
        set {
            if let p = newValue {
                defaults.set(Double(p.x), forKey: Key.panelX)
                defaults.set(Double(p.y), forKey: Key.panelY)
            } else {
                defaults.removeObject(forKey: Key.panelX)
                defaults.removeObject(forKey: Key.panelY)
            }
        }
    }

    /// Normalised base URL without a trailing slash, or nil when invalid.
    var baseURL: URL? {
        var s = brainURL.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        guard !s.contains("<"), let url = URL(string: s), let scheme = url.scheme,
              scheme == "https" || scheme == "http", url.host != nil else { return nil }
        return url
    }
}
