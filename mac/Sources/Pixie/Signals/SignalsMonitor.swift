import AppKit
import ApplicationServices
import Combine
import EventKit
import Foundation
import PixieCore

/// Context signals (PROTOCOL.md §4.1 `signals.update`): mic / camera in use, music playing, calendar busy,
/// typing and app-switch rates, screen lock. Keeps the latest snapshot for the local pet engine (read every
/// tick through `current`) and sends `signals.update` to the brain on change only (changes within ~2 s are coalesced into one send).
///
/// Nothing here reads content: no audio, no video, no track names, no keys typed (only how many), no event
/// titles, notes, locations or attendees.
@MainActor
final class PixieSignalsMonitor {
    /// Sends `signals.update`. Called only while online; the latest snapshot is re-sent after reconnecting.
    var send: ((PixieSignalsData) -> Void)?
    var isOnline: () -> Bool = { false }
    /// Screen lock state, owned by `PetBodyController` (its lock/unlock observers are reused).
    var screenLocked: () -> Bool = { false }
    /// True while Pixie itself is using the microphone (push-to-talk), so that does not read as a call.
    var ownMicActive: () -> Bool = { false }
    /// A short message for the user (permission denied and similar).
    var onNotice: ((String) -> Void)?

    /// The latest snapshot (also while offline).
    private(set) var current = PixieSignalsData()

    private let prefs: Preferences
    private var lastSent: PixieSignalsData?
    private var debounce: DispatchWorkItem?
    private var pollTimer: Timer?
    private var calendarTimer: Timer?
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
    private var cancellables: Set<AnyCancellable> = []

    // Inputs
    private var micInUse = false
    private var cameraInUse = false
    private var keyTimes: [Double] = []
    private var switchTimes: [Double] = []
    /// Player app name → playing (true) / paused (false). Stopped or quit players are removed.
    private var players: [String: Bool] = [:]
    /// Most recently changed player first.
    private var playerOrder: [String] = []
    private var calendarBusyNow = false
    private var nextBusyInMin: Int?

    // Calendar
    private let eventStore = EKEventStore()
    private var calendarActive = false
    private var calendarRequesting = false

    // Location
    let location: PixieLocationReporter

    static let spotifyBundleID = "com.spotify.client"
    static let musicBundleID = "com.apple.Music"

    init(prefs: Preferences) {
        self.prefs = prefs
        location = PixieLocationReporter(prefs: prefs)
    }

    // MARK: Lifecycle

