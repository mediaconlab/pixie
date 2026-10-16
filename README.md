# Pixie

A cute, emotional desktop companion that lives on your Mac, relays your Android phone's calls and WhatsApp messages, watches your screen with you (only when you let it), pair-codes in VS Code, and makes low-risk decisions on its own. Its brain runs on Cloudflare.

| Part | Folder | What it is |
| --- | --- | --- |
| Orchestrator | [`brain/`](brain/) | Cloudflare Worker `pixie-orchestrator`: one Durable Object per user (perceive → think → decide), Workers AI, D1 device registry |
| Mac app | [`mac/`](mac/) | Native Swift, Apple Silicon, macOS 14+: the floating character, voice, screen + audio senses with on-device OCR and redaction |
| Android companion | [`android/`](android/) | Kotlin: forwards calls and WhatsApp/SMS notification previews, sends replies only after you approve them |
| VS Code extension | [`vscode/`](vscode/) | Sends code, selection and errors; shows and applies Pixie's patches |

The wire contract between all of them is [`PROTOCOL.md`](PROTOCOL.md).

## Setup

1. **Secrets** (repo Settings → Secrets and variables → Actions): `CLOUDFLARE_API_TOKEN` (permissions: Workers Scripts Edit, D1 Edit, Workers AI Read) and `CLOUDFLARE_ACCOUNT_ID`.
2. **Deploy the orchestrator:** push to `main` (or run the *Orchestrator* workflow). It applies D1 migrations, deploys, and prints the URL in the run summary.
3. **Get the apps:** the *Apps* workflow uploads `Pixie-macOS-arm64.zip`, `Pixie-android.apk` and `pixie-vscode.vsix` as run artifacts. Push a tag `v1.0.0` to attach them to a GitHub release.
4. **First run:** open Pixie on the Mac, paste the orchestrator URL and your name. The first registration claims the instance; nobody else can register after that.
5. **Pair devices:** menu bar → *Pair a device…* shows a 6-digit code and QR. Scan the QR with the phone camera (opens the Android app), or type the code in VS Code (*Pixie: Pair with Pixie*).

## What Pixie may decide alone

| Tier | Examples |
| --- | --- |
| Auto | Hold low-priority messages during meetings, batch them into a digest, set reminders, pause commentary on calls |
| Ask first | WhatsApp replies, call-backs, code patches |
| Never | Payments, passwords, deleting things, account or system settings, sending anything without your tap |

## Privacy

Screen sharing is off by default. Password managers and private windows are never captured, OCR text is redacted on the Mac before upload, and frames are not stored. WhatsApp access is notification previews only. *Settings → Forget me* wipes everything Pixie remembers.
