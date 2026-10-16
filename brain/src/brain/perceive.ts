/**
 * perceive: turn raw device events into Observations.
 * Heuristics are pure and exported for tests; model calls go through Brainpower.
 */
import type { Brainpower } from "../ai";
import { parseJsonObject } from "../ai";
import type { IdeContextData, PhoneCallData, PhoneMessageData, ScreenFrameData } from "../protocol";
import { clamp, fnv1a, sha256Hex, truncate } from "../util";

export interface Contact {
  name: string;
  phone_hash: string | null;
  relation: string | null;
  importance: number;
}

export type ObservationKind = "chat" | "call" | "message" | "screen" | "watch" | "ide" | "system";

export interface Observation {
  kind: ObservationKind;
  /** Short natural-language description for the prompt / embeddings. Never logged. */
  text: string;
  urgency?: number;
  importance?: number;
  summary?: string;
  meta?: Record<string, unknown>;
}

// ---- Contacts --------------------------------------------------------------------

/** Normalize a phone number to its last 10 digits (handles +91 / 0 prefixes). */
export function normalizePhone(n: string): string {
  const digits = (n || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export async function phoneHash(n: string): Promise<string | null> {
  const norm = normalizePhone(n);
  if (norm.length < 5) return null;
  return sha256Hex(`pixie-phone:${norm}`);
}

const FAMILY_RE = /\b(mom|mum|mother|maa|ma|mummy|amma|aai|dad|father|papa|pappa|baba|appa|wife|husband|hubby|wifey|bae|babe|love|sis|sister|bro|brother|didi|bhaiya|bhai|nani|nana|dadi|dada|grandma|grandpa|son|daughter)\b/i;
const WORK_RE = /\b(boss|manager|office|hr|team|client|ceo|sir|ma'?am)\b/i;
const SPAM_RE = /\b(bank|offer|promo|otp|delivery|courier|loan|insurance|credit|support|noreply|no-reply|alert)\b/i;

/** Default importance for an unknown contact name (pure). 0..1 */
export function guessImportance(name: string | null, relation?: string | null): number {
  const s = `${name ?? ""} ${relation ?? ""}`;
  if (!s.trim()) return 0.3;
  if (FAMILY_RE.test(s)) return 0.85;
  if (WORK_RE.test(s)) return 0.6;
  if (SPAM_RE.test(s)) return 0.1;
  if (/^\+?[\d\s-]+$/.test((name ?? "").trim())) return 0.25; // unknown number
  return 0.45;
}

export function guessRelation(name: string | null): string | null {
  const m = (name ?? "").match(FAMILY_RE);
  if (m) return "family";
  if (WORK_RE.test(name ?? "")) return "work";
  return null;
}

// ---- Calls ------------------------------------------------------------------------

export function callUrgency(importance: number, state: PhoneCallData["state"]): number {
  if (state === "ringing") return clamp(0.5 + importance * 0.5, 0, 1);
  if (state === "missed") return clamp(0.3 + importance * 0.5, 0, 1);
  return clamp(importance * 0.4, 0, 1);
}

export function callObservation(d: PhoneCallData, contact: Contact | null): Observation {
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
    meta: { who, state: d.state },
  };
}

// ---- Messages ----------------------------------------------------------------------

const URGENT_RE = /\b(urgent|urgently|emergency|asap|a\.s\.a\.p|immediately|right now|call me|call back|pick up|hospital|accident|ambulance|police|help me|sos|not well|critical|died|passed away|important)\b/i;
const MILD_RE = /\b(soon|today|tonight|when free|quick question|need you|where are you|are you there|reply|answer)\b/i;

export interface MessageHeuristicInput {
  preview: string;
  importance: number;
  /** messages from the same sender in the last 10 min (including this one) */
  recentFromSender: number;
  isGroup: boolean;
}

/** Heuristic urgency 0..1 (pure). */
export function heuristicUrgency(i: MessageHeuristicInput): number {
  let u = 0.15;
  if (URGENT_RE.test(i.preview)) u += 0.5;
  else if (MILD_RE.test(i.preview)) u += 0.15;
  if (/!{2,}/.test(i.preview)) u += 0.05;
  if (/\?{2,}/.test(i.preview)) u += 0.05;
  u += (i.importance - 0.4) * 0.35;
  if (i.isGroup) u -= 0.12;
  return clamp(u, 0, 1);
}

/**
 * Boost for several messages from the same sender within 10 minutes (count includes this one).
 * Applied after blending, because the model only sees the single message.
 */
export function repeatBoost(recentFromSender: number): number {
  if (recentFromSender >= 4) return 0.3;
  if (recentFromSender === 3) return 0.2;
  if (recentFromSender === 2) return 0.1;
  return 0;
}

/** Blend model and heuristic scores, add the repeat boost. Keyword emergencies keep a floor. */
export function blendUrgency(heuristic: number, model: number | null, hasEmergencyKeyword: boolean, recentFromSender = 1): number {
  const b = (model == null ? heuristic : 0.55 * model + 0.45 * heuristic) + repeatBoost(recentFromSender);
  return clamp(hasEmergencyKeyword ? Math.max(b, 0.6) : b, 0, 1);
}

export function hasEmergencyKeyword(text: string): boolean {
  return URGENT_RE.test(text);
}

export interface MessageClassification {
  urgency: number | null;
  summary: string;
  expects_reply: boolean | null;
}

/** Short JSON-mode model classification. Never throws; returns nulls on failure. */
export async function classifyMessage(ai: Brainpower, d: PhoneMessageData, relation: string | null): Promise<MessageClassification> {
  const fallback: MessageClassification = { urgency: null, summary: defaultSummary(d), expects_reply: null };
  try {
    const res = await ai.chat(
      [
        {
          role: "system",
          content:
            'You triage phone notifications. Reply ONLY with JSON: {"urgency": number 0..1, "summary": "<=12 words, third person, no quotes", "expects_reply": boolean}. Urgency 0.9+ = emergency, 0.6 = wants attention soon, 0.3 = casual, 0.1 = promo/automated.',
        },
        {
          role: "user",
          content: JSON.stringify({
            app: d.app,
            from: d.from,
            relation,
            group: d.is_group ? d.conversation : null,
            message: truncate(d.preview, 500),
          }),
        },
      ],
      { maxTokens: 80, temperature: 0.2 },
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

export function defaultSummary(d: PhoneMessageData): string {
  const where = d.is_group && d.conversation ? ` in ${d.conversation}` : "";
  return `${d.from} sent a message${where}`;
}

export function messageObservation(d: PhoneMessageData, urgency: number, importance: number, summary: string): Observation {
  const where = d.is_group && d.conversation ? ` in group "${d.conversation}"` : "";
  return {
    kind: "message",
    text: `${d.app} message from ${d.from}${where}: "${truncate(d.preview, 300)}"`,
    urgency,
    importance,
    summary,
    meta: { from: d.from, app: d.app },
  };
}

// ---- Screen ---------------------------------------------------------------------------

export const VISION_MIN_INTERVAL_MS = 20_000;
/** For plain periodic frames, caption at most every Nth frame (and only if it changed). */
export const PERIODIC_EVERY_N = 6;

export interface VisionGate {
  reason: ScreenFrameData["reason"];
  watching: boolean;
  hasImage: boolean;
  now: number;
  lastVisionTs: number;
  /** count of periodic frames received since the last caption */
  periodicSinceCaption: number;
  changed: boolean;
}

/** Decide whether to spend a vision call on this frame (pure). */
export function shouldCaption(g: VisionGate): boolean {
  if (!g.hasImage) return false;
  if (g.reason === "asked") return true;
  if (g.now - g.lastVisionTs < VISION_MIN_INTERVAL_MS) return false;
  if (g.reason === "watch" || g.watching) return g.changed || g.now - g.lastVisionTs > 60_000;
  return g.changed && g.periodicSinceCaption >= PERIODIC_EVERY_N;
}

/** Fingerprint for change detection: app + window + coarse OCR. */
export function frameFingerprint(d: ScreenFrameData): string {
  const ocr = (d.ocr ?? "").replace(/\s+/g, " ").slice(0, 1500);
  return fnv1a(`${d.front_app}|${d.window}|${ocr}`);
}

export const VISION_PROMPT =
  "Describe in 1-2 short sentences what the user is doing on this screen. Mention any visible error messages, failing tests or warnings. Do not read out personal data.";

const ERROR_HINT_RE = /\b(error|exception|failed|failure|traceback|undefined is not|cannot find|not found|segmentation fault|panic|fatal|denied|stack trace)\b/i;

export function ocrHasErrors(ocr: string): boolean {
  return ERROR_HINT_RE.test(ocr);
}

export function screenObservation(d: ScreenFrameData, caption: string | null): Observation {
  const parts = [`Screen: app ${d.front_app || "unknown"}${d.window ? `, window "${truncate(d.window, 120)}"` : ""}.`];
  if (caption) parts.push(`Looks like: ${truncate(caption, 400)}`);
  if (d.ocr) parts.push(`Visible text (redacted): ${truncate(d.ocr, 1200)}`);
  return { kind: "screen", text: parts.join(" "), meta: { errors: ocrHasErrors(`${caption ?? ""} ${d.ocr ?? ""}`) } };
}

// ---- Audio watch buffer -------------------------------------------------------------

export interface TranscriptChunk {
  text: string;
  ts: number;
}

export const WATCH_BUFFER_MS = 3 * 60 * 1000;
export const WATCH_BUFFER_CHARS = 3000;

/** Append to rolling buffer, dropping chunks older than 3 min or beyond 3000 chars (pure). */
export function appendTranscript(buf: TranscriptChunk[], chunk: TranscriptChunk): TranscriptChunk[] {
  const out = [...buf, chunk].filter((c) => chunk.ts - c.ts <= WATCH_BUFFER_MS && c.text.trim());
  let total = out.reduce((n, c) => n + c.text.length, 0);
  while (out.length > 1 && total > WATCH_BUFFER_CHARS) total -= out.shift()!.text.length;
  return out;
}

export function watchObservation(caption: string | null, buf: TranscriptChunk[], frontApp: string | null): Observation {
  const transcript = buf.map((c) => c.text).join(" ");
  return {
    kind: "watch",
    text: `Watching together${frontApp ? ` in ${frontApp}` : ""}. Screen: ${caption ?? "(no new frame)"}. Recently heard: "${truncate(transcript, 1500)}"`,
  };
}

// ---- IDE -------------------------------------------------------------------------------

export function needsCodingHelp(d: IdeContextData): boolean {
  return !!d.question || d.diagnostics.some((x) => x.severity === "error");
}

/** Window of numbered lines around the selection / first error (keeps the prompt small). */
export function codeWindow(d: IdeContextData, radius = 40): { start: number; text: string } {
  const lines = (d.content ?? "").split("\n");
  const firstErr = d.diagnostics.find((x) => x.severity === "error");
  const center = d.selection ? Math.floor((d.selection.start_line + d.selection.end_line) / 2) : firstErr ? firstErr.line : 1;
  const start = Math.max(1, center - radius);
  const end = Math.min(lines.length, center + radius);
  const text = lines
    .slice(start - 1, end)
    .map((l, i) => `${String(start + i).padStart(4)}| ${l}`)
    .join("\n");
  return { start, text };
}

export function ideObservation(d: IdeContextData): Observation {
  const errs = d.diagnostics.filter((x) => x.severity === "error");
  const warns = d.diagnostics.length - errs.length;
  const parts = [`Coding in ${d.file}${d.language ? ` (${d.language})` : ""}.`];
  if (d.question) parts.push(`User asks: "${truncate(d.question, 400)}"`);
  if (errs.length) parts.push(`${errs.length} error(s): ${errs.slice(0, 3).map((e) => `line ${e.line}: ${truncate(e.message, 120)}`).join("; ")}`);
  if (warns) parts.push(`${warns} warning(s).`);
  return { kind: "ide", text: parts.join(" "), meta: { errorCount: errs.length, file: d.file } };
}
