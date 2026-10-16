/**
 * Pet relationship (PROTOCOL.md §4): personality traits, bond, familiarity, day mood, talk scale,
 * preferences from instructions and the learned daily rhythm. Pure functions only; BrainCore persists
 * the profile in kv("pet_profile") and sends `pet.profile` when its wire form changes.
 *
 * Pixie is fully grown from day one. Only its familiarity with the user grows.
 */
import { clamp } from "../util";
import type { PetStateData } from "../protocol";

export const TRAIT_NAMES = ["curiosity", "chattiness", "agreeableness", "sensitivity", "sass", "clinginess"] as const;
export type TraitName = (typeof TRAIT_NAMES)[number];
export type Traits = Record<TraitName, number>;

/** Seeded traits sit in a moderate band; drift keeps them within ±TRAIT_DRIFT_MAX of the seed and inside TRAIT_BOUNDS. */
export const TRAIT_SEED_RANGE = [0.35, 0.65] as const;
export const TRAIT_BOUNDS = [0.15, 0.85] as const;
export const TRAIT_DRIFT_MAX = 0.15;

export const BOND_START = 10;
export const BOND_DAILY_CAP = 5;
export const BOND_FLOOR = 20;
/** Bond only fades after this many days without contact. */
export const FADE_AFTER_DAYS = 4;
export const FIRST_WEEK_MS = 7 * 86_400_000;
/** Proactive lines per day at talk_scale 1 and chattiness 0.5. */
export const DAILY_LINE_BASE = 20;
export const DAILY_GOSSIP_CAP = 2;
export const DAILY_THEATRICAL_CAP = 1;
export const THEATRICAL_INTENTS = ["sulk_line", "rant"] as const;

export interface Rhythm {
  wake_hour: number;
  /** Local decimal hour; values past midnight are 0..6 (e.g. 0.5 = 00:30). */
  sleep_hour: number;
  lunch_hour: number;
  dinner_hour: number;
}
export const DEFAULT_RHYTHM: Rhythm = { wake_hour: 8.5, sleep_hour: 0.5, lunch_hour: 13.5, dinner_hour: 20.5 };

export type ObeyInstruction = "quiet" | "no_gossip" | "gossip_ok" | "sleep" | "less_needy" | "more_chatty" | "not_now" | "stop";

export interface PetProfile {
  traits: Traits;
  /** The seeded values; drift is bounded around these. */
  seed: Traits;
  bond: number;
  bond_day: string;
  bond_today: number;
  familiarity: number;
  day_mood: number;
  day_mood_day: string;
  less_needy: number;
  quiet_until: number;
  quiet_when: string[];
  gossip_enabled: boolean;
  /** name keys (lower-case) Pixie must never gossip about, with display labels */
  gossip_block: Array<{ key: string; label: string }>;
  rhythm: Rhythm;
  born_ts: number;
  last_contact_ts: number;
  days_together: number;
  last_contact_day: string;
  /** last time each instruction was obeyed (for the "same instruction within 24 h" pout rule) */
  obeyed: Partial<Record<string, number>>;
  /** timestamps of quiet-type requests made while coding (teaches quiet_when ["coding"]) */
  quiet_coding: number[];
  /** how the user treated Pixie since the last nightly drift */
  feel: { warm: number; cold: number; tease: number };
  last_fade_day: string;
  last_weekly_ts: number;
}

