import Foundation

// MARK: - Average hash

/// 16x16 grayscale average hash. Input: 256 luminance bytes (row-major). Output: 256 bits as 4 UInt64.
public struct AverageHash: Equatable, Sendable {
    public let bits: [UInt64]

    public init(bits: [UInt64]) {
        self.bits = bits
    }

    public init?(gray pixels: [UInt8]) {
        guard pixels.count == 256 else { return nil }
        var total = 0
        for p in pixels { total += Int(p) }
        let mean = total / 256
        var words = [UInt64](repeating: 0, count: 4)
        for (i, p) in pixels.enumerated() where Int(p) > mean {
            words[i / 64] |= (UInt64(1) << UInt64(i % 64))
        }
        bits = words
    }

    public func distance(to other: AverageHash) -> Int {
        var d = 0
        for i in 0..<min(bits.count, other.bits.count) {
            d += (bits[i] ^ other.bits[i]).nonzeroBitCount
        }
        return d
    }

    /// True when `other` is nil or differs by at least `threshold` bits.
    public func changed(from other: AverageHash?, threshold: Int = 5) -> Bool {
        guard let other else { return true }
        return distance(to: other) >= threshold
    }
}

// MARK: - Backoff

/// Exponential reconnect backoff: 1, 2, 4, 8, 16, 30, 30, ... seconds.
public struct Backoff: Sendable {
    public let base: TimeInterval
    public let maxDelay: TimeInterval
    public private(set) var attempt: Int = 0

    public init(base: TimeInterval = 1, maxDelay: TimeInterval = 30) {
        self.base = base
        self.maxDelay = maxDelay
    }

    /// Returns the delay for the next attempt and advances.
    public mutating func next() -> TimeInterval {
        let exp = min(attempt, 10)
        let delay = min(maxDelay, base * pow(2.0, Double(exp)))
        attempt += 1
        return delay
    }

    public mutating func reset() {
        attempt = 0
    }
}

// MARK: - Offline queue

/// Bounded FIFO; when full the oldest element is dropped.
public struct BoundedQueue<Element> {
    public let capacity: Int
    public private(set) var items: [Element] = []

    public init(capacity: Int) {
        self.capacity = max(1, capacity)
    }

    public var count: Int { items.count }
    public var isEmpty: Bool { items.isEmpty }

    public mutating func push(_ e: Element) {
        items.append(e)
        if items.count > capacity {
            items.removeFirst(items.count - capacity)
        }
    }

    public mutating func drain() -> [Element] {
        let out = items
        items.removeAll()
        return out
    }

    /// Puts elements back at the front (used when a send fails mid-flush), respecting the cap.
    public mutating func prepend(_ es: [Element]) {
        items = es + items
        if items.count > capacity {
            items.removeFirst(items.count - capacity)
        }
    }
}

// MARK: - Activity classification

public enum ActivityClassifier {
    public static let codingBundles: Set<String> = [
        "com.apple.dt.Xcode", "com.microsoft.VSCode", "com.microsoft.VSCodeInsiders",
        "com.todesktop.230313mzl4w4u92", // Cursor
        "com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable", "com.mitchellh.ghostty",
        "dev.zed.Zed",
    ]
    public static let meetingBundles: Set<String> = [
        "us.zoom.xos", "com.microsoft.teams", "com.microsoft.teams2", "com.apple.FaceTime",
        "com.cisco.webexmeetingsapp", "com.tinyspeck.slackmacgap.huddle",
    ]
    public static let browserBundles: Set<String> = [
        "com.apple.Safari", "com.google.Chrome", "org.mozilla.firefox", "com.microsoft.edgemac",
        "com.brave.Browser", "company.thebrowser.Browser", "com.operasoftware.Opera", "com.vivaldi.Vivaldi",
    ]

    /// - Parameters:
    ///   - idleSeconds: seconds since last user input.
    public static func classify(bundleID: String?, appName: String?, windowTitle: String?, watching: Bool, idleSeconds: Double) -> Activity {
        if idleSeconds >= 15 * 60 { return .away }
        if idleSeconds >= 5 * 60 && !watching { return .idle }

        let bid = bundleID ?? ""
        let name = (appName ?? "").lowercased()
        let title = (windowTitle ?? "").lowercased()

        if meetingBundles.contains(bid) || name == "zoom.us" || name.contains("teams") || name == "facetime"
            || title.contains("meet") {
            return .meeting
        }
        if watching || title.contains("youtube") || title.contains("netflix") || title.contains("prime video")
            || title.contains("hotstar") {
            return .video
        }
        if codingBundles.contains(bid) || bid.hasPrefix("com.jetbrains.") || name == "cursor" || name == "code"
            || name == "terminal" || name == "iterm2" {
            return .coding
        }
        if browserBundles.contains(bid) {
            return .browsing
        }
        return .idle
    }
}

// MARK: - Capture guard

public enum CaptureGuard {
    public static let defaultBlockedBundleIDs: [String] = [
        "com.1password.1password",
        "com.bitwarden.desktop",
        "com.apple.keychainaccess",
        "com.apple.systempreferences",
        "com.apple.Passwords",
    ]
    public static let blockedTitleWords: [String] = ["private", "incognito"]

    public static func isBlocked(bundleID: String?, blocklist: [String]) -> Bool {
        guard let bundleID, !bundleID.isEmpty else { return false }
        return blocklist.contains { $0.caseInsensitiveCompare(bundleID) == .orderedSame }
    }

    public static func isPrivateTitle(_ title: String?) -> Bool {
        guard let t = title?.lowercased(), !t.isEmpty else { return false }
        return blockedTitleWords.contains { t.contains($0) }
    }
}
