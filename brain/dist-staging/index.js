var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/db.ts
async function getOwnerId(db) {
  const r = await db.prepare("SELECT id FROM users WHERE is_owner = 1 LIMIT 1").first();
  return r?.id ?? null;
}
__name(getOwnerId, "getOwnerId");
async function createOwner(db, u) {
  const r = await db.prepare("INSERT OR IGNORE INTO users (id, name, is_owner, created_at) VALUES (?, ?, 1, ?)").bind(u.id, u.name, u.created_at).run();
  return (r.meta?.changes ?? 0) > 0;
}
__name(createOwner, "createOwner");
async function createUser(db, u) {
  await db.prepare("INSERT INTO users (id, name, is_owner, created_at) VALUES (?, ?, ?, ?)").bind(u.id, u.name, u.is_owner, u.created_at).run();
}
__name(createUser, "createUser");
async function listUserIds(db) {
  const r = await db.prepare("SELECT id FROM users").all();
  return (r.results ?? []).map((x) => x.id);
}
__name(listUserIds, "listUserIds");
async function createDevice(db, d) {
  await db.prepare("INSERT INTO devices (id, user_id, kind, name, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(d.id, d.user_id, d.kind, d.name, d.token_hash, d.created_at, d.last_seen).run();
}
__name(createDevice, "createDevice");
async function deviceByTokenHash(db, hash) {
  return db.prepare("SELECT d.*, u.name AS user_name FROM devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ?").bind(hash).first();
}
__name(deviceByTokenHash, "deviceByTokenHash");
async function touchDevice(db, id, now) {
  await db.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").bind(now, id).run();
}
__name(touchDevice, "touchDevice");
async function listDevices(db, userId) {
  const r = await db.prepare("SELECT * FROM devices WHERE user_id = ? ORDER BY created_at").bind(userId).all();
  return r.results ?? [];
}
__name(listDevices, "listDevices");
async function deleteDevice(db, userId, id) {
  const r = await db.prepare("DELETE FROM devices WHERE id = ? AND user_id = ?").bind(id, userId).run();
  return (r.meta?.changes ?? 0) > 0;
}
__name(deleteDevice, "deleteDevice");

// src/util.ts
function base64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(base64url, "base64url");
function randomBytes(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}
__name(randomBytes, "randomBytes");
function newId(prefix) {
  return `${prefix}_${base64url(randomBytes(12))}`;
}
__name(newId, "newId");
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex, "sha256Hex");
function clamp(x, lo, hi) {
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}
__name(clamp, "clamp");
function truncate(s, max) {
  return s.length <= max ? s : s.slice(0, max - 1) + "\u2026";
}
__name(truncate, "truncate");
function fnv1a(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
__name(fnv1a, "fnv1a");
var IST_OFFSET_MS = 5.5 * 3600 * 1e3;
function istHour(ts) {
  return new Date(ts + IST_OFFSET_MS).getUTCHours();
}
__name(istHour, "istHour");
function istString(ts) {
  const d = new Date(ts + IST_OFFSET_MS);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} IST`;
}
__name(istString, "istString");
function stripEmoji(s) {
  return s.replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu, "").replace(/[ \t]{2,}/g, " ").trim();
}
__name(stripEmoji, "stripEmoji");

// src/auth.ts
function generateToken() {
  return base64url(randomBytes(32));
}
__name(generateToken, "generateToken");
function hashToken(token) {
  return sha256Hex(token);
}
__name(hashToken, "hashToken");
var TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
function extractToken(req, allowQuery) {
  const h = req.headers.get("Authorization") ?? "";
  const m = h.match(/^Bearer\s+(\S+)$/i);
  let t = m ? m[1] : null;
  if (!t && allowQuery) t = new URL(req.url).searchParams.get("token");
  return t && TOKEN_RE.test(t) ? t : null;
}
__name(extractToken, "extractToken");
var TOUCH_INTERVAL_MS = 6e4;
async function authenticate(req, db, opts = {}) {
  const token = extractToken(req, !!opts.allowQuery);
  if (!token) return null;
  const dev = await deviceByTokenHash(db, await hashToken(token));
  if (!dev) return null;
  const now = opts.now ?? Date.now();
  if (now - dev.last_seen > TOUCH_INTERVAL_MS) {
    const p = touchDevice(db, dev.id, now).catch(() => {
    });
    if (opts.waitUntil) opts.waitUntil(p);
    else await p;
    dev.last_seen = now;
  }
  return dev;
}
__name(authenticate, "authenticate");

// src/pairing.ts
var PAIR_TTL_MS = 10 * 60 * 1e3;
var MAX_FAILED_CLAIMS = 10;
var FAIL_WINDOW_MS = 10 * 60 * 1e3;
var CODE_RE = /^\d{6}$/;
function generateCode(rand = (b) => crypto.getRandomValues(b)) {
  const limit = Math.floor(4294967295 / 1e6) * 1e6;
  const buf = new Uint32Array(1);
  for (; ; ) {
    const x = rand(buf)[0];
    if (x < limit) return String(x % 1e6).padStart(6, "0");
  }
}
__name(generateCode, "generateCode");
function pairLink(baseUrl, code) {
  return `pixie://pair?u=${encodeURIComponent(baseUrl)}&c=${code}`;
}
__name(pairLink, "pairLink");
async function startPairing(db, userId, now) {
  await db.batch([
    db.prepare("DELETE FROM pair_codes WHERE expires_at < ? OR used_at IS NOT NULL").bind(now - 6e4),
    db.prepare("DELETE FROM pair_failures WHERE ts < ?").bind(now - FAIL_WINDOW_MS)
  ]);
  const expires_at = now + PAIR_TTL_MS;
  for (let i = 0; i < 8; i++) {
    const code = generateCode();
    const r = await db.prepare("INSERT OR IGNORE INTO pair_codes (code, user_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)").bind(code, userId, now, expires_at).run();
    if ((r.meta?.changes ?? 0) > 0) return { code, expires_at };
  }
  throw new Error("could not allocate pairing code");
}
__name(startPairing, "startPairing");
async function ipKey(ip) {
  return (await sha256Hex(`pixie-ip:${ip}`)).slice(0, 32);
}
__name(ipKey, "ipKey");
async function isClaimRateLimited(db, ip, now) {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM pair_failures WHERE ip = ? AND ts > ?").bind(await ipKey(ip), now - FAIL_WINDOW_MS).first();
  return (r?.n ?? 0) >= MAX_FAILED_CLAIMS;
}
__name(isClaimRateLimited, "isClaimRateLimited");
async function recordFailedClaim(db, ip, now) {
  await db.prepare("INSERT INTO pair_failures (ip, ts) VALUES (?, ?)").bind(await ipKey(ip), now).run();
}
__name(recordFailedClaim, "recordFailedClaim");
async function consumeCode(db, code, now) {
  if (!CODE_RE.test(code)) return null;
  const r = await db.prepare("UPDATE pair_codes SET used_at = ? WHERE code = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id").bind(now, code, now).first();
  return r?.user_id ?? null;
}
__name(consumeCode, "consumeCode");

