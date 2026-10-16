/**
 * Pixie protocol v1 — types, envelope parsing and Performance validation.
 * Mirrors PROTOCOL.md exactly; keep in sync.
 */
import { clamp, stripEmoji, truncate } from "./util";

/** Wire protocol number. Additive changes keep it; breaking changes bump it (PROTOCOL.md §0). */
export const PROTOCOL_VERSION = 1;
/** Oldest device protocol the brain still serves. Raise only after apps that speak the newer one have shipped. */
export const MIN_PROTOCOL = 1;
/** WebSocket close code sent after `update_required`. */
export const CLOSE_UPDATE_REQUIRED = 4002;
export const UPDATE_REQUIRED_MESSAGE = "Please update Pixie to keep using it.";
export const BRAIN_VERSION = "1.0.0";
export const MAX_FRAME_BYTES = 1024 * 1024;

export type DeviceKind = "mac" | "android" | "ide";
export const DEVICE_KINDS: readonly DeviceKind[] = ["mac", "android", "ide"];

export const EMOTIONS = [
  "neutral", "happy", "excited", "curious", "concerned", "sleepy", "proud",
  "shy", "annoyed", "sad", "surprised", "love", "thinking",
] as const;
export type Emotion = (typeof EMOTIONS)[number];

export const GESTURES = [
  "none", "wave", "nod", "shake", "bounce", "lean_in", "spin", "hide", "dance", "jump",
] as const;
export type Gesture = (typeof GESTURES)[number];

export const GAZES = ["user", "screen", "phone", "away", "cursor"] as const;
export type Gaze = (typeof GAZES)[number];

export const PACES = ["slow", "normal", "fast"] as const;
export type Pace = (typeof PACES)[number];

export type Activity = "idle" | "coding" | "meeting" | "video" | "browsing" | "away";
export const ACTIVITIES: readonly Activity[] = ["idle", "coding", "meeting", "video", "browsing", "away"];

export interface Performance {
  say: string;
  emotion: Emotion;
  intensity: number;
  gesture: Gesture;
  gaze: Gaze;
  voice: { pace: Pace; pitch: number };
  speak: boolean;
  reply_to?: string;
}

export interface Envelope<T = unknown> {
  v: number;
  id: string;
  ts: number;
  type: string;
  data: T;
}

// ---- Device -> brain payloads ------------------------------------------------

export interface HelloData {
  kind: DeviceKind;
  name: string;
  /** Device protocol number; a missing value is treated as 1 (apps that predate the field). */
  protocol: number;
  app_version?: string;
  capabilities?: string[];
}
export interface UserSayData { text: string; via: "typed" | "voice" }
export interface StateUpdateData {
  activity?: Activity;
  front_app?: string;
  focus_mode?: boolean;
  watching?: boolean;
}
export interface PhoneCallData {
  state: "ringing" | "answered" | "ended" | "missed";
  number: string;
  name: string | null;
}
export interface PhoneMessageData {
  app: "whatsapp" | "whatsapp_business" | "sms" | "other";
  package?: string;
  from: string;
  conversation: string | null;
  preview: string;
  is_group: boolean;
  key: string;
  replyable: boolean;
}
export interface ScreenFrameData {
  image?: string;
  width?: number;
  height?: number;
  front_app?: string;
  window?: string;
  ocr?: string;
  reason: "periodic" | "asked" | "watch";
}
export interface AudioTranscriptData { text: string; seconds?: number; source?: "system" | "mic" }
export interface Diagnostic { line: number; severity: "error" | "warning"; message: string }
export interface IdeContextData {
  file: string;
  language?: string;
  content?: string;
  selection: { start_line: number; end_line: number; text: string } | null;
  diagnostics: Diagnostic[];
  question: string | null;
  reason: "asked" | "save" | "diagnostics";
}
export interface UserFeedbackData {
  proposal_id: string;
  verdict: "approve" | "reject" | "never";
  edited_text?: string;
  /** PROTOCOL §5: which rule a "never" creates (also sent by the card's quick actions). */
  scope?: "contact" | "group" | "like_this";
}
export interface ExecResultData { proposal_id: string; ok: boolean; error?: string }

// ---- Pet life (PROTOCOL.md §4) -------------------------------------------------

