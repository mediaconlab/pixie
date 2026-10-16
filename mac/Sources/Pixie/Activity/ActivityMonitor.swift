import AppKit
import CoreGraphics
import Foundation
import PixieCore

/// Derives `state.update` from the frontmost app, its window title and input idleness.
/// Sends only when something changed.
@MainActor
final class ActivityMonitor {
    var onChange: ((StateUpdateData) -> Void)?
    /// Supplies whether watch mode is on.
    var isWatching: () -> Bool = { false }

    private var timer: Timer?
    private var last: StateUpdateData?
    private var appObserver: NSObjectProtocol?

    func start() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.evaluate() }
        }
        appObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.evaluate() }
        }
        evaluate()
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        if let o = appObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(o)
        }
        appObserver = nil
    }

    /// Forces the next evaluation to send (e.g. after reconnecting).
    func resend() {
        last = nil
        evaluate()
    }

    func evaluate() {
        let app = NSWorkspace.shared.frontmostApplication
        let bundle = app?.bundleIdentifier
        let name = app?.localizedName ?? ""
        let title = Self.frontWindowTitle(pid: app?.processIdentifier)
        let idle = AvatarModel.systemIdleSeconds()
        let watching = isWatching()
        let activity = ActivityClassifier.classify(bundleID: bundle, appName: name, windowTitle: title,
                                                   watching: watching, idleSeconds: idle)
        let state = StateUpdateData(activity: activity, front_app: name, focus_mode: false, watching: watching)
        if state != last {
            last = state
            onChange?(state)
        }
    }

    /// Window title of the frontmost app's top window via CGWindowList. Titles of other apps' windows are
    /// only populated when Screen Recording permission is granted; otherwise this returns nil.
    static func frontWindowTitle(pid: pid_t?) -> String? {
        guard let pid else { return nil }
        let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { return nil }
        for info in list {
            guard let owner = info[kCGWindowOwnerPID as String] as? Int, pid_t(owner) == pid else { continue }
            let layer = info[kCGWindowLayer as String] as? Int ?? 0
            guard layer == 0 else { continue }
            if let title = info[kCGWindowName as String] as? String, !title.isEmpty {
                return title
            }
        }
        return nil
    }
}
