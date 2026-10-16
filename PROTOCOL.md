# Pixie protocol (v1)

The single contract between the brain (`brain/`, Cloudflare Worker `pixie-orchestrator`) and every device
(`mac/`, `android/`, `vscode/`). Devices only **sense** and **perform**; every decision is made in the brain.

Brain base URL: configurable on every device (default placeholder `https://pixie-orchestrator.<subdomain>.workers.dev`).
All JSON is UTF-8. All timestamps are Unix **milliseconds**.

---

## 1. Auth and pairing (REST)

Every device holds a **device token** (opaque string, 43 chars base64url). Send it as
`Authorization: Bearer <token>` on REST calls and on the WebSocket upgrade. (Fallback for clients that cannot
set upgrade headers: `?token=<token>` query param.)

| Method + path | Auth | Body → Response |
| --- | --- | --- |
| `GET /health` | none | → `{ "ok": true, "version": "1.0.0" }` |
| `POST /v1/register` | none | `{ "name": "Ishaan", "device": { "kind": "mac", "name": "MacBook Air" } }` → `{ "user_id", "device_id", "token" }`. Only works while the instance has **no owner yet** (first registration claims it) or when the env var `ALLOW_SIGNUP=1`. Otherwise `403 {"error":"registration_closed"}`. Only `kind:"mac"` may register. |
| `POST /v1/pair/start` | Bearer | `{}` → `{ "code": "482913", "expires_at": 1760610000000, "link": "pixie://pair?u=<urlencoded base url>&c=482913" }`. 6-digit code, valid 10 min, single use. |
| `POST /v1/pair/claim` | none | `{ "code": "482913", "device": { "kind": "android" \| "ide", "name": "Pixel 8" } }` → `{ "user_id", "device_id", "token" }`. `404 {"error":"bad_code"}` if wrong/expired. |
| `GET /v1/devices` | Bearer | → `{ "devices": [ { "id", "kind", "name", "last_seen", "online" } ] }` |
| `DELETE /v1/devices/:id` | Bearer | → `{ "ok": true }` (revokes token) |
| `GET /v1/memory` | Bearer | → `{ "facts": [...], "memories": [...], "preferences": [...] }` |
| `DELETE /v1/memory` | Bearer | → `{ "ok": true }` ("forget me": wipes memories, prefs, decisions, mood) |
| `GET /v1/ws` | Bearer | WebSocket upgrade (see below) |

**Pair flow:** Mac app calls `/v1/pair/start`, shows the 6-digit code and a QR code of `link`. On Android the
system camera opens the `pixie://pair?...` deep link straight into the app (the app must register that intent
filter); manual entry of URL + code is the fallback. The VS Code extension asks for URL + code via input boxes.

Error bodies are always `{ "error": "<snake_case_code>", "message"?: "..." }`.

---

## 2. WebSocket

`GET /v1/ws` with `Authorization: Bearer <token>`. One socket per device. Every frame is one JSON **envelope**:

```json
{ "v": 1, "id": "evt_8f3k2...", "ts": 1760607720000, "type": "phone.message", "data": { ... } }
```

- `id`: client-generated unique string (any format, ≤ 64 chars). The brain echoes it as `reply_to` where relevant.
- Keepalive: client sends the **plain text** frame `ping` every 30 s; brain answers `pong` (not JSON).
- Reconnect: exponential backoff 1 s → 30 s max. Queue unsent events offline (cap 100, drop oldest).
- Max frame size 1 MiB (screen frames must be downscaled JPEGs, see `screen.frame`).

### 2.1 Device → brain

| type | sender | data |
| --- | --- | --- |
| `hello` | all, first frame after connect | `{ "kind": "mac"\|"android"\|"ide", "name": "MacBook Air", "app_version": "1.0.0", "capabilities": ["screen","audio","voice","notify","whatsapp","calls","code"] }` |
| `user.say` | mac, ide | `{ "text": "what's this error?", "via": "typed"\|"voice" }` |
| `state.update` | mac | `{ "activity": "idle"\|"coding"\|"meeting"\|"video"\|"browsing"\|"away", "front_app": "Xcode", "focus_mode": false, "watching": false }` — send on change only |
| `phone.call` | android | `{ "state": "ringing"\|"answered"\|"ended"\|"missed", "number": "+9198...", "name": "Mom" \| null }` |
| `phone.message` | android | `{ "app": "whatsapp"\|"whatsapp_business"\|"sms"\|"other", "package": "com.whatsapp", "from": "Mom", "conversation": "Family" \| null, "preview": "Call me when free", "is_group": false, "key": "<notification key>", "replyable": true }` |
| `screen.frame` | mac | `{ "image": "data:image/jpeg;base64,...", "width": 768, "height": 480, "front_app": "Safari", "window": "YouTube - ...", "ocr": "redacted visible text, ≤ 4000 chars", "reason": "periodic"\|"asked"\|"watch" }`. JPEG longest side ≤ 768 px, quality ~0.6. The Mac must **redact** OCR text (API keys, passwords, card/OTP numbers) before sending and must never send frames from blocked apps. |
| `audio.transcript` | mac | `{ "text": "...", "seconds": 10, "source": "system"\|"mic" }` — on-device speech-to-text of system audio during watch mode |
| `ide.context` | ide | `{ "file": "src/app.ts", "language": "typescript", "content": "<file text, ≤ 20000 chars>", "selection": { "start_line": 10, "end_line": 24, "text": "..." } \| null, "diagnostics": [ { "line": 12, "severity": "error"\|"warning", "message": "..." } ], "question": "why does this fail?" \| null, "reason": "asked"\|"save"\|"diagnostics" }` |
| `user.feedback` | all | `{ "proposal_id": "prp_...", "verdict": "approve"\|"reject"\|"never", "edited_text"?: "..." }` |
| `exec.result` | android, ide | `{ "proposal_id": "prp_...", "ok": true, "error"?: "..." }` |

