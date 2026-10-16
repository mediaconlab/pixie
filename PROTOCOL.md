# Pixie protocol (v1)

The single contract between the brain (`brain/`, Cloudflare Worker `pixie-orchestrator`) and every device
(`mac/`, `android/`, `vscode/`). Devices only **sense** and **perform**; every decision is made in the brain.

Brain base URL: configurable on every device (default placeholder `https://pixie-orchestrator.<subdomain>.workers.dev`).
All JSON is UTF-8. All timestamps are Unix **milliseconds**.

---

## 0. Versioning

Two numbers travel in every device's `hello`:

- **`protocol`** (integer, current **1**): the version of *this contract*. It says which wire shapes the app
  understands. A missing `protocol` is treated as `1` (apps that predate the field).
- **`app_version`** (string, e.g. `"1.0.0"`): the app's own release version. Informational only (logs,
  support); the brain never gates on it.

The brain has two constants: `PROTOCOL_VERSION` (the newest protocol it speaks) and `MIN_PROTOCOL` (the oldest
it still serves). Both are returned in `welcome` and on `GET /health` as `protocol` and `min_protocol`.

**Too-old app.** If `hello.protocol < MIN_PROTOCOL`, the brain sends

```json
{ "v": 1, "type": "update_required", "data": { "min_protocol": 2, "latest_protocol": 2, "message": "Please update Pixie to keep using it." } }
```

and closes the socket with code **4002**. On either signal the app must **stop reconnecting** (reconnecting would
only be refused again) and show a persistent "Update Pixie" message with `message`. It reconnects only after
the user changes settings or restarts the app.

**When to bump.**

- *Additive changes keep the protocol number:* new optional fields, new event types, new enum values that
  older apps already tolerate (apps ignore unknown fields and unknown event types; unknown performance values
  fall back as in §2.3).
- *Breaking changes bump `PROTOCOL_VERSION`:* removing or renaming a field, changing a field's type or meaning,
  making an optional field required. The brain must keep serving the old shape while old apps are in the wild.
- *Raise `MIN_PROTOCOL` only after* apps that speak the new protocol have shipped and users have had time to
  update. Raising it is what forces old apps onto the `update_required` path.

The envelope's `v` stays `1`; it versions the envelope framing, not the contract.

---

## 1. Auth and pairing (REST)

Every device holds a **device token** (opaque string, 43 chars base64url). Send it as
`Authorization: Bearer <token>` on REST calls and on the WebSocket upgrade. (Fallback for clients that cannot
set upgrade headers: `?token=<token>` query param.)

| Method + path | Auth | Body → Response |
| --- | --- | --- |
| `GET /health` | none | → `{ "ok": true, "version": "1.0.0", "protocol": 1, "min_protocol": 1 }` |
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
| `hello` | all, first frame after connect | `{ "kind": "mac"\|"android"\|"ide", "name": "MacBook Air", "protocol": 1, "app_version": "1.0.0", "capabilities": ["screen","audio","voice","notify","whatsapp","calls","code"] }` |
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
| `welcome` | the connecting device | `{ "user_name": "Ishaan", "persona": { "name": "Pixie" }, "mood": { "valence": 0.3, "energy": 0.7 }, "devices": [ { "id","kind","name","online" } ], "protocol": 1, "min_protocol": 1 }` |
| `update_required` | a device whose `hello.protocol` is below `min_protocol` | `{ "min_protocol": 2, "latest_protocol": 2, "message": "Please update Pixie to keep using it." }`, then close code 4002 (see §0) |
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

---

## 4. Pet life (additive, protocol stays 1)

Design: the Mac runs the **body** (a 1 Hz deterministic tick: sleep pressure, energy, needs, mood, emotion,
attention ladder, the behaviour picker and *when* to speak). The brain owns the **relationship and the voice**:
personality traits, bond, familiarity, learned rhythm, preferences from instructions, the thought reservoir
(gossip / world / callbacks), weather and calendar context, and writing every spoken line. The LLM never decides
state or timing.

### 4.1 Device → brain

| type | sender | data |
| --- | --- | --- |
| `location.update` | android (preferred), mac (fallback) | `{ "lat": 28.46, "lon": 77.03, "accuracy_m": 500, "source": "phone"\|"mac" }` — **rounded to 2 decimals before sending** (~1 km). Send on start and when it moves > 2 km, at most every 15 min. |
| `signals.update` | mac | `{ "mic_in_use": false, "camera_in_use": false, "music": { "app": "Spotify", "playing": true } \| null, "calendar_busy_now": false, "next_busy_in_min": 42 \| null, "typing_rate": "none"\|"low"\|"high", "app_switch_rate": "low"\|"high", "screen_locked": false }` — send on change only. Calendar = busy/free times only, never titles. |
| `pet.state` | mac | `{ "phase": "awake"\|"napping"\|"sleepy"\|"asleep"\|"waking", "sleep_pressure": 0.42, "energy": 0.61, "social": 0.3, "boredom": 0.2, "snack": 0.5, "mood": { "p": 0.2, "a": 0.1, "d": 0.0 }, "emotion": "curious", "ladder": 0 }` — on phase / ladder / emotion change, at most once per minute, plus every 10 min. |
| `pet.event` | mac | `{ "kind": "petted"\|"poked"\|"fed"\|"carried"\|"bubble_replied"\|"bubble_dismissed"\|"bubble_ignored"\|"woke"\|"fell_asleep"\|"ate"\|"sulked"\|"made_up"\|"reunion", "intent"?: "...", "thought_id"?: "..." }` |
| `pet.speak` | mac | Ask the brain to voice a line now: `{ "intent": "greet_morning"\|"playful_bid"\|"sulk_line"\|"rant"\|"gossip"\|"world"\|"callback"\|"sleepy"\|"weather"\|"reunion"\|"late_night"\|"reaction", "thought_id"?: "th_...", "hint"?: "it started raining" }`. The brain answers with `bot.perform` (`reply_to` = this event id). It may answer with `say: ""` to decline (caps, privacy, nothing worth saying). |
| `phone.self_reply` | android | `{ "key": "<notification key>", "conversation": "Mom" \| "Family", "is_group": false }` — the user's own message appeared in a conversation notification. **No text.** |

