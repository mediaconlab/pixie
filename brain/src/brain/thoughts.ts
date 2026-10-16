/**
 * Thought reservoir (PROTOCOL.md §4.2 pet.thoughts): candidate topics Pixie may voice when the Mac asks.
 * - gossip: deterministic daily aggregates over interaction counts and app/activity history. Names and
 *   counts only, never message text, never places.
 * - world: short-lived notes about notable world events seen in what reaches the user (3-day expiry,
 *   extended when they recur), detected cheaply by regex and rarely.
 * - callback: important memories, once familiarity is moderate.
 * Only ids, kind, salience and expiry go to the Mac; the fact text stays in the brain. Pure functions.
 */
import { fnv1a, truncate } from "../util";
import type { PetProfile } from "./pet";

export type ThoughtKind = "gossip" | "world" | "callback";

export interface Thought {
  id: string;
  kind: ThoughtKind;
  salience: number;
  expires_at: number;
  /** internal description for the voice prompt; never sent to devices */
  fact: string;
  /** contact / app key the thought is about (gossip), memory id (callback), topic key (world) */
  subject_key: string | null;
}

export interface ThoughtWire { id: string; kind: ThoughtKind; salience: number; expires_at: number }

export const WORLD_TTL_MS = 3 * 86_400_000;
export const WORLD_MAX_LIFE_MS = 7 * 86_400_000;
export const WORLD_CHECK_INTERVAL_MS = 10 * 60_000;
export const WORLD_MAX_NEW_PER_DAY = 3;
export const CALLBACK_MIN_FAMILIARITY = 0.3;
export const MAX_WIRE_THOUGHTS = 12;

const r2 = (x: number) => Math.round(x * 100) / 100;

export function thoughtId(...parts: string[]): string {
  return `th_${fnv1a(parts.join("|"))}${fnv1a(parts.reverse().join("#")).slice(0, 4)}`;
}

// ---- privacy --------------------------------------------------------------------------------------

/**
 * Topics Pixie never gossips or reminisces about: health, money, romance, religion, politics, places /
 * location, work content, family conflict or grief, other people's private lives, sexuality, legal
 * matters, appearance or weight.
 */
export const SENSITIVE_RE = new RegExp(
  "(?<![a-z0-9])(?:" +
  [
    // health
    "doctor|dr\\.?\\s|hospital|clinic|medic|medicine|pharma|pharmacy|chemist|apollo|practo|1mg|netmeds|health|therap|psychiat|diagnos|sick|ill(?:ness)?\\b|fever|covid|pregnan|period|fertility|calorie|diet|insulin|blood|cancer|surgery|injur",
    // money
    "bank|loan|emi\\b|credit|debit|upi|paytm|phonepe|gpay|google pay|wallet|salary|payment|invoice|tax|insurance|zerodha|groww|upstox|kite|robinhood|coinbase|binance|crypto|bitcoin|stock|trading|invest|mutual fund|money|rupees?|\\brs\\.?\\s|₹|\\$\\d|debt|rent\\b",
    // romance / sexuality
    "bae\\b|babe\\b|baby\\b|jaan\\b|jaanu|darling|sweetheart|honey\\b|love\\b|lover|crush|girlfriend|boyfriend|\\bgf\\b|\\bbf\\b|wife|wifey|husband|hubby|partner|date\\b|dating|tinder|bumble|hinge|grindr|aisle|romance|romantic|kiss|sexual|sexy|\\bsex\\b|porn|onlyfans|gay|lesbian|queer|nsfw",
    // religion
    "temple|mandir|church|mosque|masjid|gurudwara|gurdwara|pooja|puja\\b|namaz|prayer|bible|quran|gita\\b|religio|god\\b|bhagwan|allah|jesus|astrolog|horoscope",
    // politics
    "politic|election|vote|voting|bjp|congress|aap\\b|party office|minister|modi|rahul gandhi|parliament|lok sabha|rajya sabha|protest|government",
    // places / location
    "maps\\b|google maps|uber|ola\\b|rapido|airbnb|booking\\.com|makemytrip|irctc|flight|airport|station|hotel|trip\\b|travel|location|address|visited|went to|nearby|gps",
    // work content
    "slack|microsoft teams|\\bteams\\b|outlook|jira|confluence|zoom|google meet|webex|boss|manager|client|office|meeting|appraisal|deadline|layoff|resign|interview",
    // family conflict / grief / private lives
    "fight|argument|divorce|breakup|broke up|funeral|passed away|died|death|rip\\b|condolence|grief|cheat|affair|gossip about|secret",
    // legal
    "lawyer|advocate|court|police|fir\\b|legal|lawsuit|case hearing|bail|notice from",
    // appearance / weight
    "weight|kg\\b|fat\\b|thin\\b|skinny|looks|ugly|pretty|hair ?fall|acne|skin|body|gym selfie",
  ].join("|") +
  ")",
  "i",
);

