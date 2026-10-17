import AppKit

/// App entry point. Accessory activation policy: no Dock icon, just the menu-bar item and the overlay.
@main
enum PixieMain {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        if SnapshotRenderer.runIfRequested() { return }
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
        // `app.run()` never returns; keep the delegate alive for its whole lifetime.
        withExtendedLifetime(delegate) {}
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var controller: AppController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let c = AppController(prefs: Preferences())
        controller = c
        c.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        controller?.shutdown()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}