    func start() {
        stop()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.poll() }
        }
        observeMusic()
        observeCalendarChanges()
        // Settings: the published value arrives before it is stored, so re-read on the next main-loop turn.
        prefs.$useCalendar.dropFirst().sink { [weak self] _ in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.applySettings() } }
        }.store(in: &cancellables)
        prefs.$macLocationChoice.dropFirst().sink { [weak self] _ in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.applySettings() } }
        }.store(in: &cancellables)
        prefs.$androidPaired.dropFirst().sink { [weak self] _ in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.applySettings() } }
        }.store(in: &cancellables)
        location.onNotice = { [weak self] text in self?.onNotice?(text) }
        poll()
        applySettings()
    }

    func stop() {
        pollTimer?.invalidate()
        pollTimer = nil
        stopCalendar()
        location.stop()
        debounce?.cancel()
        debounce = nil
        for (center, o) in observers { center.removeObserver(o) }
        observers.removeAll()
        cancellables.removeAll()
    }

    /// After reconnecting: send the latest snapshot again (and the last location fix).
    func connected() {
        lastSent = nil
        scheduleSend()
        location.connected()
    }

    // MARK: Inputs from elsewhere

    /// One key press anywhere (from the global/local key monitor). Only the time is kept.
    func keyDown() {
        keyTimes.append(Date().timeIntervalSince1970)
        if keyTimes.count > 2000 { keyTimes.removeFirst(keyTimes.count - 2000) }
    }

    /// The frontmost app changed (from `PetBodyController`'s workspace observer).
    func appSwitched() {
        switchTimes.append(Date().timeIntervalSince1970)
        if switchTimes.count > 500 { switchTimes.removeFirst(switchTimes.count - 500) }
    }

    /// Screen locked or unlocked (from `PetBodyController`).
    func screenLockChanged() {
        refresh()
    }

    // MARK: Polling

    private func poll() {
        let mic = PixieDeviceProbes.micInUse()
        // Pixie's own push-to-talk keeps the previous answer instead of looking like a call.
        if !ownMicActive() { micInUse = mic }
        cameraInUse = PixieDeviceProbes.cameraInUse()
        refresh()
    }

    /// Rebuilds the snapshot and schedules a send when it differs from the last one sent.
    private func refresh() {
        let now = Date().timeIntervalSince1970
        keyTimes = PixieSignalMath.prune(keyTimes, now: now, window: 60)
        switchTimes = PixieSignalMath.prune(switchTimes, now: now, window: 300)
        var s = PixieSignalsData()
        s.mic_in_use = micInUse
        s.camera_in_use = cameraInUse
        s.music = musicSignal()
        s.calendar_busy_now = calendarActive && calendarBusyNow
        s.next_busy_in_min = calendarActive ? nextBusyInMin : nil
        // A global key monitor only delivers events with Accessibility access; without it, report "none".
        s.typing_rate = AXIsProcessTrusted() ? PixieSignalMath.typingRate(keysLastMinute: keyTimes.count) : PetTypingRate.none
        s.app_switch_rate = PixieSignalMath.appSwitchRate(switchesLast5Min: switchTimes.count)
        s.screen_locked = screenLocked()
        current = s
        if s != lastSent { scheduleSend() }
    }

    private func scheduleSend() {
        guard debounce == nil else { return }
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.flush() }
        }
        debounce = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: work)
    }

    private func flush() {
        debounce = nil
        // Not queued while offline: `connected()` re-sends the latest snapshot instead.
        guard isOnline(), current != lastSent else { return }
        lastSent = current
        send?(current)
    }

    // MARK: Music

    private func observeMusic() {
        let dn: NotificationCenter = DistributedNotificationCenter.default()
        let pairs: [(String, String)] = [
            ("com.spotify.client.PlaybackStateChanged", "Spotify"),
            ("com.apple.Music.playerInfo", "Music"),
        ]
        for (name, app) in pairs {
            let o = dn.addObserver(forName: NSNotification.Name(name), object: nil, queue: .main) { [weak self] note in
                // Only the player state is read; track, artist and album are ignored.
                let state = note.userInfo?["Player State"] as? String
                MainActor.assumeIsolated { self?.playerChanged(app: app, state: state) }
            }
            observers.append((dn, o))
        }
        let ws: NotificationCenter = NSWorkspace.shared.notificationCenter
        let o = ws.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            let bundle = app?.bundleIdentifier
            MainActor.assumeIsolated {
                if bundle == PixieSignalsMonitor.spotifyBundleID { self?.playerChanged(app: "Spotify", state: "Stopped") }
                if bundle == PixieSignalsMonitor.musicBundleID { self?.playerChanged(app: "Music", state: "Stopped") }
            }
        }
        observers.append((ws, o))
    }

    private func playerChanged(app: String, state: String?) {
        playerOrder.removeAll { $0 == app }
        switch state ?? "" {
        case "Playing":
            players[app] = true
            playerOrder.insert(app, at: 0)
        case "Paused":
            players[app] = false
            playerOrder.insert(app, at: 0)
        default:
            // "Stopped", missing or unknown: this player is not a music signal any more.
            players[app] = nil
        }
        refresh()
    }

    /// The most recent playing player, else the most recent paused one, else nil.
    private func musicSignal() -> PixieMusicSignal? {
        if let app = playerOrder.first(where: { players[$0] == true }) {
            return PixieMusicSignal(app: app, playing: true)
        }
        if let app = playerOrder.first(where: { players[$0] == false }) {
            return PixieMusicSignal(app: app, playing: false)
        }
        return nil
    }

    // MARK: Settings

    private func applySettings() {
        if prefs.useCalendar {
            enableCalendar()
        } else {
            stopCalendar()
        }
        location.setEnabled(prefs.useMacLocation)
    }

    // MARK: Calendar (busy/free only)

    static var calendarAccessGranted: Bool {
        EKEventStore.authorizationStatus(for: .event) == .fullAccess
    }

    static var calendarAccessBlocked: Bool {
        let s = EKEventStore.authorizationStatus(for: .event)
        return s == .denied || s == .restricted
    }

    private func enableCalendar() {
        guard !calendarActive, !calendarRequesting else { return }
        if Self.calendarAccessGranted {
            startCalendar()
            return
        }
        if Self.calendarAccessBlocked {
            prefs.useCalendar = false
            onNotice?("I can't see your calendar. You can allow it in System Settings → Privacy & Security → Calendars.")
            return
        }
        // Not determined (or write-only): ask for full access, which only reads busy/free times here.
        calendarRequesting = true
        // The completion arrives on an arbitrary queue; hop to the main actor.
        eventStore.requestFullAccessToEvents { @Sendable [weak self] granted, _ in
            Task { @MainActor in
                guard let self else { return }
                self.calendarRequesting = false
                if granted && self.prefs.useCalendar {
                    self.startCalendar()
                } else if !granted {
                    self.prefs.useCalendar = false
                    self.onNotice?("Okay, I'll stay out of your calendar.")
                }
            }
        }
    }

    private func startCalendar() {
        calendarActive = true
        calendarTimer?.invalidate()
        calendarTimer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.computeCalendar() }
        }
        computeCalendar()
    }

    private func stopCalendar() {
        calendarTimer?.invalidate()
        calendarTimer = nil
        let was = calendarActive
        calendarActive = false
        calendarBusyNow = false
        nextBusyInMin = nil
        if was { refresh() }
    }

    private func observeCalendarChanges() {
        let o = NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: eventStore, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.calendarActive else { return }
                self.computeCalendar()
            }
        }
        observers.append((NotificationCenter.default, o))
    }

    /// Busy now and minutes to the next busy event, from start/end times only.
    private func computeCalendar() {
        guard calendarActive, Self.calendarAccessGranted else {
            calendarBusyNow = false
            nextBusyInMin = nil
            refresh()
            return
        }
        let now = Date()
        let predicate = eventStore.predicateForEvents(withStart: now.addingTimeInterval(-12 * 3600),
                                                      end: now.addingTimeInterval(24 * 3600), calendars: nil)
        var intervals: [PixieBusyInterval] = []
        for event in eventStore.events(matching: predicate) {
            guard Self.countsAsBusy(event) else { continue }
            let start: Date? = event.startDate
            let end: Date? = event.endDate
            guard let start, let end else { continue }
            intervals.append(PixieBusyInterval(start: start, end: end))
        }
        let status = PixieSignalMath.calendarStatus(intervals, now: now)
        calendarBusyNow = status.busyNow
        nextBusyInMin = status.nextBusyInMin
        refresh()
    }

    /// Timed, not cancelled, not marked free, and not declined by the user. Only these properties are read.
    private static func countsAsBusy(_ event: EKEvent) -> Bool {
        if event.isAllDay { return false }
        if event.status == .canceled { return false }
        if event.availability == .free { return false }
        // The user's own response only (the attendee flagged as the current user); no other attendee data is used.
        if let me = event.attendees?.first(where: { $0.isCurrentUser }), me.participantStatus == .declined {
            return false
        }
        return true
    }
}
