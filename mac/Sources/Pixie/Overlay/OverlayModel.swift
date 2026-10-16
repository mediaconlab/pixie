import AppKit
import Foundation
import PixieCore
import SwiftUI

struct NoticeItem: Identifiable, Equatable {
    let id = UUID()
    let data: NoticeData
    let createdAt = Date()
}

struct ProposalItem: Identifiable, Equatable {
    var id: String { data.proposal_id }
    let data: ProposeData
}

/// UI state for everything floating around the character: speech bubble, cards, toast, chat field.
@MainActor
final class OverlayModel: ObservableObject {
    // Speech bubble (typewriter)
    @Published private(set) var bubbleText = ""
    @Published private(set) var bubbleVisible = false

    // Cards
    @Published private(set) var notices: [NoticeItem] = []
    @Published private(set) var digest: [DigestItem] = []
    @Published var digestVisible = false
    @Published private(set) var proposals: [ProposalItem] = []
    @Published private(set) var toast: String?
    /// Persistent "Update Pixie" card (brain sent `update_required`). Never auto-hides.
    @Published private(set) var updateMessage: String?

    // Chat
    @Published var chatOpen = false
    @Published var chatText = ""
    @Published var recording = false
    @Published var connected = false

    // Wiring (set by AppController)
    var onSend: ((String, String) -> Void)?
    var onFeedback: ((String, String, String?) -> Void)?
    var onMicDown: (() -> Void)?
    var onMicUp: (() -> Void)?
    /// Called with true while the typewriter runs and nobody is speaking aloud (drives the mouth).
    var onTyping: ((Bool) -> Void)?

    private var fullText: [Character] = []
    private var typeIndex = 0
    private var typeMouth = false
    private var typeTimer: Timer?
    private var hideWork: DispatchWorkItem?
    private var toastWork: DispatchWorkItem?
    private var noticeTimers: [UUID: DispatchWorkItem] = [:]

    // MARK: Bubble

    /// Shows `text` with a typewriter effect. `animateMouth` is false when TTS already animates it.
    func say(_ text: String, animateMouth: Bool) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        typeTimer?.invalidate()
        hideWork?.cancel()
        fullText = Array(trimmed)
        bubbleText = ""
        bubbleVisible = true
        if animateMouth { onTyping?(true) }

        typeIndex = 0
        typeMouth = animateMouth
        let perChar = fullText.count > 160 ? 0.018 : 0.032
        typeTimer = Timer.scheduledTimer(withTimeInterval: perChar, repeats: true) { [weak self] timer in
            MainActor.assumeIsolated {
                guard let self else { timer.invalidate(); return }
                self.typeTick(timer)
            }
        }
    }

    private func typeTick(_ timer: Timer) {
        // Type several characters per tick for long messages so they don't drag.
        let step = fullText.count > 240 ? 3 : 1
        let end = min(fullText.count, typeIndex + step)
        if typeIndex < end {
            bubbleText.append(contentsOf: fullText[typeIndex..<end])
            typeIndex = end
        }
        if typeIndex >= fullText.count {
            timer.invalidate()
            if typeMouth { onTyping?(false) }
            scheduleBubbleHide(chars: fullText.count)
        }
    }

    /// While TTS is talking the bubble never auto-hides.
    private var speaking = false

    func speechStarted() {
        speaking = true
        hideWork?.cancel()
    }

    func speechEnded() {
        speaking = false
        if bubbleVisible && typeIndex >= fullText.count {
            scheduleBubbleHide(chars: 0)
        }
    }

    private func scheduleBubbleHide(chars: Int) {
        hideWork?.cancel()
        if speaking { return }
        let delay = max(4.0, min(14.0, 3.0 + Double(chars) * 0.055))
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                withAnimation(.easeOut(duration: 0.25)) { self?.bubbleVisible = false }
            }
        }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    func dismissBubble() {
        typeTimer?.invalidate()
        hideWork?.cancel()
        onTyping?(false)
        withAnimation(.easeOut(duration: 0.2)) { bubbleVisible = false }
    }

    // MARK: Notices & digest

    func addNotice(_ n: NoticeData) {
        let item = NoticeItem(data: n)
        withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
            notices.insert(item, at: 0)
            if notices.count > 3 { notices.removeLast(notices.count - 3) }
        }
        // Urgent cards linger longer; calls stay until dismissed or 60 s.
        let urgency = n.urgency ?? 0.5
        let life: TimeInterval = n.kind == "call" ? 60 : (urgency >= 0.7 ? 40 : 20)
        let id = item.id
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.dismissNotice(id) }
        }
        noticeTimers[id] = work
        DispatchQueue.main.asyncAfter(deadline: .now() + life, execute: work)
    }

    func dismissNotice(_ id: UUID) {
        noticeTimers[id]?.cancel()
        noticeTimers[id] = nil
        withAnimation(.easeOut(duration: 0.2)) { notices.removeAll { $0.id == id } }
    }

    /// Quiet notices (`interrupt:false`) go to the digest list instead of a card.
    func addToDigest(_ n: NoticeData) {
        let item = DigestItem(from: n.from, app: n.app, summary: n.summary ?? n.preview,
                              urgency: n.urgency, ts: Double(Envelope.nowMillis()))
        digest.insert(item, at: 0)
        if digest.count > 30 { digest.removeLast(digest.count - 30) }
    }

    func showDigest(_ items: [DigestItem]) {
        digest = Array((items + digest).prefix(30))
        withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) { digestVisible = !digest.isEmpty }
    }

    func clearDigest() {
        withAnimation(.easeOut(duration: 0.2)) {
            digestVisible = false
        }
        digest.removeAll()
    }

    // MARK: Proposals

    func addProposal(_ p: ProposeData) {
        withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
            proposals.removeAll { $0.id == p.proposal_id }
            proposals.insert(ProposalItem(data: p), at: 0)
            if proposals.count > 3 { proposals.removeLast(proposals.count - 3) }
        }
        if let exp = p.expires_at {
            let delay = exp / 1000 - Date().timeIntervalSince1970
            if delay > 0 {
                let pid = p.proposal_id
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                    MainActor.assumeIsolated { self?.removeProposal(pid) }
                }
            }
        }
    }

    func respond(to proposalID: String, verdict: String, editedText: String? = nil) {
        onFeedback?(proposalID, verdict, editedText)
        removeProposal(proposalID)
    }

    /// "Not now" maps to `reject`.
    func removeProposal(_ id: String) {
        withAnimation(.easeOut(duration: 0.2)) { proposals.removeAll { $0.id == id } }
    }

    // MARK: Update required

    func showUpdateRequired(_ message: String) {
        withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) { updateMessage = message }
    }

    func clearUpdateRequired() {
        updateMessage = nil
    }

    // MARK: Toast

    func showToast(_ text: String) {
        toastWork?.cancel()
        withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) { toast = text }
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                withAnimation(.easeOut(duration: 0.25)) { self?.toast = nil }
            }
        }
        toastWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 6, execute: work)
    }

    // MARK: Chat

    func toggleChat() {
        withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) { chatOpen.toggle() }
    }

    func openChat() {
        withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) { chatOpen = true }
    }

    func closeChat() {
        withAnimation(.easeOut(duration: 0.2)) { chatOpen = false }
    }

    func submitChat() {
        let text = chatText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        chatText = ""
        onSend?(text, "typed")
    }
}
