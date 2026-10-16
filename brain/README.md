# pixie-orchestrator (the brain)

Cloudflare Worker + one SQLite-backed Durable Object per user (`UserBrain`). Devices (Mac, Android,
VS Code) only sense and perform; every decision is made here. The wire contract is
[`../PROTOCOL.md`](../PROTOCOL.md).

```
src/
  index.ts           Worker: REST routes (§1), CORS, token auth, WS forwarding, nightly cron
  auth.ts            device tokens (32 random bytes, base64url; only SHA-256 stored)
  pairing.ts         6-digit codes (10 min, single use), failed-claim rate limit (10 / IP / 10 min)
  db.ts              D1: users, devices, pair_codes, pair_failures
  ai.ts              the only Workers AI gateway (chat fallback + cooldowns, vision, embeddings)
  protocol.ts        envelope parsing, event validation, Performance sanitizing
  brain/
    UserBrain.ts     Durable Object shell: WebSocket Hibernation API, alarms, RPC learn()
    core.ts          BrainCore: perceive → think → decide → perform/notify (runtime-agnostic)
    perceive.ts      events → Observations (urgency heuristics, contacts, vision gating, IDE)
    think.ts         prompts (persona, mood, memories, context) + JSON validation / fallbacks
    decide.ts        PURE tier policy (auto / propose / never), routing, promotion rules
    mood.ts          valence/energy with 30-min half-life decay (pure)
    vectors.ts       cosine, top-k, dedupe, eviction (pure)
    learner.ts       nightly consolidation helpers (pure)
    store.ts         per-user SQLite schema
```

## Deploy

No secrets are required (Workers AI is a binding).

```sh
npm install
npx wrangler login                                            # once
npx wrangler d1 migrations apply pixie-orchestrator --remote  # create D1 tables
npm run deploy                                                # = wrangler deploy
```

Then open the Mac app, point it at `https://pixie-orchestrator.<subdomain>.workers.dev`, and register.
The first `POST /v1/register` claims the instance; after that registration is closed unless the
`ALLOW_SIGNUP` var is set to `"1"`. Other devices are added via `POST /v1/pair/start` (Mac) and
`POST /v1/pair/claim` (Android / VS Code).

The Llama 3.2 vision model needs a one-time license agreement; the brain sends `{ prompt: "agree" }`
automatically the first time a vision call fails with a license error.

### Config (`wrangler.jsonc` vars)

| var | default | |
| --- | --- | --- |
| `ALLOW_SIGNUP` | `"0"` | `"1"` lets additional users register |
| `MODELS` | `@cf/zai-org/glm-5.3-flash,@cf/google/gemma-4-26b-a4b-it` | chat models, tried in order. A failing model is skipped for 60 s (6 h if the error mentions 5035 / 403 / paid) |
| `VISION_MODEL` | `@cf/meta/llama-3.2-11b-vision-instruct` | |
| `EMBED_MODEL` | `@cf/baai/bge-base-en-v1.5` | |

The cron `30 20 * * *` (02:00 IST) runs the nightly learner for every user.

## Develop

```sh
npm run dev         # wrangler dev (local D1: npx wrangler d1 migrations apply pixie-orchestrator --local)
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npx wrangler deploy --dry-run --outdir dist   # validate bundle + config without credentials
```

Tests run in Node. `BrainCore` is runtime-agnostic, so the integration tests drive it against
`node:sqlite` (standing in for `ctx.storage.sql`) with a fake AI. The REST tests run the real
Worker router against a `node:sqlite`-backed fake D1 that applies `migrations/0001_init.sql`.

## Behaviour notes

- **Turns are serialized per user** with a promise chain, so two events never interleave.
- **Model budget**: 120 model calls per user per hour (chat, classification, drafts, vision, learner).
  Background work (classification, drafts, periodic vision, watch comments) stops at 100 so chat keeps
  headroom. Past the limit the device gets `error rate_limited` and Pixie does a sleepy perform.
- **Vision** runs at most once per 20 s per user unless the frame `reason` is `"asked"`. Periodic
  frames are only captioned every 6th frame and only when the app, window or OCR text changed.
- **Decision tiers** live in `decide.ts` and are enforced in code. `whatsapp.reply`, `call.back`
  and `code.patch` are never promoted to auto. Unknown action kinds fail closed (never).
- **Privacy**: logs carry only event types, timings and error class names. Message previews, OCR
  text, transcripts and model output are never logged. Phone numbers are stored only as salted
  SHA-256 hashes in `contacts`; the number for a pending call-back is kept for 24 h so the proposal
  can carry it. `DELETE /v1/memory` wipes memories, preferences, decisions, proposals, context,
  contacts, digest, reminders and mood.
