import Foundation
import PixieCore

/// URLSession delegate that forwards socket open/close to the main actor.
/// Kept separate from `LinkClient` so the delegate methods are plain nonisolated ObjC callbacks.
final class WebSocketEvents: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    var onOpen: (@Sendable (URLSessionWebSocketTask) -> Void)?
    var onClose: (@Sendable (URLSessionTask) -> Void)?

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        onOpen?(webSocketTask)
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        onClose?(webSocketTask)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        onClose?(task)
    }
}

/// WebSocket link to the brain (PROTOCOL.md §2):
///  - `Authorization: Bearer <token>` on the upgrade request
///  - `hello` as the first frame after connect
///  - plain-text `ping` every 30 s (brain answers `pong`)
///  - exponential reconnect backoff 1 → 30 s
///  - offline queue of unsent envelopes (cap 100, drop oldest)
@MainActor
final class LinkClient {
    var onEvent: ((IncomingEvent) -> Void)?
    var onConnectionChange: ((Bool) -> Void)?
    /// Called when the brain rejects our token (HTTP 401/403 on upgrade): sign-in is needed.
    var onUnauthorized: (() -> Void)?

    private(set) var isOpen = false

    private let events: WebSocketEvents
    private let session: URLSession
    private var task: URLSessionWebSocketTask?
    private var backoff = Backoff(base: 1, maxDelay: 30)
    private var queue = BoundedQueue<Envelope>(capacity: ProtocolConstants.offlineQueueCap)
    private var pingTimer: Timer?
    private var reconnectWork: DispatchWorkItem?
    private var baseURL: URL?
    private var token: String?
    private var helloName = "Mac"
    private var wantConnected = false
    private var lastPong = Date()

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.waitsForConnectivity = false
        let ev = WebSocketEvents()
        events = ev
        session = URLSession(configuration: config, delegate: ev, delegateQueue: nil)
        events.onOpen = { [weak self] task in
            Task { @MainActor in self?.handleOpen(task) }
        }
        events.onClose = { [weak self] task in
            Task { @MainActor in self?.handleClose(task) }
        }
    }

    // MARK: Public API

    func connect(baseURL: URL, token: String, deviceName: String) {
        self.baseURL = baseURL
        self.token = token
        self.helloName = deviceName
        wantConnected = true
        backoff.reset()
        openSocket()
    }

    func disconnect() {
        wantConnected = false
        reconnectWork?.cancel()
        reconnectWork = nil
        tearDown()
        queue = BoundedQueue<Envelope>(capacity: ProtocolConstants.offlineQueueCap)
    }

    /// Sends now if connected, otherwise queues (cap 100, oldest dropped).
    /// Only the newest `screen.frame` is kept in the queue: stale screenshots are large and useless.
    func send(_ env: Envelope) {
        if isOpen, let task {
            transmit(env, on: task)
        } else {
            enqueue(env)
        }
    }

    func send<T: Encodable>(_ type: String, _ payload: T) {
        guard let env = Envelope.make(type, payload) else { return }
        send(env)
    }

    // MARK: Socket lifecycle

    private func openSocket() {
        tearDown()
        guard wantConnected, let baseURL, let token,
              let wsURL = BrainAPI(baseURL: baseURL, token: token).webSocketURL else { return }
        var request = URLRequest(url: wsURL)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 20
        let t = session.webSocketTask(with: request)
        t.maximumMessageSize = 4 * ProtocolConstants.maxFrameBytes
        task = t
        t.resume()
        receive(on: t)
    }

    private func tearDown() {
        pingTimer?.invalidate()
        pingTimer = nil
        if let t = task {
            task = nil
            t.cancel(with: .goingAway, reason: nil)
        }
        setOpen(false)
    }

    private func handleOpen(_ t: URLSessionWebSocketTask) {
        guard t === task else { return }
        backoff.reset()
        lastPong = Date()
        setOpen(true)

        // hello must be the first frame after connect.
        let hello = HelloData(kind: "mac", name: helloName, app_version: ProtocolConstants.appVersion,
                              capabilities: ["screen", "audio", "voice", "notify"])
        if let env = Envelope.make("hello", hello) {
            transmit(env, on: t)
        }
        flushQueue(on: t)

        pingTimer?.invalidate()
        pingTimer = Timer.scheduledTimer(withTimeInterval: ProtocolConstants.pingInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.sendPing() }
        }
    }

    private func handleClose(_ t: URLSessionTask) {
        guard t === task else { return }
        if let http = t.response as? HTTPURLResponse, http.statusCode == 401 || http.statusCode == 403 {
            wantConnected = false
            tearDown()
            onUnauthorized?()
            return
        }
        task = nil
        t.cancel()
        pingTimer?.invalidate()
        pingTimer = nil
        setOpen(false)
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        guard wantConnected else { return }
        reconnectWork?.cancel()
        let delay = backoff.next()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.wantConnected else { return }
                self.openSocket()
            }
        }
        reconnectWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func setOpen(_ open: Bool) {
        guard open != isOpen else { return }
        isOpen = open
        onConnectionChange?(open)
    }

    // MARK: Frames

    private func sendPing() {
        guard isOpen, let t = task else { return }
        // If the brain stopped answering pings for 2.5 intervals, treat the socket as dead.
        if Date().timeIntervalSince(lastPong) > ProtocolConstants.pingInterval * 2.5 {
            handleClose(t)
            return
        }
        t.send(.string("ping")) { @Sendable [weak self] error in
            if error != nil {
                Task { @MainActor in self?.handleClose(t) }
            }
        }
    }

    private func transmit(_ env: Envelope, on t: URLSessionWebSocketTask) {
        guard let text = env.jsonString() else { return }
        guard text.utf8.count <= ProtocolConstants.maxFrameBytes else {
            NSLog("Pixie: dropping %@ frame larger than 1 MiB", env.type)
            return
        }
        t.send(.string(text)) { @Sendable [weak self] error in
            guard error != nil else { return }
            Task { @MainActor in
                guard let self else { return }
                if env.type != "hello" { self.enqueue(env) }
                self.handleClose(t)
            }
        }
    }

    private func enqueue(_ env: Envelope) {
        if env.type == "hello" { return }
        if env.type == "screen.frame" {
            var kept = queue.drain().filter { $0.type != "screen.frame" }
            kept.append(env)
            queue.prepend(kept)
        } else {
            queue.push(env)
        }
    }

    private func flushQueue(on t: URLSessionWebSocketTask) {
        let pending = queue.drain()
        for env in pending {
            transmit(env, on: t)
        }
    }

    private func receive(on t: URLSessionWebSocketTask) {
        t.receive { @Sendable [weak self] result in
            Task { @MainActor in
                guard let self, t === self.task else { return }
                switch result {
                case .success(let message):
                    switch message {
                    case .string(let text):
                        self.handleText(text)
                    case .data(let data):
                        if let text = String(data: data, encoding: .utf8) { self.handleText(text) }
                    @unknown default:
                        break
                    }
                    self.receive(on: t)
                case .failure:
                    self.handleClose(t)
                }
            }
        }
    }

    private func handleText(_ text: String) {
        lastPong = Date() // any inbound traffic proves liveness
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed == "pong" || trimmed == "ping" { return }
        guard let env = Envelope.parse(trimmed) else { return }
        onEvent?(IncomingEvent(env))
    }
}
