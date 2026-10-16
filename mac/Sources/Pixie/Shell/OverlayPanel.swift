import AppKit
import SwiftUI

/// Transparent, borderless, non-activating, always-on-top panel that hosts Pixie.
final class OverlayPanel: NSPanel {
    /// Creates and configures the panel. (No custom designated initializer, so the inherited NSPanel
    /// initializers – including init?(coder:) – keep working without overrides.)
    static func make(contentRect: NSRect) -> OverlayPanel {
        let p = OverlayPanel(contentRect: contentRect,
                             styleMask: [.borderless, .nonactivatingPanel],
                             backing: .buffered,
                             defer: false)
        p.configure()
        return p
    }

    private func configure() {
        isFloatingPanel = true
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        backgroundColor = .clear
        isOpaque = false
        hasShadow = false
        hidesOnDeactivate = false
        isMovable = false            // we move it ourselves while dragging the character
        isMovableByWindowBackground = false
        becomesKeyOnlyIfNeeded = true
        isReleasedWhenClosed = false
        ignoresMouseEvents = true    // see PanelController: toggled by the hit-test poller
        animationBehavior = .none
    }

    // Needed so the chat TextField can receive keystrokes without activating the app.
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// Hosting view that reacts to the very first click even though the panel is never the active app's
/// main window (otherwise the first click on Pixie would only "focus" the panel).
final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// Owns the overlay panel.
///
/// Click-through approach: the panel starts with `ignoresMouseEvents = true`, so every click goes to the
/// apps underneath. SwiftUI reports the frames of the interactive pieces (character, bubble, cards, chat
/// field) through a PreferenceKey into `HitRegionStore`. A 30 Hz main-thread timer compares
/// `NSEvent.mouseLocation` (which needs no permission) against those frames and flips
/// `ignoresMouseEvents` to false only while the pointer is over one of them. This is more reliable than
/// overriding `hitTest` in an NSHostingView, because a window that is not ignoring mouse events always
/// swallows clicks on its transparent pixels on recent macOS versions. While a drag is in progress the
/// panel keeps capturing so the drag never "drops" when the pointer outruns the character.
@MainActor
final class PanelController {
    let panel: OverlayPanel
    private let avatar: AvatarModel
    private let overlay: OverlayModel
    private let prefs: Preferences
    private let hitStore = HitRegionStore()
    private var pollTimer: Timer?
    private var dragging = false
    private var dragStartMouse: NSPoint = .zero
    private var dragStartOrigin: NSPoint = .zero
    // Hover-stroke detection (petting without clicking): direction reversals while over the character.
    private var lastHoverX: CGFloat?
    private var lastHoverDir: CGFloat = 0
    private var hoverTravel: CGFloat = 0
    private var reversals: [Date] = []
    private var lastStrokeAt = Date.distantPast
    private var visibilityTicks = 0

    static let panelSize = NSSize(width: 360, height: 640)

