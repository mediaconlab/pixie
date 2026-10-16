import AppKit
import PixieCore
import SwiftUI

// MARK: - Interactive hit regions

/// Collects the frames (in the "overlay" coordinate space, origin top-left) of every view that should
/// receive clicks. The panel controller polls the mouse and toggles `ignoresMouseEvents` from these.
final class HitRegionStore: @unchecked Sendable {
    var rects: [CGRect] = []
}

struct InteractiveRectsKey: PreferenceKey {
    static let defaultValue: [CGRect] = []
    static func reduce(value: inout [CGRect], nextValue: () -> [CGRect]) {
        value.append(contentsOf: nextValue())
    }
}

extension View {
    /// Marks this view as clickable (clicks elsewhere in the panel pass through to apps below).
    func interactiveRegion() -> some View {
        background(
            GeometryReader { geo in
                Color.clear.preference(key: InteractiveRectsKey.self, value: [geo.frame(in: .named("overlay"))])
            }
        )
    }

    func cardStyle() -> some View {
        self
            .padding(12)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color(nsColor: .windowBackgroundColor).opacity(0.97))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(Color.primary.opacity(0.08), lineWidth: 1)
            )
            .shadow(color: Color.black.opacity(0.18), radius: 10, x: 0, y: 4)
    }
}

// MARK: - Root overlay

struct OverlayRootView: View {
    @ObservedObject var avatar: AvatarModel
    @ObservedObject var overlay: OverlayModel
    @ObservedObject var prefs: Preferences
    let hitStore: HitRegionStore

    /// Built outside `body` so the (possibly @Sendable) preference callback only captures the store.
    static func updater(for store: HitRegionStore) -> @Sendable ([CGRect]) -> Void {
        return { rects in store.rects = rects }
    }

    var body: some View {
        let size = prefs.characterSize.points
        VStack(spacing: 8) {
            Spacer(minLength: 0)
            CardsColumn(overlay: overlay)
            if overlay.bubbleVisible {
                SpeechBubble(text: overlay.bubbleText)
                    .interactiveRegion()
                    .onTapGesture { overlay.userClosedBubble() }
                    .transition(.scale(scale: 0.85, anchor: .bottom).combined(with: .opacity))
            }
            if overlay.chatOpen {
                ChatField(overlay: overlay)
                    .interactiveRegion()
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            CharacterView(model: avatar, size: size)
                .interactiveRegion()
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 6)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .coordinateSpace(name: "overlay")
        .onPreferenceChange(InteractiveRectsKey.self, perform: Self.updater(for: hitStore))
    }
}

struct CardsColumn: View {
    @ObservedObject var overlay: OverlayModel

    var body: some View {
        VStack(spacing: 8) {
            if let message = overlay.updateMessage {
                UpdateRequiredCard(message: message)
                    .interactiveRegion()
                    .transition(.opacity)
            }
            if let toast = overlay.toast {
                ToastView(text: toast)
                    .interactiveRegion()
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
            ForEach(overlay.notices) { item in
                NoticeCard(item: item, onClose: { overlay.dismissNotice(item.id) })
                    .interactiveRegion()
                    .transition(.scale(scale: 0.9).combined(with: .opacity))
            }
            if overlay.digestVisible && !overlay.digest.isEmpty {
                DigestCard(items: overlay.digest, onClose: { overlay.clearDigest() })
                    .interactiveRegion()
                    .transition(.opacity)
            }
            ForEach(overlay.proposals) { item in
                ProposalCard(item: item, overlay: overlay)
                    .interactiveRegion()
                    .transition(.scale(scale: 0.9).combined(with: .opacity))
            }
            if !overlay.digestVisible && !overlay.digest.isEmpty {
                Button {
                    withAnimation { overlay.digestVisible = true }
                } label: {
                    Label("\(overlay.digest.count) quiet update\(overlay.digest.count == 1 ? "" : "s")", systemImage: "tray.full")
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(Capsule().fill(Color(nsColor: .windowBackgroundColor).opacity(0.95)))
                        .shadow(color: Color.black.opacity(0.15), radius: 4, y: 2)
                }
                .buttonStyle(.plain)
                .interactiveRegion()
            }
        }
    }
}

// MARK: - Speech bubble

struct SpeechBubble: View {
    let text: String