export const PET_PHASES = ["awake", "napping", "sleepy", "asleep", "waking"] as const;
export type PetPhase = (typeof PET_PHASES)[number];
export const PET_EVENT_KINDS = [
  "petted", "poked", "fed", "carried", "bubble_replied", "bubble_dismissed", "bubble_ignored",
  "woke", "fell_asleep", "ate", "sulked", "made_up", "reunion",
] as const;
export const SPEAK_INTENTS = [
  "greet_morning", "playful_bid", "sulk_line", "rant", "gossip", "world", "callback",
  "sleepy", "weather", "reunion", "late_night", "reaction",
] as const;
export type SpeakIntent = (typeof SPEAK_INTENTS)[number];

export interface LocationUpdateData { lat: number; lon: number; accuracy_m: number; source: "phone" | "mac" }
export interface SignalsUpdateData {
  mic_in_use?: boolean;
  camera_in_use?: boolean;
  music?: { app: string; playing: boolean } | null;
  calendar_busy_now?: boolean;
  next_busy_in_min?: number | null;
  typing_rate?: "none" | "low" | "high";
  app_switch_rate?: "low" | "high";
  screen_locked?: boolean;
}
export interface PetStateData {
  phase: PetPhase;
  sleep_pressure: number;
  energy: number;
  social: number;
  boredom: number;
  snack: number;
  mood: { p: number; a: number; d: number };
  emotion: string;
  ladder: number;
}
/** `kind` is one of PET_EVENT_KINDS, or an unknown string from a newer app (logged, otherwise ignored). */
export interface PetEventData { kind: string; intent?: string; thought_id?: string }
export interface PetSpeakData { intent: SpeakIntent; thought_id?: string; hint?: string }
export interface PhoneSelfReplyData { key: string; conversation: string | null; is_group: boolean }

export type InboundEvent =
  | { type: "hello"; data: HelloData }
  | { type: "location.update"; data: LocationUpdateData }
  | { type: "signals.update"; data: SignalsUpdateData }
  | { type: "pet.state"; data: PetStateData }
  | { type: "pet.event"; data: PetEventData }
  | { type: "pet.speak"; data: PetSpeakData }
  | { type: "phone.self_reply"; data: PhoneSelfReplyData }
  | { type: "user.say"; data: UserSayData }
  | { type: "state.update"; data: StateUpdateData }
  | { type: "phone.call"; data: PhoneCallData }
  | { type: "phone.message"; data: PhoneMessageData }
  | { type: "screen.frame"; data: ScreenFrameData }
  | { type: "audio.transcript"; data: AudioTranscriptData }
  | { type: "ide.context"; data: IdeContextData }
  | { type: "user.feedback"; data: UserFeedbackData }
  | { type: "exec.result"; data: ExecResultData };

export type ParsedEvent = InboundEvent & { id: string; ts: number };

// ---- Brain -> device ---------------------------------------------------------

export type ProposalKind = "whatsapp.reply" | "call.back" | "code.patch" | "reminder";
export type Executor = "android" | "ide" | "mac" | "brain";

export interface ProposeData {
  proposal_id: string;
  kind: ProposalKind;
  title: string;
  detail: string;
  payload: Record<string, unknown>;
  executor: Executor;
  expires_at: number;
  /** PROTOCOL §5 (whatsapp.reply cards only): one short reason the card is shown. */
  why?: string;
  /** PROTOCOL §5: true when the card is a labelled exploration (max 3/day). */
  exploration?: boolean;
  /** PROTOCOL §5: one-tap "never" shortcuts; the device sends verdict "never" + the matching scope. */
  quick_actions?: Array<{ id: string; label: string }>;
}

export type ErrorCode = "rate_limited" | "bad_event" | "model_error";

/** True when a device speaking `protocol` is too old for this brain. */
export function needsUpdate(protocol: number): boolean {
  return protocol < MIN_PROTOCOL;
}

export function updateRequiredData(): { min_protocol: number; latest_protocol: number; message: string } {
  return { min_protocol: MIN_PROTOCOL, latest_protocol: PROTOCOL_VERSION, message: UPDATE_REQUIRED_MESSAGE };
}

// ---- Parsing -----------------------------------------------------------------

export type ParseResult =
  | { ok: true; event: ParsedEvent }
  | { ok: false; code: ErrorCode; message: string; id?: string };

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown, max = 100_000): string => (typeof x === "string" ? x.slice(0, max) : "");
const optStr = (x: unknown, max = 1000): string | null => (typeof x === "string" ? x.slice(0, max) : null);
const bool = (x: unknown): boolean => x === true;
const num = (x: unknown, d = 0): number => (typeof x === "number" && Number.isFinite(x) ? x : d);
function oneOf<T extends string>(x: unknown, allowed: readonly T[], d: T): T {
  return typeof x === "string" && (allowed as readonly string[]).includes(x) ? (x as T) : d;
}

