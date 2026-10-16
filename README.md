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

1. **Secret** (repo Settings → Secrets and variables → Actions): `CLOUDFLARE_API_TOKEN`, made from the *Edit Cloudflare Workers* template plus D1 Edit and Workers AI Read. `CLOUDFLARE_ACCOUNT_ID` is optional; it's only needed if the token can see more than one account.
2. **Deploy the orchestrator:** push to `main` (or run the *Orchestrator* workflow). It applies D1 migrations, deploys, and prints the URL in the run summary.
3. **Get the apps:** the *Apps* workflow uploads `Pixie-macOS-arm64.zip`, `Pixie-android.apk` and `pixie-vscode.vsix` as run artifacts. Push a tag `v1.0.0` to attach them to a GitHub release.
4. **First run:** open Pixie on the Mac, paste the orchestrator URL and your name. The first registration claims the instance; nobody else can register after that.
5. **Pair devices:** menu bar → *Pair a device…* shows a 6-digit code and QR. Scan the QR with the phone camera (opens the Android app), or type the code in VS Code (*Pixie: Pair with Pixie*).

## Environments

| Environment | Branch | Worker | Notes |
| --- | --- | --- | --- |
| Production | `main` | `pixie-orchestrator` | D1 `pixie-orchestrator`, signup closed after the owner registers, nightly learning cron |
| Staging | `dev` | `pixie-orchestrator-staging` | D1 `pixie-orchestrator-staging`, signup open so test accounts can be made, no cron |

Workflow: work on `dev`; each push deploys staging (the run prints the staging URL). Test by pointing a test
install of the app at the staging URL. Merge `dev` → `main` to ship to production. The *Apps* workflow builds
artifacts on both branches; releases still come only from `v*` tags.

## What Pixie may decide alone

The orchestrator variable `AUTONOMY` in `brain/wrangler.jsonc` sets the level. It is **`full`**: no topic is forbidden, and messages you ask Pixie to send go out without an approval tap. Set it to `guarded` and redeploy to bring back the original rules.

| Action | `full` (current) | `guarded` |
| --- | --- | --- |
| Hold or digest messages, set reminders, pause commentary | Automatic | Automatic |
| WhatsApp reply you ask for ("tell Mom I'm on my way") | Sent immediately | Ask first |
| Reply Pixie drafts by itself for an incoming message | Ask first | Ask first |
| Call-backs, code patches | Ask first | Ask first |
| Payments, passwords, deleting, settings | Not blocked; Pixie has no integration for these yet | Never |

## Privacy

Screen sharing is off by default. Password managers and private windows are never captured, OCR text is redacted on the Mac before upload, and frames are not stored. WhatsApp access is notification previews only. *Settings → Forget me* wipes everything Pixie remembers.