### 2.2 Brain → device

| type | to | data |
| --- | --- | --- |
| `welcome` | the connecting device | `{ "user_name": "Ishaan", "persona": { "name": "Pixie" }, "mood": { "valence": 0.3, "energy": 0.7 }, "devices": [ { "id","kind","name","online" } ] }` |
| `bot.perform` | mac (and ide for replies to ide) | **Performance** (below) |
| `bot.notice` | mac | `{ "kind": "call"\|"message", "from": "Mom", "preview": "Call me when free", "app": "whatsapp", "urgency": 0.0-1.0, "summary": "Mom wants a call back, sounds casual", "interrupt": true }` — mac shows a caller/message card; `interrupt:false` means show quietly in the digest |
| `bot.digest` | mac | `{ "items": [ { "from", "app", "summary", "urgency", "ts" } ] }` — batched low-urgency items |
| `bot.propose` | mac (always) + ide (for `code.patch`) | `{ "proposal_id": "prp_...", "kind": "whatsapp.reply"\|"call.back"\|"code.patch"\|"reminder", "title": "Reply to Mom?", "detail": "\"Sure, calling you at 6!\"", "payload": { ... }, "executor": "android"\|"ide"\|"mac"\|"brain", "expires_at": 1760610000000 }` |
| `bot.execute` | the executor device | `{ "proposal_id": "prp_...", "kind": "whatsapp.reply", "payload": { "key": "<notification key>", "text": "Sure, calling you at 6!" } }` (sent only after an `approve`) |
| `bot.auto` | mac | `{ "action": "hold_notifications"\|"digest"\|"reminder.set"\|"pause_commentary", "detail": "Held 3 low-priority messages while you're in a meeting" }` — tells the user what Pixie did on its own (auto tier) |
| `ide.suggestion` | ide | `{ "file": "src/app.ts", "explanation": "...", "patch": "<unified diff>" \| null, "line"?: 12 }` |
| `capture.request` | mac | `{ "reason": "asked" }` — brain wants a fresh screen frame (e.g. user said "look at this") |
| `error` | any | `{ "code": "rate_limited"\|"bad_event"\|"model_error", "message": "..." }` |

payload shapes by proposal kind:
- `whatsapp.reply`: `{ "key": "<notification key>", "to": "Mom", "text": "..." }`
- `call.back`: `{ "number": "+91...", "name": "Mom" }` (android opens the dialer, never auto-dials)
- `code.patch`: `{ "file": "src/app.ts", "patch": "<unified diff>" }`
- `reminder`: `{ "text": "...", "at": 1760610000000 }`

### 2.3 Performance

```json
{
  "say": "Ooh, that test failed again... want me to look at line 42?",
  "emotion": "concerned",
  "intensity": 0.6,
  "gesture": "lean_in",
  "gaze": "screen",
  "voice": { "pace": "normal", "pitch": 1 },
  "speak": true,
  "reply_to": "evt_..."
}
```

- `emotion` ∈ `neutral, happy, excited, curious, concerned, sleepy, proud, shy, annoyed, sad, surprised, love, thinking`
- `intensity` 0..1 (blend from neutral)
- `gesture` ∈ `none, wave, nod, shake, bounce, lean_in, spin, hide, dance, jump`
- `gaze` ∈ `user, screen, phone, away, cursor`
- `voice.pace` ∈ `slow, normal, fast`; `voice.pitch` integer −2..2
- `speak`: whether to read `say` aloud (TTS on device). `say` may be `""` for a pure expression.
- Unknown values from a newer brain must be tolerated (fall back to `neutral` / `none` / `user`).

---

## 3. Decision tiers (enforced in brain code, not by the model)

The brain env var `AUTONOMY` picks the policy: `guarded` is the table below; `full` drops the never tier and sends user-requested `whatsapp.reply` directly (`bot.execute` + `bot.auto` with `action: "message.sent"`), without a `bot.propose`.


| Tier | Brain behaviour |
| --- | --- |
| auto | executes, then sends `bot.auto` so the user knows |
| propose | sends `bot.propose`; executes only after `user.feedback approve` → `bot.execute` to the executor |
| never | dropped; Pixie says it can't do that |

Devices must never execute a `bot.execute` they did not receive after an approval tap on *some* device, and the
Android app must never send a WhatsApp reply without a matching `bot.execute`.
