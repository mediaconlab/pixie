# Pixie for macOS

Pixie is a small companion that lives on your desktop. The Mac app only senses things and performs; every
decision is made by the brain (Cloudflare Worker `pixie-orchestrator`). See `../PROTOCOL.md` for the contract.

- macOS 14 Sonoma or later, Apple Silicon (arm64) only
- Native Swift: SwiftUI + AppKit, built with Swift Package Manager, no third-party dependencies
- Lightweight: no Dock icon, a menu-bar item and a floating character

## Build

```bash
# from the repository root
swift build -c release --arch arm64 --package-path mac   # just the binary
swift test --package-path mac                             # PixieCore unit tests (redactor, hash, backoff, models)
bash mac/scripts/package.sh                               # → mac/dist/Pixie.app and mac/dist/Pixie-macOS-arm64.zip
```

`package.sh` builds the release binary, puts together `Pixie.app` (`Contents/MacOS/Pixie`, `Contents/Info.plist`,
`Contents/Resources`), signs it ad hoc with `Pixie.entitlements`, and zips it with `ditto`.

### Layout

| Path | What it holds |
| --- | --- |
| `Sources/PixieCore` | Pure Foundation code: protocol envelope and models, `Redactor`, average hash, backoff, offline queue, activity classifier, capture guard |
| `Sources/Pixie/App` | Entry point, `AppController` (connects all the parts), menu bar, preferences, Keychain |
| `Sources/Pixie/Shell` | Transparent click-through `NSPanel`, ⌥Space hotkey |
| `Sources/Pixie/Avatar` | The character, drawn entirely with SwiftUI shapes: emotions, gestures, gaze, idle life |
| `Sources/Pixie/Overlay` | Speech bubble, notice, digest and proposal cards, toast, chat field |
| `Sources/Pixie/Link` | REST client and the WebSocket link (hello, ping, backoff, offline queue) |
| `Sources/Pixie/Onboarding` | First-run sign-up, plus pairing (code, QR code, device list) |
| `Sources/Pixie/Senses` | ScreenCaptureKit stills, OCR and redaction, system-audio transcription |
| `Sources/Pixie/Voice` | Text to speech and push-to-talk |
| `Sources/Pixie/Activity` | `state.update` detection |
| `Sources/Pixie/Settings` | Settings window |

## First run

1. Open Pixie. A welcome window asks for your **brain URL** (for example `https://pixie-orchestrator.you.workers.dev`)
   and **your name**. Pixie registers this Mac (`POST /v1/register`) and stores the device token in the Keychain.
2. Click Pixie, or press **⌥Space**, to chat. Hold the mic button in the chat field to talk.
3. Use the menu-bar ✨ item to open **Pair a device…**. Scan the QR code with your Android phone, or enter the
   6-digit code in the VS Code extension.

### Permissions

macOS asks for each permission the first time you use the feature that needs it:

| Permission | Needed for | Where to find it |
| --- | --- | --- |
| **Screen Recording** | "Let Pixie see my screen", "Watch with me", and window titles for activity detection | System Settings → Privacy & Security → Screen & System Audio Recording |
| **Microphone** | Push-to-talk | System Settings → Privacy & Security → Microphone |
| **Speech Recognition** | Push-to-talk and watch-mode transcripts (both on-device) | System Settings → Privacy & Security → Speech Recognition |
| **Accessibility** | The ⌥Space hotkey while another app is frontmost (global key monitor) | System Settings → Privacy & Security → Accessibility. Settings → "Grant Accessibility…" |

After you grant Screen Recording, macOS often needs Pixie to restart: quit it from the menu and open it again.
On macOS 15 and later the system also shows a reminder about screen recording from time to time. That is expected.

Because the app is signed ad hoc, macOS treats every new build as a new app. You may need to remove Pixie from
the permission lists and grant access again after you update it.

### Privacy

- Screen sharing is **off by default**. While it is on, a small eye badge shows on Pixie.
- Periodic frames are sent only when the screen has visibly changed (a 16×16 average hash).
- Apps on the blocklist are cut out of every capture. Pixie skips the capture entirely when a blocked app is
  frontmost or the front window's title contains "Private" or "Incognito". You can edit the blocklist in Settings.
- OCR runs on your Mac (Vision). API keys, tokens, card numbers, OTPs and lines that contain "password" are
  replaced with `‹redacted›` before anything is sent.
- Speech recognition is set to run only on your Mac.
- **Forget me** in Settings wipes Pixie's memory in the brain (`DELETE /v1/memory`).

## Gatekeeper (unsigned app)

The CI build is signed ad hoc, not notarized, so Gatekeeper blocks it the first time you open it. To get past this:

- Right-click **Pixie.app** → **Open** → **Open**, or
- Run this after you move it to Applications:

  ```bash
  xattr -dr com.apple.quarantine /Applications/Pixie.app
  ```
