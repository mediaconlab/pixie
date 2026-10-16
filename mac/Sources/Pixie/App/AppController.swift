import AppKit
import PixieCore
import SwiftUI

/// Wires senses, link, voice and the overlay together. Every decision is made by the brain; this class
/// only senses, forwards, and performs what the brain sends back.
@MainActor
final class AppController: NSObject, NSWindowDelegate {
    let prefs: Preferences
    let avatar: AvatarModel
    let overlay: OverlayModel
    let link: LinkClient
    let voiceOut: VoiceOut
    let ptt: PushToTalk
    let activity: ActivityMonitor
    let screen: ScreenSense
    let audio: AudioSense

    private var panel: PanelController?
    private var hotKey: HotKey?
    private var statusItem: NSStatusItem?
    private var watchItem: NSMenuItem?
    private var screenItem: NSMenuItem?
    private var connectionItem: NSMenuItem?
    private var updateItem: NSMenuItem?

    private var onboardingWindow: NSWindow?
    private var pairingWindow: NSWindow?
    private var settingsWindow: NSWindow?

    private var watching = false
    private var userName = ""

    /// A new designated initializer (not an override of NSObject.init) so its main-actor isolation
    /// never conflicts with the nonisolated superclass initializer.
    init(prefs p: Preferences) {
        prefs = p
        avatar = AvatarModel()
        overlay = OverlayModel()
        link = LinkClient()
        voiceOut = VoiceOut()
        ptt = PushToTalk()
        activity = ActivityMonitor()
        screen = ScreenSense(prefs: p)
        audio = AudioSense(prefs: p)
        super.init()
    }

    // MARK: Launch

    func start() {
        panel = PanelController(avatar: avatar, overlay: overlay, prefs: prefs)
        panel?.show()
        buildStatusItem()
        wireAvatarAndOverlay()
        wireVoice()
        wireLink()
        wireSenses()

        hotKey = HotKey { [weak self] in self?.hotKeyPressed() }
        hotKey?.start()

        activity.isWatching = { [weak self] in self?.watching ?? false }
        activity.start()

        if prefs.screenSharing && ScreenSense.hasPermission {
            screen.setSharing(true)
        } else if prefs.screenSharing {
            prefs.screenSharing = false
        }
        refreshIndicators()

        if Keychain.get() != nil && prefs.baseURL != nil {
            connect()
            avatar.playGesture(.wave)
            avatar.setEmotion(.happy, intensity: 0.6, hold: 3)
        } else {
            showOnboarding()
        }
    }

    func shutdown() {
        link.disconnect()
        audio.stop()
        voiceOut.stop()
    }

    private func connect() {
        guard let base = prefs.baseURL, let token = Keychain.get() else { return }
        clearUpdateRequired()
        link.connect(baseURL: base, token: token, deviceName: Host.current().localizedName ?? "Mac")
    }

    private func currentAPI() -> BrainAPI? {
        guard let base = prefs.baseURL, let token = Keychain.get() else { return nil }
        return BrainAPI(baseURL: base, token: token)
    }

    // MARK: Wiring

    private func wireAvatarAndOverlay() {
        avatar.onTap = { [weak self] in self?.characterTapped() }
        overlay.onSend = { [weak self] text, via in self?.sendSay(text, via: via) }
        overlay.onFeedback = { [weak self] pid, verdict, edited in
            guard let self else { return }
            self.link.send("user.feedback", UserFeedbackData(proposal_id: pid, verdict: verdict, edited_text: edited))
            switch verdict {
            case "approve":
                self.avatar.setEmotion(.happy, intensity: 0.7, hold: 3)
                self.avatar.playGesture(.nod)
            case "never":
                self.avatar.setEmotion(.shy, intensity: 0.5, hold: 3)
            default:
                self.avatar.playGesture(.nod)
            }
        }
        overlay.onTyping = { [weak self] on in self?.avatar.setTypingTalking(on) }
        overlay.onMicDown = { [weak self] in self?.micDown() }
        overlay.onMicUp = { [weak self] in self?.micUp() }
    }

    private func wireVoice() {
        voiceOut.onSpeakingChanged = { [weak self] speaking in
            guard let self else { return }
            self.avatar.setTTSTalking(speaking)
            if speaking { self.overlay.speechStarted() } else { self.overlay.speechEnded() }
        }
        voiceOut.onWord = { [weak self] in self?.avatar.wordSpoken() }

        ptt.onPartial = { [weak self] text in self?.overlay.chatText = text }
        ptt.onFinal = { [weak self] text in
            guard let self else { return }
            self.overlay.chatText = ""
            self.sendSay(text, via: "voice")
        }
        ptt.onError = { [weak self] message in
            guard let self else { return }
            self.overlay.recording = false
            self.avatar.listening = false
            self.localSay(message, emotion: .concerned)
        }
    }

