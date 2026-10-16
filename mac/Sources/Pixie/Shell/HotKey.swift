import AppKit
import ApplicationServices

/// ⌥Space opens the chat field.
///
/// Uses NSEvent monitors:
///  - a *local* monitor (works whenever a Pixie window is key; can swallow the event), and
///  - a *global* monitor (works while other apps are frontmost). Global key monitors only deliver
///    events once the user grants Pixie Accessibility access (System Settings → Privacy & Security →
///    Accessibility). Global monitors cannot consume events, so the frontmost app also receives ⌥Space.
@MainActor
final class HotKey {
    private var globalMonitor: Any?
    private var localMonitor: Any?
    private let action: () -> Void
    /// Every key press seen by either monitor (no key codes or characters are passed on), for typing rate.
    var onAnyKeyDown: (() -> Void)?

    init(action: @escaping () -> Void) {
        self.action = action
    }

    func start() {
        stop()
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            let hot = HotKey.matches(event)
            Task { @MainActor in
                self?.onAnyKeyDown?()
                if hot { self?.action() }
            }
        }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            MainActor.assumeIsolated { self?.onAnyKeyDown?() }
            guard HotKey.matches(event) else { return event }
            MainActor.assumeIsolated { self?.action() }
            return nil
        }
    }

    func stop() {
        if let g = globalMonitor { NSEvent.removeMonitor(g) }
        if let l = localMonitor { NSEvent.removeMonitor(l) }
        globalMonitor = nil
        localMonitor = nil
    }

    nonisolated static func matches(_ event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection([.command, .option, .control, .shift])
        return event.keyCode == 49 /* kVK_Space */ && flags == .option
    }

    static var isTrusted: Bool {
        AXIsProcessTrusted()
    }

    /// Shows the system "grant Accessibility" prompt (only if not trusted yet).
    static func requestTrust() {
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
    }
}