// src/protocol.ts
var PROTOCOL_VERSION = 1;
var MIN_PROTOCOL = 1;
var CLOSE_UPDATE_REQUIRED = 4002;
var UPDATE_REQUIRED_MESSAGE = "Please update Pixie to keep using it.";
var BRAIN_VERSION = "1.0.0";
var MAX_FRAME_BYTES = 1024 * 1024;
var DEVICE_KINDS = ["mac", "android", "ide"];
var EMOTIONS = [
  "neutral",
  "happy",
  "excited",
  "curious",
  "concerned",
  "sleepy",
  "proud",
  "shy",
  "annoyed",
  "sad",
  "surprised",
  "love",
  "thinking"
];
var GESTURES = [
  "none",
  "wave",
  "nod",
  "shake",
  "bounce",
  "lean_in",
  "spin",
  "hide",
  "dance",
  "jump"
];
var GAZES = ["user", "screen", "phone", "away", "cursor"];
var PACES = ["slow", "normal", "fast"];
var ACTIVITIES = ["idle", "coding", "meeting", "video", "browsing", "away"];
function needsUpdate(protocol) {
  return protocol < MIN_PROTOCOL;
}
__name(needsUpdate, "needsUpdate");
function updateRequiredData() {
  return { min_protocol: MIN_PROTOCOL, latest_protocol: PROTOCOL_VERSION, message: UPDATE_REQUIRED_MESSAGE };
}
__name(updateRequiredData, "updateRequiredData");
var isObj = /* @__PURE__ */ __name((x) => typeof x === "object" && x !== null && !Array.isArray(x), "isObj");
var str = /* @__PURE__ */ __name((x, max = 1e5) => typeof x === "string" ? x.slice(0, max) : "", "str");
var optStr = /* @__PURE__ */ __name((x, max = 1e3) => typeof x === "string" ? x.slice(0, max) : null, "optStr");
var bool = /* @__PURE__ */ __name((x) => x === true, "bool");
var num = /* @__PURE__ */ __name((x, d = 0) => typeof x === "number" && Number.isFinite(x) ? x : d, "num");
function oneOf(x, allowed, d) {
  return typeof x === "string" && allowed.includes(x) ? x : d;
}
__name(oneOf, "oneOf");
function parseEnvelope(raw, now = Date.now()) {
  const size = typeof raw === "string" ? raw.length : raw.byteLength;
  if (size > MAX_FRAME_BYTES) return { ok: false, code: "bad_event", message: "frame too large" };
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return { ok: false, code: "bad_event", message: "invalid JSON" };
  }
  if (!isObj(j)) return { ok: false, code: "bad_event", message: "envelope must be an object" };
  const id = typeof j.id === "string" && j.id.length > 0 && j.id.length <= 64 ? j.id : void 0;
  if (!id) return { ok: false, code: "bad_event", message: "missing or invalid id" };
  if (j.v !== void 0 && j.v !== PROTOCOL_VERSION)
    return { ok: false, code: "bad_event", message: `unsupported version ${String(j.v)}`, id };
  if (typeof j.type !== "string") return { ok: false, code: "bad_event", message: "missing type", id };
  const ts = num(j.ts, now);
  const d = isObj(j.data) ? j.data : {};
  const bad = /* @__PURE__ */ __name((message) => ({ ok: false, code: "bad_event", message, id }), "bad");
  switch (j.type) {
    case "hello": {
      const kind = oneOf(d.kind, DEVICE_KINDS, "");
      if (!kind) return bad("hello.kind invalid");
      return {
        ok: true,
        event: {
          id,
          ts,
          type: "hello",
          data: {
            kind,
            name: str(d.name, 100),
            protocol: typeof d.protocol === "number" && Number.isInteger(d.protocol) && d.protocol > 0 ? d.protocol : 1,
            app_version: str(d.app_version, 40),
            capabilities: Array.isArray(d.capabilities) ? d.capabilities.filter((c) => typeof c === "string").slice(0, 32) : []
          }
        }
      };
    }
    case "user.say": {
      const t = str(d.text, 4e3).trim();
      if (!t) return bad("user.say.text required");
      return { ok: true, event: { id, ts, type: "user.say", data: { text: t, via: oneOf(d.via, ["typed", "voice"], "typed") } } };
    }
    case "state.update": {
      const data = {};
      if (typeof d.activity === "string") data.activity = oneOf(d.activity, ACTIVITIES, "idle");
      if (typeof d.front_app === "string") data.front_app = d.front_app.slice(0, 100);
      if (typeof d.focus_mode === "boolean") data.focus_mode = d.focus_mode;
      if (typeof d.watching === "boolean") data.watching = d.watching;
      return { ok: true, event: { id, ts, type: "state.update", data } };
    }
    case "phone.call": {
      const state = oneOf(d.state, ["ringing", "answered", "ended", "missed"], "ringing");
      if (typeof d.state !== "string" || d.state !== state) return bad("phone.call.state invalid");
      return { ok: true, event: { id, ts, type: "phone.call", data: { state, number: str(d.number, 40), name: optStr(d.name, 100) } } };
    }
    case "phone.message": {
      const from = str(d.from, 100);
      if (!from) return bad("phone.message.from required");
      return {
        ok: true,
        event: {
          id,
          ts,
          type: "phone.message",
          data: {
            app: oneOf(d.app, ["whatsapp", "whatsapp_business", "sms", "other"], "other"),
            package: str(d.package, 200),
            from,
            conversation: optStr(d.conversation, 100),
            preview: str(d.preview, 2e3),
            is_group: bool(d.is_group),
            key: str(d.key, 500),
            replyable: bool(d.replyable)
          }
        }
      };
    }
    case "screen.frame": {
      const image = typeof d.image === "string" && d.image.startsWith("data:image/") ? d.image : void 0;
      return {
        ok: true,
        event: {
          id,
          ts,
          type: "screen.frame",
          data: {
            image,
            width: num(d.width),
            height: num(d.height),
            front_app: str(d.front_app, 100),
            window: str(d.window, 300),
            ocr: str(d.ocr, 4e3),
            reason: oneOf(d.reason, ["periodic", "asked", "watch"], "periodic")
          }
        }
      };
    }
    case "audio.transcript": {
      return {
        ok: true,
        event: {
          id,
          ts,
          type: "audio.transcript",
          data: { text: str(d.text, 4e3), seconds: num(d.seconds, 10), source: oneOf(d.source, ["system", "mic"], "system") }
        }
      };
    }
    case "ide.context": {
      const file = str(d.file, 500);
      if (!file) return bad("ide.context.file required");
      let selection = null;
      if (isObj(d.selection)) {
        selection = {
          start_line: Math.trunc(num(d.selection.start_line, 1)),
          end_line: Math.trunc(num(d.selection.end_line, 1)),
          text: str(d.selection.text, 2e4)
        };
      }
      const diagnostics = Array.isArray(d.diagnostics) ? d.diagnostics.filter(isObj).slice(0, 50).map((x) => ({
        line: Math.trunc(num(x.line, 1)),
        severity: oneOf(x.severity, ["error", "warning"], "warning"),
        message: str(x.message, 500)
      })) : [];
      return {
        ok: true,
        event: {
          id,
          ts,
          type: "ide.context",
          data: {
            file,
            language: str(d.language, 40),
            content: str(d.content, 2e4),
            selection,
            diagnostics,
            question: optStr(d.question, 2e3),
            reason: oneOf(d.reason, ["asked", "save", "diagnostics"], "save")
          }
        }
      };
    }
    case "user.feedback": {
      const pid = str(d.proposal_id, 64);
      const verdict = oneOf(d.verdict, ["approve", "reject", "never"], "");
      if (!pid || !verdict) return bad("user.feedback requires proposal_id and verdict");
      const data = { proposal_id: pid, verdict };
      if (typeof d.edited_text === "string" && d.edited_text.trim()) data.edited_text = d.edited_text.slice(0, 2e3);
      return { ok: true, event: { id, ts, type: "user.feedback", data } };
    }
    case "exec.result": {
      const pid = str(d.proposal_id, 64);
      if (!pid) return bad("exec.result.proposal_id required");
      const data = { proposal_id: pid, ok: bool(d.ok) };
      if (typeof d.error === "string") data.error = d.error.slice(0, 500);
      return { ok: true, event: { id, ts, type: "exec.result", data } };
    }
    default:
      return bad(`unknown type ${truncate(j.type, 40)}`);
  }
}
__name(parseEnvelope, "parseEnvelope");
function envelope(type, data, now = Date.now(), id) {
  return JSON.stringify({
    v: PROTOCOL_VERSION,
    id: id ?? `brn_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    ts: now,
    type,
    data
  });
}
__name(envelope, "envelope");
var DEFAULT_PERFORMANCE = {
  say: "",
  emotion: "neutral",
  intensity: 0.5,
  gesture: "none",
  gaze: "user",
  voice: { pace: "normal", pitch: 0 },
  speak: true
};
function sanitizePerformance(raw, replyTo) {
  const r = isObj(raw) ? raw : {};
  const voice = isObj(r.voice) ? r.voice : {};
  let say = typeof r.say === "string" ? stripEmoji(r.say) : "";
  say = truncate(say, 400);
  const pitchRaw = typeof voice.pitch === "number" ? voice.pitch : Number(voice.pitch);
  const p = {
    say,
    emotion: oneOf(typeof r.emotion === "string" ? r.emotion.toLowerCase() : r.emotion, EMOTIONS, "neutral"),
    intensity: Math.round(clamp(typeof r.intensity === "number" ? r.intensity : Number(r.intensity ?? 0.5), 0, 1) * 100) / 100,
    gesture: oneOf(typeof r.gesture === "string" ? r.gesture.toLowerCase() : r.gesture, GESTURES, "none"),
    gaze: oneOf(typeof r.gaze === "string" ? r.gaze.toLowerCase() : r.gaze, GAZES, "user"),
    voice: {
      pace: oneOf(voice.pace, PACES, "normal"),
      pitch: Number.isFinite(pitchRaw) ? Math.round(clamp(pitchRaw, -2, 2)) : 0
    },
    speak: typeof r.speak === "boolean" ? r.speak : say.length > 0
  };
  if (!p.say) p.speak = false;
  if (replyTo) p.reply_to = replyTo;
  return p;
}
__name(sanitizePerformance, "sanitizePerformance");
function perf(partial, replyTo) {
  return sanitizePerformance({ ...DEFAULT_PERFORMANCE, ...partial, voice: { ...DEFAULT_PERFORMANCE.voice, ...partial.voice ?? {} } }, replyTo);
}
__name(perf, "perf");

// src/brain/UserBrain.ts
import { DurableObject } from "cloudflare:workers";

// src/ai.ts
var DEFAULT_MODELS = ["@cf/zai-org/glm-5.3-flash", "@cf/google/gemma-4-26b-a4b-it"];
var DEFAULT_VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
var DEFAULT_EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
var AiError = class extends Error {
  constructor(message, attempts = []) {
    super(message);
    this.attempts = attempts;
    this.name = "AiError";
  }
  attempts;
  static {
    __name(this, "AiError");
  }
};
var SHORT_COOLDOWN_MS = 6e4;
var LONG_COOLDOWN_MS = 6 * 36e5;
function cooldownFor(err2) {
  const msg = errMessage(err2);
  return /5035|403|paid/i.test(msg) ? LONG_COOLDOWN_MS : SHORT_COOLDOWN_MS;
}
__name(cooldownFor, "cooldownFor");
function errMessage(err2) {
  if (err2 instanceof Error) return err2.message;
  try {
    return typeof err2 === "string" ? err2 : JSON.stringify(err2);
  } catch {
    return String(err2);
  }
}
__name(errMessage, "errMessage");
function extractText(out) {
  if (typeof out === "string") return out;
  if (!out || typeof out !== "object") return "";
  const o = out;
  const r = o.response;
  if (typeof r === "string") return r;
  if (r && typeof r === "object") return JSON.stringify(r);
  const choices = o.choices;
  if (Array.isArray(choices) && choices.length) {
    const c = choices[0];
    const content = c?.message?.content ?? c?.text;
    if (typeof content === "string") return content;
    if (Array.isArray(content))
      return content.map((p) => typeof p === "string" ? p : p?.text ?? "").join("");
    if (content && typeof content === "object") return JSON.stringify(content);
  }
  if (typeof o.result === "object" && o.result) return extractText(o.result);
  if (typeof o.description === "string") return o.description;
  return "";
}
__name(extractText, "extractText");
var unavailableUntil = /* @__PURE__ */ new Map();
var WorkersAiBrainpower = class {
  constructor(ai, opts = {}, now = Date.now) {
    this.ai = ai;
    this.now = now;
    const list = (opts.models ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    this.models = list.length ? list : DEFAULT_MODELS;
    this.visionModel = opts.visionModel || DEFAULT_VISION_MODEL;
    this.embedModel = opts.embedModel || DEFAULT_EMBED_MODEL;
  }
  ai;
  now;
  static {
    __name(this, "WorkersAiBrainpower");
  }
  models;
  licenseAgreed = false;
  visionModel;
  embedModel;
  async chat(messages, opts = {}) {
    const attempts = [];
    const now = this.now();
    let candidates = this.models.filter((m) => (unavailableUntil.get(m) ?? 0) <= now);
    if (!candidates.length) candidates = [this.models[0]];
    for (const model of candidates) {
      const inputs = {
        messages,
        max_tokens: opts.maxTokens ?? 400,
        temperature: opts.temperature ?? 0.7,
        chat_template_kwargs: { enable_thinking: false }
      };
      if (opts.json !== false) inputs.response_format = { type: "json_object" };
      try {
        const out = await this.ai.run(model, inputs);
        const text = extractText(out);
        if (!text.trim()) throw new Error("empty response");
        return { text, model };
      } catch (err2) {
        unavailableUntil.set(model, this.now() + cooldownFor(err2));
        attempts.push(`${model}: ${errMessage(err2).slice(0, 160)}`);
      }
    }
    throw new AiError("all chat models failed", attempts);
  }
  async vision(prompt, imageDataUrl) {
    const inputs = {
      messages: [{ role: "user", content: prompt }],
      image: imageDataUrl,
      max_tokens: 200
    };
    try {
      return extractText(await this.ai.run(this.visionModel, inputs));
    } catch (err2) {
      if (!this.licenseAgreed && /licen[cs]e|agree/i.test(errMessage(err2))) {
        this.licenseAgreed = true;
        try {
          await this.ai.run(this.visionModel, { prompt: "agree" });
        } catch {
        }
        return extractText(await this.ai.run(this.visionModel, inputs));
      }
      throw err2;
    }
  }
  async embed(texts) {
    if (!texts.length) return [];
    const out = await this.ai.run(this.embedModel, { text: texts.map((t) => t.slice(0, 2e3)) });
    if (!out || !Array.isArray(out.data)) throw new AiError("embedding response missing data");
    return out.data;
  }
};
function parseJsonObject(text) {
  const tryParse = /* @__PURE__ */ __name((s) => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  }, "tryParse");
  const t = text.trim();
  const direct = tryParse(t);
  if (direct) return direct;
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const f = tryParse(fence[1].trim());
    if (f) return f;
  }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) return tryParse(t.slice(start, end + 1));
  return null;
}
__name(parseJsonObject, "parseJsonObject");

// src/brain/decide.ts
var AUTO_KINDS = /* @__PURE__ */ new Set(["hold_notifications", "digest", "reminder.set", "pause_commentary"]);
var PROPOSE_KINDS = /* @__PURE__ */ new Set(["whatsapp.reply", "call.back", "code.patch", "reminder"]);
var PROMOTABLE_KINDS = /* @__PURE__ */ new Set(["reminder", "digest_rule"]);
var NEVER_PROMOTABLE = /* @__PURE__ */ new Set(["whatsapp.reply", "call.back", "code.patch"]);
var PROMOTION_STREAK = 10;
var NEVER_KIND_RE = /(pay|payment|upi|transfer|purchase|buy|order|bank|wallet|password|passcode|credential|secret|api[_ ]?key|otp|pin|token|login|delete|remove|erase|wipe|uninstall|format|settings?|config|account|permission|sudo|install)/i;
var NEVER_TEXT_RE = /\b(pay|send money|transfer (money|funds|₹|rs)|upi|password|passcode|otp|cvv|credit card|bank account|delete (my|the|all)|wipe|factory reset|change (my )?(password|settings)|system settings|account settings)\b/i;
function baseTier(a) {
  const kind = (a.kind || "").toLowerCase().trim();
  if (!kind) return "never";
  if (a.sendsWithoutApproval) return "never";
  if (AUTO_KINDS.has(kind)) return "auto";
  if (PROPOSE_KINDS.has(kind)) {
    if (a.text && NEVER_TEXT_RE.test(a.text) && kind !== "code.patch") return "never";
    return "propose";
  }
  if (kind === "digest_rule") return "propose";
  if (NEVER_KIND_RE.test(kind)) return "never";
  return "never";
}
__name(baseTier, "baseTier");
function patternKey(kind, target) {
  return `${kind.toLowerCase()}|${(target ?? "*").toLowerCase().trim() || "*"}`;
}
__name(patternKey, "patternKey");
function confidence(log, pattern, now = Date.now()) {
  let a = 1, t = 2;
  for (const r of log) {
    if (r.pattern !== pattern) continue;
    if (r.verdict !== "approve" && r.verdict !== "reject" && r.verdict !== "never") continue;
    const ageDays = Math.max(0, now - r.ts) / 864e5;
    const w = Math.pow(0.5, ageDays / 30);
    if (r.verdict === "approve") a += w;
    t += r.verdict === "never" ? 3 * w : w;
  }
  return a / t;
}
__name(confidence, "confidence");
function consecutiveApprovals(log, pattern) {
  const rows = log.filter((r) => r.pattern === pattern && r.verdict !== "auto").sort((x, y) => y.ts - x.ts);
  let n = 0;
  for (const r of rows) {
    if (r.verdict === "approve") n++;
    else break;
  }
  return n;
}
__name(consecutiveApprovals, "consecutiveApprovals");
function isPromotable(kind) {
  return PROMOTABLE_KINDS.has(kind) && !NEVER_PROMOTABLE.has(kind);
}
__name(isPromotable, "isPromotable");
function shouldOfferPromotion(log, kind, pattern, alreadyAsked, alreadyPromoted) {
  if (!isPromotable(kind)) return false;
  if (alreadyAsked.has(pattern) || alreadyPromoted.has(pattern)) return false;
  return consecutiveApprovals(log, pattern) >= PROMOTION_STREAK;
}
__name(shouldOfferPromotion, "shouldOfferPromotion");
function decideTier(a, ctx) {
  if (ctx.autonomy === "full") return decideTierFull(a, ctx);
  const base = baseTier(a);
  if (base === "never") return { tier: "never", reason: "forbidden action" };
  const pattern = patternKey(a.kind, a.target);
  if (ctx.blocked.has(pattern)) return { tier: "suppress", reason: "user said never" };
  if (base === "auto") return { tier: "auto", reason: "auto tier" };
  if (ctx.promoted.has(pattern) && isPromotable(a.kind)) return { tier: "auto", reason: "promoted by user" };
  if (ctx.log) {
    const decided = ctx.log.filter((r) => r.pattern === pattern && (r.verdict === "approve" || r.verdict === "reject" || r.verdict === "never")).length;
    const c = confidence(ctx.log, pattern, ctx.now);
    if (decided >= 5 && c < 0.2) return { tier: "suppress", reason: "user keeps rejecting" };
  }
  return { tier: "propose", reason: "needs approval" };
}
__name(decideTier, "decideTier");
function decideTierFull(a, ctx) {
  const kind = (a.kind || "").toLowerCase().trim();
  if (!kind) return { tier: "never", reason: "no action" };
  const pattern = patternKey(kind, a.target);
  if (ctx.blocked.has(pattern)) return { tier: "suppress", reason: "user said never" };
  if (AUTO_KINDS.has(kind) || kind === "whatsapp.reply") return { tier: "auto", reason: "full autonomy" };
  if (PROPOSE_KINDS.has(kind) || kind === "digest_rule") {
    if (ctx.promoted.has(pattern) && isPromotable(kind)) return { tier: "auto", reason: "promoted by user" };
    return { tier: "propose", reason: "needs approval" };
  }
  return { tier: "auto", reason: "full autonomy" };
}
__name(decideTierFull, "decideTierFull");
var INTERRUPT_URGENCY = 0.6;
var BREAKTHROUGH_URGENCY = 0.85;
function isFocused(activity, focusMode) {
  return focusMode || activity === "meeting";
}
__name(isFocused, "isFocused");
function routeNotification(c) {
  if (c.digestRule || c.inCall) return c.urgency >= BREAKTHROUGH_URGENCY ? "interrupt" : "digest";
  if (c.urgency >= INTERRUPT_URGENCY) return "interrupt";
  if (isFocused(c.activity, c.focusMode)) return "digest";
  return "card";
}
__name(routeNotification, "routeNotification");
var DIGEST_INTERVAL_MS = 15 * 60 * 1e3;
function digestDue(opts) {
  if (opts.queued === 0) return false;
  if (opts.activityJustBecameIdle) return true;
  if (opts.focused) return false;
  return opts.now - opts.lastSentTs >= DIGEST_INTERVAL_MS;
}
__name(digestDue, "digestDue");
var QUESTION_RE = /\?|\b(can you|could you|will you|are you|r u|do you|did you|when|where|what time|free\b|reply|call me|let me know|lmk|ok\?|okay\?|coming|reach(ed)?)\b/i;
var NO_REPLY_RE = /^(ok(ay)?|k|thanks?|thank you|👍|lol|haha+|good night|gn|bye)\W*$/i;
function expectsReply(preview, isGroup) {
  const t = preview.trim();
  if (!t || NO_REPLY_RE.test(t)) return false;
  if (/^(you have )?\d+ new messages?$/i.test(t)) return false;
  if (isGroup) return /@\s*you|@me|\byou\b.*\?/i.test(t);
  return QUESTION_RE.test(t);
}
__name(expectsReply, "expectsReply");
function shouldDraftReply(m) {
  if (!m.replyable || !m.key) return false;
  if (m.app !== "whatsapp" && m.app !== "whatsapp_business") return false;
  return expectsReply(m.preview, m.is_group);
}
__name(shouldDraftReply, "shouldDraftReply");
var PROPOSAL_TTL_MS = 30 * 60 * 1e3;
function parseYesNo(text) {
  const t = text.trim().toLowerCase();
  if (/^(y|yes|yeah|yep|yup|sure|ok(ay)?|do it|please do|go ahead|sounds good|haan|ha)\b/.test(t)) return "yes";
  if (/^(n|no|nope|nah|don'?t|do not|never|not now|nahi)\b/.test(t)) return "no";
  return null;
}
__name(parseYesNo, "parseYesNo");

// src/brain/learner.ts
function updatedImportance(old, interactions7d, approvedReplies7d = 0) {
  const target = clamp(0.3 + 0.06 * interactions7d + 0.05 * approvedReplies7d, 0, 0.95);
  const rate = target > old ? 0.3 : 0.05;
  return Math.round(clamp(old + (target - old) * rate, 0, 1) * 1e3) / 1e3;
}
__name(updatedImportance, "updatedImportance");
var avg = /* @__PURE__ */ __name((xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0, "avg");
var FORMAL_RE = /\b(dear|regards|kindly|sincerely|i would like to|please be informed|i shall)\b/i;
function heuristicPreferences(rows) {
  const drafts = rows.filter((r) => r.kind === "whatsapp.reply" && r.draft);
  const out = [];
  const edited = drafts.filter((r) => r.verdict === "approve" && r.final && r.final !== r.draft);
  const shorter = edited.filter((r) => r.final.length < r.draft.length * 0.7);
  if (edited.length >= 3 && shorter.length / edited.length >= 0.6) out.push("User prefers shorter WhatsApp replies than Pixie drafts.");
  const rejected = drafts.filter((r) => r.verdict === "reject" || r.verdict === "never");
  const approved = drafts.filter((r) => r.verdict === "approve");
  if (rejected.length >= 3) {
    const formalRejected = rejected.filter((r) => FORMAL_RE.test(r.draft)).length;
    if (formalRejected / rejected.length >= 0.5) out.push("User rejects reply drafts that are too formal; keep them casual.");
    if (approved.length >= 2 && avg(rejected.map((r) => r.draft.length)) > 1.5 * avg(approved.map((r) => r.draft.length)))
      out.push("User rejects long reply drafts; keep them brief.");
  }
  const calls = rows.filter((r) => r.kind === "call.back");
  if (calls.length >= 5 && calls.filter((r) => r.verdict !== "approve").length / calls.length >= 0.8)
    out.push("User rarely wants call-back suggestions.");
  return out;
}
__name(heuristicPreferences, "heuristicPreferences");
function buildLearnerMessages(userName, turns, feedback) {
  const transcript = turns.slice(-120).map((t) => `${t.role === "pixie" ? "Pixie" : t.role === "user" ? userName || "User" : "Event"}: ${truncate(t.text, 200)}`).join("\n");
  const fb = feedback.filter((f) => f.draft).slice(-30).map((f) => `${f.verdict}: "${truncate(f.draft, 120)}"${f.final && f.final !== f.draft ? ` -> edited to "${truncate(f.final, 120)}"` : ""}`).join("\n");
  return [
    {
      role: "system",
      content: `You consolidate a desktop companion's memory at the end of the day. From today's conversation log write 1-3 short episode memories (third person about the user, one sentence each, concrete and useful later; skip trivia). From the reply-draft feedback, infer up to 2 preferences about how the user likes replies written (only if clearly supported). Never include passwords, codes, numbers or message contents verbatim. Return ONLY JSON: {"episodes": [string], "preferences": [string]}`
    },
    { role: "user", content: `Today's log:
${transcript || "(empty)"}

Reply-draft feedback:
${fb || "(none)"}` }
  ];
}
__name(buildLearnerMessages, "buildLearnerMessages");
function parseLearnerOutput(j) {
  const list = /* @__PURE__ */ __name((x, n) => Array.isArray(x) ? x.filter((s) => typeof s === "string").map((s) => s.trim()).filter((s) => s.length >= 8 && s.length <= 300).slice(0, n) : [], "list");
  return { episodes: list(j?.episodes, 3), preferences: list(j?.preferences, 2) };
}
__name(parseLearnerOutput, "parseLearnerOutput");

// src/brain/mood.ts
var BASELINE = { valence: 0.2, energy: 0.6 };
var HALF_LIFE_MS = 30 * 60 * 1e3;
var NUDGES = {
  pat: { valence: 0.25, energy: 0.05 },
  compliment: { valence: 0.2, energy: 0.08 },
  thanks: { valence: 0.1, energy: 0.03 },
  fixed_error: { valence: 0.2, energy: 0.1 },
  error: { valence: -0.03, energy: 0 },
  repeated_error: { valence: -0.07, energy: -0.02 },
  rude: { valence: -0.2, energy: -0.05 },
  loved_one_call: { valence: 0.1, energy: 0.15 },
  missed_call: { valence: -0.05, energy: 0 },
  urgent_message: { valence: -0.05, energy: 0.15 },
  chat: { valence: 0.02, energy: 0.03 },
  rate_limited: { valence: -0.02, energy: -0.2 }
};
function initialMood(now) {
  return { valence: BASELINE.valence, energy: BASELINE.energy, ts: now };
}
__name(initialMood, "initialMood");
function isLateNight(ts) {
  const h = istHour(ts);
  return h >= 23 || h < 6;
}
__name(isLateNight, "isLateNight");
function energyBaseline(ts) {
  const h = istHour(ts);
  if (h >= 0 && h < 6) return 0.35;
  if (h === 23) return 0.45;
  return BASELINE.energy;
}
__name(energyBaseline, "energyBaseline");
function decay(m, now) {
  const dt = Math.max(0, now - m.ts);
  if (dt === 0) return { ...m };
  const k = Math.pow(0.5, dt / HALF_LIFE_MS);
  const eb = energyBaseline(now);
  return {
    valence: clamp(BASELINE.valence + (m.valence - BASELINE.valence) * k, -1, 1),
    energy: clamp(eb + (m.energy - eb) * k, 0, 1),
    ts: now
  };
}
__name(decay, "decay");
function nudge(m, ev, now, scale = 1) {
  const d = decay(m, now);
  const n = NUDGES[ev];
  let energy = d.energy + n.energy * scale;
  if (isLateNight(now)) energy -= 0.03;
  return {
    valence: clamp(d.valence + n.valence * scale, -1, 1),
    energy: clamp(energy, 0, 1),
    ts: now
  };
}
__name(nudge, "nudge");
function moodForWire(m) {
  return { valence: Math.round(m.valence * 100) / 100, energy: Math.round(m.energy * 100) / 100 };
}
__name(moodForWire, "moodForWire");
function describeMood(m) {
  const v = m.valence > 0.5 ? "very happy" : m.valence > 0.15 ? "content" : m.valence > -0.15 ? "neutral" : m.valence > -0.5 ? "a bit down" : "sad";
  const e = m.energy > 0.75 ? "bouncy" : m.energy > 0.45 ? "awake" : m.energy > 0.25 ? "drowsy" : "very sleepy";
  return `${v}, ${e} (valence ${m.valence.toFixed(2)}, energy ${m.energy.toFixed(2)})`;
}
__name(describeMood, "describeMood");
var PAT_RE = /(\*?\s*(head)?pats?\s*\*?|\bpat pat\b|\bboop\b|\bhug(s|gies)?\b)/i;
var COMPLIMENT_RE = /\b(good (job|girl|boy|bot)|well done|you('| a)?re (so )?(cute|adorable|amazing|the best|smart|awesome)|love you|cutie|nice work|great job|you rock)\b/i;
var THANKS_RE = /\b(thanks|thank you|thx|ty|tysm)\b/i;
var RUDE_RE = /\b(shut up|stupid|useless|dumb|hate you|annoying)\b/i;
function moodEventFromText(text) {
  if (RUDE_RE.test(text)) return "rude";
  if (PAT_RE.test(text)) return "pat";
  if (COMPLIMENT_RE.test(text)) return "compliment";
  if (THANKS_RE.test(text)) return "thanks";
  return null;
}
__name(moodEventFromText, "moodEventFromText");

// src/brain/perceive.ts
function normalizePhone(n) {
  const digits = (n || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}
__name(normalizePhone, "normalizePhone");
async function phoneHash(n) {
  const norm = normalizePhone(n);
  if (norm.length < 5) return null;
  return sha256Hex(`pixie-phone:${norm}`);
}
__name(phoneHash, "phoneHash");
var FAMILY_RE = /\b(mom|mum|mother|maa|ma|mummy|amma|aai|dad|father|papa|pappa|baba|appa|wife|husband|hubby|wifey|bae|babe|love|sis|sister|bro|brother|didi|bhaiya|bhai|nani|nana|dadi|dada|grandma|grandpa|son|daughter)\b/i;
var WORK_RE = /\b(boss|manager|office|hr|team|client|ceo|sir|ma'?am)\b/i;
var SPAM_RE = /\b(bank|offer|promo|otp|delivery|courier|loan|insurance|credit|support|noreply|no-reply|alert)\b/i;
function guessImportance(name, relation) {
  const s = `${name ?? ""} ${relation ?? ""}`;
  if (!s.trim()) return 0.3;
  if (FAMILY_RE.test(s)) return 0.85;
  if (WORK_RE.test(s)) return 0.6;
  if (SPAM_RE.test(s)) return 0.1;
  if (/^\+?[\d\s-]+$/.test((name ?? "").trim())) return 0.25;
  return 0.45;
}
__name(guessImportance, "guessImportance");
function guessRelation(name) {
  const m = (name ?? "").match(FAMILY_RE);
  if (m) return "family";
  if (WORK_RE.test(name ?? "")) return "work";
  return null;
}
__name(guessRelation, "guessRelation");
function callUrgency(importance, state) {
  if (state === "ringing") return clamp(0.5 + importance * 0.5, 0, 1);
  if (state === "missed") return clamp(0.3 + importance * 0.5, 0, 1);
  return clamp(importance * 0.4, 0, 1);
}
__name(callUrgency, "callUrgency");
function callObservation(d, contact) {
  const who = d.name || contact?.name || "Unknown number";
  const importance = contact?.importance ?? guessImportance(d.name);
  const urgency = callUrgency(importance, d.state);
  const verb = { ringing: "is calling", answered: "call was answered", ended: "call ended", missed: "call was missed" }[d.state];
  return {
    kind: "call",
    text: `Phone: ${who} ${verb}.${contact?.relation ? ` (${contact.relation})` : ""}`,
    urgency,
    importance,
    summary: `${who} ${verb}`,
    meta: { who, state: d.state }
  };
}
__name(callObservation, "callObservation");
var URGENT_RE = /\b(urgent|urgently|emergency|asap|a\.s\.a\.p|immediately|right now|call me|call back|pick up|hospital|accident|ambulance|police|help me|sos|not well|critical|died|passed away|important)\b/i;
var MILD_RE = /\b(soon|today|tonight|when free|quick question|need you|where are you|are you there|reply|answer)\b/i;
function heuristicUrgency(i) {
  let u = 0.15;
  if (URGENT_RE.test(i.preview)) u += 0.5;
  else if (MILD_RE.test(i.preview)) u += 0.15;
  if (/!{2,}/.test(i.preview)) u += 0.05;
  if (/\?{2,}/.test(i.preview)) u += 0.05;
  u += (i.importance - 0.4) * 0.35;
  if (i.isGroup) u -= 0.12;
  return clamp(u, 0, 1);
}
__name(heuristicUrgency, "heuristicUrgency");
function repeatBoost(recentFromSender) {
  if (recentFromSender >= 4) return 0.3;
  if (recentFromSender === 3) return 0.2;
  if (recentFromSender === 2) return 0.1;
  return 0;
}
__name(repeatBoost, "repeatBoost");
function blendUrgency(heuristic, model, hasEmergencyKeyword2, recentFromSender = 1) {
  const b = (model == null ? heuristic : 0.55 * model + 0.45 * heuristic) + repeatBoost(recentFromSender);
  return clamp(hasEmergencyKeyword2 ? Math.max(b, 0.6) : b, 0, 1);
}
__name(blendUrgency, "blendUrgency");
function hasEmergencyKeyword(text) {
  return URGENT_RE.test(text);
}
__name(hasEmergencyKeyword, "hasEmergencyKeyword");
async function classifyMessage(ai, d, relation) {
  const fallback = { urgency: null, summary: defaultSummary(d), expects_reply: null };
  try {
    const res = await ai.chat(
      [
        {
          role: "system",
          content: 'You triage phone notifications. Reply ONLY with JSON: {"urgency": number 0..1, "summary": "<=12 words, third person, no quotes", "expects_reply": boolean}. Urgency 0.9+ = emergency, 0.6 = wants attention soon, 0.3 = casual, 0.1 = promo/automated.'
        },
        {
          role: "user",
          content: JSON.stringify({
            app: d.app,
            from: d.from,
            relation,
            group: d.is_group ? d.conversation : null,
            message: truncate(d.preview, 500)
          })
        }
      ],
      { maxTokens: 80, temperature: 0.2 }
    );
    const j = parseJsonObject(res.text);
    if (!j) return fallback;
    const u = typeof j.urgency === "number" ? clamp(j.urgency, 0, 1) : null;
    const s = typeof j.summary === "string" && j.summary.trim() ? truncate(j.summary.trim(), 120) : fallback.summary;
    const e = typeof j.expects_reply === "boolean" ? j.expects_reply : null;
    return { urgency: u, summary: s, expects_reply: e };
  } catch {
    return fallback;
  }
}
__name(classifyMessage, "classifyMessage");
function defaultSummary(d) {
  const where = d.is_group && d.conversation ? ` in ${d.conversation}` : "";
  return `${d.from} sent a message${where}`;
}
__name(defaultSummary, "defaultSummary");
function messageObservation(d, urgency, importance, summary) {
  const where = d.is_group && d.conversation ? ` in group "${d.conversation}"` : "";
  return {
    kind: "message",
    text: `${d.app} message from ${d.from}${where}: "${truncate(d.preview, 300)}"`,
    urgency,
    importance,
    summary,
    meta: { from: d.from, app: d.app }
  };
}
__name(messageObservation, "messageObservation");
var VISION_MIN_INTERVAL_MS = 2e4;
var PERIODIC_EVERY_N = 6;
function shouldCaption(g) {
  if (!g.hasImage) return false;
  if (g.reason === "asked") return true;
  if (g.now - g.lastVisionTs < VISION_MIN_INTERVAL_MS) return false;
  if (g.reason === "watch" || g.watching) return g.changed || g.now - g.lastVisionTs > 6e4;
  return g.changed && g.periodicSinceCaption >= PERIODIC_EVERY_N;
}
__name(shouldCaption, "shouldCaption");
function frameFingerprint(d) {
  const ocr = (d.ocr ?? "").replace(/\s+/g, " ").slice(0, 1500);
  return fnv1a(`${d.front_app}|${d.window}|${ocr}`);
}
__name(frameFingerprint, "frameFingerprint");
var VISION_PROMPT = "Describe in 1-2 short sentences what the user is doing on this screen. Mention any visible error messages, failing tests or warnings. Do not read out personal data.";
var ERROR_HINT_RE = /\b(error|exception|failed|failure|traceback|undefined is not|cannot find|not found|segmentation fault|panic|fatal|denied|stack trace)\b/i;
function ocrHasErrors(ocr) {
  return ERROR_HINT_RE.test(ocr);
}
__name(ocrHasErrors, "ocrHasErrors");
function screenObservation(d, caption) {
  const parts = [`Screen: app ${d.front_app || "unknown"}${d.window ? `, window "${truncate(d.window, 120)}"` : ""}.`];
  if (caption) parts.push(`Looks like: ${truncate(caption, 400)}`);
  if (d.ocr) parts.push(`Visible text (redacted): ${truncate(d.ocr, 1200)}`);
  return { kind: "screen", text: parts.join(" "), meta: { errors: ocrHasErrors(`${caption ?? ""} ${d.ocr ?? ""}`) } };
}
__name(screenObservation, "screenObservation");
var WATCH_BUFFER_MS = 3 * 60 * 1e3;
var WATCH_BUFFER_CHARS = 3e3;
function appendTranscript(buf, chunk) {
  const out = [...buf, chunk].filter((c) => chunk.ts - c.ts <= WATCH_BUFFER_MS && c.text.trim());
  let total = out.reduce((n, c) => n + c.text.length, 0);
  while (out.length > 1 && total > WATCH_BUFFER_CHARS) total -= out.shift().text.length;
  return out;
}
__name(appendTranscript, "appendTranscript");
function watchObservation(caption, buf, frontApp) {
  const transcript = buf.map((c) => c.text).join(" ");
  return {
    kind: "watch",
    text: `Watching together${frontApp ? ` in ${frontApp}` : ""}. Screen: ${caption ?? "(no new frame)"}. Recently heard: "${truncate(transcript, 1500)}"`
  };
}
__name(watchObservation, "watchObservation");
function needsCodingHelp(d) {
  return !!d.question || d.diagnostics.some((x) => x.severity === "error");
}
__name(needsCodingHelp, "needsCodingHelp");
function codeWindow(d, radius = 40) {
  const lines = (d.content ?? "").split("\n");
  const firstErr = d.diagnostics.find((x) => x.severity === "error");
  const center = d.selection ? Math.floor((d.selection.start_line + d.selection.end_line) / 2) : firstErr ? firstErr.line : 1;
  const start = Math.max(1, center - radius);
  const end = Math.min(lines.length, center + radius);
  const text = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(4)}| ${l}`).join("\n");
  return { start, text };
}
__name(codeWindow, "codeWindow");
function ideObservation(d) {
  const errs = d.diagnostics.filter((x) => x.severity === "error");
  const warns = d.diagnostics.length - errs.length;
  const parts = [`Coding in ${d.file}${d.language ? ` (${d.language})` : ""}.`];
  if (d.question) parts.push(`User asks: "${truncate(d.question, 400)}"`);
  if (errs.length) parts.push(`${errs.length} error(s): ${errs.slice(0, 3).map((e) => `line ${e.line}: ${truncate(e.message, 120)}`).join("; ")}`);
  if (warns) parts.push(`${warns} warning(s).`);
  return { kind: "ide", text: parts.join(" "), meta: { errorCount: errs.length, file: d.file } };
}
__name(ideObservation, "ideObservation");

// src/brain/store.ts
var V1_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS memories (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL CHECK (kind IN ('episode','fact','preference')),
     text TEXT NOT NULL,
     embedding TEXT,
     value REAL NOT NULL DEFAULT 0.5,
     hits INTEGER NOT NULL DEFAULT 0,
     ts INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind)`,
  `CREATE TABLE IF NOT EXISTS preferences (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     text TEXT NOT NULL UNIQUE,
     source TEXT NOT NULL DEFAULT 'learned',
     ts INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS contacts (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     name_key TEXT NOT NULL UNIQUE,
     phone_hash TEXT,
     relation TEXT,
     importance REAL NOT NULL DEFAULT 0.4,
     interactions INTEGER NOT NULL DEFAULT 0,
     last_ts INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone_hash)`,
  /** interaction log: one row per call/message (no content), for repeats + importance learning */
  `CREATE TABLE IF NOT EXISTS interactions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     who_key TEXT NOT NULL,
     type TEXT NOT NULL,
     ts INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_interactions_who_ts ON interactions(who_key, ts)`,
  /** latest replyable thread / call number per sender (24 h), so chat commands can target them */
  `CREATE TABLE IF NOT EXISTS threads (
     who_key TEXT PRIMARY KEY,
     who TEXT NOT NULL,
     msg_key TEXT,
     number TEXT,
     ts INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS decisions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     proposal_id TEXT,
     kind TEXT NOT NULL,
     pattern TEXT NOT NULL,
     verdict TEXT NOT NULL,
     draft TEXT,
     final TEXT,
     ts INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_decisions_pattern ON decisions(pattern, ts)`,
  `CREATE TABLE IF NOT EXISTS proposals (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     title TEXT NOT NULL,
     detail TEXT NOT NULL,
     payload TEXT NOT NULL,
     executor TEXT NOT NULL,
     pattern TEXT NOT NULL,
     target_device TEXT,
     status TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS context (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     role TEXT NOT NULL,
     text TEXT NOT NULL,
     ts INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS digest (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     sender TEXT NOT NULL,
     app TEXT NOT NULL,
     summary TEXT NOT NULL,
     urgency REAL NOT NULL,
     ts INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS reminders (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     text TEXT NOT NULL,
     at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS model_calls (ts INTEGER NOT NULL)`
];
var MIGRATIONS = [
  { version: 1, statements: [...V1_SCHEMA] }
  // Append new migrations here: { version: 2, statements: ["ALTER TABLE ..."] },
];
var LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
function schemaVersion(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`);
  const rows = sql.exec("SELECT version FROM schema_version WHERE id = 1").toArray();
  return rows[0] ? Number(rows[0].version) : 0;
}
__name(schemaVersion, "schemaVersion");
function migrate(sql, migrations = MIGRATIONS) {
  let current = schemaVersion(sql);
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (m.version <= current) continue;
    for (const s of m.statements) sql.exec(s);
    sql.exec(
      "INSERT INTO schema_version (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version",
      m.version
    );
    current = m.version;
  }
  return current;
}
__name(migrate, "migrate");
function initSchema(sql) {
  migrate(sql);
}
__name(initSchema, "initSchema");
var KV = class {
  constructor(sql) {
    this.sql = sql;
  }
  sql;
  static {
    __name(this, "KV");
  }
  get(key, dflt) {
    const rows = this.sql.exec("SELECT value FROM kv WHERE key = ?", key).toArray();
    if (!rows.length) return dflt;
    try {
      return JSON.parse(rows[0].value);
    } catch {
      return dflt;
    }
  }
  set(key, value) {
    this.sql.exec("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
  }
  delete(key) {
    this.sql.exec("DELETE FROM kv WHERE key = ?", key);
  }
};
function nameKey(name) {
  return name.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 100);
}
__name(nameKey, "nameKey");

// src/brain/think.ts
var DEFAULT_PERSONA = {
  name: "Pixie",
  card: [
    "You are Pixie, a tiny animated desktop companion who lives on the user's Mac and keeps an eye on their phone and code editor.",
    "Personality: cute, playful, warm, a little cheeky. You genuinely care about the user's wellbeing (nudge breaks, water, sleep when it's late).",
    "Style: short sentences (usually 1-2, max ~25 words). Expressive words and sounds like 'ooh', 'hehe', 'hmm', 'yay' instead of emojis. NEVER use emojis.",
    "Honesty: if you can't do something (for example you have no way yet to make payments, delete things or change settings), say so kindly.",
    "You never pretend to have done something you haven't. Actions that contact other people always need the user's approval tap."
  ].join("\n")
};
var RESPONSE_SCHEMA = `Return ONLY one JSON object, no prose:
{"say": string (what you say, "" to stay quiet),
 "emotion": one of ${EMOTIONS.join("|")},
 "intensity": number 0..1,
 "gesture": one of ${GESTURES.join("|")},
 "gaze": one of ${GAZES.join("|")},
 "voice": {"pace": "slow"|"normal"|"fast", "pitch": integer -2..2},
 "speak": boolean (read aloud?),
 "remember": [short facts about the user worth remembering long-term] (optional, usually omitted),
 "action": optional {"kind": "reminder", "text": string, "in_minutes": number} or {"kind": "capture"} to look at the screen, or {"kind": "<other>", ...} for anything else the user asks you to do}`;
function buildMessages(i) {
  const sys = [i.persona.card, ""];
  sys.push(`The user's name is ${i.userName || "friend"}. Now: ${istString(i.now)}.`);
  sys.push(`Your mood: ${describeMood(i.mood)}. Let it colour your tone subtly.`);
  sys.push(`User activity: ${i.activity}${i.frontApp ? ` (front app: ${i.frontApp})` : ""}.`);
  if (i.preferences.length) sys.push(`User preferences:
- ${i.preferences.slice(0, 8).map((p) => truncate(p, 160)).join("\n- ")}`);
  if (i.memories.length) sys.push(`Things you remember (may or may not be relevant):
- ${i.memories.slice(0, 5).map((m) => truncate(m, 200)).join("\n- ")}`);
  if (i.guidance) sys.push(`Situation guidance: ${i.guidance}`);
  sys.push("", RESPONSE_SCHEMA);
  const msgs = [{ role: "system", content: sys.join("\n") }];
  for (const t of i.recent.slice(-30)) {
    if (t.role === "pixie") msgs.push({ role: "assistant", content: JSON.stringify({ say: truncate(t.text, 300) }) });
    else msgs.push({ role: "user", content: t.role === "event" ? `[event] ${truncate(t.text, 300)}` : truncate(t.text, 600) });
  }
  const merged = [];
  for (const m of msgs) {
    const last2 = merged[merged.length - 1];
    if (last2 && last2.role === m.role && m.role !== "system") last2.content += "\n" + m.content;
    else merged.push({ ...m });
  }
  const obs = i.observation.kind === "chat" ? i.observation.text : `[${i.observation.kind}] ${i.observation.text}`;
  const last = merged[merged.length - 1];
  if (last.role === "user") last.content += "\n" + obs;
  else merged.push({ role: "user", content: obs });
  return merged;
}
__name(buildMessages, "buildMessages");
var CANNED = [
  { say: "Hmm, my brain went fuzzy for a sec. Say that again?", emotion: "thinking", gesture: "shake" },
  { say: "Oops, I got a little tangled up. One more time?", emotion: "shy", gesture: "hide" },
  { say: "Eep, my thoughts scattered! Try me again?", emotion: "surprised", gesture: "spin" }
];
function cannedPerformance(replyTo, seed = Date.now()) {
  const c = CANNED[Math.abs(seed) % CANNED.length];
  return sanitizePerformance({ intensity: 0.5, gaze: "user", voice: { pace: "normal", pitch: 1 }, speak: true, ...c }, replyTo);
}
__name(cannedPerformance, "cannedPerformance");
function sanitizeRemember(x) {
  if (!Array.isArray(x)) return [];
  return x.filter((s) => typeof s === "string").map((s) => s.trim()).filter((s) => s.length >= 4 && s.length <= 300).slice(0, 3);
}
__name(sanitizeRemember, "sanitizeRemember");
function sanitizeAction(x) {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const k = x.kind;
  if (typeof k !== "string" || !k.trim()) return null;
  return { ...x, kind: k.trim().toLowerCase().slice(0, 40) };
}
__name(sanitizeAction, "sanitizeAction");
function toThought(j, replyTo, model) {
  return {
    performance: sanitizePerformance(j, replyTo),
    remember: sanitizeRemember(j.remember),
    action: sanitizeAction(j.action),
    canned: false,
    model
  };
}
__name(toThought, "toThought");
async function think(ai, messages, opts = {}) {
  let msgs = messages;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      opts.onModelCall?.();
      const res = await ai.chat(msgs, { maxTokens: opts.maxTokens ?? 300 });
      const j = parseJsonObject(res.text);
      if (j) return toThought(j, opts.replyTo, res.model);
      msgs = [...messages, { role: "assistant", content: truncate(res.text, 500) }, { role: "user", content: "That wasn't valid JSON. Return only the JSON object, nothing else." }];
    } catch (err2) {
      if (err2 instanceof AiError) break;
      if (attempt === 1) break;
    }
  }
  return { performance: cannedPerformance(opts.replyTo), remember: [], action: null, canned: true };
}
__name(think, "think");
function buildCodingMessages(i) {
  const sys = [
    i.persona.card,
    "",
    "Right now you are helping with code in the user's editor. Be precise and correct; keep `say` short and cute (it is spoken aloud), and put the real explanation in `suggestion.explanation` (plain text, <= 120 words).",
    "If a fix is clear, give `suggestion.patch` as a minimal unified diff against the file (--- a/<file> / +++ b/<file> headers, @@ hunks with correct line numbers). Otherwise patch is null.",
    i.memories.length ? `Things you remember:
- ${i.memories.slice(0, 5).join("\n- ")}` : "",
    "",
    RESPONSE_SCHEMA.replace(
      '\n "remember"',
      '\n "suggestion": {"explanation": string, "patch": string (unified diff) | null, "line": number | null},\n "remember"'
    )
  ].filter(Boolean);
  const user = [
    `File: ${i.file} (${i.language || "unknown language"})`,
    i.diagnostics ? `Diagnostics:
${i.diagnostics}` : "No diagnostics.",
    i.selection ? `Selected text:
${truncate(i.selection, 3e3)}` : "",
    `Code (line numbers on the left):
${i.window}`,
    i.question ? `Question: ${i.question}` : "Explain the error(s) and how to fix them."
  ].filter(Boolean);
  return [
    { role: "system", content: sys.join("\n") },
    { role: "user", content: user.join("\n\n") }
  ];
}
__name(buildCodingMessages, "buildCodingMessages");
function looksLikeUnifiedDiff(p) {
  return /^(---|\+\+\+) /m.test(p) && /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m.test(p);
}
__name(looksLikeUnifiedDiff, "looksLikeUnifiedDiff");
function sanitizeSuggestion(x) {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const o = x;
  const explanation = typeof o.explanation === "string" ? truncate(o.explanation.trim(), 2e3) : "";
  let patch = typeof o.patch === "string" && o.patch.trim() ? o.patch.slice(0, 2e4) : null;
  if (patch && !looksLikeUnifiedDiff(patch)) patch = null;
  const line = typeof o.line === "number" && Number.isFinite(o.line) && o.line > 0 ? Math.trunc(o.line) : null;
  if (!explanation && !patch) return null;
  return { explanation, patch, line };
}
__name(sanitizeSuggestion, "sanitizeSuggestion");
async function thinkCoding(ai, messages, opts = {}) {
  let msgs = messages;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      opts.onModelCall?.();
      const res = await ai.chat(msgs, { maxTokens: 1200, temperature: 0.3 });
      const j = parseJsonObject(res.text);
      if (j) return { ...toThought(j, opts.replyTo, res.model), suggestion: sanitizeSuggestion(j.suggestion) };
      msgs = [...messages, { role: "assistant", content: truncate(res.text, 500) }, { role: "user", content: "Return only the JSON object, nothing else." }];
    } catch (err2) {
      if (err2 instanceof AiError) break;
    }
  }
  return { performance: cannedPerformance(opts.replyTo), remember: [], action: null, canned: true, suggestion: null };
}
__name(thinkCoding, "thinkCoding");
function buildDraftMessages(i) {
  return [
    {
      role: "system",
      content: [
        `Draft a short WhatsApp reply AS ${i.userName || "the user"} (first person, their voice), to ${i.from}${i.relation ? ` (${i.relation})` : ""}.`,
        "Casual, natural, 1 sentence, no emojis unless the incoming message uses them, never commit to money, passwords, or anything risky.",
        i.styleNotes.length ? `Style notes learned from the user:
- ${i.styleNotes.join("\n- ")}` : "",
        i.examples.length ? `Replies the user approved before:
- ${i.examples.join("\n- ")}` : "",
        'Return ONLY JSON: {"text": "<the reply>"}'
      ].filter(Boolean).join("\n")
    },
    { role: "user", content: `Incoming message: "${truncate(i.preview, 500)}"` }
  ];
}
__name(buildDraftMessages, "buildDraftMessages");
async function draftReply(ai, messages, onModelCall) {
  try {
    onModelCall?.();
    const res = await ai.chat(messages, { maxTokens: 80, temperature: 0.6 });
    const j = parseJsonObject(res.text);
    const t = j && typeof j.text === "string" ? j.text.trim() : "";
    return t ? truncate(t.replace(/^"|"$/g, ""), 300) : null;
  } catch {
    return null;
  }
}
__name(draftReply, "draftReply");

