# Pixie for macOS

Pixie is a small companion that lives on your desktop. The brain (Cloudflare Worker `pixie-orchestrator`) owns the
relationship and the voice; the Mac runs Pixie's **body**: sleep, energy, needs, mood, what it does moment to moment,
and *when* it might say something. See `../PROTOCOL.md` (§4 for pet life) for the contract.

- macOS 14 Sonoma or later, Apple Silicon (arm64) only
- Native Swift: SwiftUI + AppKit, built with Swift Package Manager, no third-party dependencies
- Lightweight: no Dock icon, a menu-bar item and a floating character

## Build

```bash
# from the repository root
swift build -c release --arch arm64 --package-path mac   # just the binary
swift test --package-path mac                             # PixieCore unit tests (redactor, hash, backoff, models, pet engine)
bash mac/scripts/package.sh                               # → mac/dist/Pixie.app and mac/dist/Pixie-macOS-arm64.zip
```

`package.sh` builds the release binary, puts together `Pixie.app` (`Contents/MacOS/Pixie`, `Contents/Info.plist`,
`Contents/Resources`), signs it ad hoc with `Pixie.entitlements`, and zips it with `ditto`.

### Layout

| Path | What it holds |
| --- | --- |
| `Sources/PixieCore` | Pure Foundation code: protocol envelope and models (`PetProtocol.swift` for §4), the pet engine (`PetEngine.swift`), `Redactor`, average hash, backoff, offline queue, activity classifier, capture guard |
| `Sources/Pixie/App` | Entry point, `AppController` (connects all the parts), menu bar, preferences, Keychain |
| `Sources/Pixie/Shell` | Transparent click-through `NSPanel`, ⌥Space hotkey |
| `Sources/Pixie/Avatar` | The character, drawn entirely with SwiftUI shapes: emotions, gestures, gaze, pet behaviours, props (`PetMotion.swift`) |
| `Sources/Pixie/Pet` | `PetBodyController`: steps the engine at 1 Hz, persists it, sends `pet.state` / `pet.event` / `pet.speak` |
| `Sources/Pixie/Overlay` | Speech bubble, notice, digest and proposal cards, toast, chat field |
| `Sources/Pixie/Link` | REST client and the WebSocket link (hello, ping, backoff, offline queue) |
| `Sources/Pixie/Onboarding` | First-run sign-up, plus pairing (code, QR code, device list) |
| `Sources/Pixie/Senses` | ScreenCaptureKit stills, OCR and redaction, system-audio transcription |
| `Sources/Pixie/Voice` | Text to speech and push-to-talk |
| `Sources/Pixie/Activity` | `state.update` detection |
| `Sources/Pixie/Settings` | Settings window |

## Pixie's body

Pixie is a fully grown pet from the first launch, with no fixed timetable. Once a second, `PetEngine` (PixieCore,
deterministic, unit-tested) updates:

- **Sleep pressure** (rises while awake, falls while asleep; naps take some off) against a **circadian** term from the
  learned rhythm (`pet.profile.rhythm`, default wake 8:30, sleep 0:30). Together they give the phases *awake*,
  *sleepy*, *napping*, *asleep* and *waking*. If you keep working late, Pixie stays up as drowsy company curled near
  your cursor instead of falling asleep; it sleeps once you leave.
- **Energy**, **social need** (rises only while you are here and free), **boredom**, a cosmetic **snack** level,
  **mood** (pleasure / arousal / dominance drifting back to a default set by its traits) and the current **emotion**,
  which fades back into the mood.

Every few seconds (jittered, with a minimum hold) it scores what it could do and picks by weighted chance among the
top three: breathing, watching the cursor or your work, playing with a ball, chasing the cursor, exploring, peeking,
napping, yawning and stretching, snacking, looking out of a little window (rain, snow, sunset), fanning itself when it
is hot, hiding from a storm, bobbing to music, a festive wiggle with a party hat on holidays. Fast typing, calls and
sleepiness damp play.

**Attention ladder** (only while you are free, gentle by default, slower with `less_needy`): a glance → a hop → one
gentle spoken bid at a natural break → a short sulk (turned away, puffed up) → at most one theatrical line a day when
things are relaxed → it gives up and naps. Any interaction resets it with a happy make-up wiggle and hearts.

**Talking** is rare. Pixie asks the brain for a line (`pet.speak`) only at natural breaks (an app switch or a short
pause), never in a meeting, call, video, while away or during quiet time, at least 20 minutes apart, at most 2 an hour
and 10 a day × `talk_scale`, gossip at most twice a day. It learns a per-user threshold: lines you reply to (within
2 minutes) lower it, lines you close or ignore raise it, and two ignored lines in a row pause it for 90 minutes.
Routine moments (sleepy, waking, ate, weather, reactions, playful bids) use the brain's `pet.lines` bank locally.
Proactive lines show as bubbles and are never spoken aloud.

**Your instructions always win.** `pet.obey` (quiet, gossip on/off, go to sleep, less needy, more chatty, not now,
stop) applies at once; afterwards Pixie may play a short pout ("hmph"), never in a meeting.

The engine state is saved in UserDefaults (`petBody.v1`).

### Touching Pixie

| You do | Pixie feels | Also |
| --- | --- | --- |
| Quick click | **poke** (a squish; several quick pokes annoy it) | Opens or closes the chat, as before |
| Click and hold still (≥ 0.5 s) | **petting** | No chat; keeps stroking every 2 s while held |
| Move the pointer back and forth over Pixie (no click) | **petting** (a hover stroke) | A sleeping Pixie stays asleep and smiles |
| Drag | **carried** (wiggles while held) | Moves Pixie, as before |
| Right-click → **Give Pixie a snack** (or the menu-bar item) | **fed** | Eats a cookie |
| ⌥Space, menu-bar **Talk to Pixie**, typing to it | attention | Wakes it (unless you told it to sleep) |

Petting, poking, feeding and carrying are reported as `pet.event`.

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
