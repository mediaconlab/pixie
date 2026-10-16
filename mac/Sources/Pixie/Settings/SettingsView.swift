import AppKit
import PixieCore
import SwiftUI

struct SettingsView: View {
    @ObservedObject var prefs: Preferences
    let onBrainURLCommitted: () -> Void
    let onIntervalChanged: () -> Void
    let onForgetMe: @MainActor () async -> String?
    let onSignOut: () -> Void

    @State private var urlDraft = ""
    @State private var newBundle = ""
    @State private var selection: String?
    @State private var confirmForget = false
    @State private var confirmSignOut = false
    @State private var status: String?

    init(prefs: Preferences,
         onBrainURLCommitted: @escaping () -> Void,
         onIntervalChanged: @escaping () -> Void,
         onForgetMe: @escaping @MainActor () async -> String?,
         onSignOut: @escaping () -> Void) {
        _prefs = ObservedObject(wrappedValue: prefs)
        self.onBrainURLCommitted = onBrainURLCommitted
        self.onIntervalChanged = onIntervalChanged
        self.onForgetMe = onForgetMe
        self.onSignOut = onSignOut
    }

    var body: some View {
        Form {
            Section("Brain") {
                HStack {
                    TextField("Brain URL", text: $urlDraft)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { commitURL() }
                    Button("Save") { commitURL() }
                        .disabled(urlDraft == prefs.brainURL)
                }
                if prefs.baseURL == nil {
                    Text("Enter an https:// URL.").font(.caption).foregroundStyle(Color.red)
                }
            }

            Section("Pixie") {
                Toggle("Speak out loud", isOn: $prefs.voiceEnabled)
                Picker("Character size", selection: $prefs.characterSize) {
                    ForEach(CharacterSize.allCases) { s in
                        Text(s.rawValue).tag(s)
                    }
                }
                .pickerStyle(.segmented)
                HStack {
                    Text("Screen glance every")
                    Slider(value: $prefs.screenInterval, in: 3...60, step: 1, onEditingChanged: { editing in
                        if !editing { onIntervalChanged() }
                    })
                    Text("\(Int(prefs.screenInterval)) s")
                        .monospacedDigit()
                        .frame(width: 40, alignment: .trailing)
                }
                HStack {
                    Text("Global hotkey ⌥Space")
                    Spacer()
                    if HotKey.isTrusted {
                        Label("Enabled", systemImage: "checkmark.circle.fill").foregroundStyle(Color.green)
                    } else {
                        Button("Grant Accessibility…") { HotKey.requestTrust() }
                    }
                }
            }

            Section("Never look at these apps") {
                List(selection: $selection) {
                    ForEach(prefs.blocklist, id: \.self) { id in
                        Text(id).font(.system(size: 12, design: .monospaced)).tag(id)
                    }
                }
                .frame(height: 120)
                HStack {
                    TextField("Bundle ID, e.g. com.example.app", text: $newBundle)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { addBundle() }
                    Button("Add") { addBundle() }
                        .disabled(newBundle.trimmingCharacters(in: .whitespaces).isEmpty)
                    Menu("Running apps") {
                        ForEach(runningApps(), id: \.self) { id in
                            Button(id) {
                                if !prefs.blocklist.contains(id) { prefs.blocklist.append(id) }
                            }
                        }
                    }
                    .fixedSize()
                    Button("Remove") {
                        if let s = selection { prefs.blocklist.removeAll { $0 == s } }
                        selection = nil
                    }
                    .disabled(selection == nil)
                }
                Text("Windows titled “Private” or “Incognito” are always skipped.")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Restore defaults") {
                    prefs.blocklist = CaptureGuard.defaultBlockedBundleIDs
                }
                .buttonStyle(.link)
            }

            Section("Privacy") {
                HStack {
                    Button("Forget me…", role: .destructive) { confirmForget = true }
                    Button("Sign out…") { confirmSignOut = true }
                    Spacer()
                    if let status {
                        Text(status).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 520, height: 600)
        .onAppear { urlDraft = prefs.brainURL }
        .alert("Forget everything?", isPresented: $confirmForget) {
            Button("Forget me", role: .destructive) {
                Task { @MainActor in
                    status = await onForgetMe() ?? "Pixie forgot everything."
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Pixie's brain will wipe all memories, preferences, decisions and mood. This can't be undone.")
        }
        .alert("Sign out?", isPresented: $confirmSignOut) {
            Button("Sign out", role: .destructive) { onSignOut() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This Mac's token will be removed from the Keychain.")
        }
    }

    private func commitURL() {
        prefs.brainURL = urlDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        onBrainURLCommitted()
    }

    private func addBundle() {
        let id = newBundle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty, !prefs.blocklist.contains(id) else { return }
        prefs.blocklist.append(id)
        newBundle = ""
    }

    private func runningApps() -> [String] {
        let me = Bundle.main.bundleIdentifier
        let ids = NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular }
            .compactMap { $0.bundleIdentifier }
            .filter { $0 != me && !prefs.blocklist.contains($0) }
        return Array(Set(ids)).sorted()
    }
}