    private func wireLink() {
        link.onEvent = { [weak self] event in self?.handle(event) }
        link.onConnectionChange = { [weak self] open in
            guard let self else { return }
            self.avatar.connected = open
            self.overlay.connected = open
            if self.link.updateRequiredMessage != nil {
                self.connectionItem?.title = "Update required"
            } else {
                self.connectionItem?.title = open ? "Connected to brain" : "Connecting…"
            }
            if open { self.activity.resend() }
        }
        link.onUnauthorized = { [weak self] in
            guard let self else { return }
            self.localSay("My brain doesn't recognise this Mac any more. Let's sign in again!", emotion: .sad)
            Keychain.delete()
            self.showOnboarding()
        }
        link.onUpdateRequired = { [weak self] message in self?.showUpdateRequired(message) }
    }

    /// The brain no longer supports this app's protocol. The link has stopped reconnecting.
    private func showUpdateRequired(_ message: String) {
        overlay.showUpdateRequired(message)
        connectionItem?.title = "Update required"
        updateItem?.isHidden = false
        avatar.connected = false
        overlay.connected = false
        avatar.setEmotion(.sad, intensity: 0.5, hold: 4)
    }

    private func clearUpdateRequired() {
        overlay.clearUpdateRequired()
        updateItem?.isHidden = true
    }

    private func wireSenses() {
        screen.onFrame = { [weak self] frame in self?.link.send("screen.frame", frame) }
        audio.onTranscript = { [weak self] t in self?.link.send("audio.transcript", t) }
        audio.onUnavailable = { [weak self] message in self?.localSay(message, emotion: .concerned) }
        activity.onChange = { [weak self] state in
            guard let self, self.link.isOpen else { return } // re-sent on reconnect, so never queued stale
            self.link.send("state.update", state)
        }
    }

    // MARK: Incoming events

    private func handle(_ event: IncomingEvent) {
        switch event {
        case .welcome(let w):
            userName = w.user_name ?? prefs.userName
            avatar.setEmotion(.happy, intensity: 0.5, hold: 2)
        case .perform(let p):
            act(p)
        case .notice(let n):
            if n.interrupt == false {
                overlay.addToDigest(n)
            } else {
                overlay.addNotice(n)
                avatar.wake()
                let urgent = (n.urgency ?? 0) >= 0.7
                avatar.setEmotion(urgent ? .surprised : .curious, intensity: urgent ? 0.8 : 0.5, hold: 3)
                avatar.playGesture(n.kind == "call" ? .jump : .bounce)
            }
        case .digest(let d):
            overlay.showDigest(d.items)
            avatar.playGesture(.nod)
        case .propose(let p):
            overlay.addProposal(p)
            avatar.wake()
            avatar.setEmotion(.curious, intensity: 0.6, hold: 4)
            avatar.playGesture(.leanIn)
        case .execute(let x):
            execute(x)
        case .auto(let a):
            if let detail = a.detail, !detail.isEmpty { overlay.showToast(detail) }
        case .captureRequest(let r):
            handleCaptureRequest(reason: r.reason ?? "asked")
        case .updateRequired(let u):
            // LinkClient intercepts this before onEvent; handled here too so the switch stays exhaustive.
            showUpdateRequired(u.displayMessage)
        case .error(let e):
            NSLog("Pixie brain error: %@ %@", e.code ?? "?", e.message ?? "")
            if e.code == "rate_limited" {
                overlay.showToast("I'm thinking too fast — give me a moment.")
            }
        case .unknown:
            break
        }
    }

    private func act(_ p: Performance) {
        avatar.play(p)
        let speakAloud = p.speak && prefs.voiceEnabled
        if !p.say.isEmpty {
            overlay.say(p.say, animateMouth: !speakAloud)
            if speakAloud { voiceOut.speak(p.say, voice: p.voice) }
        }
    }

    /// Pixie talking on its own (offline / permission hints) without the brain.
    private func localSay(_ text: String, emotion: Emotion) {
        act(Performance(say: text, emotion: emotion, intensity: 0.6, gesture: GestureKind.none, gaze: .user,
                            voice: PixieVoiceSpec(), speak: false))
    }