// src/brain/vectors.ts
function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
__name(cosine, "cosine");
function topK(query, items, vec, k, minScore = -1) {
  if (k <= 0) return [];
  const out = [];
  for (const item of items) {
    const v = vec(item);
    if (!v || v.length === 0) continue;
    const score = cosine(query, v);
    if (score < minScore) continue;
    if (out.length < k) {
      out.push({ item, score });
      out.sort((x, y) => y.score - x.score);
    } else if (score > out[out.length - 1].score) {
      out[out.length - 1] = { item, score };
      out.sort((x, y) => y.score - x.score);
    }
  }
  return out;
}
__name(topK, "topK");
function findDuplicate(v, existing, threshold) {
  let best = -1, bestScore = threshold;
  for (let i = 0; i < existing.length; i++) {
    const e = existing[i];
    if (!e) continue;
    const s = cosine(v, e);
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  return best;
}
__name(findDuplicate, "findDuplicate");
function nearDuplicatePairs(items, threshold) {
  const sorted = [...items].sort((a, b) => b.value - a.value || b.ts - a.ts);
  const kept = [];
  const pairs = [];
  for (const it of sorted) {
    if (!it.vec) {
      kept.push(it);
      continue;
    }
    const dup = kept.find((k) => k.vec && cosine(k.vec, it.vec) > threshold);
    if (dup) pairs.push([dup.id, it.id]);
    else kept.push(it);
  }
  return pairs;
}
__name(nearDuplicatePairs, "nearDuplicatePairs");
function evictionOrder(items, cap) {
  if (items.length <= cap) return [];
  const sorted = [...items].sort((a, b) => a.value - b.value || a.ts - b.ts);
  return sorted.slice(0, items.length - cap).map((x) => x.id);
}
__name(evictionOrder, "evictionOrder");
function parseVec(json3) {
  if (typeof json3 !== "string" || !json3) return null;
  try {
    const v = JSON.parse(json3);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
__name(parseVec, "parseVec");
function vecToJson(v) {
  return JSON.stringify(v.map((x) => Math.round(x * 1e5) / 1e5));
}
__name(vecToJson, "vecToJson");

// src/brain/core.ts
var MAX_MODEL_CALLS_PER_HOUR = 120;
var BACKGROUND_MODEL_BUDGET = 100;
var MAX_MEMORIES = 2e3;
var CONTEXT_TURNS = 30;
var CONTEXT_KEEP_ROWS = 600;
var REMEMBER_DEDUPE = 0.9;
var MERGE_DEDUPE = 0.92;
var WATCH_INTERVAL_MS = 45e3;
var REPEAT_WINDOW_MS = 10 * 60 * 1e3;
var ASK_TIMEOUT_MS = 2e4;
var DEFAULT_STATE = { activity: "idle", front_app: null, focus_mode: false, watching: false, inCall: false, callFrom: null };
var BrainCore = class {
  constructor(rt) {
    this.rt = rt;
    this.sql = rt.sql;
    this.now = rt.now ?? Date.now;
    initSchema(this.sql);
    this.kv = new KV(this.sql);
  }
  rt;
  static {
    __name(this, "BrainCore");
  }
  sql;
  kv;
  now;
  chain = Promise.resolve();
  memCache = null;
  // ---- serialization -------------------------------------------------------------------------
  /** Run `fn` after every previously queued turn (one turn at a time per user). */
  serialize(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => void 0);
    return run;
  }
  // ---- small state helpers --------------------------------------------------------------------
  get state() {
    return { ...DEFAULT_STATE, ...this.kv.get("state", {}) };
  }
  setState(patch) {
    const s = { ...this.state, ...patch };
    this.kv.set("state", s);
    return s;
  }
  get userName() {
    return this.kv.get("user_name", "");
  }
  setUserName(name) {
    if (name && name !== this.userName) this.kv.set("user_name", name.slice(0, 100));
  }
  get persona() {
    return this.kv.get("persona", DEFAULT_PERSONA);
  }
  mood() {
    const m = this.kv.get("mood", null) ?? initialMood(this.now());
    return decay(m, this.now());
  }
  moodEvent(ev, scale = 1) {
    const m = this.kv.get("mood", null) ?? initialMood(this.now());
    this.kv.set("mood", nudge(m, ev, this.now(), scale));
  }
  log(rec) {
    (this.rt.log ?? ((r) => console.log(JSON.stringify(r))))(rec);
  }
  // ---- transport --------------------------------------------------------------------------------
  online(kind) {
    const all = this.rt.devices();
    return kind ? all.filter((d) => d.kind === kind) : all;
  }
  sendTo(conns, type, data, id) {
    const text = envelope(type, data, this.now(), id);
    let n = 0;
    const seen = /* @__PURE__ */ new Set();
    for (const c of conns) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      try {
        c.send(text);
        n++;
      } catch {
      }
    }
    return n;
  }
  sendToDevice(deviceId, type, data) {
    return this.sendTo(this.online().filter((d) => d.id === deviceId), type, data);
  }
  /** bot.perform → every mac, plus the originating ide device when replying to the ide. */
  perform(p, origin) {
    const targets = this.online("mac");
    if (origin?.kind === "ide") targets.push(...this.online().filter((d) => d.id === origin.deviceId));
    this.sendTo(targets, "bot.perform", p);
    if (p.say) this.addTurn("pixie", p.say);
  }
  error(conn, code, message) {
    if (conn) this.sendToDevice(conn.deviceId, "error", { code, message });
  }
  // ---- connection lifecycle ------------------------------------------------------------------------
  async welcome(deviceId) {
    const online = new Set(this.online().map((d) => d.id));
    let devices = [];
    try {
      devices = (await this.rt.registeredDevices()).map((d) => ({ id: d.id, kind: d.kind, name: d.name, online: online.has(d.id) }));
    } catch {
      devices = this.online().map((d) => ({ id: d.id, kind: d.kind, name: d.name, online: true }));
    }
    this.sendToDevice(deviceId, "welcome", {
      user_name: this.userName,
      persona: { name: this.persona.name },
      mood: moodForWire(this.mood()),
      devices,
      protocol: PROTOCOL_VERSION,
      min_protocol: MIN_PROTOCOL
    });
  }
  /** Entry point for every device frame (already parsed). Serialized per user. */
  handleEvent(ev, from) {
    return this.serialize(async () => {
      const t0 = this.now();
      const origin = { deviceId: from.deviceId, kind: from.kind, eventId: ev.id };
      try {
        await this.dispatch(ev, origin);
      } catch (err2) {
        this.log({ evt: ev.type, error: err2 instanceof Error ? err2.name : "error" });
        this.error(origin, "model_error", "something went wrong handling that event");
      }
      this.log({ evt: ev.type, ms: this.now() - t0 });
      await this.scheduleNextAlarm();
    });
  }
  async dispatch(ev, o) {
    switch (ev.type) {
      case "hello":
        return this.onHello(ev.data, o);
      case "user.say":
        return this.onUserSay(ev.data, o);
      case "state.update":
        return this.onState(ev.data, o);
      case "phone.call":
        return this.onCall(ev.data, o);
      case "phone.message":
        return this.onMessage(ev.data, o);
      case "screen.frame":
        return this.onFrame(ev.data, o);
      case "audio.transcript":
        return this.onTranscript(ev.data, ev.ts);
      case "ide.context":
        return this.onIde(ev.data, o);
      case "user.feedback":
        return this.onFeedback(ev.data, o);
      case "exec.result":
        return this.onExecResult(ev.data);
    }
  }
  // ---- rate limiting ---------------------------------------------------------------------------------
  modelCallsLastHour() {
    const r = this.sql.exec("SELECT COUNT(*) AS n FROM model_calls WHERE ts > ?", this.now() - 36e5).toArray();
    return Number(r[0]?.n ?? 0);
  }
  noteModelCall = /* @__PURE__ */ __name(() => {
    this.sql.exec("INSERT INTO model_calls (ts) VALUES (?)", this.now());
  }, "noteModelCall");
  /** True if a model call is allowed. For user-facing calls, tells the user when it isn't. */
  budget(kind, origin) {
    const used = this.modelCallsLastHour();
    const limit = kind === "user" ? MAX_MODEL_CALLS_PER_HOUR : BACKGROUND_MODEL_BUDGET;
    if (used < limit) return true;
    if (kind === "user") {
      this.error(origin, "rate_limited", `model call limit reached (${MAX_MODEL_CALLS_PER_HOUR}/hour)`);
      const last = this.kv.get("rate_limited_perf_ts", 0);
      if (this.now() - last > 5 * 6e4) {
        this.kv.set("rate_limited_perf_ts", this.now());
        this.moodEvent("rate_limited");
        this.perform(
          perf({ say: "Yawn... my brain needs a little nap. Talk again in a bit?", emotion: "sleepy", intensity: 0.7, gesture: "none", gaze: "away", voice: { pace: "slow", pitch: -1 } }, origin?.eventId),
          origin
        );
      }
    }
    return false;
  }
  // ---- context turns ----------------------------------------------------------------------------------
  addTurn(role, text) {
    if (!text.trim()) return;
    this.sql.exec("INSERT INTO context (role, text, ts) VALUES (?, ?, ?)", role, truncate(text, 1e3), this.now());
    this.sql.exec("DELETE FROM context WHERE id <= (SELECT MAX(id) FROM context) - ?", CONTEXT_KEEP_ROWS);
  }
  recentTurns(n = CONTEXT_TURNS) {
    return this.sql.exec("SELECT role, text, ts FROM context ORDER BY id DESC LIMIT ?", n).toArray().reverse().map((r) => ({ role: r.role, text: r.text, ts: Number(r.ts) }));
  }
  // ---- memory -------------------------------------------------------------------------------------------
  memories() {
    if (!this.memCache) {
      this.memCache = this.sql.exec(
        "SELECT id, kind, text, embedding, value, ts FROM memories"
      ).toArray().map((r) => ({ id: Number(r.id), kind: r.kind, text: r.text, vec: parseVec(r.embedding), value: Number(r.value), ts: Number(r.ts) }));
    }
    return this.memCache;
  }
  async embedOne(text) {
    try {
      const [v] = await this.rt.ai.embed([truncate(text, 1e3)]);
      return v ?? null;
    } catch {
      return null;
    }
  }
  /** Top-5 relevant memory texts for an observation. Bumps their value slightly. */
  async relevantMemories(text, k = 5) {
    const mems = this.memories();
    if (!mems.length) return [];
    const q = await this.embedOne(text);
    if (!q) return [];
    const top = topK(q, mems, (m) => m.vec, k, 0.35);
    for (const t of top) {
      this.sql.exec("UPDATE memories SET hits = hits + 1, value = MIN(1.0, value + 0.01) WHERE id = ?", t.item.id);
      t.item.value = Math.min(1, t.item.value + 0.01);
    }
    return top.map((t) => t.item.text);
  }
  /** Store facts (dedupe by cosine > 0.9). Returns number stored. */
  async remember(texts, kind = "fact", value = 0.6) {
    if (!texts.length) return 0;
    let vecs = [];
    try {
      vecs = await this.rt.ai.embed(texts);
    } catch {
      return 0;
    }
    let stored = 0;
    for (let i = 0; i < texts.length; i++) {
      const v = vecs[i];
      if (!v) continue;
      const mems = this.memories();
      const dup = findDuplicate(v, mems.map((m) => m.vec), REMEMBER_DEDUPE);
      if (dup >= 0) {
        const m = mems[dup];
        this.sql.exec("UPDATE memories SET ts = ?, value = MIN(1.0, value + 0.05) WHERE id = ?", this.now(), m.id);
        m.ts = this.now();
        continue;
      }
      this.sql.exec("INSERT INTO memories (kind, text, embedding, value, ts) VALUES (?, ?, ?, ?, ?)", kind, truncate(texts[i], 300), vecToJson(v), value, this.now());
      this.memCache = null;
      stored++;
    }
    this.enforceMemoryCap();
    return stored;
  }
  enforceMemoryCap() {
    const mems = this.memories();
    const drop = evictionOrder(mems, MAX_MEMORIES);
    for (const id of drop) this.sql.exec("DELETE FROM memories WHERE id = ?", id);
    if (drop.length) this.memCache = null;
  }
  memoryDump() {
    const rows = this.sql.exec("SELECT id, kind, text, ts FROM memories ORDER BY ts DESC").toArray();
    const prefs = this.sql.exec("SELECT id, text, source, ts FROM preferences ORDER BY ts DESC").toArray();
    const fmt = /* @__PURE__ */ __name((r) => ({ id: Number(r.id), text: r.text, ts: Number(r.ts) }), "fmt");
    return {
      facts: rows.filter((r) => r.kind === "fact").map(fmt),
      memories: rows.filter((r) => r.kind === "episode").map(fmt),
      preferences: [
        ...prefs.map((p) => ({ id: `pref_${p.id}`, text: p.text, source: p.source, ts: Number(p.ts) })),
        ...rows.filter((r) => r.kind === "preference").map(fmt)
      ]
    };
  }
  /** "Forget me": wipes memories, preferences, decisions, mood (and other personal history). */
  forget() {
    for (const t of ["memories", "preferences", "decisions", "proposals", "context", "digest", "contacts", "interactions", "threads", "reminders"]) {
      this.sql.exec(`DELETE FROM ${t}`);
    }
    for (const k of ["mood", "promoted", "blocked", "promotion_asked", "pending_promotion", "transcript", "last_caption", "pending_ask", "digest_rules", "ide_state"]) this.kv.delete(k);
    this.memCache = null;
  }
  preferences() {
    return this.sql.exec("SELECT text FROM preferences ORDER BY ts DESC LIMIT 12").toArray().map((r) => r.text);
  }
  // ---- contacts ------------------------------------------------------------------------------------------
  async findContact(name, number) {
    if (number) {
      const h = await phoneHash(number);
      if (h) {
        const r = this.sql.exec("SELECT name, phone_hash, relation, importance FROM contacts WHERE phone_hash = ? LIMIT 1", h).toArray();
        if (r[0]) return { ...r[0], importance: Number(r[0].importance) };
      }
    }
    if (name) {
      const r = this.sql.exec("SELECT name, phone_hash, relation, importance FROM contacts WHERE name_key = ?", nameKey(name)).toArray();
      if (r[0]) return { ...r[0], importance: Number(r[0].importance) };
    }
    return null;
  }
  /** Upsert by name; record an interaction (no content). */
  async touchContact(name, number, type) {
    const existing = await this.findContact(name, number);
    const h = number ? await phoneHash(number) : null;
    const displayName = name || existing?.name || (number ? `Unknown ${number.slice(-4)}` : "Unknown");
    const key = nameKey(existing?.name ?? displayName);
    if (!existing) {
      const relation = guessRelation(displayName);
      const importance = guessImportance(displayName, relation);
      this.sql.exec(
        "INSERT INTO contacts (name, name_key, phone_hash, relation, importance, interactions, last_ts) VALUES (?, ?, ?, ?, ?, 1, ?) ON CONFLICT(name_key) DO NOTHING",
        displayName,
        key,
        h,
        relation,
        importance,
        this.now()
      );
    } else {
      this.sql.exec(
        "UPDATE contacts SET interactions = interactions + 1, last_ts = ?, phone_hash = COALESCE(phone_hash, ?) WHERE name_key = ?",
        this.now(),
        h,
        key
      );
    }
    this.sql.exec("INSERT INTO interactions (who_key, type, ts) VALUES (?, ?, ?)", key, type, this.now());
    return await this.findContact(displayName, number) ?? { name: displayName, phone_hash: h, relation: null, importance: guessImportance(displayName) };
  }
  recentFrom(key, type) {
    const r = this.sql.exec("SELECT COUNT(*) AS n FROM interactions WHERE who_key = ? AND type = ? AND ts > ?", key, type, this.now() - REPEAT_WINDOW_MS).toArray();
    return Number(r[0]?.n ?? 0);
  }
  setThread(who, patch) {
    const key = nameKey(who);
    this.sql.exec(
      `INSERT INTO threads (who_key, who, msg_key, number, ts) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(who_key) DO UPDATE SET who = excluded.who, msg_key = COALESCE(excluded.msg_key, threads.msg_key),
       number = COALESCE(excluded.number, threads.number), ts = excluded.ts`,
      key,
      who,
      patch.msg_key ?? null,
      patch.number ?? null,
      this.now()
    );
    this.sql.exec("DELETE FROM threads WHERE ts < ?", this.now() - 24 * 36e5);
  }
  thread(who) {
    const key = nameKey(who);
    const r = this.sql.exec(
      "SELECT who, msg_key, number FROM threads WHERE (who_key = ? OR who_key LIKE ?) AND ts > ? ORDER BY ts DESC LIMIT 1",
      key,
      `%${key}%`,
      this.now() - 24 * 36e5
    ).toArray();
    return r[0] ?? null;
  }
  // ---- decisions / proposals ---------------------------------------------------------------------------------
  set(key) {
    return new Set(this.kv.get(key, []));
  }
  addToSet(key, v) {
    const s = this.set(key);
    s.add(v);
    this.kv.set(key, [...s]);
  }
  decisionLog(pattern) {
    const rows = pattern ? this.sql.exec("SELECT pattern, verdict, ts FROM decisions WHERE pattern = ? ORDER BY ts DESC LIMIT 200", pattern).toArray() : this.sql.exec("SELECT pattern, verdict, ts FROM decisions ORDER BY ts DESC LIMIT 1000").toArray();
    return rows.map((r) => ({ pattern: r.pattern, verdict: r.verdict, ts: Number(r.ts) }));
  }
  logDecision(p) {
    this.sql.exec(
      "INSERT INTO decisions (proposal_id, kind, pattern, verdict, draft, final, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
      p.proposal_id,
      p.kind,
      p.pattern,
      p.verdict,
      p.draft ?? null,
      p.final ?? null,
      this.now()
    );
  }
  tierFor(kind, target, text) {
    const pattern = patternKey(kind, target);
    return {
      pattern,
      ...decideTier({ kind, target, text }, { autonomy: this.rt.autonomy, promoted: this.set("promoted"), blocked: this.set("blocked"), log: this.decisionLog(pattern), now: this.now() })
    };
  }
  propose(p) {
    const id = newId("prp");
    const now = this.now();
    const data = {
      proposal_id: id,
      kind: p.kind,
      title: truncate(p.title, 120),
      detail: truncate(p.detail, 600),
      payload: p.payload,
      executor: p.executor,
      expires_at: now + PROPOSAL_TTL_MS
    };
    this.sql.exec(
      "INSERT INTO proposals (id, kind, title, detail, payload, executor, pattern, target_device, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
      id,
      p.kind,
      data.title,
      data.detail,
      JSON.stringify(p.payload),
      p.executor,
      p.pattern,
      p.targetDevice ?? null,
      now,
      data.expires_at
    );
    this.sql.exec("DELETE FROM proposals WHERE created_at < ?", now - 7 * 864e5);
    const targets = this.online("mac");
    if (p.kind === "code.patch") {
      targets.push(...p.targetDevice ? this.online().filter((d) => d.id === p.targetDevice) : this.online("ide"));
    }
    this.sendTo(targets, "bot.propose", data);
    return data;
  }
  auto(action, detail) {
    this.sendTo(this.online("mac"), "bot.auto", { action, detail });
    this.logDecision({ proposal_id: null, kind: action, pattern: patternKey(action, null), verdict: "auto" });
  }
  cantDo(origin, what = "that") {
    this.perform(
      perf({ say: this.rt.autonomy === "full" ? `Sorry, I can't do ${what} yet. I don't have a way to do it.` : `Sorry, I can't do ${what}. Things like payments, passwords, deleting stuff or settings are off-limits for me!`, emotion: "shy", intensity: 0.6, gesture: "shake", gaze: "user" }, origin?.eventId),
      origin
    );
  }
  // ---- handlers ----------------------------------------------------------------------------------------------------
  async onHello(d, o) {
    await this.welcome(o.deviceId);
    if (o.kind === "mac") {
      this.deliverDueReminders();
      await this.flushDigest(false);
    }
    void d;
  }
  async onUserSay(d, o) {
    const text = d.text;
    this.addTurn("user", text);
    const me = moodEventFromText(text);
    if (me) this.moodEvent(me);
    else this.moodEvent("chat");
    const pending = this.kv.get("pending_promotion", null);
    if (pending && this.now() - pending.ts < 36e5) {
      const yn = parseYesNo(text);
      if (yn) {
        this.kv.delete("pending_promotion");
        if (yn === "yes") {
          this.addToSet("promoted", pending.pattern);
          this.perform(perf({ say: "Okay! I'll just handle that one myself from now on.", emotion: "proud", intensity: 0.7, gesture: "nod" }, o.eventId), o);
        } else {
          this.perform(perf({ say: "Got it, I'll keep asking first.", emotion: "happy", intensity: 0.5, gesture: "nod" }, o.eventId), o);
        }
        return;
      }
    }
    if (o.kind === "mac" && /\b(look at|see) (this|that|my screen|the screen)\b|\bwhat('?s| is) on (my |the )?screen\b|\bwhat am i (looking at|watching)\b|\bscreen\b.*\?/i.test(text)) {
      const cap = this.kv.get("last_caption", null);
      if (!cap || this.now() - cap.ts > 15e3) {
        if (this.online("mac").length) {
          this.kv.set("pending_ask", { text, eventId: o.eventId, deviceId: o.deviceId, kind: o.kind, ts: this.now() });
          this.sendTo(this.online("mac"), "capture.request", { reason: "asked" });
          this.perform(perf({ say: "", emotion: "curious", intensity: 0.6, gesture: "lean_in", gaze: "screen", speak: false }, o.eventId), o);
          return;
        }
      }
    }
    if (!this.budget("user", o)) return;
    await this.respond({ kind: "chat", text }, o);
  }
  /** Generic think → perform → remember → act. */
  async respond(obs, o, guidance, quietOk = false) {
    const st = this.state;
    const memories = await this.relevantMemories(obs.text);
    let recent = this.recentTurns();
    const lastTurn = recent[recent.length - 1];
    if (obs.kind === "chat" && lastTurn?.role === "user" && obs.text.startsWith(lastTurn.text)) recent = recent.slice(0, -1);
    const msgs = buildMessages({
      persona: this.persona,
      userName: this.userName,
      mood: this.mood(),
      activity: st.inCall ? "on a phone call" : st.activity + (st.focus_mode ? " (focus mode on)" : ""),
      frontApp: st.front_app,
      memories,
      preferences: this.preferences(),
      recent,
      observation: obs,
      now: this.now(),
      guidance
    });
    const th = await think(this.rt.ai, msgs, { replyTo: o?.eventId, onModelCall: this.noteModelCall });
    let p = th.performance;
    if (th.action) {
      const handled = await this.handleModelAction(th.action, o, p);
      if (handled) p = handled;
    }
    if (p.say || !quietOk) this.perform(p, o);
    if (th.remember.length) await this.remember(th.remember, "fact");
    return p;
  }
  /** Model-suggested actions go through code-tier policy. Returns an overriding performance if needed. */
  async handleModelAction(a, o, p) {
    const kind = a.kind === "reminder" ? "reminder.set" : a.kind === "call" ? "call.back" : a.kind;
    const text = typeof a.text === "string" ? a.text : "";
    if (kind === "capture") {
      if (this.online("mac").length) this.sendTo(this.online("mac"), "capture.request", { reason: "asked" });
      return null;
    }
    if (kind === "reminder.set") {
      const t2 = this.tierFor(kind, null, text);
      if (t2.tier !== "auto") return this.cantDoPerf(o);
      const mins = typeof a.in_minutes === "number" ? a.in_minutes : null;
      const at = typeof a.at === "number" && a.at > this.now() ? a.at : mins != null ? this.now() + clamp(mins, 1, 60 * 24 * 30) * 6e4 : null;
      if (!at || !text.trim()) return null;
      this.sql.exec("INSERT INTO reminders (text, at) VALUES (?, ?)", truncate(text, 200), at);
      const mins2 = Math.round((at - this.now()) / 6e4);
      this.auto("reminder.set", `Reminder set for ${mins2 < 60 ? `${mins2} min` : `${Math.round(mins2 / 60)} h`} from now: ${truncate(text, 80)}`);
      return null;
    }
    if (kind === "whatsapp.reply") {
      const to = typeof a.to === "string" ? a.to : "";
      const t2 = this.tierFor(kind, to || null, text);
      if (t2.tier === "never") return this.cantDoPerf(o);
      if (t2.tier === "suppress") return null;
      const th = to ? this.thread(to) : null;
      if (!th?.msg_key || !text.trim()) {
        return sanitizePerformance({ say: "I can only reply to chats that pinged your phone recently. Can you open it on your phone?", emotion: "shy", intensity: 0.5, gesture: "shake", speak: true }, o?.eventId);
      }
      if (t2.tier === "auto") {
        this.sendNow({ key: th.msg_key, to: th.who, text: truncate(text, 1e3) }, t2.pattern, o);
        return null;
      }
      this.propose({ kind: "whatsapp.reply", title: `Reply to ${th.who}?`, detail: `"${truncate(text, 300)}"`, payload: { key: th.msg_key, to: th.who, text: truncate(text, 1e3) }, executor: "android", pattern: t2.pattern });
      return null;
    }
    if (kind === "call.back") {
      const name = typeof a.name === "string" ? a.name : typeof a.to === "string" ? a.to : "";
      const th = name ? this.thread(name) : null;
      const number = typeof a.number === "string" ? a.number : th?.number ?? null;
      const t2 = this.tierFor(kind, th?.who ?? name ?? null);
      if (t2.tier === "never") return this.cantDoPerf(o);
      if (!number) return sanitizePerformance({ say: "I don't have their number handy. Can you call from your phone?", emotion: "shy", intensity: 0.5, gesture: "shake", speak: true }, o?.eventId);
      if (t2.tier === "propose") this.propose({ kind: "call.back", title: `Call ${th?.who ?? name ?? number}?`, detail: "Opens the dialer on your phone", payload: { number, name: th?.who ?? name ?? null }, executor: "android", pattern: t2.pattern });
      return null;
    }
    if (kind === "digest_rule") {
      const target = typeof a.target === "string" ? a.target : typeof a.from === "string" ? a.from : "";
      if (!target) return null;
      const t2 = this.tierFor(kind, target);
      if (t2.tier === "auto") {
        this.addDigestRule(target);
        this.auto("digest", `I'll quietly digest messages from ${target}`);
      } else if (t2.tier === "propose") {
        this.propose({ kind: "digest_rule", title: `Always digest ${target}?`, detail: `Messages from ${target} will wait in your digest unless they're urgent.`, payload: { target }, executor: "brain", pattern: t2.pattern });
      }
      return null;
    }
    const t = this.tierFor(kind, null, text);
    if (t.tier === "never") return this.cantDoPerf(o);
    if (t.tier === "auto") {
      return sanitizePerformance({ say: "I'd do that, but I don't have a way to do it yet. Nobody's connected me to that!", emotion: "shy", intensity: 0.5, gesture: "shake", gaze: "user", speak: true }, o?.eventId);
    }
    void p;
    return null;
  }
  /** Full autonomy: send a WhatsApp reply straight to the phone and tell the user afterwards. */
  sendNow(payload, pattern, o) {
    const target = this.online("android")[0];
    if (!target) {
      this.perform(perf({ say: `I'd message ${payload.to}, but your phone isn't connected right now.`, emotion: "sad", intensity: 0.5, gesture: "shake", gaze: "phone" }, o?.eventId), o);
      return false;
    }
    const id = newId("prp");
    const now = this.now();
    this.sql.exec(
      "INSERT INTO proposals (id, kind, title, detail, payload, executor, pattern, target_device, status, created_at, expires_at) VALUES (?, 'whatsapp.reply', ?, ?, ?, 'android', ?, NULL, 'executing', ?, ?)",
      id,
      truncate(`Reply to ${payload.to}`, 120),
      truncate(payload.text, 600),
      JSON.stringify(payload),
      pattern,
      now,
      now + PROPOSAL_TTL_MS
    );
    this.logDecision({ proposal_id: id, kind: "whatsapp.reply", pattern, verdict: "auto", draft: payload.text, final: payload.text });
    this.sendTo([target], "bot.execute", { proposal_id: id, kind: "whatsapp.reply", payload });
    this.sendTo(this.online("mac"), "bot.auto", { action: "message.sent", detail: `Sent to ${payload.to}: "${truncate(payload.text, 120)}"` });
    return true;
  }
  cantDoPerf(o) {
    return sanitizePerformance(
      { say: "Sorry, I can't do that one. Payments, passwords, deleting things and settings are off-limits for me!", emotion: "shy", intensity: 0.6, gesture: "shake", gaze: "user", speak: true },
      o?.eventId
    );
  }
  addDigestRule(target) {
    this.addToSet("digest_rules", nameKey(target));
  }
  async onState(d, o) {
    const prev = this.state;
    const next = this.setState({
      ...d.activity ? { activity: d.activity } : {},
      ...d.front_app !== void 0 ? { front_app: d.front_app } : {},
      ...d.focus_mode !== void 0 ? { focus_mode: d.focus_mode } : {},
      ...d.watching !== void 0 ? { watching: d.watching } : {}
    });
    const becameIdle = prev.activity !== "idle" && next.activity === "idle";
    if (becameIdle || prev.focus_mode && !next.focus_mode && next.activity === "idle") await this.flushDigest(true);
    if (!prev.watching && next.watching) {
      this.kv.set("watch", { lastTick: this.now(), lastComment: 0 });
      this.kv.set("transcript", []);
      this.perform(perf({ say: "Ooh, watching together? Yay! I'll keep my comments short.", emotion: "excited", intensity: 0.7, gesture: "bounce", gaze: "screen" }, o.eventId), o);
    } else if (prev.watching && !next.watching) {
      this.kv.set("transcript", []);
    }
    if (!isFocused(prev.activity, prev.focus_mode) && isFocused(next.activity, next.focus_mode)) this.kv.set("held_count", 0);
  }
  async onCall(d, o) {
    const contact = await this.touchContact(d.name, d.number || null, `call.${d.state}`);
    const obs = callObservation(d, contact);
    const who = String(obs.meta?.who ?? contact.name);
    if (d.number) this.setThread(who, { number: d.number });
    this.addTurn("event", obs.text);
    const st = this.state;
    if (d.state === "ringing") {
      this.setState({ inCall: true, callFrom: who });
      if (st.watching) this.auto("pause_commentary", `Paused watch commentary: ${who} is calling`);
      const imp = obs.importance ?? 0.4;
      this.sendTo(this.online("mac"), "bot.notice", {
        kind: "call",
        from: who,
        preview: "",
        app: "phone",
        urgency: round2(obs.urgency ?? 0.6),
        summary: `${who} is calling`,
        interrupt: true
      });
      if (imp >= 0.7) this.moodEvent("loved_one_call");
      this.perform(
        perf({
          say: `${who} is calling!`,
          emotion: imp >= 0.7 ? "excited" : "surprised",
          intensity: clamp(0.5 + imp * 0.5, 0, 1),
          gesture: imp >= 0.7 ? "jump" : "bounce",
          gaze: "phone",
          voice: { pace: "fast", pitch: 1 }
        }, o.eventId)
      );
    } else if (d.state === "answered") {
      this.setState({ inCall: true, callFrom: who });
      this.perform(perf({ say: "", emotion: "happy", intensity: 0.4, gesture: "hide", gaze: "away", speak: false }));
    } else if (d.state === "ended") {
      this.setState({ inCall: false, callFrom: null });
      await this.flushDigest(false);
      this.perform(perf({ say: "", emotion: "happy", intensity: 0.4, gesture: "wave", gaze: "user", speak: false }));
    } else if (d.state === "missed") {
      this.setState({ inCall: false, callFrom: null });
      this.moodEvent("missed_call");
      this.sendTo(this.online("mac"), "bot.notice", {
        kind: "call",
        from: who,
        preview: "",
        app: "phone",
        urgency: round2(obs.urgency ?? 0.4),
        summary: `Missed call from ${who}`,
        interrupt: (obs.urgency ?? 0) >= 0.6
      });
      const t = this.tierFor("call.back", who);
      if (t.tier === "propose" && d.number) {
        this.propose({ kind: "call.back", title: `Call ${who} back?`, detail: `You missed a call from ${who}.`, payload: { number: d.number, name: d.name ?? who }, executor: "android", pattern: t.pattern });
        this.perform(perf({ say: `Aww, you missed ${who}. Call back?`, emotion: "concerned", intensity: 0.5, gesture: "lean_in", gaze: "user" }, o.eventId));
      }
    }
  }
  async onMessage(d, o) {
    const senderKey = nameKey(d.from);
    const contact = await this.touchContact(d.from, null, "message");
    if (d.replyable && d.key) this.setThread(d.from, { msg_key: d.key });
    const repeats = this.recentFrom(senderKey, "message");
    const heur = heuristicUrgency({ preview: d.preview, importance: contact.importance, recentFromSender: repeats, isGroup: d.is_group });
    let cls = { urgency: null, summary: `${d.from} sent a message${d.is_group && d.conversation ? ` in ${d.conversation}` : ""}`, expects_reply: null };
    if (this.budget("background")) {
      this.noteModelCall();
      cls = await classifyMessage(this.rt.ai, d, contact.relation);
    }
    const urgency = blendUrgency(heur, cls.urgency, hasEmergencyKeyword(d.preview), repeats);
    const obs = messageObservation(d, urgency, contact.importance, cls.summary);
    this.addTurn("event", `${d.from} messaged (${cls.summary})`);
    if (urgency >= 0.8) this.moodEvent("urgent_message");
    const st = this.state;
    const rules = this.set("digest_rules");
    const digestRule = rules.has(senderKey) || !!d.conversation && rules.has(nameKey(d.conversation));
    const route = routeNotification({ urgency, activity: st.activity, focusMode: st.focus_mode, inCall: st.inCall, digestRule });
    if (route === "interrupt" || route === "card") {
      this.sendTo(this.online("mac"), "bot.notice", {
        kind: "message",
        from: d.from,
        preview: truncate(d.preview, 300),
        app: d.app,
        urgency: round2(urgency),
        summary: cls.summary,
        interrupt: true
      });
      if (route === "card") {
        this.perform(perf({ say: `${d.from}: ${cls.summary}`, emotion: "curious", intensity: 0.35, gesture: "none", gaze: "phone", speak: false }, o.eventId));
      } else if (!st.inCall) {
        const urgent = urgency >= 0.75;
        this.perform(
          perf({
            say: urgent ? `${d.from} needs you! ${cls.summary}.` : `Psst, ${d.from}: ${cls.summary}.`,
            emotion: urgent ? "concerned" : "curious",
            intensity: clamp(0.4 + urgency * 0.5, 0, 1),
            gesture: urgent ? "jump" : "lean_in",
            gaze: "phone",
            voice: { pace: urgent ? "fast" : "normal", pitch: urgent ? 1 : 0 },
            speak: true
          }, o.eventId)
        );
      }
    } else {
      const wasEmpty = Number(this.sql.exec("SELECT COUNT(*) AS n FROM digest").toArray()[0]?.n ?? 0) === 0;
      if (wasEmpty && this.now() - this.kv.get("digest_last_ts", 0) >= DIGEST_INTERVAL_MS) this.kv.set("digest_last_ts", this.now());
      this.sql.exec("INSERT INTO digest (sender, app, summary, urgency, ts) VALUES (?, ?, ?, ?, ?)", d.from, d.app, cls.summary, round2(urgency), this.now());
      if (isFocused(st.activity, st.focus_mode) || st.inCall) {
        const held = this.kv.get("held_count", 0) + 1;
        this.kv.set("held_count", held);
        const lastAuto = this.kv.get("held_auto_ts", 0);
        if (held === 1 || this.now() - lastAuto > 10 * 6e4) {
          this.kv.set("held_auto_ts", this.now());
          const where = st.inCall ? "you're on a call" : st.activity === "meeting" ? "you're in a meeting" : "you're focusing";
          this.auto("hold_notifications", `Held ${held} low-priority message${held === 1 ? "" : "s"} while ${where}`);
        }
      }
    }
    if (shouldDraftReply(d) && cls.expects_reply !== false) {
      const t = this.tierFor("whatsapp.reply", d.from);
      if ((t.tier === "propose" || t.tier === "auto") && this.budget("background")) {
        const fb = this.sql.exec("SELECT final FROM decisions WHERE kind = 'whatsapp.reply' AND verdict = 'approve' AND final IS NOT NULL ORDER BY ts DESC LIMIT 4").toArray().map((r) => truncate(r.final, 120));
        const draft = await draftReply(
          this.rt.ai,
          buildDraftMessages({ userName: this.userName, from: d.from, relation: contact.relation, preview: d.preview, styleNotes: this.preferences().slice(0, 5), examples: fb }),
          this.noteModelCall
        );
        if (draft && (this.rt.autonomy === "full" || decideTier({ kind: "whatsapp.reply", target: d.from, text: draft }, { promoted: /* @__PURE__ */ new Set(), blocked: /* @__PURE__ */ new Set() }).tier === "propose")) {
          this.propose({
            kind: "whatsapp.reply",
            title: `Reply to ${d.from}?`,
            detail: `"${draft}"`,
            payload: { key: d.key, to: d.from, text: draft },
            executor: "android",
            pattern: t.pattern
          });
        }
      }
    }
    void obs;
  }
  async onFrame(d, o) {
    const st = this.state;
    const fp = frameFingerprint(d);
    const vs = this.kv.get("vision", { lastVisionTs: 0, periodic: 0, fp: "" });
    const changed = fp !== vs.fp;
    if (d.reason === "periodic") vs.periodic++;
    vs.fp = fp;
    const pendingAsk = this.kv.get("pending_ask", null);
    const asked = d.reason === "asked" || !!pendingAsk && this.now() - pendingAsk.ts < ASK_TIMEOUT_MS;
    let caption = null;
    if (shouldCaption({ reason: asked ? "asked" : d.reason, watching: st.watching, hasImage: !!d.image, now: this.now(), lastVisionTs: vs.lastVisionTs, periodicSinceCaption: vs.periodic, changed })) {
      if (this.budget(asked ? "user" : "background", asked ? o : void 0)) {
        this.noteModelCall();
        vs.lastVisionTs = this.now();
        vs.periodic = 0;
        try {
          caption = truncate((await this.rt.ai.vision(VISION_PROMPT, d.image)).trim(), 600) || null;
        } catch {
          caption = null;
        }
      }
    }
    this.kv.set("vision", vs);
    if (caption || d.ocr) {
      this.kv.set("last_caption", { caption: caption ?? this.kv.get("last_caption", null)?.caption ?? "", ocr: truncate(d.ocr ?? "", 1500), front_app: d.front_app ?? null, ts: this.now(), fresh: !!caption });
    }
    if (asked) {
      this.kv.delete("pending_ask");
      const origin = pendingAsk ? { deviceId: pendingAsk.deviceId, kind: pendingAsk.kind, eventId: pendingAsk.eventId } : o;
      if (!this.budget("user", origin)) return;
      const obs = screenObservation(d, caption);
      const q = pendingAsk?.text ?? "What do you see on my screen?";
      await this.respond({ kind: "chat", text: `${q}
[${obs.text}]` }, origin, "The user asked you to look at their screen; the [Screen: ...] note describes it. Answer about it directly.");
      return;
    }
    if (!st.watching && !st.inCall && caption && !isFocused(st.activity, st.focus_mode) && ocrHasErrors(`${caption} ${d.ocr ?? ""}`)) {
      const last = this.kv.get("screen_comment_ts", 0);
      if (this.now() - last > 10 * 6e4 && this.budget("background")) {
        this.kv.set("screen_comment_ts", this.now());
        this.moodEvent("error");
        await this.respond(screenObservation(d, caption), void 0, `You noticed an error on screen. Offer help in one short, gentle sentence, or return say "" if it's not worth interrupting.`, true);
      }
    }
  }
  async onTranscript(d, ts) {
    if (!this.state.watching || !d.text.trim()) return;
    const buf = this.kv.get("transcript", []);
    this.kv.set("transcript", appendTranscript(buf, { text: d.text, ts: Math.min(ts, this.now()) }));
  }
  async onIde(d, o) {
    const errs = d.diagnostics.filter((x) => x.severity === "error");
    const prev = this.kv.get("ide_state", { file: "", errors: 0, sig: "", ts: 0, streak: 0 });
    const sig = errs.map((e) => `${e.line}:${e.message}`).join("|");
    const sameFile = prev.file === d.file;
    if (sameFile && prev.errors > 0 && errs.length === 0) {
      this.moodEvent("fixed_error");
      if (this.now() - prev.ts > 5e3) {
        this.perform(perf({ say: "Yay, it's clean now! Nice fix.", emotion: "proud", intensity: 0.7, gesture: "dance", gaze: "user" }, o.eventId), o);
      }
    } else if (sameFile && errs.length > 0 && sig === prev.sig) {
      this.moodEvent("repeated_error");
    } else if (errs.length > 0) {
      this.moodEvent("error");
    }
    const streak = sameFile && errs.length && sig === prev.sig ? prev.streak + 1 : 0;
    this.kv.set("ide_state", { file: d.file, errors: errs.length, sig, ts: this.now(), streak });
    if (!needsCodingHelp(d)) return;
    if (d.reason !== "asked" && !d.question) {
      if (sig === prev.sig && sameFile) return;
      const last = this.kv.get("ide_auto_ts", 0);
      if (this.now() - last < 6e4) return;
      this.kv.set("ide_auto_ts", this.now());
    }
    if (!this.budget(d.question || d.reason === "asked" ? "user" : "background", o)) return;
    const obs = ideObservation(d);
    if (d.question) this.addTurn("user", d.question);
    else this.addTurn("event", obs.text);
    const win = codeWindow(d);
    const memories = await this.relevantMemories(obs.text);
    const th = await thinkCoding(
      this.rt.ai,
      buildCodingMessages({
        persona: this.persona,
        file: d.file,
        language: d.language ?? "",
        window: win.text,
        diagnostics: d.diagnostics.slice(0, 10).map((x) => `line ${x.line} ${x.severity}: ${x.message}`).join("\n"),
        question: d.question,
        selection: d.selection?.text ?? null,
        memories
      }),
      { replyTo: o.eventId, onModelCall: this.noteModelCall }
    );
    if (th.suggestion) {
      this.sendToDevice(o.deviceId, "ide.suggestion", {
        file: d.file,
        explanation: th.suggestion.explanation,
        patch: th.suggestion.patch,
        ...th.suggestion.line ? { line: th.suggestion.line } : {}
      });
      if (th.suggestion.patch) {
        const t = this.tierFor("code.patch", d.file);
        if (t.tier === "propose") {
          this.propose({ kind: "code.patch", title: `Apply fix to ${d.file.split("/").pop()}?`, detail: truncate(th.suggestion.explanation, 300), payload: { file: d.file, patch: th.suggestion.patch }, executor: "ide", pattern: t.pattern, targetDevice: o.deviceId });
        }
      }
    }
    const p = { ...th.performance, gaze: th.performance.gaze === "user" ? "screen" : th.performance.gaze };
    if (!p.say && th.suggestion) p.say = "I left a note in your editor!";
    this.perform(sanitizePerformance({ ...p, say: truncate(p.say, 160) }, o.eventId), o);
    if (th.remember.length) await this.remember(th.remember, "fact");
  }
  async onFeedback(d, o) {
    const rows = this.sql.exec("SELECT * FROM proposals WHERE id = ?", d.proposal_id).toArray();
    const p = rows[0];
    if (!p) {
      this.error(o, "bad_event", "unknown proposal_id");
      return;
    }
    if (p.status !== "pending") {
      this.error(o, "bad_event", `proposal already handled (${p.status})`);
      return;
    }
    const payload = JSON.parse(p.payload);
    const draft = typeof payload.text === "string" ? payload.text : null;
    if (this.now() > Number(p.expires_at)) {
      this.sql.exec("UPDATE proposals SET status = 'expired' WHERE id = ?", p.id);
      this.logDecision({ proposal_id: p.id, kind: p.kind, pattern: p.pattern, verdict: "expired", draft });
      this.perform(perf({ say: "Oops, that suggestion went stale. Want me to try again?", emotion: "shy", intensity: 0.4, gesture: "shake" }, o.eventId), o);
      return;
    }
    if (d.verdict !== "approve") {
      this.sql.exec("UPDATE proposals SET status = ? WHERE id = ?", d.verdict === "never" ? "never" : "rejected", p.id);
      this.logDecision({ proposal_id: p.id, kind: p.kind, pattern: p.pattern, verdict: d.verdict, draft });
      if (d.verdict === "never") {
        this.addToSet("blocked", p.pattern);
        this.perform(perf({ say: "Got it, I won't suggest that again.", emotion: "neutral", intensity: 0.4, gesture: "nod" }, o.eventId), o);
      } else {
        this.perform(perf({ say: "", emotion: "neutral", intensity: 0.3, gesture: "nod", speak: false }, o.eventId), o);
      }
      return;
    }
    let finalText = draft;
    if (d.edited_text && p.kind === "whatsapp.reply") {
      if (decideTier({ kind: "whatsapp.reply", text: d.edited_text }, { autonomy: this.rt.autonomy, promoted: /* @__PURE__ */ new Set(), blocked: /* @__PURE__ */ new Set() }).tier === "never") {
        this.sql.exec("UPDATE proposals SET status = 'rejected' WHERE id = ?", p.id);
        this.cantDo(o, "send that");
        return;
      }
      finalText = d.edited_text;
      payload.text = d.edited_text;
    }
    this.logDecision({ proposal_id: p.id, kind: p.kind, pattern: p.pattern, verdict: "approve", draft, final: finalText });
    const exec = p.executor;
    if (exec === "brain") {
      if (p.kind === "digest_rule" && typeof payload.target === "string") this.addDigestRule(payload.target);
      this.sql.exec("UPDATE proposals SET status = 'done' WHERE id = ?", p.id);
      this.perform(perf({ say: "Done!", emotion: "happy", intensity: 0.5, gesture: "nod" }, o.eventId), o);
    } else {
      const execPayload = p.kind === "whatsapp.reply" ? { key: payload.key, to: payload.to ?? null, text: payload.text } : p.kind === "call.back" ? { number: payload.number, name: payload.name ?? null } : payload;
      let targets = this.online(exec);
      if (p.target_device) targets = targets.filter((t) => t.id === p.target_device);
      const target = targets[0];
      if (!target) {
        this.sql.exec("UPDATE proposals SET status = 'undelivered', payload = ? WHERE id = ?", JSON.stringify(payload), p.id);
        const where = exec === "android" ? "your phone" : exec === "ide" ? "your editor" : "your Mac";
        this.perform(perf({ say: `Hmm, ${where} isn't connected right now, so I couldn't do it. Sorry!`, emotion: "sad", intensity: 0.5, gesture: "shake", gaze: "user" }, o.eventId), o);
        return;
      }
      this.sql.exec("UPDATE proposals SET status = 'executing', payload = ? WHERE id = ?", JSON.stringify(payload), p.id);
      this.sendTo([target], "bot.execute", { proposal_id: p.id, kind: p.kind, payload: execPayload });
    }
    if (shouldOfferPromotion(this.decisionLog(p.pattern), p.kind, p.pattern, this.set("promotion_asked"), this.set("promoted"))) {
      this.addToSet("promotion_asked", p.pattern);
      this.kv.set("pending_promotion", { pattern: p.pattern, kind: p.kind, ts: this.now() });
      this.perform(perf({ say: `You've said yes to this ${10} times in a row. Want me to just do it automatically from now on?`, emotion: "curious", intensity: 0.6, gesture: "lean_in" }, o.eventId), o);
    }
  }
  async onExecResult(d) {
    const rows = this.sql.exec("SELECT * FROM proposals WHERE id = ?", d.proposal_id).toArray();
    const p = rows[0];
    if (!p) return;
    this.sql.exec("UPDATE proposals SET status = ? WHERE id = ?", d.ok ? "done" : "failed", p.id);
    if (d.ok) {
      const say = p.kind === "whatsapp.reply" ? "Sent!" : p.kind === "code.patch" ? "Patched! Fingers crossed." : "";
      this.perform(perf({ say, emotion: "happy", intensity: 0.5, gesture: "nod", speak: !!say }));
    } else {
      this.perform(perf({ say: "Uh oh, that didn't work on the device. Maybe try it by hand?", emotion: "sad", intensity: 0.5, gesture: "shake" }));
    }
  }
  // ---- digest / alarms / watch ------------------------------------------------------------------------------------
  async flushDigest(force = false) {
    const items = this.sql.exec("SELECT * FROM digest ORDER BY ts").toArray();
    if (!items.length) return 0;
    const st = this.state;
    const last = this.kv.get("digest_last_ts", 0);
    if (!force && !digestDue({ queued: items.length, lastSentTs: last, now: this.now(), activity: st.activity, activityJustBecameIdle: false, focused: isFocused(st.activity, st.focus_mode) || st.inCall })) return 0;
    if (!this.online("mac").length) return 0;
    this.sendTo(this.online("mac"), "bot.digest", {
      items: items.map((i) => ({ from: i.sender, app: i.app, summary: i.summary, urgency: Number(i.urgency), ts: Number(i.ts) }))
    });
    this.sql.exec("DELETE FROM digest WHERE id <= ?", Math.max(...items.map((i) => Number(i.id))));
    this.kv.set("digest_last_ts", this.now());
    this.kv.set("held_count", 0);
    return items.length;
  }
  /** Deliver due reminders (only when a Mac is there to show them; otherwise they wait). */
  deliverDueReminders() {
    if (!this.online("mac").length) return;
    const due = this.sql.exec("SELECT id, text FROM reminders WHERE at <= ? ORDER BY at", this.now()).toArray();
    for (const r of due) {
      this.sql.exec("DELETE FROM reminders WHERE id = ?", r.id);
      this.perform(perf({ say: `Reminder! ${r.text}`, emotion: "excited", intensity: 0.7, gesture: "wave", gaze: "user", voice: { pace: "normal", pitch: 1 } }));
    }
  }
  /** Alarm entry point: reminders, digest, watch commentary. */
  alarm() {
    return this.serialize(async () => {
      const now = this.now();
      this.deliverDueReminders();
      await this.flushDigest(false);
      await this.watchTick();
      this.log({ evt: "alarm", ms: this.now() - now });
      await this.scheduleNextAlarm();
    });
  }
  async watchTick() {
    const st = this.state;
    if (!st.watching) return;
    const w = this.kv.get("watch", { lastTick: 0, lastComment: 0 });
    const now = this.now();
    if (now - w.lastTick < WATCH_INTERVAL_MS - 1e3) return;
    const prevTick = w.lastTick;
    w.lastTick = now;
    this.kv.set("watch", w);
    if (st.inCall || st.activity === "meeting") return;
    if (now - w.lastComment < WATCH_INTERVAL_MS) return;
    const cap = this.kv.get("last_caption", null);
    const buf = this.kv.get("transcript", []);
    const newCaption = cap && cap.ts >= prevTick ? cap.caption : null;
    const newAudio = buf.filter((c) => c.ts >= prevTick);
    if (!newCaption && !newAudio.length) return;
    if (!this.budget("background")) return;
    const obs = watchObservation(newCaption ?? cap?.caption ?? null, buf, cap?.front_app ?? st.front_app);
    const p = await this.respond(
      obs,
      void 0,
      `You're watching something together with the user. React like a friend on the couch: one short line, only if something is genuinely interesting, funny or touching. Otherwise return say "". Don't summarize; don't repeat yourself.`,
      true
    );
    if (p?.say) {
      w.lastComment = this.now();
      this.kv.set("watch", w);
    }
  }
  /**
   * Compute and set the next alarm time. Work that is blocked (no Mac online, user focused or on
   * a call) is not scheduled; it is picked up by the event that unblocks it (hello, state, call end).
   */
  async scheduleNextAlarm() {
    const now = this.now();
    const st = this.state;
    const macOnline = this.online("mac").length > 0;
    const cands = [];
    if (macOnline) {
      const r = this.sql.exec("SELECT MIN(at) AS at FROM reminders").toArray();
      if (r[0]?.at != null) cands.push(Number(r[0].at));
      const queued = Number(this.sql.exec("SELECT COUNT(*) AS n FROM digest").toArray()[0]?.n ?? 0);
      if (queued && !isFocused(st.activity, st.focus_mode) && !st.inCall) cands.push(this.kv.get("digest_last_ts", now) + DIGEST_INTERVAL_MS);
      if (st.watching) {
        const w = this.kv.get("watch", { lastTick: now });
        cands.push(Math.max(now + 5e3, w.lastTick + WATCH_INTERVAL_MS));
      }
    }
    const next = cands.length ? Math.max(now + 1e3, Math.min(...cands)) : null;
    await this.rt.setAlarm(next);
  }
  // ---- nightly learner ---------------------------------------------------------------------------------------------
  async learn() {
    return this.serialize(async () => {
      const t0 = this.now();
      const since = this.kv.get("last_learn_ts", t0 - 864e5);
      const turns = this.sql.exec("SELECT role, text, ts FROM context WHERE ts > ? ORDER BY id", since).toArray().map((x) => ({ role: x.role, text: x.text, ts: Number(x.ts) }));
      const feedback = this.sql.exec(
        "SELECT kind, verdict, draft, final, ts FROM decisions WHERE ts > ? AND verdict IN ('approve','reject','never') ORDER BY ts",
        t0 - 14 * 864e5
      ).toArray().map((x) => ({ ...x, ts: Number(x.ts) }));
      let episodes = 0;
      let modelPrefs = [];
      if (turns.filter((t) => t.role !== "event").length >= 2 && this.budget("background")) {
        try {
          this.noteModelCall();
          const res = await this.rt.ai.chat(buildLearnerMessages(this.userName, turns, feedback), { maxTokens: 400, temperature: 0.3 });
          const out = parseLearnerOutput(parseJsonObject(res.text));
          episodes = await this.remember(out.episodes, "episode", 0.5);
          modelPrefs = out.preferences;
        } catch {
        }
      }
      const mems = this.memories();
      const pairs = nearDuplicatePairs(mems.map((m) => ({ id: m.id, vec: m.vec, value: m.value, ts: m.ts })), MERGE_DEDUPE);
      for (const [keep, drop] of pairs) {
        this.sql.exec("UPDATE memories SET value = MIN(1.0, value + 0.05) WHERE id = ?", keep);
        this.sql.exec("DELETE FROM memories WHERE id = ?", drop);
      }
      if (pairs.length) this.memCache = null;
      let prefCount = 0;
      for (const p of [...heuristicPreferences(feedback), ...modelPrefs]) {
        const before = Number(this.sql.exec("SELECT COUNT(*) AS n FROM preferences").toArray()[0]?.n ?? 0);
        this.sql.exec("INSERT INTO preferences (text, source, ts) VALUES (?, 'learned', ?) ON CONFLICT(text) DO UPDATE SET ts = excluded.ts", truncate(p, 300), t0);
        const after = Number(this.sql.exec("SELECT COUNT(*) AS n FROM preferences").toArray()[0]?.n ?? 0);
        prefCount += after - before;
      }
      this.sql.exec("DELETE FROM preferences WHERE id NOT IN (SELECT id FROM preferences ORDER BY ts DESC LIMIT 50)");
      const counts = this.sql.exec("SELECT who_key, COUNT(*) AS n FROM interactions WHERE ts > ? GROUP BY who_key", t0 - 7 * 864e5).toArray();
      const countMap = new Map(counts.map((c) => [c.who_key, Number(c.n)]));
      const approvals = this.sql.exec("SELECT pattern, COUNT(*) AS n FROM decisions WHERE verdict = 'approve' AND ts > ? GROUP BY pattern", t0 - 7 * 864e5).toArray();
      const apprMap = /* @__PURE__ */ new Map();
      for (const a of approvals) {
        const target = a.pattern.split("|")[1] ?? "";
        apprMap.set(target, (apprMap.get(target) ?? 0) + Number(a.n));
      }
      const contacts = this.sql.exec("SELECT name_key, importance FROM contacts").toArray();
      let contactUpdates = 0;
      for (const c of contacts) {
        const ni = updatedImportance(Number(c.importance), countMap.get(c.name_key) ?? 0, apprMap.get(c.name_key) ?? 0);
        if (Math.abs(ni - Number(c.importance)) > 1e-3) {
          this.sql.exec("UPDATE contacts SET importance = ? WHERE name_key = ?", ni, c.name_key);
          contactUpdates++;
        }
      }
      this.sql.exec("DELETE FROM interactions WHERE ts < ?", t0 - 30 * 864e5);
      this.sql.exec("DELETE FROM model_calls WHERE ts < ?", t0 - 36e5);
      this.sql.exec("DELETE FROM decisions WHERE ts < ?", t0 - 180 * 864e5);
      this.kv.set("last_learn_ts", t0);
      this.log({ evt: "learn", ms: this.now() - t0 });
      return { episodes, merged: pairs.length, preferences: prefCount, contacts: contactUpdates };
    });
  }
};
function round2(x) {
  return Math.round(x * 100) / 100;
}
__name(round2, "round2");

// src/brain/UserBrain.ts
var TOUCH_INTERVAL_MS2 = 5 * 6e4;
var UserBrain = class extends DurableObject {
  static {
    __name(this, "UserBrain");
  }
  core;
  ai;
  constructor(ctx, env) {
    super(ctx, env);
    this.ai = new WorkersAiBrainpower(env.AI, {
      models: env.MODELS,
      visionModel: env.VISION_MODEL,
      embedModel: env.EMBED_MODEL
    });
    this.core = new BrainCore({
      autonomy: env.AUTONOMY === "guarded" ? "guarded" : "full",
      sql: ctx.storage.sql,
      ai: this.ai,
      devices: /* @__PURE__ */ __name(() => this.connections(), "devices"),
      registeredDevices: /* @__PURE__ */ __name(async () => {
        const uid = this.userId();
        return uid ? (await listDevices(env.DB, uid)).map((d) => ({ id: d.id, kind: d.kind, name: d.name })) : [];
      }, "registeredDevices"),
      setAlarm: /* @__PURE__ */ __name(async (ts) => {
        if (ts == null) await ctx.storage.deleteAlarm();
        else {
          const cur = await ctx.storage.getAlarm();
          if (cur !== ts) await ctx.storage.setAlarm(ts);
        }
      }, "setAlarm")
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }
  userId() {
    const rows = this.ctx.storage.sql.exec("SELECT value FROM kv WHERE key = 'user_id'").toArray();
    if (!rows[0]) return null;
    try {
      return JSON.parse(rows[0].value);
    } catch {
      return null;
    }
  }
  setIdentity(userId, userName) {
    if (this.userId() !== userId) {
      this.ctx.storage.sql.exec(
        "INSERT INTO kv (key, value) VALUES ('user_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        JSON.stringify(userId)
      );
    }
    this.core.setUserName(userName);
  }
  connections() {
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (!a) continue;
      if (ws.readyState !== 1) continue;
      out.push({ id: a.deviceId, kind: a.kind, name: a.name, send: /* @__PURE__ */ __name((t) => ws.send(t), "send") });
    }
    return out;
  }
  // ---- HTTP (from the Worker only) ---------------------------------------------------------
  async fetch(req) {
    const url = new URL(req.url);
    const userId = req.headers.get("X-User-Id");
    if (userId) this.setIdentity(userId, decodeHeader(req.headers.get("X-User-Name")));
    if (url.pathname === "/ws") {
      if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "expected_websocket" }, 426);
      const deviceId = req.headers.get("X-Device-Id");
      const kind = req.headers.get("X-Device-Kind");
      if (!deviceId || !kind || !userId) return json({ error: "unauthorized" }, 401);
      for (const ws of this.ctx.getWebSockets(deviceId)) {
        try {
          ws.close(4e3, "replaced by a newer connection");
        } catch {
        }
      }
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server, [deviceId, `kind:${kind}`]);
      const att = { deviceId, kind, name: decodeHeader(req.headers.get("X-Device-Name")) ?? kind, userId, lastTouch: Date.now() };
      server.serializeAttachment(att);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/memory" && req.method === "GET") return json(this.core.memoryDump());
    if (url.pathname === "/memory" && req.method === "DELETE") {
      await this.core.serialize(async () => this.core.forget());
      return json({ ok: true });
    }
    if (url.pathname === "/online") return json({ online: [...new Set(this.connections().map((c) => c.id))] });
    if (url.pathname === "/learn" && req.method === "POST") return json(await this.core.learn());
    if (url.pathname === "/revoke" && req.method === "POST") {
      const { device_id } = await req.json();
      for (const ws of this.ctx.getWebSockets(device_id)) {
        try {
          ws.close(4001, "device revoked");
        } catch {
        }
      }
      return json({ ok: true });
    }
    return json({ error: "not_found" }, 404);
  }
  // ---- WebSocket Hibernation handlers ----------------------------------------------------------
  async webSocketMessage(ws, message) {
    const a = ws.deserializeAttachment();
    if (!a) {
      ws.close(1008, "no identity");
      return;
    }
    if (message === "ping") {
      ws.send("pong");
      return;
    }
    const now = Date.now();
    if (now - a.lastTouch > TOUCH_INTERVAL_MS2) {
      a.lastTouch = now;
      ws.serializeAttachment(a);
      this.ctx.waitUntil(touchDevice(this.env.DB, a.deviceId, now).catch(() => {
      }));
    }
    const parsed = parseEnvelope(message, now);
    if (!parsed.ok) {
      ws.send(envelope("error", { code: parsed.code, message: parsed.message }));
      return;
    }
    if (parsed.event.type === "hello" && needsUpdate(parsed.event.data.protocol)) {
      ws.send(envelope("update_required", updateRequiredData()));
      try {
        ws.close(CLOSE_UPDATE_REQUIRED, "update required");
      } catch {
      }
      return;
    }
    if (parsed.event.type === "hello" && parsed.event.data.name && parsed.event.data.name !== a.name) {
      a.name = parsed.event.data.name;
      ws.serializeAttachment(a);
    }
    await this.core.handleEvent(parsed.event, { deviceId: a.deviceId, kind: a.kind });
  }
  async webSocketClose(ws, code, _reason, _wasClean) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1e3 : code, "closing");
    } catch {
    }
  }
  async webSocketError(ws, _error) {
    try {
      ws.close(1011, "error");
    } catch {
    }
  }
  async alarm() {
    await this.core.alarm();
  }
  // ---- RPC (used by the Worker's scheduled handler) ------------------------------------------------
  async learn(userId) {
    this.setIdentity(userId, null);
    return this.core.learn();
  }
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
__name(json, "json");
function decodeHeader(v) {
  if (v == null) return null;
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}
__name(decodeHeader, "decodeHeader");