    var body: some View {
        VStack(spacing: 0) {
            Text(text.isEmpty ? " " : text)
                .font(.system(size: 13.5, weight: .medium, design: .rounded))
                .foregroundStyle(Color(red: 0.16, green: 0.15, blue: 0.25))
                .multilineTextAlignment(.leading)
                .lineLimit(12)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .frame(maxWidth: 300, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(Color.white)
                )
            BubbleTail()
                .fill(Color.white)
                .frame(width: 18, height: 10)
        }
        .compositingGroup()
        .shadow(color: Color.black.opacity(0.16), radius: 8, x: 0, y: 3)
    }
}

// MARK: - Toast (bot.auto)

struct ToastView: View {
    let text: String
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "wand.and.stars")
                .foregroundStyle(Color(red: 0.55, green: 0.45, blue: 0.95))
            Text(text)
                .font(.system(size: 12, weight: .medium, design: .rounded))
                .lineLimit(3)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Capsule().fill(Color(nsColor: .windowBackgroundColor).opacity(0.97)))
        .shadow(color: Color.black.opacity(0.15), radius: 6, y: 2)
        .frame(maxWidth: 320)
    }
}

// MARK: - Update required (update_required / close 4002)

struct UpdateRequiredCard: View {
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "arrow.down.circle.fill")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(Color(red: 0.95, green: 0.33, blue: 0.36))
            VStack(alignment: .leading, spacing: 3) {
                Text("Update Pixie")
                    .font(.system(size: 13, weight: .bold, design: .rounded))
                Text(message)
                    .font(.system(size: 12, design: .rounded))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .frame(width: 300)
        .cardStyle()
    }
}

// MARK: - Notice (bot.notice)

func urgencyColor(_ u: Double?) -> Color {
    let v = u ?? 0.3
    if v >= 0.7 { return Color(red: 0.95, green: 0.33, blue: 0.36) }
    if v >= 0.4 { return Color(red: 0.98, green: 0.62, blue: 0.25) }
    return Color(red: 0.36, green: 0.72, blue: 0.55)
}

func appGlyph(kind: String?, app: String?) -> String {
    if kind == "call" { return "phone.fill" }
    switch app ?? "" {
    case "whatsapp", "whatsapp_business": return "bubble.left.and.bubble.right.fill"
    case "sms": return "message.fill"
    default: return "bell.fill"
    }
}

struct NoticeCard: View {
    let item: NoticeItem
    let onClose: () -> Void

    var body: some View {
        let n = item.data
        let tint = urgencyColor(n.urgency)
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: appGlyph(kind: n.kind, app: n.app))
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Color.white)
                .frame(width: 34, height: 34)
                .background(Circle().fill(tint))
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(n.from ?? "Someone")
                        .font(.system(size: 13, weight: .bold, design: .rounded))
                    Spacer(minLength: 4)
                    Text(n.kind == "call" ? "Calling" : (n.app ?? "Message").capitalized)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(tint)
                }
                if let summary = n.summary, !summary.isEmpty {
                    Text(summary)
                        .font(.system(size: 12, design: .rounded))
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let preview = n.preview, !preview.isEmpty {
                    Text("“\(preview)”")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
        }
        .frame(width: 300)
        .cardStyle()
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: 2).fill(tint).frame(width: 4).padding(.vertical, 12)
        }
    }
}

// MARK: - Digest (bot.digest)

