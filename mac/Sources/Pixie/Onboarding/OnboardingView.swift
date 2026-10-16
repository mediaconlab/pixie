import AppKit
import PixieCore
import SwiftUI

/// First-launch window: brain URL + your name → POST /v1/register → token in Keychain.
struct OnboardingView: View {
    @ObservedObject var prefs: Preferences
    @ObservedObject var preview: AvatarModel
    /// Called with the register response after a successful sign-up.
    let onRegistered: (RegisterResponse) -> Void

    @State private var url = ""
    @State private var name = ""
    @State private var busy = false
    @State private var error: String?

    init(prefs: Preferences, preview: AvatarModel, onRegistered: @escaping (RegisterResponse) -> Void) {
        _prefs = ObservedObject(wrappedValue: prefs)
        _preview = ObservedObject(wrappedValue: preview)
        self.onRegistered = onRegistered
    }

    var body: some View {
        VStack(spacing: 16) {
            CharacterView(model: preview, size: 96)
                .allowsHitTesting(false)
                .frame(height: 130)
            Text("Hi! I'm Pixie.")
                .font(.system(size: 22, weight: .bold, design: .rounded))
            Text("Tell me where my brain lives and what to call you.")
                .font(.system(size: 13, design: .rounded))
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 6) {
                Text("Brain URL").font(.caption).foregroundStyle(.secondary)
                TextField("https://pixie-orchestrator.you.workers.dev", text: $url)
                    .textFieldStyle(.roundedBorder)
                Text("Your name").font(.caption).foregroundStyle(.secondary)
                    .padding(.top, 6)
                TextField("Ishaan", text: $name)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { submit() }
            }
            if let error {
                Text(error)
                    .font(.system(size: 12))
                    .foregroundStyle(Color.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                if busy { ProgressView().controlSize(.small) }
                Button("Let's go") { submit() }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty || url.isEmpty)
            }
        }
        .padding(24)
        .frame(width: 420)
        .onAppear {
            url = prefs.brainURL == Preferences.defaultBrainURL ? "" : prefs.brainURL
            name = prefs.userName
            preview.playGesture(.wave)
            preview.setEmotion(.happy, intensity: 0.8, hold: 30)
        }
    }

    private func submit() {
        error = nil
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        prefs.brainURL = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let base = prefs.baseURL else {
            error = BrainAPIError.badURL.errorDescription
            return
        }
        busy = true
        let deviceName = Host.current().localizedName ?? "Mac"
        Task { @MainActor in
            do {
                let resp = try await BrainAPI(baseURL: base, token: nil).register(userName: trimmedName, deviceName: deviceName)
                prefs.userName = trimmedName
                busy = false
                onRegistered(resp)
            } catch {
                busy = false
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                preview.setEmotion(.concerned, intensity: 0.7, hold: 4)
            }
        }
    }
}