export function isSensitive(text: string): boolean {
  return SENSITIVE_RE.test(text);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Gossip passes only if enabled, the subject isn't blocked, and nothing in it touches a sensitive topic. */
export function gossipAllowed(t: Pick<Thought, "fact" | "subject_key">, p: Pick<PetProfile, "gossip_enabled" | "gossip_block">): boolean {
  if (!p.gossip_enabled) return false;
  if (isSensitive(t.fact) || (t.subject_key && isSensitive(t.subject_key))) return false;
  for (const b of p.gossip_block) {
    if (t.subject_key && t.subject_key === b.key) return false;
    for (const w of [b.key, b.label]) {
      if (w && new RegExp(`\\b${escapeRe(w)}\\b`, "i").test(t.fact)) return false;
    }
  }
  return true;
}

// ---- daily aggregates ------------------------------------------------------------------------------------

export interface InteractionRow { who_key: string; ts: number }
export interface ActivityLogRow { activity: string; front_app: string | null; ts: number }
export interface ContactInfo { name: string; relation: string | null }

export interface GossipInput {
  now: number;
  /** start of the current local day (04:00 boundary) */
  dayStart: number;
  dayKey: string;
  /** local decimal hour for a timestamp */
  localHour: (ts: number) => number;
  messages: InteractionRow[];
  activity: ActivityLogRow[];
  contacts: Map<string, ContactInfo>;
  profile: Pick<PetProfile, "gossip_enabled" | "gossip_block">;
}

const DAY = 86_400_000;
const MAX_SEGMENT_MS = 2 * 3600_000;

/** Time per (activity, app) between consecutive activity rows within [from, to), segments capped at 2 h. */
export function activityDurations(rows: ActivityLogRow[], from: number, to: number): Map<string, number> {
  const out = new Map<string, number>();
  const sorted = [...rows].sort((a, b) => a.ts - b.ts);
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i]!;
    const next = sorted[i + 1]?.ts ?? Math.min(to, r.ts + 30 * 60_000);
    const s = Math.max(r.ts, from);
    const e = Math.min(next, to, r.ts + MAX_SEGMENT_MS);
    if (e <= s || r.activity === "away") continue;
    const key = `${r.activity}|${(r.front_app ?? "").trim()}`;
    out.set(key, (out.get(key) ?? 0) + (e - s));
  }
  return out;
}

function sumWhere(m: Map<string, number>, f: (activity: string, app: string) => boolean): number {
  let n = 0;
  for (const [k, v] of m) {
    const [a, app] = k.split("|") as [string, string];
    if (f(a, app)) n += v;
  }
  return n;
}

function appTotals(m: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, v] of m) {
    const app = k.split("|")[1] ?? "";
    if (app) out.set(app, (out.get(app) ?? 0) + v);
  }
  return out;
}

const hoursText = (ms: number) => {
  const h = Math.round((ms / 3600_000) * 2) / 2;
  return h === 1 ? "an hour" : `${h} hours`;
};