export interface ProfileWire {
  traits: Traits;
  bond: number;
  familiarity: number;
  day_mood: number;
  first_week: boolean;
  talk_scale: number;
  less_needy: number;
  quiet_until: number;
  gossip_enabled: boolean;
  rhythm: Rhythm;
  quiet_when?: string[];
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function seedTraits(random: () => number): Traits {
  const [lo, hi] = TRAIT_SEED_RANGE;
  const t = {} as Traits;
  for (const n of TRAIT_NAMES) t[n] = r2(lo + (hi - lo) * clamp(random(), 0, 1));
  return t;
}

export function newProfile(now: number, random: () => number): PetProfile {
  const traits = seedTraits(random);
  return {
    traits, seed: { ...traits },
    bond: BOND_START, bond_day: "", bond_today: 0,
    familiarity: 0,
    day_mood: 0, day_mood_day: "",
    less_needy: 0, quiet_until: 0, quiet_when: [],
    gossip_enabled: true, gossip_block: [],
    rhythm: { ...DEFAULT_RHYTHM },
    born_ts: now, last_contact_ts: now, days_together: 0, last_contact_day: "",
    obeyed: {}, quiet_coding: [],
    feel: { warm: 0, cold: 0, tease: 0 },
    last_fade_day: "", last_weekly_ts: now,
  };
}

/** Fill fields missing from an older stored profile. */
export function normalizeProfile(p: Partial<PetProfile> | null, now: number, random: () => number): PetProfile {
  const base = newProfile(now, random);
  if (!p || typeof p !== "object" || !p.traits) return base;
  return { ...base, ...p, traits: { ...base.traits, ...p.traits }, seed: { ...base.seed, ...(p.seed ?? p.traits) }, rhythm: { ...DEFAULT_RHYTHM, ...(p.rhythm ?? {}) }, feel: { ...base.feel, ...(p.feel ?? {}) } };
}

export function isFirstWeek(p: PetProfile, now: number): boolean {
  return now - p.born_ts < FIRST_WEEK_MS;
}

/** Multiplier for the Mac's speech caps: 0.5 in the first week, reduced by less_needy (down to half). */
export function talkScale(p: PetProfile, now: number): number {
  return r2((isFirstWeek(p, now) ? 0.5 : 1) * (1 - 0.5 * clamp(p.less_needy, 0, 1)));
}

export function profileWire(p: PetProfile, now: number): ProfileWire {
  const w: ProfileWire = {
    traits: Object.fromEntries(TRAIT_NAMES.map((n) => [n, r2(p.traits[n])])) as Traits,
    bond: Math.round(p.bond),
    familiarity: r2(p.familiarity),
    day_mood: r2(p.day_mood),
    first_week: isFirstWeek(p, now),
    talk_scale: talkScale(p, now),
    less_needy: r2(p.less_needy),
    quiet_until: p.quiet_until > now ? p.quiet_until : 0,
    gossip_enabled: p.gossip_enabled,
    rhythm: { wake_hour: r2(p.rhythm.wake_hour), sleep_hour: r2(p.rhythm.sleep_hour), lunch_hour: r2(p.rhythm.lunch_hour), dinner_hour: r2(p.rhythm.dinner_hour) },
  };
  if (p.quiet_when.length) w.quiet_when = [...p.quiet_when];
  return w;
}

// ---- bond ------------------------------------------------------------------------------------

/** Add a warm-interaction gain, respecting the daily cap. Returns the applied gain. */
export function addBond(p: PetProfile, gain: number, dayKey: string): number {
  if (gain <= 0) return 0;
  if (p.bond_day !== dayKey) {
    p.bond_day = dayKey;
    p.bond_today = 0;
  }
  const g = Math.min(gain, BOND_DAILY_CAP - p.bond_today, 100 - p.bond);
  if (g <= 0) return 0;
  p.bond += g;
  p.bond_today += g;
  return g;
}

/** Nightly: after FADE_AFTER_DAYS without contact, lose 1 point per night, never below the floor. */
export function fadeBond(p: PetProfile, now: number, dayKey: string): boolean {
  if (p.last_fade_day === dayKey) return false;
  p.last_fade_day = dayKey;
  const idleDays = (now - p.last_contact_ts) / 86_400_000;
  if (idleDays < FADE_AFTER_DAYS || p.bond <= BOND_FLOOR) return false;
  p.bond = Math.max(BOND_FLOOR, p.bond - 1);
  return true;
}

/** Record contact with the user (counts distinct local days together). */
export function noteContact(p: PetProfile, now: number, dayKey: string): void {
  p.last_contact_ts = now;
  if (p.last_contact_day !== dayKey) {
    p.last_contact_day = dayKey;
    p.days_together += 1;
  }
}

// ---- familiarity ------------------------------------------------------------------------------

/** Familiarity grows with days together and with memories; it never goes down (except "forget me"). */
export function familiarityFor(daysTogether: number, memoryCount: number): number {
  const days = 1 - Math.exp(-Math.max(0, daysTogether) / 45);
  const mems = 1 - Math.exp(-Math.max(0, memoryCount) / 150);
  return r2(clamp(0.6 * days + 0.4 * mems, 0, 1));
}

export function updateFamiliarity(p: PetProfile, memoryCount: number): void {
  p.familiarity = Math.max(p.familiarity, familiarityFor(p.days_together, memoryCount));
}

// ---- day mood ----------------------------------------------------------------------------------

/** Sample the day's mood once per local morning: small random swing, nudged by the bond. */
export function sampleDayMood(p: PetProfile, random: () => number): number {
  return r2(clamp((random() - 0.5) * 0.5 + (p.bond - 50) / 500, -0.4, 0.4));
}

export function ensureDayMood(p: PetProfile, moodDay: string, random: () => number): boolean {
  if (p.day_mood_day === moodDay) return false;
  p.day_mood_day = moodDay;
  p.day_mood = sampleDayMood(p, random);
  return true;
}

// ---- trait drift -----------------------------------------------------------------------------------

function boundTrait(p: PetProfile, n: TraitName, v: number): number {
  return r2(clamp(clamp(v, p.seed[n] - TRAIT_DRIFT_MAX, p.seed[n] + TRAIT_DRIFT_MAX), TRAIT_BOUNDS[0], TRAIT_BOUNDS[1]));
}

export function nudgeTrait(p: PetProfile, n: TraitName, delta: number): void {
  p.traits[n] = boundTrait(p, n, p.traits[n] + delta);
}

/** Nightly drift from how the user treated Pixie: at most ~0.01 per trait per night. */
export function driftTraits(p: PetProfile): void {
  const { warm, cold, tease } = p.feel;
  const total = warm + cold + tease;
  if (total > 0) {
    const net = (warm - 2 * cold) / (total + 5); // -1..1, damped for small samples
    nudgeTrait(p, "agreeableness", 0.01 * net);
    nudgeTrait(p, "clinginess", 0.006 * net);
    nudgeTrait(p, "sensitivity", cold > warm ? 0.005 : -0.003);
    if (tease >= 2) nudgeTrait(p, "sass", 0.008);
    if (warm >= 3) nudgeTrait(p, "curiosity", 0.003);
  }
  p.feel = { warm: 0, cold: 0, tease: 0 };
}

/** Weekly: if most proactive lines were ignored or dismissed, Pixie becomes a little less chatty. */
export function weeklyChattiness(p: PetProfile, outcomes: { replied: number; dismissed: number; ignored: number }, now: number): boolean {
  if (now - p.last_weekly_ts < 7 * 86_400_000) return false;
  p.last_weekly_ts = now;
  const total = outcomes.replied + outcomes.dismissed + outcomes.ignored;
  if (total < 6) return false;
  const ignoredShare = (outcomes.dismissed + outcomes.ignored) / total;
  if (ignoredShare > 0.6) {
    nudgeTrait(p, "chattiness", -0.05);
    return true;
  }
  if (ignoredShare < 0.25) nudgeTrait(p, "chattiness", 0.02);
  return false;
}

// ---- speech caps ----------------------------------------------------------------------------------

export function dailyLineCap(p: PetProfile, now: number): number {
  return Math.max(1, Math.round(DAILY_LINE_BASE * talkScale(p, now) * (0.7 + 0.6 * p.traits.chattiness)));
}

export type SpeakDecline = "quiet" | "busy" | "cap" | "gossip_cap" | "theatrical_cap" | "budget" | "privacy" | "no_thought" | null;

export interface CapInput {
  profile: PetProfile;
  now: number;
  intent: string;
  activity: string;
  inMeeting: boolean;
  linesToday: number;
  gossipToday: number;
  theatricalToday: number;
  modelBudgetLeft: number;
}

/** Why Pixie should stay silent for a pet.speak request, or null to go ahead (pure). */
export function speakDecline(c: CapInput): SpeakDecline {
  const p = c.profile;
  if (c.now < p.quiet_until) return "quiet";
  if (p.quiet_when.includes(c.activity)) return "quiet";
  if (c.inMeeting) return "busy";
  if (c.linesToday >= dailyLineCap(p, c.now)) return "cap";
  if (c.intent === "gossip" && c.gossipToday >= DAILY_GOSSIP_CAP) return "gossip_cap";
  if ((THEATRICAL_INTENTS as readonly string[]).includes(c.intent) && c.theatricalToday >= DAILY_THEATRICAL_CAP) return "theatrical_cap";
  if (c.modelBudgetLeft < 2) return "budget";
  return null;
}

// ---- rhythm ----------------------------------------------------------------------------------------

export interface ActivityRow { activity: string; ts: number }
export interface DayWindow { start: number; end: number }

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Learn wake / sleep / lunch / dinner hours from activity history (state.update rows, `away` = not at the
 * computer) and pet wake signals. `days` are local-day windows starting at 04:00 local; `localHour` maps a
 * timestamp to a local decimal hour. Needs ≥ 3 days of evidence per value; blends 30 % toward the
 * observation so one odd day doesn't swing it.
 */
export function learnRhythm(prev: Rhythm, rows: ActivityRow[], days: DayWindow[], localHour: (ts: number) => number, wakeSignals: number[] = []): Rhythm {
  const wakes: number[] = [];
  const sleeps: number[] = [];
  const lunches: number[] = [];
  const dinners: number[] = [];
  const sorted = [...rows].sort((a, b) => a.ts - b.ts);
  for (const d of days) {
    const inDay = sorted.filter((r) => r.ts >= d.start && r.ts < d.end);
    const present = inDay.filter((r) => r.activity !== "away");
    const sig = wakeSignals.filter((t) => t >= d.start && t < d.end);
    const firstTs = Math.min(present[0]?.ts ?? Infinity, sig[0] ?? Infinity);
    if (Number.isFinite(firstTs)) wakes.push(localHour(firstTs));
    // Sleep: the last time the user left (or the last presence) after 20:00 local.
    const lastAway = [...inDay].reverse().find((r) => r.activity === "away");
    const lastPresent = present[present.length - 1];
    const sleepTs = lastAway && lastPresent && lastAway.ts > lastPresent.ts ? lastAway.ts : lastPresent?.ts;
    if (sleepTs != null) {
      let h = localHour(sleepTs);
      if (h < 6) h += 24;
      if (h >= 20) sleeps.push(h);
    }
    // Meals: an away gap of 20 min – 2 h starting in the lunch / dinner window.
    for (let i = 0; i < inDay.length; i++) {
      const r = inDay[i]!;
      if (r.activity !== "away") continue;
      const back = inDay.slice(i + 1).find((x) => x.activity !== "away");
      if (!back) continue;
      const gap = back.ts - r.ts;
      if (gap < 20 * 60_000 || gap > 2 * 3600_000) continue;
      const mid = localHour(r.ts + gap / 2);
      if (mid >= 11.5 && mid <= 15.5) lunches.push(mid);
      else if (mid >= 18.5 && mid <= 23) dinners.push(mid);
    }
  }
  const blend = (old: number, obs: number[], wrap = false): number => {
    if (obs.length < 3) return old;
    const m = median(obs)!;
    const o = wrap && old < 6 ? old + 24 : old;
    let v = o + (m - o) * 0.3;
    if (wrap && v >= 24) v -= 24;
    return Math.round(v * 4) / 4; // quarter hours
  };
  return {
    wake_hour: blend(prev.wake_hour, wakes),
    sleep_hour: blend(prev.sleep_hour, sleeps, true),
    lunch_hour: blend(prev.lunch_hour, lunches),
    dinner_hour: blend(prev.dinner_hour, dinners),
  };
}

// ---- pet.state in words --------------------------------------------------------------------------------

/** Render the Mac's latest pet.state for the voice prompt. */
export function describePetState(s: PetStateData | null): string {
  if (!s) return "awake";
  const phase = { awake: "awake", napping: "napping", sleepy: "getting sleepy", asleep: "asleep", waking: "just waking up" }[s.phase] ?? "awake";
  const bits = [phase];
  if (s.sleep_pressure > 0.7 && s.phase === "awake") bits.push("very drowsy");
  if (s.energy > 0.75) bits.push("full of energy");
  else if (s.energy < 0.3) bits.push("low on energy");
  if (s.boredom > 0.6) bits.push("a bit bored");
  if (s.snack > 0.7) bits.push("peckish");
  if (s.social > 0.7) bits.push("in the mood for company");
  if (s.mood.p > 0.3) bits.push("cheerful");
  else if (s.mood.p < -0.3) bits.push("a little grumpy");
  if (s.mood.a > 0.4) bits.push("excitable");
  if (s.emotion && s.emotion !== "neutral") bits.push(`feeling ${s.emotion}`);
  return bits.join(", ");
}

export function describeTraits(t: Traits): string {
  const words: string[] = [];
  const say = (n: TraitName, hi: string, lo: string) => {
    if (t[n] >= 0.58) words.push(hi);
    else if (t[n] <= 0.42) words.push(lo);
  };
  say("curiosity", "very curious", "easygoing");
  say("chattiness", "chatty", "a little reserved");
  say("agreeableness", "sweet-natured", "a bit contrary");
  say("sensitivity", "sensitive", "thick-skinned");
  say("sass", "sassy", "earnest");
  say("clinginess", "affectionate", "independent");
  return words.length ? words.join(", ") : "balanced";
}

export function describeBond(p: PetProfile): string {
  const fam = p.familiarity < 0.15 ? "you are still getting to know them" : p.familiarity < 0.4 ? "you know them a little" : p.familiarity < 0.7 ? "you know them well" : "you know them really well";
  const bond = p.bond < 25 ? "friendly but new" : p.bond < 50 ? "warm" : p.bond < 75 ? "close" : "very close";
  return `${bond} bond; ${fam}`;
}
