/**
 * Pixie's mood: valence (-1..1) and energy (0..1). Pure functions only.
 * Decays toward a baseline with a 30-minute half-life; events nudge it.
 */
import { clamp, istHour } from "../util";

export interface Mood {
  valence: number;
  energy: number;
  /** unix ms of the last update */
  ts: number;
}

export const BASELINE = { valence: 0.2, energy: 0.6 } as const;
export const HALF_LIFE_MS = 30 * 60 * 1000;

export type MoodEvent =
  | "pat"
  | "compliment"
  | "thanks"
  | "fixed_error"
  | "error"
  | "repeated_error"
  | "rude"
  | "loved_one_call"
  | "missed_call"
  | "urgent_message"
  | "chat"
  | "rate_limited";

const NUDGES: Record<MoodEvent, { valence: number; energy: number }> = {
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
  rate_limited: { valence: -0.02, energy: -0.2 },
};

export function initialMood(now: number): Mood {
  return { valence: BASELINE.valence, energy: BASELINE.energy, ts: now };
}

/** Is this a late-night hour in Asia/Kolkata (23:00 - 05:59)? */
export function isLateNight(ts: number): boolean {
  const h = istHour(ts);
  return h >= 23 || h < 6;
}

/**
 * Energy baseline at a given time. Late-night hours in IST pull energy down.
 * The base is 0.6; 0.35 between 00:00-05:59, 0.45 at 23:00.
 */
export function energyBaseline(ts: number): number {
  const h = istHour(ts);
  if (h >= 0 && h < 6) return 0.35;
  if (h === 23) return 0.45;
  return BASELINE.energy;
}

/** Exponential decay toward the (time-aware) baseline. */
export function decay(m: Mood, now: number): Mood {
  const dt = Math.max(0, now - m.ts);
  if (dt === 0) return { ...m };
  const k = Math.pow(0.5, dt / HALF_LIFE_MS);
  const eb = energyBaseline(now);
  return {
    valence: clamp(BASELINE.valence + (m.valence - BASELINE.valence) * k, -1, 1),
    energy: clamp(eb + (m.energy - eb) * k, 0, 1),
    ts: now,
  };
}

/** Apply decay up to `now`, then nudge by an event. */
export function nudge(m: Mood, ev: MoodEvent, now: number, scale = 1): Mood {
  const d = decay(m, now);
  const n = NUDGES[ev];
  let energy = d.energy + n.energy * scale;
  // Late night: every interaction tires Pixie a little more.
  if (isLateNight(now)) energy -= 0.03;
  return {
    valence: clamp(d.valence + n.valence * scale, -1, 1),
    energy: clamp(energy, 0, 1),
    ts: now,
  };
}

/** Round for transport. */
export function moodForWire(m: Mood): { valence: number; energy: number } {
  return { valence: Math.round(m.valence * 100) / 100, energy: Math.round(m.energy * 100) / 100 };
}

/** One-line description for the prompt. */
export function describeMood(m: Mood): string {
  const v = m.valence > 0.5 ? "very happy" : m.valence > 0.15 ? "content" : m.valence > -0.15 ? "neutral" : m.valence > -0.5 ? "a bit down" : "sad";
  const e = m.energy > 0.75 ? "bouncy" : m.energy > 0.45 ? "awake" : m.energy > 0.25 ? "drowsy" : "very sleepy";
  return `${v}, ${e} (valence ${m.valence.toFixed(2)}, energy ${m.energy.toFixed(2)})`;
}

const PAT_RE = /(\*?\s*(head)?pats?\s*\*?|\bpat pat\b|\bboop\b|\bhug(s|gies)?\b)/i;
const COMPLIMENT_RE = /\b(good (job|girl|boy|bot)|well done|you('| a)?re (so )?(cute|adorable|amazing|the best|smart|awesome)|love you|cutie|nice work|great job|you rock)\b/i;
const THANKS_RE = /\b(thanks|thank you|thx|ty|tysm)\b/i;
const RUDE_RE = /\b(shut up|stupid|useless|dumb|hate you|annoying)\b/i;

/** Map something the user said to a mood event (heuristic, pure). */
export function moodEventFromText(text: string): MoodEvent | null {
  if (RUDE_RE.test(text)) return "rude";
  if (PAT_RE.test(text)) return "pat";
  if (COMPLIMENT_RE.test(text)) return "compliment";
  if (THANKS_RE.test(text)) return "thanks";
  return null;
}
