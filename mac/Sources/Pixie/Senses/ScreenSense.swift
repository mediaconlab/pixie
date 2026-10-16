import AppKit
import CoreGraphics
import Foundation
import PixieCore
import ScreenCaptureKit

/// Screen frames via ScreenCaptureKit (macOS 14 `SCScreenshotManager`).
///
/// Modes:
///  - periodic: every `interval` s while "Let Pixie see my screen" is on, only when the 16x16 average hash
///    moved by ≥ 5 bits since the last sent frame.
///  - asked: on `capture.request`.
///  - watch: every 4 s while "Watch with me" is on.
///
/// Guard: blocklisted apps are excluded from the capture filter, the capture is skipped entirely when the
/// frontmost app is blocked or its window title looks private, and apps that own a Private/Incognito window
/// are excluded except for their non-private windows. Pixie's own panel is always excluded.
enum ProcessedFrame: @unchecked Sendable {
    case failed
    case unchanged
    case ready(FrameProcessor.Output, String)
}

@MainActor
final class ScreenSense {
    enum CaptureResult {
        case frame(ScreenFrameData)
        case unchanged
        case blocked
        case noPermission
        case failed
    }

    var onFrame: ((ScreenFrameData) -> Void)?

    private let prefs: Preferences
    private var periodicTimer: Timer?
    private var watchTimer: Timer?
    private var lastSentHash: AverageHash?
    private var inFlight = false

    private(set) var sharingEnabled = false
    private(set) var watching = false

    init(prefs: Preferences) {
        self.prefs = prefs
    }

    // MARK: Permission

    static var hasPermission: Bool {
        CGPreflightScreenCaptureAccess()
    }

    /// Triggers the system Screen Recording prompt the first time; afterwards it only reports status.
    @discardableResult
    static func requestPermission() -> Bool {
        CGRequestScreenCaptureAccess()
    }

    // MARK: Modes

    func setSharing(_ on: Bool) {
        sharingEnabled = on
        periodicTimer?.invalidate()
        periodicTimer = nil
        lastSentHash = nil
        guard on else { return }
        let interval = max(2, prefs.screenInterval)
        periodicTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.periodicTick() }
        }
    }

    func setWatching(_ on: Bool) {
        watching = on
        watchTimer?.invalidate()
        watchTimer = nil
        guard on else { return }
        watchTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.watchTick() }
        }
    }

    /// Restart the periodic timer after the interval setting changes.
    func intervalChanged() {
        if sharingEnabled { setSharing(true) }
    }

    private func periodicTick() {
        // Watch mode already sends frames every 4 s.
        guard sharingEnabled, !watching, !inFlight else { return }
        Task { @MainActor in
            let r = await self.capture(reason: "periodic", skipIfUnchanged: true)
            if case .frame(let f) = r { self.onFrame?(f) }
        }
    }

    private func watchTick() {
        guard watching, !inFlight else { return }
        Task { @MainActor in
            let r = await self.capture(reason: "watch", skipIfUnchanged: true)
            if case .frame(let f) = r { self.onFrame?(f) }
        }
    }

    // MARK: Capture

    func capture(reason: String, skipIfUnchanged: Bool) async -> CaptureResult {
        guard Self.hasPermission else { return .noPermission }
        // An explicit request waits (up to ~3 s) for a periodic capture that is already running.
        var waited = 0
        while inFlight && waited < 30 {
            try? await Task.sleep(nanoseconds: 100_000_000)
            waited += 1
        }
        guard !inFlight else { return .failed }
        inFlight = true
        defer { inFlight = false }

        let blocklist = prefs.blocklist
        let frontApp = NSWorkspace.shared.frontmostApplication
        let frontBundle = frontApp?.bundleIdentifier
        let frontName = frontApp?.localizedName ?? ""
        let frontPID = frontApp?.processIdentifier ?? 0

        if CaptureGuard.isBlocked(bundleID: frontBundle, blocklist: blocklist) {
            return .blocked
        }

        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        } catch {
            return .failed
        }

        // Front window title: the first normal-layer, titled window owned by the frontmost app.
        let frontWindows = content.windows.filter { w in
            w.owningApplication?.processID == frontPID && w.windowLayer == 0 && w.isOnScreen
        }
        let windowTitle = frontWindows.first(where: { !($0.title ?? "").isEmpty })?.title ?? ""
        if CaptureGuard.isPrivateTitle(windowTitle) {
            return .blocked
        }

        guard let display = Self.pickDisplay(from: content.displays) else { return .failed }

        // Build the exclusion list.
        let myPID = ProcessInfo.processInfo.processIdentifier
        var excludedPIDs = Set<pid_t>()
        for app in content.applications {
            if app.processID == myPID || CaptureGuard.isBlocked(bundleID: app.bundleIdentifier, blocklist: blocklist) {
                excludedPIDs.insert(app.processID)
            }
        }
        // Apps with a private/incognito window: exclude the app, but keep its other windows.
        var privateOwnerPIDs = Set<pid_t>()
        for w in content.windows where CaptureGuard.isPrivateTitle(w.title) {
            if let pid = w.owningApplication?.processID { privateOwnerPIDs.insert(pid) }
        }
        let excludedApps = content.applications.filter {
            excludedPIDs.contains($0.processID) || privateOwnerPIDs.contains($0.processID)
        }
        let exceptedWindows = content.windows.filter { w in
            guard let pid = w.owningApplication?.processID else { return false }
            return privateOwnerPIDs.contains(pid) && !excludedPIDs.contains(pid) && !CaptureGuard.isPrivateTitle(w.title)
        }

        let filter = SCContentFilter(display: display, excludingApplications: excludedApps, exceptingWindows: exceptedWindows)
        let config = SCStreamConfiguration()
        // Capture at up to ~1600 px so OCR stays legible; the JPEG is downscaled to 768 afterwards.
        let longest = max(display.width, display.height)
        let k = longest > 0 ? min(2.0, 1600.0 / Double(longest)) : 1.0
        config.width = max(2, Int(Double(display.width) * k))
        config.height = max(2, Int(Double(display.height) * k))
        config.showsCursor = false

        let image: CGImage
        do {
            image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        } catch {
            return .failed
        }

        let previous = skipIfUnchanged ? lastSentHash : nil
        let processed = await Task.detached(priority: .utility) { () -> ProcessedFrame in
            guard let out = FrameProcessor.encode(image, maxSide: 768, quality: 0.6) else { return .failed }
            if skipIfUnchanged, let h = out.hash, !h.changed(from: previous, threshold: 5) {
                return .unchanged
            }
            return .ready(out, FrameProcessor.recognizeText(image))
        }.value

        let out: FrameProcessor.Output
        let ocr: String
        switch processed {
        case .failed:
            return .failed
        case .unchanged:
            return .unchanged
        case .ready(let o, let text):
            out = o
            ocr = text
        }
        lastSentHash = out.hash

        return .frame(ScreenFrameData(image: out.dataURL, width: out.width, height: out.height,
                                      front_app: frontName, window: windowTitle, ocr: ocr, reason: reason))
    }

    /// The display under the mouse pointer, falling back to the main display.
    private static func pickDisplay(from displays: [SCDisplay]) -> SCDisplay? {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }) ?? NSScreen.main
        if let number = screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
            let id = CGDirectDisplayID(number.uint32Value)
            if let d = displays.first(where: { $0.displayID == id }) { return d }
        }
        return displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? displays.first
    }
}