/** Parse one raw WebSocket text frame into a validated, normalized event. */
export function parseEnvelope(raw: string | ArrayBuffer, now = Date.now()): ParseResult {
  const size = typeof raw === "string" ? raw.length : raw.byteLength;
  if (size > MAX_FRAME_BYTES) return { ok: false, code: "bad_event", message: "frame too large" };
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return { ok: false, code: "bad_event", message: "invalid JSON" };
  }
  if (!isObj(j)) return { ok: false, code: "bad_event", message: "envelope must be an object" };
  const id = typeof j.id === "string" && j.id.length > 0 && j.id.length <= 64 ? j.id : undefined;
  if (!id) return { ok: false, code: "bad_event", message: "missing or invalid id" };
  if (j.v !== undefined && j.v !== PROTOCOL_VERSION)
    return { ok: false, code: "bad_event", message: `unsupported version ${String(j.v)}`, id };
  if (typeof j.type !== "string") return { ok: false, code: "bad_event", message: "missing type", id };
  const ts = num(j.ts, now);
  const d = isObj(j.data) ? j.data : {};
  const bad = (message: string): ParseResult => ({ ok: false, code: "bad_event", message, id });

  switch (j.type) {
    case "hello": {
      const kind = oneOf<DeviceKind | "">(d.kind, DEVICE_KINDS, "");
      if (!kind) return bad("hello.kind invalid");
      return {
        ok: true,
        event: {
          id, ts, type: "hello",
          data: {
            kind,
            name: str(d.name, 100),
            protocol: typeof d.protocol === "number" && Number.isInteger(d.protocol) && d.protocol > 0 ? d.protocol : 1,
            app_version: str(d.app_version, 40),
            capabilities: Array.isArray(d.capabilities)
              ? d.capabilities.filter((c): c is string => typeof c === "string").slice(0, 32)
              : [],
          },
        },
      };
    }
    case "user.say": {
      const t = str(d.text, 4000).trim();
      if (!t) return bad("user.say.text required");
      return { ok: true, event: { id, ts, type: "user.say", data: { text: t, via: oneOf(d.via, ["typed", "voice"] as const, "typed") } } };
    }
    case "state.update": {
      const data: StateUpdateData = {};
      if (typeof d.activity === "string") data.activity = oneOf(d.activity, ACTIVITIES, "idle");
      if (typeof d.front_app === "string") data.front_app = d.front_app.slice(0, 100);
      if (typeof d.focus_mode === "boolean") data.focus_mode = d.focus_mode;
      if (typeof d.watching === "boolean") data.watching = d.watching;
      return { ok: true, event: { id, ts, type: "state.update", data } };
    }
    case "phone.call": {
      const state = oneOf(d.state, ["ringing", "answered", "ended", "missed"] as const, "ringing");
      if (typeof d.state !== "string" || d.state !== state) return bad("phone.call.state invalid");
      return { ok: true, event: { id, ts, type: "phone.call", data: { state, number: str(d.number, 40), name: optStr(d.name, 100) } } };
    }
    case "phone.message": {
      const from = str(d.from, 100);
      if (!from) return bad("phone.message.from required");
      return {
        ok: true,
        event: {
          id, ts, type: "phone.message",
          data: {
            app: oneOf(d.app, ["whatsapp", "whatsapp_business", "sms", "other"] as const, "other"),
            package: str(d.package, 200),
            from,
            conversation: optStr(d.conversation, 100),
            preview: str(d.preview, 2000),
            is_group: bool(d.is_group),
            key: str(d.key, 500),
            replyable: bool(d.replyable),
          },
        },
      };
    }
    case "screen.frame": {
      const image = typeof d.image === "string" && d.image.startsWith("data:image/") ? d.image : undefined;
      return {
        ok: true,
        event: {
          id, ts, type: "screen.frame",
          data: {
            image,
            width: num(d.width),
            height: num(d.height),
            front_app: str(d.front_app, 100),
            window: str(d.window, 300),
            ocr: str(d.ocr, 4000),
            reason: oneOf(d.reason, ["periodic", "asked", "watch"] as const, "periodic"),
          },
        },
      };
    }
    case "audio.transcript": {
      return {
        ok: true,
        event: {
          id, ts, type: "audio.transcript",
          data: { text: str(d.text, 4000), seconds: num(d.seconds, 10), source: oneOf(d.source, ["system", "mic"] as const, "system") },
        },
      };
    }
    case "ide.context": {
      const file = str(d.file, 500);
      if (!file) return bad("ide.context.file required");
      let selection: IdeContextData["selection"] = null;
      if (isObj(d.selection)) {
        selection = {
          start_line: Math.trunc(num(d.selection.start_line, 1)),
          end_line: Math.trunc(num(d.selection.end_line, 1)),
          text: str(d.selection.text, 20000),
        };
      }
      const diagnostics: Diagnostic[] = Array.isArray(d.diagnostics)
        ? d.diagnostics.filter(isObj).slice(0, 50).map((x) => ({
            line: Math.trunc(num(x.line, 1)),
            severity: oneOf(x.severity, ["error", "warning"] as const, "warning"),
            message: str(x.message, 500),
          }))
        : [];
      return {
        ok: true,
        event: {
          id, ts, type: "ide.context",
          data: {
            file,
            language: str(d.language, 40),
            content: str(d.content, 20000),
            selection,
            diagnostics,
            question: optStr(d.question, 2000),
            reason: oneOf(d.reason, ["asked", "save", "diagnostics"] as const, "save"),
          },
        },
      };
    }
    case "user.feedback": {
      const pid = str(d.proposal_id, 64);
      const verdict = oneOf<UserFeedbackData["verdict"] | "">(d.verdict, ["approve", "reject", "never"], "");
      if (!pid || !verdict) return bad("user.feedback requires proposal_id and verdict");
      const data: UserFeedbackData = { proposal_id: pid, verdict };
      if (typeof d.edited_text === "string" && d.edited_text.trim()) data.edited_text = d.edited_text.slice(0, 2000);
      const scope = oneOf<NonNullable<UserFeedbackData["scope"]> | "">(d.scope, ["contact", "group", "like_this"], "");
      if (scope) data.scope = scope;
      return { ok: true, event: { id, ts, type: "user.feedback", data } };
    }
    case "exec.result": {
      const pid = str(d.proposal_id, 64);
      if (!pid) return bad("exec.result.proposal_id required");
      const data: ExecResultData = { proposal_id: pid, ok: bool(d.ok) };
      if (typeof d.error === "string") data.error = d.error.slice(0, 500);
      return { ok: true, event: { id, ts, type: "exec.result", data } };
    }
    case "location.update": {
      const lat = typeof d.lat === "number" && Number.isFinite(d.lat) ? d.lat : NaN;
      const lon = typeof d.lon === "number" && Number.isFinite(d.lon) ? d.lon : NaN;
      if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) return bad("location.update needs lat/lon");
      // Re-round on arrival: the brain never keeps more than ~1 km precision.
      const r2 = (x: number) => Math.round(x * 100) / 100;
      return {
        ok: true,
        event: { id, ts, type: "location.update", data: { lat: r2(lat), lon: r2(lon), accuracy_m: Math.max(0, num(d.accuracy_m, 1000)), source: oneOf(d.source, ["phone", "mac"] as const, "mac") } },
      };
    }
    case "signals.update": {
      const data: SignalsUpdateData = {};
      for (const k of ["mic_in_use", "camera_in_use", "calendar_busy_now", "screen_locked"] as const) if (typeof d[k] === "boolean") data[k] = d[k] as boolean;
      if (d.music === null) data.music = null;
      else if (isObj(d.music)) data.music = { app: str(d.music.app, 60), playing: bool(d.music.playing) };
      if (d.next_busy_in_min === null) data.next_busy_in_min = null;
      else if (typeof d.next_busy_in_min === "number" && Number.isFinite(d.next_busy_in_min)) data.next_busy_in_min = Math.max(0, Math.round(d.next_busy_in_min));
      if (typeof d.typing_rate === "string") data.typing_rate = oneOf(d.typing_rate, ["none", "low", "high"] as const, "none");
      if (typeof d.app_switch_rate === "string") data.app_switch_rate = oneOf(d.app_switch_rate, ["low", "high"] as const, "low");
      return { ok: true, event: { id, ts, type: "signals.update", data } };
    }
    case "pet.state": {
      const m = isObj(d.mood) ? d.mood : {};
      const u = (x: unknown) => clamp(num(x, 0), 0, 1);
      const s = (x: unknown) => clamp(num(x, 0), -1, 1);
      return {
        ok: true,
        event: {
          id, ts, type: "pet.state",
          data: {
            phase: oneOf(d.phase, PET_PHASES, "awake"),
            sleep_pressure: u(d.sleep_pressure), energy: u(d.energy), social: u(d.social), boredom: u(d.boredom), snack: u(d.snack),
            mood: { p: s(m.p), a: s(m.a), d: s(m.d) },
            emotion: oneOf(d.emotion, EMOTIONS, "neutral"),
            ladder: Math.max(0, Math.trunc(num(d.ladder, 0))),
          },
        },
      };
    }
    case "pet.event": {
      const kind = str(d.kind, 40);
      if (!kind) return bad("pet.event.kind required");
      const data: PetEventData = { kind };
      if (typeof d.intent === "string" && d.intent) data.intent = d.intent.slice(0, 40);
      if (typeof d.thought_id === "string" && d.thought_id) data.thought_id = d.thought_id.slice(0, 64);
      return { ok: true, event: { id, ts, type: "pet.event", data } };
    }
    case "pet.speak": {
      const intent = oneOf<SpeakIntent | "">(d.intent, SPEAK_INTENTS, "");
      if (!intent) return bad("pet.speak.intent invalid");
      const data: PetSpeakData = { intent };
      if (typeof d.thought_id === "string" && d.thought_id) data.thought_id = d.thought_id.slice(0, 64);
      if (typeof d.hint === "string" && d.hint.trim()) data.hint = d.hint.trim().slice(0, 200);
      return { ok: true, event: { id, ts, type: "pet.speak", data } };
    }
    case "phone.self_reply": {
      return { ok: true, event: { id, ts, type: "phone.self_reply", data: { key: str(d.key, 500), conversation: optStr(d.conversation, 100), is_group: bool(d.is_group) } } };
    }
    default:
      return bad(`unknown type ${truncate(j.type, 40)}`);
  }
}