    /// Only `reminder` can be executed on the Mac. The brain sends `bot.execute` only after an approve tap.
    private func execute(_ x: ExecuteData) {
        guard x.kind == "reminder" else { return }
        let text = x.payload?["text"]?.stringValue ?? "Reminder!"
        let atMs = x.payload?["at"]?.doubleValue ?? 0
        let delay = max(0, atMs / 1000 - Date().timeIntervalSince1970)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.avatar.wake()
                self.act(Performance(say: "⏰ " + text, emotion: .excited, intensity: 0.8, gesture: .jump,
                                         gaze: .user, voice: PixieVoiceSpec(), speak: true))
            }
        }
    }

    private func handleCaptureRequest(reason: String) {
        guard prefs.screenSharing || watching else {
            localSay("I'd love to look, but I can't see your screen yet. Turn on “Let Pixie see my screen” in my menu ✨", emotion: .shy)
            return
        }
        avatar.play(Performance(emotion: .curious, intensity: 0.6, gesture: .leanIn, gaze: .screen))
        Task { @MainActor in
            let result = await self.screen.capture(reason: "asked", skipIfUnchanged: false)
            switch result {
            case .frame(let f):
                self.link.send("screen.frame", f)
            case .blocked:
                self.localSay("That window is private, so I won't peek. 🙈", emotion: .shy)
            case .noPermission:
                self.localSay("macOS hasn't given me Screen Recording permission yet. Can you allow it in System Settings → Privacy & Security?", emotion: .concerned)
                ScreenSense.requestPermission()
            case .unchanged, .failed:
                self.localSay("Hmm, I couldn't grab your screen just now.", emotion: .concerned)
            }
        }
    }

    // MARK: User actions

    private func sendSay(_ text: String, via: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        link.send("user.say", UserSayData(text: t, via: via))
        avatar.wake()
        avatar.setEmotion(.thinking, intensity: 0.6, hold: 6)
        voiceOut.stop()
        overlay.dismissBubble()
        if !link.isOpen {
            overlay.showToast("I'm offline right now — I'll pass that on when I'm back.")
        }
    }

    private func characterTapped() {
        avatar.wake()
        if overlay.chatOpen {
            overlay.closeChat()
        } else {
            overlay.openChat()
            panel?.focusForTyping()
            avatar.playGesture(.bounce)
        }
    }

    private func hotKeyPressed() {
        avatar.wake()
        if overlay.chatOpen {
            overlay.closeChat()
        } else {
            overlay.openChat()
            panel?.focusForTyping()
        }
    }

    private func micDown() {
        voiceOut.stop()
        overlay.recording = true
        avatar.listening = true
        avatar.setEmotion(.curious, intensity: 0.5, hold: 5)
        Task { @MainActor in await self.ptt.begin() }
    }

    private func micUp() {
        overlay.recording = false
        avatar.listening = false
        ptt.end()
    }

    private func setScreenSharing(_ on: Bool) {
        if on && !ScreenSense.hasPermission {
            ScreenSense.requestPermission()
            if !ScreenSense.hasPermission {
                localSay("Please allow Screen Recording for Pixie in System Settings → Privacy & Security, then turn this on again (you may need to restart me).", emotion: .shy)
                return
            }
        }
        prefs.screenSharing = on
        screen.setSharing(on)
        refreshIndicators()
        if on {
            avatar.play(Performance(say: "Ooh, I can see now! I'll only peek when things change.", emotion: .excited,
                                    intensity: 0.7, gesture: .bounce, gaze: .screen, speak: false))
        } else {
            avatar.setEmotion(.neutral, intensity: 0.5)
        }
        activity.evaluate()
    }

    private func setWatching(_ on: Bool) {
        if on && !ScreenSense.hasPermission {
            ScreenSense.requestPermission()
            if !ScreenSense.hasPermission {
                localSay("To watch with you I need Screen Recording permission. You'll find it in System Settings → Privacy & Security.", emotion: .shy)
                return
            }
        }
        watching = on
        screen.setWatching(on)
        if on {
            Task { @MainActor in await self.audio.start() }
            avatar.play(Performance(say: "Yay, movie time! 🍿", emotion: .excited, intensity: 0.8, gesture: .dance,
                                    gaze: .screen, speak: false))
        } else {
            audio.stop()
        }
        refreshIndicators()
        activity.evaluate()
    }

    private func refreshIndicators() {
        avatar.eyeIndicator = prefs.screenSharing || watching
        screenItem?.state = prefs.screenSharing ? .on : .off
        watchItem?.state = watching ? .on : .off
    }

    // MARK: Menu bar

    private func buildStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = item.button {
            let image = NSImage(systemSymbolName: "sparkles", accessibilityDescription: "Pixie")
            image?.isTemplate = true
            button.image = image
        }
        let menu = NSMenu()
        menu.autoenablesItems = false

        let conn = NSMenuItem(title: "Connecting…", action: nil, keyEquivalent: "")
        conn.isEnabled = false
        menu.addItem(conn)
        connectionItem = conn
        let upd = makeItem("Update Pixie", #selector(menuUpdate))
        upd.isHidden = true
        menu.addItem(upd)
        updateItem = upd
        menu.addItem(.separator())

        menu.addItem(makeItem("Talk to Pixie", #selector(menuTalk)))
        let w = makeItem("Watch with me", #selector(menuWatch))
        menu.addItem(w)
        watchItem = w
        let s = makeItem("Let Pixie see my screen", #selector(menuScreen))
        menu.addItem(s)
        screenItem = s
        menu.addItem(.separator())
        menu.addItem(makeItem("Pair a device…", #selector(menuPair)))
        menu.addItem(makeItem("Settings…", #selector(menuSettings), key: ","))
        menu.addItem(makeItem("Bring Pixie back", #selector(menuResetPosition)))
        menu.addItem(.separator())
        menu.addItem(makeItem("Quit Pixie", #selector(menuQuit), key: "q"))

        item.menu = menu
        statusItem = item
    }

    private func makeItem(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.target = self
        i.isEnabled = true
        return i
    }

    @objc private func menuTalk() {
        overlay.openChat()
        panel?.focusForTyping()
        avatar.wake()
    }

    @objc private func menuWatch() { setWatching(!watching) }

    @objc private func menuScreen() { setScreenSharing(!prefs.screenSharing) }

    @objc private func menuPair() { showPairing() }

    @objc private func menuSettings() { showSettings() }

    @objc private func menuResetPosition() {
        panel?.resetPosition()
        panel?.show()
        avatar.playGesture(.wave)
    }

    @objc private func menuQuit() { NSApp.terminate(nil) }

    @objc private func menuUpdate() {
        let alert = NSAlert()
        alert.messageText = "Update Pixie"
        alert.informativeText = link.updateRequiredMessage ?? overlay.updateMessage ?? ProtocolConstants.defaultUpdateMessage
        alert.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        _ = alert.runModal()
    }

    // MARK: Windows

    private func present(_ window: NSWindow) {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    private func makeWindow<V: View>(_ title: String, _ view: V) -> NSWindow {
        let host = NSHostingController(rootView: view)
        let w = NSWindow(contentViewController: host)
        w.title = title
        w.styleMask = [.titled, .closable]
        w.isReleasedWhenClosed = false
        w.delegate = self
        w.center()
        return w
    }

    private func showOnboarding() {
        link.disconnect()
        if let w = onboardingWindow {
            present(w)
            return
        }
        let view = OnboardingView(prefs: prefs, preview: AvatarModel()) { [weak self] resp in
            self?.registered(resp)
        }
        let w = makeWindow("Welcome to Pixie", view)
        onboardingWindow = w
        present(w)
    }

    private func registered(_ resp: RegisterResponse) {
        Keychain.set(resp.token)
        prefs.deviceID = resp.device_id
        onboardingWindow?.close()
        onboardingWindow = nil
        connect()
        let name = prefs.userName.isEmpty ? "friend" : prefs.userName
        act(Performance(say: "Yay! Nice to meet you, \(name)! Click me anytime to chat ✨", emotion: .excited,
                            intensity: 0.9, gesture: .wave, gaze: .user, voice: PixieVoiceSpec(pace: .normal, pitch: 1),
                            speak: true))
    }

    private func showPairing() {
        guard currentAPI() != nil else {
            showOnboarding()
            return
        }
        // Always fresh, so a new code is fetched each time the window opens.
        pairingWindow?.close()
        let model = PairingModel(api: { [weak self] in self?.currentAPI() }, ownDeviceID: prefs.deviceID)
        let w = makeWindow("Pair a device", PairingView(model: model))
        pairingWindow = w
        present(w)
    }

    private func showSettings() {
        if let w = settingsWindow {
            present(w)
            return
        }
        let view = SettingsView(
            prefs: prefs,
            onBrainURLCommitted: { [weak self] in
                guard let self else { return }
                self.link.disconnect()
                self.connect()
            },
            onIntervalChanged: { [weak self] in self?.screen.intervalChanged() },
            onForgetMe: { @MainActor [weak self] in
                guard let api = self?.currentAPI() else { return BrainAPIError.notSignedIn.errorDescription }
                do {
                    try await api.forgetMe()
                    self?.localSay("Okay… I forgot everything. Hi, I'm Pixie! 🌱", emotion: .shy)
                    return nil
                } catch {
                    return (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                }
            },
            onSignOut: { [weak self] in self?.signOut() }
        )
        let w = makeWindow("Pixie Settings", view)
        settingsWindow = w
        present(w)
    }

    private func signOut() {
        link.disconnect()
        Keychain.delete()
        prefs.deviceID = ""
        setWatching(false)
        if prefs.screenSharing { setScreenSharing(false) }
        settingsWindow?.close()
        avatar.setEmotion(.sad, intensity: 0.6, hold: 4)
        showOnboarding()
    }

    // MARK: NSWindowDelegate

    func windowWillClose(_ notification: Notification) {
        guard let w = notification.object as? NSWindow else { return }
        if w === pairingWindow { pairingWindow = nil }
        if w === settingsWindow { settingsWindow = nil }
        if w === onboardingWindow { onboardingWindow = nil }
    }
}