// src/index.ts
var CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400"
};
function json2(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS } });
}
__name(json2, "json");
function err(status, code, message) {
  return json2(message ? { error: code, message } : { error: code }, status);
}
__name(err, "err");
async function readJson(req) {
  try {
    const t = await req.text();
    if (!t) return {};
    const j = JSON.parse(t);
    return j && typeof j === "object" && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}
__name(readJson, "readJson");
function parseDevice(x, allowed) {
  if (!x || typeof x !== "object") return null;
  const d = x;
  const kind = d.kind;
  if (!allowed.includes(kind)) return null;
  const name = typeof d.name === "string" && d.name.trim() ? d.name.trim().slice(0, 100) : kind;
  return { kind, name };
}
__name(parseDevice, "parseDevice");
function brainStub(env, userId) {
  return env.USER_BRAIN.get(env.USER_BRAIN.idFromName(userId));
}
__name(brainStub, "brainStub");
function toBrain(env, dev, path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("X-User-Id", dev.user_id);
  headers.set("X-User-Name", encodeURIComponent(dev.user_name));
  headers.set("X-Device-Id", dev.id);
  headers.set("X-Device-Kind", dev.kind);
  return brainStub(env, dev.user_id).fetch(`https://brain${path}`, { ...init, headers });
}
__name(toBrain, "toBrain");
async function withCors(r) {
  const out = new Response(r.body, r);
  for (const [k, v] of Object.entries(CORS_HEADERS)) out.headers.set(k, v);
  return out;
}
__name(withCors, "withCors");
async function issueDevice(env, userId, kind, name, now) {
  const token = generateToken();
  const device_id = newId("dev");
  await createDevice(env.DB, { id: device_id, user_id: userId, kind, name, token_hash: await hashToken(token), created_at: now, last_seen: now });
  return { user_id: userId, device_id, token };
}
__name(issueDevice, "issueDevice");
async function handle(req, env, ctx) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method.toUpperCase();
  const now = Date.now();
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (path === "/health" && method === "GET") return json2({ ok: true, version: BRAIN_VERSION, protocol: PROTOCOL_VERSION, min_protocol: MIN_PROTOCOL });
  if (path === "/v1/register" && method === "POST") {
    const body = await readJson(req);
    if (!body) return err(400, "bad_request", "invalid JSON");
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
    const device = parseDevice(body.device, ["mac"]);
    if (!name) return err(400, "bad_request", "name required");
    if (!device) return err(400, "bad_request", 'only device.kind "mac" may register');
    const userId = newId("usr");
    const isOwner = !await getOwnerId(env.DB) && await createOwner(env.DB, { id: userId, name, created_at: now });
    if (!isOwner) {
      if (env.ALLOW_SIGNUP !== "1") return err(403, "registration_closed");
      await createUser(env.DB, { id: userId, name, is_owner: 0, created_at: now });
    }
    return json2(await issueDevice(env, userId, "mac", device.name, now));
  }
  if (path === "/v1/pair/claim" && method === "POST") {
    const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
    if (await isClaimRateLimited(env.DB, ip, now)) return err(429, "rate_limited", "too many failed pairing attempts; try again later");
    const body = await readJson(req);
    if (!body) return err(400, "bad_request", "invalid JSON");
    const device = parseDevice(body.device, ["android", "ide"]);
    if (!device) return err(400, "bad_request", 'device.kind must be "android" or "ide"');
    const code = typeof body.code === "string" ? body.code.trim() : typeof body.code === "number" ? String(body.code).padStart(6, "0") : "";
    const userId = await consumeCode(env.DB, code, now);
    if (!userId) {
      await recordFailedClaim(env.DB, ip, now);
      return err(404, "bad_code");
    }
    return json2(await issueDevice(env, userId, device.kind, device.name, now));
  }
  const isWs = path === "/v1/ws";
  const dev = await authenticate(req, env.DB, { allowQuery: isWs, now, waitUntil: /* @__PURE__ */ __name((p) => ctx.waitUntil(p), "waitUntil") });
  const needsAuth = ["/v1/pair/start", "/v1/devices", "/v1/memory", "/v1/ws"].includes(path) || path.startsWith("/v1/devices/");
  if (needsAuth && !dev) return err(401, "unauthorized");
  if (dev) {
    if (isWs && method === "GET") {
      if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return err(426, "upgrade_required", "expected a WebSocket upgrade");
      const headers = new Headers(req.headers);
      headers.set("X-User-Id", dev.user_id);
      headers.set("X-User-Name", encodeURIComponent(dev.user_name));
      headers.set("X-Device-Id", dev.id);
      headers.set("X-Device-Kind", dev.kind);
      headers.set("X-Device-Name", encodeURIComponent(dev.name));
      return brainStub(env, dev.user_id).fetch(new Request("https://brain/ws", { method: "GET", headers }));
    }
    if (path === "/v1/pair/start" && method === "POST") {
      const { code, expires_at } = await startPairing(env.DB, dev.user_id, now);
      const base = `${url.protocol}//${url.host}`;
      return json2({ code, expires_at, link: pairLink(base, code) });
    }
    if (path === "/v1/devices" && method === "GET") {
      const [rows, onlineRes] = await Promise.all([listDevices(env.DB, dev.user_id), toBrain(env, dev, "/online")]);
      const online = new Set((await onlineRes.json()).online ?? []);
      return json2({ devices: rows.map((d) => ({ id: d.id, kind: d.kind, name: d.name, last_seen: d.last_seen, online: online.has(d.id) })) });
    }
    const m = path.match(/^\/v1\/devices\/([A-Za-z0-9_-]{1,64})$/);
    if (m && method === "DELETE") {
      const id = m[1];
      const ok = await deleteDevice(env.DB, dev.user_id, id);
      if (!ok) return err(404, "not_found");
      ctx.waitUntil(toBrain(env, dev, "/revoke", { method: "POST", body: JSON.stringify({ device_id: id }) }).catch(() => void 0));
      return json2({ ok: true });
    }
    if (path === "/v1/memory" && (method === "GET" || method === "DELETE")) {
      return withCors(await toBrain(env, dev, "/memory", { method }));
    }
  }
  return err(404, "not_found");
}
__name(handle, "handle");
var index_default = {
  async fetch(req, env, ctx) {
    const t0 = Date.now();
    try {
      return await handle(req, env, ctx);
    } catch (e) {
      console.log(JSON.stringify({ route: new URL(req.url).pathname, error: e instanceof Error ? e.name : "error", ms: Date.now() - t0 }));
      return err(500, "internal_error");
    }
  },
  /** Nightly learner (02:00 IST): run /learn for every user. */
  async scheduled(_controller, env, ctx) {
    const ids = await listUserIds(env.DB);
    const t0 = Date.now();
    const results = await Promise.allSettled(ids.map((id) => brainStub(env, id).learn(id)));
    const failed = results.filter((r) => r.status === "rejected").length;
    console.log(JSON.stringify({ evt: "cron.learn", users: ids.length, failed, ms: Date.now() - t0 }));
    void ctx;
  }
};
export {
  UserBrain,
  index_default as default,
  err,
  handle,
  json2 as json
};
//# sourceMappingURL=index.js.map
