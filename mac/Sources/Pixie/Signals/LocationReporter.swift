import CoreLocation
import Foundation
import PixieCore

/// CoreLocation delegate callbacks; forwarded to the main actor.
final class PixieLocationDelegate: NSObject, CLLocationManagerDelegate, @unchecked Sendable {
    var onLocation: (@Sendable (Double, Double, Double) -> Void)?
    var onAuthChange: (@Sendable () -> Void)?

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let l = locations.last else { return }
        onLocation?(l.coordinate.latitude, l.coordinate.longitude, l.horizontalAccuracy)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // No fix this time (e.g. Wi-Fi off). Weather simply keeps the last location.
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        onAuthChange?()
    }
}

/// The Mac's fallback for `location.update` (PROTOCOL.md §4.1, `source: "mac"`), for weather when no Android
/// phone reports location. Kilometre accuracy, coordinates rounded to 2 decimals before they leave the Mac,
/// sent on start and when moved > 2 km, at most every 15 min. Nothing is stored except the last sent fix.
@MainActor
final class PixieLocationReporter {
    var send: ((PixieLocationData) -> Void)?
    var isOnline: () -> Bool = { false }
    var onNotice: ((String) -> Void)?

    private let prefs: Preferences
    private let manager = CLLocationManager()
    private let delegate = PixieLocationDelegate()
    private var enabled = false
    private var refreshTimer: Timer?

    private var lastSentLat: Double?
    private var lastSentLon: Double?
    private var lastSentAt: Double?
    /// The latest rounded fix, re-sent after reconnecting if it was never delivered.
    private var latest: PixieLocationData?
    private var latestDelivered = false

    init(prefs: Preferences) {
        self.prefs = prefs
        manager.delegate = delegate
        manager.desiredAccuracy = kCLLocationAccuracyKilometer
        manager.distanceFilter = 1000
        delegate.onLocation = { [weak self] lat, lon, acc in
            Task { @MainActor in self?.received(lat: lat, lon: lon, accuracy: acc) }
        }
        delegate.onAuthChange = { [weak self] in
            Task { @MainActor in self?.authorizationChanged() }
        }
    }

    /// Always or when-in-use (raw value 4; compared by value so no availability annotation matters).
    static func isAuthorized(_ s: CLAuthorizationStatus) -> Bool {
        s == .authorizedAlways || s.rawValue == 4
    }

    static func isBlocked(_ s: CLAuthorizationStatus) -> Bool {
        s == .denied || s == .restricted
    }

    func setEnabled(_ on: Bool) {
        guard on != enabled else { return }
        enabled = on
        if on {
            // Turning it on (again) sends a fresh fix straight away.
            lastSentLat = nil
            lastSentLon = nil
            lastSentAt = nil
            begin()
        } else {
            stop()
        }
    }

    func stop() {
        enabled = false
        refreshTimer?.invalidate()
        refreshTimer = nil
        manager.stopUpdatingLocation()
    }

    func connected() {
        guard enabled, let latest, !latestDelivered else { return }
        deliver(latest)
    }

    private func begin() {
        let s = manager.authorizationStatus
        if Self.isAuthorized(s) {
            startUpdates()
        } else if Self.isBlocked(s) {
            stop()
            // Only an explicit "on" is turned off; "auto" stays auto so a later grant just works.
            if prefs.macLocationChoice == PixieLocationChoice.on.rawValue {
                prefs.macLocationChoice = PixieLocationChoice.off.rawValue
                onNotice?("I can't use this Mac's location. You can allow it in System Settings → Privacy & Security → Location Services.")
            }
        } else {
            // Not determined: on macOS this shows the location prompt; the authorization callback continues.
            manager.requestWhenInUseAuthorization()
        }
    }

    private func authorizationChanged() {
        guard enabled else { return }
        let s = manager.authorizationStatus
        if Self.isAuthorized(s) {
            startUpdates()
        } else if Self.isBlocked(s) {
            stop()
            if prefs.macLocationChoice == PixieLocationChoice.on.rawValue {
                prefs.macLocationChoice = PixieLocationChoice.off.rawValue
            }
        }
    }

    private func startUpdates() {
        manager.stopUpdatingLocation()
        manager.startUpdatingLocation()
        // Coarse updates already arrive on movement; restarting every 15 min also catches a Mac that slept
        // through a move. Sending stays limited by `shouldSendLocation`.
        refreshTimer?.invalidate()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 15 * 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.enabled else { return }
                self.manager.stopUpdatingLocation()
                self.manager.startUpdatingLocation()
            }
        }
    }

    private func received(lat: Double, lon: Double, accuracy: Double) {
        guard enabled, lat.isFinite, lon.isFinite, accuracy >= 0 else { return }
        let fix = PixieLocationData.rounded(lat: lat, lon: lon, accuracy: accuracy, source: "mac")
        let now = Date().timeIntervalSince1970
        guard PixieSignalMath.shouldSendLocation(lastLat: lastSentLat, lastLon: lastSentLon, lastSentAt: lastSentAt,
                                                 lat: fix.lat, lon: fix.lon, now: now) else { return }
        lastSentLat = fix.lat
        lastSentLon = fix.lon
        lastSentAt = now
        latest = fix
        latestDelivered = false
        deliver(fix)
    }

    private func deliver(_ fix: PixieLocationData) {
        // Not queued offline: the latest fix is delivered on reconnect instead.
        guard isOnline() else { return }
        send?(fix)
        latestDelivered = true
    }
}
