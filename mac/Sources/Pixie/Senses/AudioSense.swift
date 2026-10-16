import AVFoundation
import CoreMedia
import Foundation
import PixieCore
import ScreenCaptureKit
import Speech

/// Receives audio sample buffers from SCStream on a background queue and feeds the current
/// recognition request. All mutable state is guarded by `lock` because SCStream and Speech call back
/// on arbitrary queues.
final class SystemAudioTranscriber: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var latestText = ""
    private var stream: SCStream?
    private var chunkTimer: DispatchSourceTimer?
    private let audioQueue = DispatchQueue(label: "pixie.audio.samples")
    private let chunkSeconds: Int

    /// Delivered on an arbitrary queue.
    var onTranscript: (@Sendable (String, Int) -> Void)?
    var onStopped: (@Sendable () -> Void)?

    init(chunkSeconds: Int = 10) {
        self.chunkSeconds = chunkSeconds
        recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
        super.init()
    }

    var isAvailable: Bool {
        guard let r = recognizer else { return false }
        return r.isAvailable && r.supportsOnDeviceRecognition
    }

    func start(display: SCDisplay, excludingApps: [SCRunningApplication]) async throws {
        let filter = SCContentFilter(display: display, excludingApplications: excludingApps, exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 16_000
        config.channelCount = 1
        // We only want audio; keep the (mandatory) video stream tiny and slow.
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.queueDepth = 5

        let s = SCStream(filter: filter, configuration: config, delegate: self)
        try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
        // A screen output too (ignored in the handler) so SCStream doesn't log dropped video frames.
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: audioQueue)
        lock.lock()
        stream = s
        lock.unlock()
        beginChunk()
        try await s.startCapture()

        let timer = DispatchSource.makeTimerSource(queue: audioQueue)
        timer.schedule(deadline: .now() + .seconds(chunkSeconds), repeating: .seconds(chunkSeconds))
        timer.setEventHandler { [weak self] in self?.rotateChunk() }
        timer.resume()
        lock.lock()
        chunkTimer = timer
        lock.unlock()
    }

    func stop() {
        lock.lock()
        let s = stream
        stream = nil
        chunkTimer?.cancel()
        chunkTimer = nil
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        latestText = ""
        lock.unlock()
        if let s {
            s.stopCapture { _ in }
        }
    }

    // MARK: Chunking — restart the recognition task every chunk to stay under on-device limits.

    private func beginChunk() {
        guard let recognizer else { return }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.requiresOnDeviceRecognition = true
        req.shouldReportPartialResults = true
        req.taskHint = .dictation
        let t = recognizer.recognitionTask(with: req) { [weak self] result, _ in
            guard let self, let result else { return }
            let text = result.bestTranscription.formattedString
            self.lock.lock()
            if self.request === req { self.latestText = text }
            self.lock.unlock()
        }
        lock.lock()
        request = req
        task = t
        latestText = ""
        lock.unlock()
    }

    private func rotateChunk() {
        lock.lock()
        let oldRequest = request
        let oldTask = task
        let text = latestText.trimmingCharacters(in: .whitespacesAndNewlines)
        let running = stream != nil
        lock.unlock()

        oldRequest?.endAudio()
        oldTask?.finish()
        if !text.isEmpty { onTranscript?(text, chunkSeconds) }
        if running { beginChunk() }
    }

    // MARK: SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid else { return }
        lock.lock()
        let req = request
        lock.unlock()
        req?.appendAudioSampleBuffer(sampleBuffer)
    }

    // MARK: SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        stop()
        onStopped?()
    }
}

/// Watch-mode audio: system audio → on-device speech → `audio.transcript` every ~10 s.
@MainActor
final class AudioSense {
    var onTranscript: ((AudioTranscriptData) -> Void)?
    var onUnavailable: ((String) -> Void)?

    private var transcriber: SystemAudioTranscriber?
    private let prefs: Preferences

    init(prefs: Preferences) {
        self.prefs = prefs
    }

    nonisolated static func requestSpeechPermission() async -> Bool {
        await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            SFSpeechRecognizer.requestAuthorization { @Sendable status in
                cont.resume(returning: status == .authorized)
            }
        }
    }

    func start() async {
        stop()
        guard ScreenSense.hasPermission else {
            onUnavailable?("I need Screen Recording permission to hear what you're watching.")
            return
        }
        guard await Self.requestSpeechPermission() else {
            onUnavailable?("I need Speech Recognition permission to follow along.")
            return
        }
        let t = SystemAudioTranscriber(chunkSeconds: 10)
        guard t.isAvailable else {
            onUnavailable?("On-device speech recognition isn't available for your language yet.")
            return
        }
        t.onTranscript = { [weak self] text, seconds in
            Task { @MainActor in
                self?.onTranscript?(AudioTranscriptData(text: text, seconds: seconds, source: "system"))
            }
        }
        t.onStopped = { [weak self] in
            Task { @MainActor in self?.transcriber = nil }
        }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
                return
            }
            let blocked = content.applications.filter {
                CaptureGuard.isBlocked(bundleID: $0.bundleIdentifier, blocklist: prefs.blocklist)
            }
            try await t.start(display: display, excludingApps: blocked)
            transcriber = t
        } catch {
            t.stop()
            onUnavailable?("I couldn't start listening to system audio.")
        }
    }

    func stop() {
        transcriber?.stop()
        transcriber = nil
    }
}