    init(avatar: AvatarModel, overlay: OverlayModel, prefs: Preferences) {
        self.avatar = avatar
        self.overlay = overlay
        self.prefs = prefs
        panel = OverlayPanel.make(contentRect: NSRect(origin: .zero, size: Self.panelSize))

        let root = OverlayRootView(avatar: avatar, overlay: overlay, prefs: prefs, hitStore: hitStore)
        let hosting = FirstMouseHostingView(rootView: root)
        hosting.frame = NSRect(origin: .zero, size: Self.panelSize)
        hosting.autoresizingMask = [.width, .height]
        hosting.sizingOptions = [] // never let SwiftUI resize the panel
        panel.contentView = hosting

        panel.setFrameOrigin(restoredOrigin())

        avatar.onDragBegan = { [weak self] in self?.beginDrag() }
        avatar.onDragChanged = { [weak self] in self?.continueDrag() }
        avatar.onDragEnded = { [weak self] in self?.endDrag() }
        avatar.onPressEnded = { [weak self] in self?.cancelPress() }

        pollTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.poll() }
        }
        updateCharacterCenter()
    }

    func show() {
        panel.orderFrontRegardless()
    }

    /// Makes the panel key (without activating the app) so the chat field can take typing.
    func focusForTyping() {
        panel.ignoresMouseEvents = false
        panel.makeKeyAndOrderFront(nil)
    }

    func resetPosition() {
        prefs.panelOrigin = nil
        panel.setFrameOrigin(restoredOrigin())
        updateCharacterCenter()
    }

    // MARK: Click-through poller

    private func poll() {
        visibilityTicks += 1
        if visibilityTicks >= 30 {
            visibilityTicks = 0
            // Pause the character's animation timeline while the panel can't be seen.
            let visible = panel.occlusionState.contains(.visible) && panel.isVisible
            if avatar.hidden == visible { avatar.hidden = !visible }
        }
        if dragging {
            if panel.ignoresMouseEvents { panel.ignoresMouseEvents = false }
            return
        }
        let mouse = NSEvent.mouseLocation
        trackHoverStroke(mouse)
        let frame = panel.frame
        // Convert to the SwiftUI "overlay" space: origin at the top-left of the content.
        let local = CGPoint(x: mouse.x - frame.minX, y: frame.height - (mouse.y - frame.minY))
        var inside = false
        if frame.contains(mouse) {
            for r in hitStore.rects where r.insetBy(dx: -4, dy: -4).contains(local) {
                inside = true
                break
            }
        }
        // Keep capturing while the chat field is focused and the pointer is still over the panel's cards.
        let ignore = !inside
        if panel.ignoresMouseEvents != ignore {
            panel.ignoresMouseEvents = ignore
        }
    }

    // MARK: Hover petting

    /// Character rect in screen coordinates (bottom-centre of the panel).
    private func characterScreenRect() -> NSRect {
        let size = prefs.characterSize.points
        let f = panel.frame
        let w = size * 1.0
        let h = size * 0.9
        return NSRect(x: f.midX - w / 2, y: f.minY + 6 + size * 0.2, width: w, height: h)
    }

    /// Three left/right reversals of ≥ 12 pt within 1.5 s over the character count as a stroke.
    private func trackHoverStroke(_ mouse: NSPoint) {
        guard characterScreenRect().contains(mouse), NSEvent.pressedMouseButtons == 0 else {
            lastHoverX = nil
            hoverTravel = 0
            return
        }
        defer { lastHoverX = mouse.x }
        guard let last = lastHoverX else { return }
        let dx = mouse.x - last
        guard abs(dx) >= 1 else { return }
        let dir: CGFloat = dx > 0 ? 1 : -1
        if dir == lastHoverDir {
            hoverTravel += abs(dx)
            return
        }
        let now = Date()
        if hoverTravel >= 12 {
            reversals = reversals.filter { now.timeIntervalSince($0) < 1.5 } + [now]
        }
        lastHoverDir = dir
        hoverTravel = abs(dx)
        if reversals.count >= 3 && now.timeIntervalSince(lastStrokeAt) > 1.2 {
            lastStrokeAt = now
            reversals.removeAll()
            avatar.hoverStroke()
        }
    }

    // MARK: Dragging

    private func beginDrag() {
        dragging = true
        dragStartMouse = NSEvent.mouseLocation
        dragStartOrigin = panel.frame.origin
    }

    /// A press ended without moving: stop capturing like a finished drag, without moving the panel.
    private func cancelPress() {
        dragging = false
    }

    private func continueDrag() {
        guard dragging else { return }
        let m = NSEvent.mouseLocation
        let origin = NSPoint(x: dragStartOrigin.x + (m.x - dragStartMouse.x),
                             y: dragStartOrigin.y + (m.y - dragStartMouse.y))
        panel.setFrameOrigin(origin)
        updateCharacterCenter()
    }

    private func endDrag() {
        guard dragging else { return }
        dragging = false
        let clamped = clampToScreens(panel.frame.origin)
        panel.setFrameOrigin(clamped)
        prefs.panelOrigin = CGPoint(x: clamped.x, y: clamped.y)
        updateCharacterCenter()
        avatar.playGesture(.bounce)
    }

    private func updateCharacterCenter() {
        let f = panel.frame
        let size = prefs.characterSize.points
        avatar.screenCenter = CGPoint(x: f.midX, y: f.minY + 6 + size * 0.65)
    }

    // MARK: Position

    private func restoredOrigin() -> NSPoint {
        if let saved = prefs.panelOrigin {
            return clampToScreens(NSPoint(x: saved.x, y: saved.y))
        }
        let screen = NSScreen.main ?? NSScreen.screens.first
        let vf = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        return NSPoint(x: vf.maxX - Self.panelSize.width - 12, y: vf.minY + 8)
    }

    /// Keeps the character (bottom-centre of the panel) on a visible screen.
    private func clampToScreens(_ origin: NSPoint) -> NSPoint {
        let size = Self.panelSize
        let charPoint = NSPoint(x: origin.x + size.width / 2, y: origin.y + 60)
        let screens = NSScreen.screens
        let screen = screens.first(where: { $0.frame.contains(charPoint) }) ?? NSScreen.main ?? screens.first
        guard let vf = screen?.visibleFrame else { return origin }
        var o = origin
        let halfW = size.width / 2
        let charHalf: CGFloat = 80
        o.x = min(max(o.x, vf.minX - halfW + charHalf), vf.maxX - halfW - charHalf)
        o.y = min(max(o.y, vf.minY - 4), vf.maxY - 200)
        return o
    }
}