/** Deterministic gossip candidates for today, already privacy-filtered. */
export function gossipCandidates(i: GossipInput): Thought[] {
  const out: Thought[] = [];
  const expires = i.dayStart + DAY;
  const add = (type: string, subject: string, salience: number, fact: string) => {
    const t: Thought = { id: thoughtId("gossip", type, subject, i.dayKey), kind: "gossip", salience: r2(Math.min(1, Math.max(0.05, salience))), expires_at: expires, fact, subject_key: subject };
    if (gossipAllowed(t, i.profile)) out.push(t);
  };

  // a) a contact messaging far more than usual today
  const today = new Map<string, number>();
  const before = new Map<string, number>();
  for (const m of i.messages) {
    if (m.ts >= i.dayStart && m.ts <= i.now) today.set(m.who_key, (today.get(m.who_key) ?? 0) + 1);
    else if (m.ts >= i.dayStart - 14 * DAY && m.ts < i.dayStart) before.set(m.who_key, (before.get(m.who_key) ?? 0) + 1);
  }
  for (const [who, n] of today) {
    const c = i.contacts.get(who);
    if (!c || c.relation === "work") continue;
    const usual = (before.get(who) ?? 0) / 14;
    if (n >= 6 && n >= 3 * Math.max(usual, 1)) {
      add("msgs", who, 0.45 + Math.min(0.4, (n / Math.max(usual, 1) - 3) * 0.05), `${c.name} has sent ${n} messages today; usually it's about ${Math.max(0, Math.round(usual))} a day.`);
    }
  }

  // per-day activity totals for the last 8 days (index 0 = today)
  const days: Array<Map<string, number>> = [];
  for (let d = 0; d < 8; d++) {
    const from = i.dayStart - d * DAY;
    days.push(activityDurations(i.activity, from, d === 0 ? i.now : from + DAY));
  }

  // b) unusually long time in one app today
  const todayApps = appTotals(days[0]!);
  for (const [app, ms] of todayApps) {
    const prev = days.slice(1).map((m) => appTotals(m).get(app) ?? 0);
    const avg = prev.reduce((a, b) => a + b, 0) / prev.length;
    if (ms >= 2 * 3600_000 && ms >= 2 * Math.max(avg, 30 * 60_000)) add("app", app.toLowerCase(), 0.35 + Math.min(0.3, ms / (10 * 3600_000)), `The user has spent about ${hoursText(ms)} in ${app} today, more than usual.`);
  }

  // c) watching something several evenings in a row (app names only)
  const videoApp = (m: Map<string, number>) => {
    const v = appTotals(new Map([...m].filter(([k]) => k.startsWith("video|"))));
    let best: [string, number] | null = null;
    for (const e of v) if (!best || e[1] > best[1]) best = e;
    return best && best[1] >= 45 * 60_000 ? best[0] : null;
  };
  const v0 = videoApp(days[0]!);
  if (v0) {
    let n = 1;
    while (n < 7 && videoApp(days[n]!) === v0) n++;
    if (n >= 3) add("shows", v0.toLowerCase(), 0.35 + Math.min(0.3, n * 0.05), `${ordinal(n)} evening in a row watching something on ${v0}.`);
  }

  // d) coding streak (days with ≥ 1 h of coding, ending today or yesterday)
  const coded = days.map((m) => sumWhere(m, (a) => a === "coding") >= 3600_000);
  const startIdx = coded[0] ? 0 : coded[1] ? 1 : -1;
  if (startIdx >= 0) {
    let n = 0;
    while (startIdx + n < coded.length && coded[startIdx + n]) n++;
    if (n >= 3) add("coding", "coding", 0.4 + Math.min(0.4, n * 0.05), `${n}-day coding streak${startIdx === 0 ? ", still going today" : ""}.`);
  }

  // e) late nights: at the computer between 01:00 and 05:00 on 2 of the last 3 nights
  let late = 0;
  for (let d = 0; d < 3; d++) {
    const from = i.dayStart - d * DAY;
    const lateRow = i.activity.some((r) => r.ts >= from - 3 * 3600_000 && r.ts < from && r.activity !== "away" && i.localHour(r.ts) >= 1 && i.localHour(r.ts) < 4.5);
    if (lateRow) late++;
  }
  if (late >= 2) add("late", "late_nights", 0.5, `The user stayed up past 1 am on ${late} of the last 3 nights.`);

  // f) a repeated habit: the same first app of the day on ≥ 4 of the last 5 days
  const firstApps: string[] = [];
  for (let d = 0; d < 5; d++) {
    const from = i.dayStart - d * DAY;
    const first = i.activity.filter((r) => r.ts >= from && r.ts < from + DAY && r.activity !== "away" && r.front_app).sort((a, b) => a.ts - b.ts)[0];
    if (first?.front_app) firstApps.push(first.front_app);
  }
  const counts = new Map<string, number>();
  for (const a of firstApps) counts.set(a, (counts.get(a) ?? 0) + 1);
  for (const [app, n] of counts) {
    if (n >= 4) add("habit", app.toLowerCase(), 0.3, `Opens ${app} first thing on ${n} of the last 5 mornings.`);
  }
  return out;
}

function ordinal(n: number): string {
  return ["Zeroth", "First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh"][n] ?? `${n}th`;
}

// ---- world notes -------------------------------------------------------------------------------------

const WORLD_RE =
  /\b(breaking news|live updates?|world cup|final|semi-?final|ipl|t20|odi|test match|olympics?|medal|grand slam|wimbledon|champions league|formula 1|\bf1\b|grand prix|isro|chandrayaan|gaganyaan|nasa|spacex|rocket launch|launch(?:es|ed)?|eclipse|meteor shower|comet|supermoon|cyclone|monsoon|heatwave|earthquake|tsunami|record-breaking|world record|wins|won|beats|unveils|announces|oscars?|grammys?|box office)\b/i;