### 4.2 Brain → device

| type | to | data |
| --- | --- | --- |
| `pet.profile` | mac (on `hello` and on change) | `{ "traits": { "curiosity": 0.6, "chattiness": 0.5, "agreeableness": 0.7, "sensitivity": 0.4, "sass": 0.5, "clinginess": 0.4 }, "bond": 34, "familiarity": 0.12, "day_mood": 0.05, "first_week": true, "talk_scale": 0.5, "less_needy": 0.0, "quiet_until": 0 \| ts, "gossip_enabled": true, "rhythm": { "wake_hour": 8.5, "sleep_hour": 0.5, "lunch_hour": 13.5, "dinner_hour": 20.5 } }` — `talk_scale` multiplies the Mac's speech caps (0.5 in the first week). Hours are local decimal hours. |
| `env.update` | mac (on `hello`, hourly, and on change) | `{ "weather": { "temp_c": 31, "condition": "clear"\|"cloudy"\|"rain"\|"storm"\|"fog"\|"snow"\|"hot", "is_day": true } \| null, "sunrise": ts, "sunset": ts, "holiday": { "name": "Diwali" } \| null, "weekend": false, "tz": "Asia/Kolkata" }` |
| `pet.thoughts` | mac | `{ "items": [ { "id": "th_...", "kind": "gossip"\|"world"\|"callback", "salience": 0.0-1.0, "expires_at": ts } ] }` — candidate topics for the reservoir, **no text** (the brain voices them on `pet.speak`). Full list each time (replaces the previous one). |
| `pet.lines` | mac (on `hello` and after the nightly learner) | `{ "lines": { "<intent>": [ { "text": "mmh… five more minutes", "emotion": "sleepy", "gesture": "none" } ] } }` — pre-written line bank for routine intents (`sleepy`, `waking`, `playful_bid`, `ate`, `weather`, `reaction`) so the Mac can say small things without a live call. |
| `pet.obey` | mac | `{ "instruction": "quiet"\|"no_gossip"\|"gossip_ok"\|"sleep"\|"less_needy"\|"more_chatty"\|"not_now"\|"stop", "until": ts \| null, "pout": true }` — sent after the brain recognises an instruction in `user.say`. The Mac applies it **immediately** and plays the pout animation only if `pout` is true **and** it is not in a meeting, call, or screen share. |
| `pet.appraisal` | mac | `{ "event": "praise"\|"scold"\|"tease"\|"affection"\|"apology"\|"thanks"\|"goodbye", "intensity": 0.0-1.0 }` — how the user's latest words feel to Pixie; drives the Mac's emotion engine. |

Voice rule: proactive lines (`pet.speak` answers) come back with `speak: false` (bubble only). Replies to the
user's own `user.say` with `via: "voice"` are spoken.

Anti-manipulation rules for every voiced line (brain prompt + output filter): no guilt, no claims of suffering,
no FOMO, never argue with a goodbye, never mention places the user has been, never quote messages.

---

## 5. Smart reply cards (additive)

- `bot.propose` for `whatsapp.reply` gains optional fields:
  `"why": "You used 7 of your last 8 suggestions for Priya"`,
  `"exploration": false`,
  `"quick_actions": [ { "id": "never_contact", "label": "Not for Priya" }, { "id": "never_group", "label": "Not in Family" } ]`.
- `user.feedback` gains optional `"scope": "contact"\|"group"\|"like_this"` (used with `verdict: "never"`, and
  by the quick actions which send `verdict: "never"` + the matching scope).
- REST (Bearer):

| Method + path | Response |
| --- | --- |
| `GET /v1/reply-rules` | `{ "rules": [ { "id", "effect": "always"\|"never"\|"only", "subject_type": "contact"\|"group"\|"relation"\|"all_groups"\|"all_dms"\|"all", "subject_label": "Mom", "conditions": { ... } \| null, "expires_at": ts \| null, "source": "chat"\|"button"\|"migrated", "utterance": "always show me reply options for Mom" \| null, "created_at": ts } ] }` (active rules only) |
| `DELETE /v1/reply-rules/:id` | `{ "ok": true }` |
| `POST /v1/reply-rules/reset-learning` | `{ "ok": true }` — clears learned reply stats, keeps rules |
