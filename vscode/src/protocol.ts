/** Types and helpers for the Pixie protocol v1 (see /PROTOCOL.md). Pure. */

export const PROTOCOL_VERSION = 1;
export const APP_VERSION = "1.0.0";

export interface Envelope<T = unknown> {
  v: 1;
  id: string;
  ts: number;
  type: string;
  data: T;
}

export type Severity = "error" | "warning";

export interface IdeDiagnostic {
  line: number;
  severity: Severity;
  message: string;
}

export interface IdeContext {
  file: string;
  language: string;
  content: string;
  selection: { start_line: number; end_line: number; text: string } | null;
  diagnostics: IdeDiagnostic[];
  question: string | null;
  reason: "asked" | "save" | "diagnostics";
}

export interface HelloData {
  kind: "ide";
  name: string;
  app_version: string;
  capabilities: string[];
}

export interface Performance {
  say: string;
  emotion: Emotion;
  intensity: number;
  gesture: string;
  gaze: string;
  voice?: { pace?: string; pitch?: number };
  speak: boolean;
  reply_to?: string;
}

export const EMOTIONS = [
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
  "thinking",
] as const;
export type Emotion = (typeof EMOTIONS)[number];

const GESTURES = ["none", "wave", "nod", "shake", "bounce", "lean_in", "spin", "hide", "dance", "jump"];
const GAZES = ["user", "screen", "phone", "away", "cursor"];

export interface Proposal {
  proposal_id: string;
  kind: string;
  title: string;
  detail: string;
  payload: Record<string, unknown>;
  executor: string;
  expires_at?: number;
}

export interface CodePatchPayload {
  file: string;
  patch: string;
}

export interface ExecuteData {
  proposal_id: string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface Suggestion {
  file: string;
  explanation: string;
  patch: string | null;
  line?: number;
}

export interface WelcomeData {
  user_name?: string;
  persona?: { name?: string };
  mood?: { valence?: number; energy?: number };
  devices?: { id: string; kind: string; name: string; online: boolean }[];
}

export interface ErrorData {
  code: string;
  message?: string;
}

let counter = 0;
export function newId(prefix = "evt"): string {
  counter = (counter + 1) % 0xffffff;
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`.slice(0, 64);
}

export function makeEnvelope<T>(type: string, data: T, now: number = Date.now()): Envelope<T> {
  return { v: 1, id: newId(), ts: now, type, data };
}

/** Parse an incoming text frame. Returns "pong" for the keepalive reply, null for junk. */
export function parseFrame(raw: string): Envelope | "pong" | null {
  if (raw === "pong") return "pong";
  try {
    const obj = JSON.parse(raw) as Partial<Envelope>;
    if (!obj || typeof obj !== "object" || typeof obj.type !== "string") return null;
    return {
      v: 1,
      id: typeof obj.id === "string" ? obj.id : "",
      ts: typeof obj.ts === "number" ? obj.ts : Date.now(),
      type: obj.type,
      data: (obj.data ?? {}) as unknown,
    };
  } catch {
    return null;
  }
}

/** Normalise a bot.perform payload, tolerating unknown values from a newer brain. */
export function normalisePerformance(raw: unknown): Performance {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const emotion = (EMOTIONS as readonly string[]).includes(r.emotion as string) ? (r.emotion as Emotion) : "neutral";
  const intensity = typeof r.intensity === "number" && isFinite(r.intensity) ? Math.min(1, Math.max(0, r.intensity)) : 0.5;
  return {
    say: typeof r.say === "string" ? r.say : "",
    emotion,
    intensity,
    gesture: GESTURES.includes(r.gesture as string) ? (r.gesture as string) : "none",
    gaze: GAZES.includes(r.gaze as string) ? (r.gaze as string) : "user",
    voice: r.voice && typeof r.voice === "object" ? (r.voice as Performance["voice"]) : undefined,
    speak: r.speak === true,
    reply_to: typeof r.reply_to === "string" ? r.reply_to : undefined,
  };
}

/** Short status-bar word for an emotion. */
export function emotionWord(e: Emotion | string | undefined): string {
  switch (e) {
    case "neutral":
      return "here";
    case "love":
      return "loving";
    case "thinking":
      return "thinking";
    case undefined:
    case "":
      return "here";
    default:
      return (EMOTIONS as readonly string[]).includes(e) ? e : "here";
  }
}

/** Reconnect delay: 1 s, 2 s, 4 s ... capped at 30 s, with ±20 % jitter (jitter=0 for tests). */
export function backoffDelay(attempt: number, jitter = 0.2, rand: () => number = Math.random): number {
  const base = Math.min(30000, 1000 * Math.pow(2, Math.max(0, attempt)));
  if (jitter <= 0) return base;
  const j = base * jitter * (rand() * 2 - 1);
  return Math.max(1000, Math.min(30000, Math.round(base + j)));
}

/** FIFO queue with a cap; drops the oldest item when full. */
export class BoundedQueue<T> {
  private items: T[] = [];
  constructor(readonly cap = 100) {}
  push(item: T): void {
    this.items.push(item);
    while (this.items.length > this.cap) this.items.shift();
  }
  drain(): T[] {
    const out = this.items;
    this.items = [];
    return out;
  }
  unshiftAll(items: T[]): void {
    this.items = [...items, ...this.items];
    while (this.items.length > this.cap) this.items.shift();
  }
  get size(): number {
    return this.items.length;
  }
}

/** Normalise a user-entered brain URL: add https:// when missing, strip trailing slashes and paths like /v1. */
export function normaliseBrainUrl(input: string): string {
  let s = input.trim();
  if (!s) throw new Error("Brain URL is empty");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "https://" + s;
  const u = new URL(s);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Brain URL must be http(s)");
  let path = u.pathname.replace(/\/+$/, "");
  if (path.endsWith("/v1")) path = path.slice(0, -3);
  return `${u.protocol}//${u.host}${path}`;
}

export function wsUrlFor(brainUrl: string): string {
  const u = new URL(normaliseBrainUrl(brainUrl) + "/v1/ws");
  u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
  return u.toString();
}

export function isValidPairCode(code: string): boolean {
  return /^\d{6}$/.test(code.trim());
}