const MESSAGING_APP_RE = /\b(whatsapp|telegram|messages|imessage|signal|slack|discord|mail|gmail|outlook|teams|messenger|instagram)\b/i;
const STOP = new Set(["with", "from", "that", "this", "have", "after", "over", "into", "their", "they", "what", "when", "will", "your", "about", "more", "news", "live", "updates", "update", "breaking", "today", "latest", "video", "watch", "youtube"]);

export interface WorldHit { key: string; words: string[]; note: string }

/** Strip a trailing " - Site" / " | Site" suffix from a window title. */
export function headlineOf(title: string): string {
  const parts = title.split(/\s+[|–—-]\s+/);
  return (parts.length > 1 ? parts.slice(0, -1).join(" - ") : title).trim();
}

/**
 * Detect a notable world event in one piece of text (pure). `source` decides how the note is written:
 * window titles keep the headline; transcripts, OCR and chat keep only the matched keywords, so no
 * message or speech is ever quoted.
 */
export function detectWorld(text: string, source: "window" | "ocr" | "transcript" | "chat", frontApp?: string | null): WorldHit | null {
  if (!text || text.length < 8) return null;
  if (frontApp && MESSAGING_APP_RE.test(frontApp)) return null;
  if (source === "window" && MESSAGING_APP_RE.test(text)) return null;
  const line = source === "window" ? headlineOf(text) : (text.split(/\n/).find((l) => WORLD_RE.test(l)) ?? "");
  if (!line || !WORLD_RE.test(line) || isSensitive(line)) return null;
  const tokens = (line.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => (w.length >= 4 || /^(ipl|t20|odi|f1|isro|nasa)$/.test(w)) && !STOP.has(w));
  const uniq = [...new Set(tokens)];
  if (uniq.length < 2) return null;
  const words = [...uniq].sort((a, b) => b.length - a.length || a.localeCompare(b)).slice(0, 5).sort();
  const note = source === "window" ? truncate(line.replace(/\s+/g, " "), 100) : `Something about ${uniq.slice(0, 5).join(" ")} came up`;
  return { key: words.join(" "), words, note };
}

/** Two world notes are the same story when they share ≥ 2 key words. */
export function sameStory(a: string[], b: string[]): boolean {
  const s = new Set(a);
  return b.filter((w) => s.has(w)).length >= 2;
}

export function newWorldThought(hit: WorldHit, now: number): Thought {
  return { id: thoughtId("world", hit.key, String(now)), kind: "world", salience: 0.4, expires_at: now + WORLD_TTL_MS, fact: hit.note, subject_key: hit.key };
}

/** A recurring story stays around longer and gets a little more interesting (bounded). */
export function extendWorld(t: { salience: number; expires_at: number; created_at: number }, now: number): { salience: number; expires_at: number } {
  return { salience: r2(Math.min(0.9, t.salience + 0.1)), expires_at: Math.min(t.created_at + WORLD_MAX_LIFE_MS, Math.max(t.expires_at, now + WORLD_TTL_MS)) };
}

// ---- callbacks ----------------------------------------------------------------------------------------

export interface MemoryLite { id: number; kind: string; text: string; value: number; ts: number }

const PLACE_HINT_RE = /\b(went to|been to|visited|trip|travel|flew|at the|in (?:[A-Z][a-z]+))\b/;

/** Important older memories worth bringing up again, once familiarity is moderate. */
export function callbackCandidates(mems: MemoryLite[], familiarity: number, now: number, dayStart: number, dayKey: string): Thought[] {
  if (familiarity < CALLBACK_MIN_FAMILIARITY) return [];
  return mems
    .filter((m) => (m.kind === "fact" || m.kind === "episode") && m.value >= 0.55 && now - m.ts >= 2 * DAY && !isSensitive(m.text) && !PLACE_HINT_RE.test(m.text))
    .map((m) => ({ m, score: m.value + (parseInt(fnv1a(`${dayKey}:${m.id}`).slice(0, 4), 16) / 0xffff) * 0.3 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map(({ m }) => ({ id: thoughtId("callback", String(m.id), dayKey), kind: "callback" as const, salience: r2(Math.min(0.9, 0.3 + m.value * 0.5)), expires_at: dayStart + DAY, fact: truncate(m.text, 200), subject_key: String(m.id) }));
}

export function thoughtsWire(ts: Thought[], now: number): ThoughtWire[] {
  return ts
    .filter((t) => t.expires_at > now)
    .sort((a, b) => b.salience - a.salience || a.id.localeCompare(b.id))
    .slice(0, MAX_WIRE_THOUGHTS)
    .map((t) => ({ id: t.id, kind: t.kind, salience: t.salience, expires_at: t.expires_at }));
}
