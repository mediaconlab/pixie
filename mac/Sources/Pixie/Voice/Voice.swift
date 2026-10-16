import AVFoundation
import Foundation
import PixieCore
import Speech

// MARK: - Text to speech

/// AVSpeechSynthesizer delegate callbacks arrive off the main thread; this forwards them.
final class SpeechDelegate: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
    var onStart: (@Sendable () -> Void)?
    var onFinish: (@Sendable () -> Void)?
    var onWord: (@Sendable () -> Void)?

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        onStart?()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        onFinish?()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        onFinish?()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, willSpeakRangeOfSpeechString characterRange: NSRange, utterance: AVSpeechUtterance) {
        onWord?()
    }
}

@MainActor
final class VoiceOut {
    var onSpeakingChanged: ((Bool) -> Void)?
    var onWord: (() -> Void)?

    private let synth = AVSpeechSynthesizer()
    private let delegate = SpeechDelegate()
    private lazy var voice: AVSpeechSynthesisVoice? = VoiceOut.pickVoice()
    private var pending = 0

    init() {
        synth.delegate = delegate
        delegate.onStart = { [weak self] in
            Task { @MainActor in self?.onSpeakingChanged?(true) }
        }
        delegate.onFinish = { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.pending = max(0, self.pending - 1)
                if self.pending == 0 { self.onSpeakingChanged?(false) }
            }
        }
        delegate.onWord = { [weak self] in
            Task { @MainActor in self?.onWord?() }
        }
    }

    var isSpeaking: Bool { synth.isSpeaking }

    func speak(_ text: String, voice spec: PixieVoiceSpec) {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        stop()
        let u = AVSpeechUtterance(string: clean)
        u.voice = voice
        let base = AVSpeechUtteranceDefaultSpeechRate
        switch spec.pace {
        case .slow: u.rate = base * 0.85
        case .normal: u.rate = base * 1.02
        case .fast: u.rate = min(AVSpeechUtteranceMaximumSpeechRate, base * 1.18)
        }
        // Friendly, slightly high voice; pitch −2…2 maps to 1.0…1.5 (valid range 0.5…2.0).
        u.pitchMultiplier = Float(max(0.5, min(2.0, 1.25 + 0.12 * Double(spec.pitch))))
        u.volume = 0.9
        u.preUtteranceDelay = 0.05
        pending += 1
        synth.speak(u)
    }

    func stop() {
        if synth.isSpeaking {
            _ = synth.stopSpeaking(at: .immediate)
        }
    }

    /// Prefers a higher-quality female English voice (they sound friendlier at higher pitch).
    static func pickVoice() -> AVSpeechSynthesisVoice? {
        let lang = Locale.preferredLanguages.first ?? "en-US"
        let all = AVSpeechSynthesisVoice.speechVoices()
        let noveltyNames = ["Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos", "Good News",
                            "Jester", "Organ", "Superstar", "Trinoids", "Whisper", "Wobble", "Zarvox", "Eddy",
                            "Flo", "Grandma", "Grandpa", "Reed", "Rocko", "Sandy", "Shelley"]
        let preferredNames = ["Samantha", "Ava", "Zoe", "Allison", "Susan", "Karen", "Moira", "Tessa", "Serena"]
        let sameLang = all.filter { $0.language.hasPrefix(String(lang.prefix(2))) }
        let pool = sameLang.isEmpty ? all.filter { $0.language.hasPrefix("en") } : sameLang

        func score(_ v: AVSpeechSynthesisVoice) -> Int {
            var s = 0
            switch v.quality {
            case .premium: s += 30
            case .enhanced: s += 20
            default: s += 0
            }
            if v.gender == .female { s += 10 }
            if let i = preferredNames.firstIndex(where: { v.name.contains($0) }) { s += 15 - i }
            if v.language == lang { s += 5 }
            // Novelty voices (Bells, Bubbles…) are fun but hard to understand.
            if noveltyNames.contains(where: { v.name.contains($0) }) { s -= 100 }
            return s
        }
        return pool.max(by: { score($0) < score($1) }) ?? AVSpeechSynthesisVoice(language: lang)
    }
}

// MARK: - Push-to-talk

/// Microphone → on-device SFSpeechRecognizer while the mic button is held.
@MainActor
final class PushToTalk {
    var onPartial: ((String) -> Void)?
    var onFinal: ((String) -> Void)?
    var onError: ((String) -> Void)?

    private let engine = AVAudioEngine()
    private let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var latest = ""
    private var active = false
    private var finished = false
    /// True while the mic button is physically held (begin() is async, so the user may release early).
    private var pressed = false

    var isActive: Bool { active }

    nonisolated static func requestMicPermission() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .notDetermined:
            return await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
                AVCaptureDevice.requestAccess(for: .audio) { @Sendable ok in cont.resume(returning: ok) }
            }
        default: return false
        }
    }

    func begin() async {
        guard !active else { return }
        pressed = true
        guard await PushToTalk.requestMicPermission() else {
            onError?("I need microphone access to hear you. You can turn it on in System Settings → Privacy & Security → Microphone.")
            return
        }
        guard await AudioSense.requestSpeechPermission() else {
            onError?("I need Speech Recognition permission to understand you.")
            return
        }
        guard let recognizer, recognizer.isAvailable else {
            onError?("Speech recognition isn't available right now.")
            return
        }

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition {
            req.requiresOnDeviceRecognition = true
        }
        request = req
        latest = ""
        finished = false

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0 && format.channelCount > 0 else {
            onError?("I can't find a microphone.")
            request = nil
            return
        }
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format, block: PushToTalk.makeTap(req))

        task = recognizer.recognitionTask(with: req) { @Sendable [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let failed = error != nil
            Task { @MainActor in
                guard let self else { return }
                if let text {
                    self.latest = text
                    self.onPartial?(text)
                }
                if isFinal || (failed && !self.active) {
                    self.deliver()
                }
            }
        }

        engine.prepare()
        do {
            try engine.start()
            active = true
            if !pressed { end() }
        } catch {
            input.removeTap(onBus: 0)
            task?.cancel()
            task = nil
            request = nil
            onError?("I couldn't start the microphone.")
        }
    }

    /// Built outside the main actor: the tap block runs on a realtime audio thread.
    nonisolated static func makeTap(_ req: SFSpeechAudioBufferRecognitionRequest) -> AVAudioNodeTapBlock {
        return { buffer, _ in
            req.append(buffer)
        }
    }

    func end() {
        pressed = false
        guard active else { return }
        active = false
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        // If the final result doesn't arrive promptly, send what we have.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            MainActor.assumeIsolated { self?.deliver() }
        }
    }

    private func deliver() {
        guard !finished, !active else { return }
        finished = true
        task?.cancel()
        task = nil
        request = nil
        let text = latest.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { onFinal?(text) }
    }
}