struct DigestCard: View {
    let items: [DigestItem]
    let onClose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("While you were busy", systemImage: "tray.full.fill")
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                Spacer()
                Button("Clear", action: onClose)
                    .buttonStyle(.plain)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                        HStack(alignment: .top, spacing: 8) {
                            Circle().fill(urgencyColor(item.urgency)).frame(width: 7, height: 7).padding(.top, 5)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(item.from ?? "Someone")
                                    .font(.system(size: 11.5, weight: .semibold, design: .rounded))
                                Text(item.summary ?? "")
                                    .font(.system(size: 11))
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Spacer(minLength: 0)
                            if let ts = item.ts {
                                Text(Date(timeIntervalSince1970: ts / 1000), style: .time)
                                    .font(.system(size: 9.5))
                                    .foregroundStyle(.tertiary)
                            }
                        }
                    }
                }
            }
            .frame(maxHeight: 170)
        }
        .frame(width: 300)
        .cardStyle()
    }
}

// MARK: - Proposal (bot.propose)

struct ProposalCard: View {
    let item: ProposalItem
    @ObservedObject var overlay: OverlayModel

    @State private var editing = false
    @State private var draft = ""
    /// True while the inline "Never for…" scope choice is showing.
    @State private var choosingNever = false

    init(item: ProposalItem, overlay: OverlayModel) {
        self.item = item
        _overlay = ObservedObject(wrappedValue: overlay)
    }

    var body: some View {
        let p = item.data
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: icon(for: p.kind))
                    .foregroundStyle(Color(red: 0.55, green: 0.45, blue: 0.95))
                Text(p.title ?? "Can I do something?")
                    .font(.system(size: 13, weight: .bold, design: .rounded))
                Spacer(minLength: 0)
                if p.isExploration {
                    Text("Trying this out")
                        .font(.system(size: 10, weight: .medium, design: .rounded))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(Color.primary.opacity(0.06)))
                        .help("Pixie is learning which messages you want reply ideas for.")
                }
            }
            if editing {
                TextEditor(text: $draft)
                    .font(.system(size: 12))
                    .frame(height: 64)
                    .scrollContentBackground(.hidden)
                    .padding(4)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.06)))
            } else if let detail = p.detail, !detail.isEmpty {
                Text(detail)
                    .font(.system(size: 12, design: .rounded))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !editing, let why = p.whyText {
                Text(why)
                    .font(.system(size: 10, design: .rounded))
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if choosingNever && !editing {
                neverScopeChooser(p)
            } else {
                actionButtons(p)
            }
            if !editing && !choosingNever && !p.knownQuickActions.isEmpty {
                HStack(spacing: 6) {
                    ForEach(p.knownQuickActions) { action in
                        Button(action.label) {
                            overlay.respond(to: p.proposal_id, verdict: "never", scope: action.scope)
                        }
                        .buttonStyle(.bordered)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    }
                    Spacer(minLength: 0)
                }
                .controlSize(.mini)
            }
        }
        .frame(width: 300)
        .cardStyle()
    }

    @ViewBuilder
    private func actionButtons(_ p: ProposeData) -> some View {
        HStack(spacing: 6) {
            if editing {
                Button("Send edit") {
                    overlay.respond(to: p.proposal_id, verdict: "approve", editedText: draft)
                }
                .buttonStyle(.borderedProminent)
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button("Cancel") { editing = false }
                    .buttonStyle(.bordered)
            } else {
                Button("Approve") {
                    overlay.respond(to: p.proposal_id, verdict: "approve")
                }
                .buttonStyle(.borderedProminent)
                // Only message drafts are editable; the brain ignores edits to other kinds.
                if p.kind == "whatsapp.reply" {
                    Button("Edit") {
                        draft = p.draftText ?? stripQuotes(p.detail ?? "")
                        editing = true
                    }
                    .buttonStyle(.bordered)
                }
                Button("Not now") {
                    overlay.respond(to: p.proposal_id, verdict: "reject")
                }
                .buttonStyle(.bordered)
                Button("Never") {
                    // Smart reply cards let the user choose what "never" covers (PROTOCOL.md §5).
                    if p.kind == "whatsapp.reply" {
                        choosingNever = true
                    } else {
                        overlay.respond(to: p.proposal_id, verdict: "never")
                    }
                }
                .buttonStyle(.borderless)
                .foregroundStyle(Color.red.opacity(0.8))
            }
        }
        .controlSize(.small)
    }

    /// Inline scope choice for "Never": This person / This group (group cards only) / Messages like this.
    @ViewBuilder
    private func neverScopeChooser(_ p: ProposeData) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Never suggest replies for…")
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .foregroundStyle(.secondary)
            HStack(spacing: 6) {
                Button("This person") {
                    overlay.respond(to: p.proposal_id, verdict: "never", scope: FeedbackScope.contact)
                }
                if p.isGroupCard {
                    Button("This group") {
                        overlay.respond(to: p.proposal_id, verdict: "never", scope: FeedbackScope.group)
                    }
                }
            }
            .buttonStyle(.bordered)
            HStack(spacing: 6) {
                Button("Messages like this") {
                    overlay.respond(to: p.proposal_id, verdict: "never", scope: FeedbackScope.likeThis)
                }
                .buttonStyle(.bordered)
                Button("Cancel") { choosingNever = false }
                    .buttonStyle(.link)
            }
        }
        .controlSize(.small)
    }

    private func icon(for kind: String?) -> String {
        switch kind ?? "" {
        case "whatsapp.reply": return "arrowshape.turn.up.left.fill"
        case "call.back": return "phone.arrow.up.right.fill"
        case "code.patch": return "chevron.left.forwardslash.chevron.right"
        case "reminder": return "alarm.fill"
        default: return "sparkles"
        }
    }

    private func stripQuotes(_ s: String) -> String {
        var t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        let quotes: Set<Character> = ["\"", "“", "”"]
        if let f = t.first, quotes.contains(f) { t.removeFirst() }
        if let l = t.last, quotes.contains(l) { t.removeLast() }
        return t
    }
}