/** Build a brain -> device envelope (serialized). */
export function envelope(type: string, data: unknown, now = Date.now(), id?: string): string {
  return JSON.stringify({
    v: PROTOCOL_VERSION,
    id: id ?? `brn_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    ts: now,
    type,
    data,
  });
}

// ---- Performance validation --------------------------------------------------

export const DEFAULT_PERFORMANCE: Performance = {
  say: "",
  emotion: "neutral",
  intensity: 0.5,
  gesture: "none",
  gaze: "user",
  voice: { pace: "normal", pitch: 0 },
  speak: true,
};

/** Validate and clamp a model- or code-produced performance. Never throws. */
export function sanitizePerformance(raw: unknown, replyTo?: string): Performance {
  const r = isObj(raw) ? raw : {};
  const voice = isObj(r.voice) ? r.voice : {};
  let say = typeof r.say === "string" ? stripEmoji(r.say) : "";
  say = truncate(say, 400);
  const pitchRaw = typeof voice.pitch === "number" ? voice.pitch : Number(voice.pitch);
  const p: Performance = {
    say,
    emotion: oneOf(typeof r.emotion === "string" ? r.emotion.toLowerCase() : r.emotion, EMOTIONS, "neutral"),
    intensity: Math.round(clamp(typeof r.intensity === "number" ? r.intensity : Number(r.intensity ?? 0.5), 0, 1) * 100) / 100,
    gesture: oneOf(typeof r.gesture === "string" ? r.gesture.toLowerCase() : r.gesture, GESTURES, "none"),
    gaze: oneOf(typeof r.gaze === "string" ? r.gaze.toLowerCase() : r.gaze, GAZES, "user"),
    voice: {
      pace: oneOf(voice.pace, PACES, "normal"),
      pitch: Number.isFinite(pitchRaw) ? Math.round(clamp(pitchRaw, -2, 2)) : 0,
    },
    speak: typeof r.speak === "boolean" ? r.speak : say.length > 0,
  };
  if (!p.say) p.speak = false;
  if (replyTo) p.reply_to = replyTo;
  return p;
}

export function perf(partial: Partial<Performance>, replyTo?: string): Performance {
  return sanitizePerformance({ ...DEFAULT_PERFORMANCE, ...partial, voice: { ...DEFAULT_PERFORMANCE.voice, ...(partial.voice ?? {}) } }, replyTo);
}