// MARK: - Chat field

struct ChatField: View {
    @ObservedObject var overlay: OverlayModel
    @FocusState private var focused: Bool
    @State private var micPressed = false

    init(overlay: OverlayModel) {
        _overlay = ObservedObject(wrappedValue: overlay)
    }

    var body: some View {
        HStack(spacing: 8) {
            TextField(overlay.recording ? "Listening…" : "Say something to Pixie…", text: $overlay.chatText)
                .textFieldStyle(.plain)
                .font(.system(size: 13, design: .rounded))
                .focused($focused)
                .onSubmit { overlay.submitChat() }
                .onExitCommand { overlay.closeChat() }
            Image(systemName: overlay.recording ? "mic.fill" : "mic")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(overlay.recording ? Color.white : Color.secondary)
                .frame(width: 28, height: 28)
                .background(Circle().fill(overlay.recording ? Color.red.opacity(0.85) : Color.primary.opacity(0.07)))
                .help("Hold to talk")
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { _ in
                            if !micPressed {
                                micPressed = true
                                overlay.onMicDown?()
                            }
                        }
                        .onEnded { _ in
                            micPressed = false
                            overlay.onMicUp?()
                        }
                )
            Button {
                overlay.submitChat()
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 22))
                    .foregroundStyle(Color(red: 0.55, green: 0.45, blue: 0.95))
            }
            .buttonStyle(.plain)
            .disabled(overlay.chatText.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(.leading, 14)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
        .frame(width: 300)
        .background(Capsule().fill(Color(nsColor: .windowBackgroundColor).opacity(0.98)))
        .overlay(Capsule().stroke(Color(red: 0.55, green: 0.45, blue: 0.95).opacity(0.5), lineWidth: 1.5))
        .shadow(color: Color.black.opacity(0.18), radius: 8, y: 3)
        .task {
            try? await Task.sleep(nanoseconds: 60_000_000)
            focused = true
        }
    }
}
