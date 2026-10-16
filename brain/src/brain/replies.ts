/**
 * Smart reply cards: PURE policy, no I/O (PROTOCOL.md §5).
 *
 * Per incoming message, decide whether to show a `whatsapp.reply` card:
 *   1. explicit user rules win (most specific matching rule; ties → newest)
 *   2. otherwise a learned per-subject score (contact for DMs, group for groups), pooled toward the
 *      relation average and a global average, combined with the message's reply-likelihood.
 *
 * Learning keys never contain message text: subject keys are `c:<contact name key>` (DMs) and
 * `g:<group name key>` (groups), so a "Never" on a group card never touches that person's DMs.
 */
import { IST_OFFSET_MS, clamp, istHour } from "../util";

// ---- types ---------------------------------------------------------------------------------------

export type RuleEffect = "always" | "never" | "only";
export type SubjectType = "contact" | "group" | "relation" | "all_groups" | "all_dms" | "all";
export type RuleSource = "chat" | "button" | "migrated";
export type FeedbackScope = "contact" | "group" | "like_this";
export type RelationBucket = "family" | "work" | "friend" | "unknown";

export interface RuleConditions {
  keywords_any?: string[];
  mention_only?: boolean;
  /** rule applies only when the user is NOT mentioned ("never ... unless I'm mentioned") */
  unless_mentioned?: boolean;
  /** IST hours [from_hour, to_hour); wraps past midnight when from_hour > to_hour. */
  time?: { from_hour: number; to_hour: number };
  /** message categories (from the classifier), used by "like this" rules */
  categories?: string[];
  /** contact rules only: which chats they cover. Default "dm". */
  chat?: "dm" | "group" | "any";
}

export interface ReplyRule {
  id: string;
  effect: RuleEffect;
  subject_type: SubjectType;
  /** name key of the contact / group, or the relation; null for all / all_groups / all_dms */
  subject_key: string | null;
  subject_label: string;
  conditions: RuleConditions | null;
  expires_at: number | null;
  source: RuleSource;
  utterance: string | null;
  created_at: number;
}

export interface MessageContext {
  isGroup: boolean;
  contactKey: string;
  groupKey: string | null;
  relation: RelationBucket;
  /** user @-mentioned / named in a group message (always true for DMs) */
  mentioned: boolean;
  /** used transiently for keyword conditions; never stored */
  text: string;
  category: string;
  now: number;
}

export interface Counts {
  pos: number;
  neg: number;
}

export const ZERO: Counts = { pos: 0, neg: 0 };

// ---- keys ------------------------------------------------------------------------------------------

export const subjectKey = (ctx: Pick<MessageContext, "isGroup" | "contactKey" | "groupKey">): string =>
  ctx.isGroup ? `g:${ctx.groupKey ?? "?"}` : `c:${ctx.contactKey}`;
export const relationKey = (ctx: Pick<MessageContext, "isGroup" | "relation">): string => (ctx.isGroup ? "r:group" : `r:${ctx.relation}`);
export const globalKey = (isGroup: boolean): string => (isGroup ? "*:group" : "*:dm");

export function relationBucket(relation: string | null | undefined): RelationBucket {
  const r = (relation ?? "").toLowerCase();
  if (r === "family") return "family";
  if (r === "work") return "work";
  if (r === "friend" || r === "friends") return "friend";
  return "unknown";
}

// ---- reply likelihood (heuristic fallback for the classifier) ---------------------------------------

export const CATEGORIES = ["question", "request", "plan", "greeting", "info", "ack", "automated", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

const ACK_RE = /^(ok(ay)?|k+|kk|thanks?|thank you|thx|ty|👍|lol|haha+|hehe+|good night|gn|bye|cool|nice|done|accha|acha|theek hai|thik hai|hmm+)\W*$/i;
const AUTOMATED_RE = /\b(otp|verification code|delivered|out for delivery|your order|offer|cashback|recharge|\d+ new messages?)\b/i;
const QUESTION_WORD_RE = /\b(can you|could you|will you|would you|are you|r u|do you|did you|have you|when|where|what time|free\b|let me know|lmk|coming|reach(ed)?|kya|kab|kahan|kaha|kaise|kyun|kyu|kitna|kitne|batao|bata)\b/i;
const REQUEST_RE = /\b(please|pls|plz|call me|send|share|bhej|bhejo|bhejna|reply|answer|help)\b/i;
const PLAN_RE = /\b(tonight|tomorrow|today|dinner|lunch|meet|plan|party|movie|kal|aaj)\b/i;
const GREETING_RE = /^(hi+|hey+|hello+|yo|namaste|good morning|gm|sup)\b/i;

/** Heuristic reply-likelihood (0..1) and category for a message (pure). */
export function heuristicReply(preview: string, isGroup: boolean, mentioned = false): { p_reply: number; category: Category } {
  const t = (preview ?? "").trim();
  if (!t || ACK_RE.test(t)) return { p_reply: 0.05, category: "ack" };
  if (AUTOMATED_RE.test(t)) return { p_reply: 0.02, category: "automated" };
  const addressed = !isGroup || mentioned || /\byou\b|\bu\b|\btum\b|\btu\b|\baap\b/i.test(t);
  if (/\?/.test(t) || QUESTION_WORD_RE.test(t)) return { p_reply: addressed ? 0.75 : 0.35, category: "question" };
  if (REQUEST_RE.test(t)) return { p_reply: addressed ? 0.65 : 0.25, category: "request" };
  if (PLAN_RE.test(t)) return { p_reply: addressed ? 0.45 : 0.15, category: "plan" };
  if (GREETING_RE.test(t)) return { p_reply: isGroup ? 0.1 : 0.35, category: "greeting" };
  return { p_reply: isGroup ? 0.08 : 0.15, category: "info" };
}

/** Is the user @-mentioned or named in a (group) message? */
export function mentionsUser(preview: string, userName: string): boolean {
  if (/@\s*(you|me)\b/i.test(preview)) return true;
  const first = (userName ?? "").trim().split(/\s+/)[0];
  if (!first || first.length < 2) return false;
  const esc = first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}])@?${esc}([^\\p{L}]|$)`, "iu").test(preview);
}

// ---- rules -------------------------------------------------------------------------------------------

const SUBJECT_WEIGHT: Record<SubjectType, number> = { contact: 50, group: 40, relation: 30, all_groups: 20, all_dms: 20, all: 10 };

/** Rules with the same scope key replace each other (same subject; contact rules split DM / group). */
export function ruleScopeKey(r: Pick<ReplyRule, "subject_type" | "subject_key" | "conditions">): string {
  const chat = r.subject_type === "contact" ? `:${r.conditions?.chat ?? "dm"}` : "";
  const cats = r.conditions?.categories?.length ? `:cat=${[...r.conditions.categories].sort().join(",")}` : "";
  return `${r.subject_type}:${r.subject_key ?? ""}${chat}${cats}`;
}

/** Can Pixie offer a reply card for this notification at all? */
export function canOfferReply(m: { app: string; replyable: boolean; key: string }): boolean {
  return !!m.replyable && !!m.key && (m.app === "whatsapp" || m.app === "whatsapp_business");
}

/**
 * Combine the classifier's outputs into one reply-likelihood. A model p_reply wins; an old-style
 * expects_reply nudges the heuristic; otherwise the heuristic alone.
 */
export function combinePReply(model: number | null, expects: boolean | null, heuristic: number): number {
  if (model != null) return clamp(model, 0, 1);
  if (expects === true) return Math.max(heuristic, 0.6);
  if (expects === false) return Math.min(heuristic, 0.1);
  return heuristic;
}

export function ruleActive(r: ReplyRule, now: number): boolean {
  return r.expires_at == null || r.expires_at > now;
}

function subjectMatches(r: ReplyRule, c: MessageContext): boolean {
  switch (r.subject_type) {
    case "contact": {
      if (r.subject_key !== c.contactKey) return false;
      const chat = r.conditions?.chat ?? "dm";
      return chat === "any" || (chat === "group") === c.isGroup;
    }
    case "group":
      return c.isGroup && !!c.groupKey && r.subject_key === c.groupKey;
    case "relation":
      return !c.isGroup && r.subject_key === c.relation;
    case "all_groups":
      return c.isGroup;
    case "all_dms":
      return !c.isGroup;
    case "all":
      return true;
  }
}

function inWindow(hour: number, w: { from_hour: number; to_hour: number }): boolean {
  const f = w.from_hour, t = w.to_hour;
  if (f === t) return true;
  return f < t ? hour >= f && hour < t : hour >= f || hour < t;
}

function conditionsMatch(r: ReplyRule, c: MessageContext): boolean {
  const k = r.conditions;
  if (!k) return true;
  if (k.keywords_any?.length) {
    const t = c.text.toLowerCase();
    if (!k.keywords_any.some((w) => w && t.includes(w.toLowerCase()))) return false;
  }
  if (k.mention_only && !c.mentioned) return false;
  if (k.unless_mentioned && c.mentioned) return false;
  if (k.time && !inWindow(istHour(c.now), k.time)) return false;
  if (k.categories?.length && !k.categories.includes(c.category)) return false;
  return true;
}

export function specificity(r: ReplyRule): number {
  const k = r.conditions ?? {};
  const n = (k.keywords_any?.length ? 1 : 0) + (k.mention_only || k.unless_mentioned ? 1 : 0) + (k.time ? 1 : 0) + (k.categories?.length ? 1 : 0);
  return SUBJECT_WEIGHT[r.subject_type] + 5 * n;
}

export interface RuleMatch {
  rule: ReplyRule;
  effect: "always" | "never";
}

/**
 * The winning rule for a message, or null. Most specific wins (contact > group > relation >
 * all_groups/all_dms > all; each condition adds weight); ties go to the newest rule.
 * An "only" rule acts as "always" for its subject and as a weak "never" (below "all") for everything else.
 */
export function matchRule(rules: readonly ReplyRule[], c: MessageContext): RuleMatch | null {
  const cands: Array<{ m: RuleMatch; w: number; ts: number }> = [];
  for (const r of rules) {
    if (!ruleActive(r, c.now) || !conditionsMatch(r, c)) continue;
    if (subjectMatches(r, c)) cands.push({ m: { rule: r, effect: r.effect === "never" ? "never" : "always" }, w: specificity(r), ts: r.created_at });
    else if (r.effect === "only") cands.push({ m: { rule: r, effect: "never" }, w: SUBJECT_WEIGHT.all - 1, ts: r.created_at });
  }
  cands.sort((a, b) => b.w - a.w || b.ts - a.ts);
  return cands[0]?.m ?? null;
}

// ---- learned score -------------------------------------------------------------------------------------

export const COLD_START = { family: 0.6, work: 0.5, friend: 0.45, unknown: 0.3, group: 0.1, group_mentioned: 0.4 } as const;
export const SHOW_THRESHOLD = 0.35;
export const K_SUBJECT = 3;
export const K_RELATION = 5;
export const K_GLOBAL = 10;
export const HALF_LIFE_MS = 45 * 86_400_000;
export const EVENT_RETENTION_MS = 120 * 86_400_000;
export const EXPLORE_PER_DAY = 3;
export const EXPLORE_RATE = 0.15;
export const EXPLORE_BAND = 0.27;

const shrink = (c: Counts, prior: number, k: number) => (c.pos + k * prior) / (c.pos + c.neg + k);

/**
 * Learned "wants reply cards here" rate, pooled: subject → relation → global → cold-start default.
 * Groups: the learned rate is anchored at the mentioned default; an unmentioned message scales it
 * by group / group_mentioned (0.25), so learning carries over while chatter stays quiet.
 */
export function learnedRate(
  ctx: Pick<MessageContext, "isGroup" | "relation" | "mentioned">,
  s: { global: Counts; relation: Counts; subject: Counts },
): number {
  const cold = ctx.isGroup ? COLD_START.group_mentioned : COLD_START[ctx.relation];
  const g = shrink(s.global, cold, K_GLOBAL);
  const r = ctx.isGroup ? g : shrink(s.relation, g, K_RELATION);
  const sub = shrink(s.subject, r, K_SUBJECT);
  const scale = ctx.isGroup && !ctx.mentioned ? COLD_START.group / COLD_START.group_mentioned : 1;
  return clamp(sub * scale, 0, 1);
}

/** Final show score: geometric mean of the learned rate and the message's reply-likelihood. */
export function showScore(rate: number, pReply: number): number {
  return Math.sqrt(clamp(rate, 0, 1) * clamp(pReply, 0, 1));
}

// ---- decision --------------------------------------------------------------------------------------------

export interface DecideInput {
  ctx: MessageContext;
  rules: readonly ReplyRule[];
  stats: { global: Counts; relation: Counts; subject: Counts };
  /** recent outcomes for this subject (raw counts, newest window) for the `why` line */
  history: { used: number; total: number };
  pReply: number;
  names: { contact: string; group: string | null };
  explore: { usedToday: number; roll: number };
}

export interface ReplyDecision {
  show: boolean;
  exploration: boolean;
  reason: "rule_always" | "rule_never" | "nothing_to_reply" | "learned" | "explore" | "low_score";
  score: number;
  rate: number;
  why: string;
  rule: ReplyRule | null;
}

export function decideReplyCard(i: DecideInput): ReplyDecision {
  const { ctx } = i;
  const nothing = ctx.category === "ack" || ctx.category === "automated";
  const m = matchRule(i.rules, ctx);
  const rate = learnedRate(ctx, i.stats);
  const score = showScore(rate, i.pReply);
  const base = { score: round3(score), rate: round3(rate), rule: m?.rule ?? null, exploration: false };
  if (m?.effect === "never") return { ...base, show: false, reason: "rule_never", why: "" };
  if (m?.effect === "always") {
    if (nothing) return { ...base, show: false, reason: "nothing_to_reply", why: "" };
    return { ...base, show: true, reason: "rule_always", why: ruleWhy(m.rule) };
  }
  if (nothing) return { ...base, show: false, reason: "nothing_to_reply", why: "" };
  if (score >= SHOW_THRESHOLD) return { ...base, show: true, reason: "learned", why: learnedWhy(i) };
  if (!ctx.isGroup && score >= EXPLORE_BAND && i.explore.usedToday < EXPLORE_PER_DAY && i.explore.roll < EXPLORE_RATE) {
    return { ...base, show: true, exploration: true, reason: "explore", why: "Trying a suggestion here to learn what you like" };
  }
  return { ...base, show: false, reason: "low_score", why: "" };
}

function ruleWhy(r: ReplyRule): string {
  if (r.source === "migrated") return `You kept reply suggestions on for ${r.subject_label}`;
  return r.effect === "only" ? `You asked for reply suggestions only for ${r.subject_label}` : `You asked me to always suggest replies for ${r.subject_label}`;
}

function learnedWhy(i: DecideInput): string {
  const who = i.ctx.isGroup ? (i.names.group ?? "this group") : i.names.contact;
  if (i.history.total >= 3) return `You used ${i.history.used} of your last ${i.history.total} suggestions for ${who}`;
  if (i.ctx.isGroup) return `You were mentioned in ${who}`;
  const asks = i.ctx.category === "question" ? "asked you something" : i.ctx.category === "request" ? "asked you for something" : "seems to want a reply";
  const rel = i.ctx.relation === "unknown" ? "" : i.ctx.relation === "friend" ? " (friend)" : ` (${i.ctx.relation})`;
  return `${i.names.contact}${rel} ${asks}`;
}

/**
 * Quick actions on a card (PROTOCOL §5). They send `verdict: "never"` with the matching scope.
 * On a group card "Not for <name>" covers that person's messages in groups only, never their DMs.
 */
export function quickActions(isGroup: boolean, contactName: string, groupName: string | null): Array<{ id: string; label: string }> {
  const out = [{ id: "never_contact", label: `Not for ${contactName}` }];
  if (isGroup) out.push({ id: "never_group", label: `Not in ${groupName ?? "this group"}` });
  return out;
}

export type NewRule = Omit<ReplyRule, "id" | "created_at" | "source" | "utterance" | "expires_at">;

/**
 * The rule a "never" on a card creates, by scope.
 * - no scope: the group for group cards, the contact for DMs
 * - contact: the contact (DM card) / the contact's group messages (group card)
 * - group: the group (falls back to the contact on a DM card)
 * - like_this: same subject as the default, limited to this message category
 */
export function neverRuleFor(
  scope: FeedbackScope | undefined,
  card: { isGroup: boolean; contactKey: string; contactName: string; groupKey: string | null; groupName: string | null; category: string | null },
): NewRule {
  const useContact = scope === "contact" || !card.isGroup || !card.groupKey;
  const cond: RuleConditions = {};
  if (useContact && card.isGroup) cond.chat = "group";
  if (scope === "like_this" && card.category) cond.categories = [card.category];
  const conditions = Object.keys(cond).length ? cond : null;
  if (useContact) return { effect: "never", subject_type: "contact", subject_key: card.contactKey, subject_label: card.contactName, conditions };
  return { effect: "never", subject_type: "group", subject_key: card.groupKey, subject_label: card.groupName ?? card.groupKey!, conditions };
}

// ---- learning ---------------------------------------------------------------------------------------------

export type Outcome = "shown" | "wanted" | "not_now" | "ignored" | "never";

/** Evidence an outcome contributes. Ignoring a card only counts when the user was around to see it. */
export function outcomeEvidence(o: Outcome, active: boolean): Counts {
  switch (o) {
    case "wanted":
      return { pos: 1, neg: 0 };
    case "not_now":
      return { pos: 0, neg: 0.5 };
    case "ignored":
      return { pos: 0, neg: active ? 0.5 : 0 };
    case "never":
      return { pos: 0, neg: 1 };
    default:
      return { pos: 0, neg: 0 };
  }
}

export function decayFactor(ageMs: number): number {
  return Math.pow(0.5, Math.max(0, ageMs) / HALF_LIFE_MS);
}

/** Counts stored as of `fromTs`, faded to `now`. */
export function decayed(c: Counts, fromTs: number, now: number): Counts {
  const f = decayFactor(now - fromTs);
  return { pos: c.pos * f, neg: c.neg * f };
}

export interface EventRow {
  subject_key: string;
  relation_key: string;
  is_group: number | boolean;
  outcome: string;
  active: number | boolean;
  ts: number;
}

/** Rebuild every stats key (subject, relation, global) from the event log with time decay. */
export function recomputeStats(events: readonly EventRow[], now: number): Map<string, Counts> {
  const out = new Map<string, Counts>();
  for (const e of events) {
    const ev = outcomeEvidence(e.outcome as Outcome, !!e.active);
    if (!ev.pos && !ev.neg) continue;
    const f = decayFactor(now - e.ts);
    for (const k of [e.subject_key, e.relation_key, globalKey(!!e.is_group)]) {
      const c = out.get(k) ?? { pos: 0, neg: 0 };
      c.pos += ev.pos * f;
      c.neg += ev.neg * f;
      out.set(k, c);
    }
  }
  return out;
}

// ---- time helpers -------------------------------------------------------------------------------------------

/** Next IST midnight after `now`. */
export function endOfIstDay(now: number): number {
  const d = new Date(now + IST_OFFSET_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - IST_OFFSET_MS;
}

export function istDayKey(now: number): string {
  return new Date(now + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// ---- natural-language rules (regex fallback; the model parse maps onto the same shape) ------------------

export type Target =
  | { type: "all" | "all_groups" | "all_dms" }
  | { type: "relation"; relation: RelationBucket; word: string }
  | { type: "name"; name: string; hint: "contact" | "group" | null };

export type ParsedCommand =
  | { kind: "rule"; effect: RuleEffect; target: Target; conditions: RuleConditions | null; expires_at: number | null }
  | { kind: "relation"; name: string; relation: RelationBucket };

/** Mentions reply cards specifically (not just any "options" / "suggest"). */
const REPLY_NOUN_RE = /\b(?:repl(?:y|ies)\s+(?:suggest\w*|options?|cards?|drafts?|ideas?)|replies|reply\s+(?:mat|nahi|nahin|na)\b|suggest\w*\s+(?:a\s+)?repl\w*|(?:reply|draft)\s+cards?|reply\s+drafts?|reply\s+dikha\w*|dikha\w*)\b/i;
const STRONG_REPLY_RE = /\brepl(?:y|ies)\b/i;
const NEG_RE = /\b(never|don'?t|dont|do not|stop|no|not|mat|nahi|nahin|na|band|without|mute)\b/i;
const ONLY_RE = /\b(only|sirf|bas)\b/i;
const POS_RE = /\b(always|hamesha|every time|har baar|show|keep|dikha\w*|suggest)\b/i;

/** Cheap prefilter: could this utterance be a reply-card rule or a relation statement? */
export function looksLikeReplyCommand(text: string): boolean {
  return (REPLY_NOUN_RE.test(text) && (NEG_RE.test(text) || ONLY_RE.test(text) || /\b(always|hamesha|har baar)\b/i.test(text))) || !!parseRelationStatement(text);
}

const REL_WORDS: Array<[RegExp, RelationBucket]> = [
  [/^(?:my\s+)?(?:family|ghar(?:\s+wale|\s+waalo?n?)?|family\s+(?:members|people|log))$/i, "family"],
  [/^(?:my\s+)?(?:work|office|colleagues|coworkers|co-workers|work\s+(?:people|contacts|log)|people\s+(?:from|at)\s+(?:work|office)|office\s+(?:people|log|wale))$/i, "work"],
  [/^(?:my\s+)?(?:friends|dost(?:on)?|friends\s+log)$/i, "friend"],
];

function relationWord(name: string): RelationBucket | null {
  for (const [re, r] of REL_WORDS) if (re.test(name.trim())) return r;
  return null;
}

/** "Priya is from work", "Priya office se hai", "Rahul is my friend" → relation statement. */
export function parseRelationStatement(text: string): { name: string; relation: RelationBucket } | null {
  const t = text.trim().replace(/[.!]+$/, "");
  const pats: Array<[RegExp, (m: RegExpMatchArray) => RelationBucket]> = [
    [/^(.{1,40}?)\s+(?:is|'s)\s+(?:from|at)\s+(?:my\s+)?(?:work|office|the office)$/i, () => "work"],
    [/^(.{1,40}?)\s+is\s+(?:my\s+|a\s+)?(?:colleague|coworker|co-worker|boss|manager|teammate|client)$/i, () => "work"],
    [/^(.{1,40}?)\s+is\s+(?:my\s+|a\s+)?(?:friend|buddy|bestie|best friend)$/i, () => "friend"],
    [/^(.{1,40}?)\s+is\s+(?:my\s+)?(?:family|mom|mother|dad|father|sister|brother|cousin|aunt|uncle|wife|husband|son|daughter)$/i, () => "family"],
    [/^(.{1,40}?)\s+(?:mere\s+|meri\s+)?(?:office|kaam|work)\s+(?:se|wali|wala|ki|ka|mein|me)\s+(?:hai|h|he)$/i, () => "work"],
    [/^(.{1,40}?)\s+(?:meri|mera|mere)\s+(?:dost|friend)\s+(?:hai|h|he)$/i, () => "friend"],
    [/^(.{1,40}?)\s+(?:family|ghar)\s+(?:se|ki|ka|wali|wala)?\s*(?:hai|h|he)$/i, () => "family"],
  ];
  for (const [re, rel] of pats) {
    const m = t.match(re);
    if (!m) continue;
    const name = cleanName(m[1]!);
    if (!name || /^(it|this|that|he|she|they|there|what|who|which|reply|replies)\b/i.test(name) || REPLY_NOUN_RE.test(name)) return null;
    return { name, relation: rel(m) };
  }
  return null;
}

function cleanName(s: string): string {
  return s
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/^(?:the|to|for|from|in)\s+/i, "")
    .replace(/(?:'s|’s)?\s+(?:messages?|chats?|texts?)$/i, "")
    .replace(/\s+(?:ke|ki|ka)\s+(?:messages?|chats?)$/i, "")
    .replace(/\s+chat$/i, "")
    .trim();
}

function parseHour(n: string, ampm?: string): number {
  let h = Number(n) % 24;
  if (ampm?.toLowerCase() === "pm" && h < 12) h += 12;
  if (ampm?.toLowerCase() === "am" && h === 12) h = 0;
  return h;
}

/** Regex parser for reply-card commands in English and Hinglish. Returns null when it isn't one. */
export function parseReplyCommand(text: string, now: number): ParsedCommand | null {
  const rel = parseRelationStatement(text);
  if (rel) return { kind: "relation", ...rel };
  if (!REPLY_NOUN_RE.test(text)) return null;
  let t = ` ${text.trim().replace(/[.!?]+$/, "")} `;

  // effect
  const effect: RuleEffect | null = NEG_RE.test(t) ? "never" : ONLY_RE.test(t) ? "only" : POS_RE.test(t) ? "always" : null;
  if (!effect) return null;

  // duration
  let expires_at: number | null = null;
  const take = (re: RegExp, f: (m: RegExpMatchArray) => void) => {
    const m = t.match(re);
    if (m) {
      f(m);
      t = t.replace(re, " ");
    }
  };
  take(/\b(?:for\s+)?(?:today|tonight|the rest of the day|aaj(?:\s+ke\s+liye)?|aaj\s+bhar)\b/i, () => (expires_at = endOfIstDay(now)));
  take(/\bfor\s+(?:the\s+next\s+)?(\d{1,3}|an?|one)\s+(?:hours?|hrs?)\b|\b(\d{1,3})\s+ghante?\b/i, (m) => {
    const n = m[1] ? (/^\d+$/.test(m[1]) ? Number(m[1]) : 1) : Number(m[2]);
    expires_at = now + clamp(n, 1, 24 * 30) * 3600_000;
  });
  take(/\b(?:for\s+)?(?:this|a|one)\s+week\b|\bis\s+hafte\b|\bek\s+hafte?\b/i, () => (expires_at = now + 7 * 86_400_000));

  // conditions
  const cond: RuleConditions = {};
  take(/\bunless\s+(?:i'?m|i am)\s+(?:mentioned|tagged)\b|\bjab\s+tak\s+(?:mujhe\s+)?(?:tag|mention)\s+na\b/i, () => (cond.unless_mentioned = true));
  take(/\b(?:only\s+)?when\s+(?:i'?m|i am)\s+(?:mentioned|tagged)\b|\bjab\s+(?:mujhe\s+)?(?:tag|mention)\s+(?:karein|kare|karo|ho)\b/i, () => (cond.mention_only = true));
  take(/\bbetween\s+(\d{1,2})\s*(am|pm)?\s+(?:and|to|-)\s+(\d{1,2})\s*(am|pm)?\b/i, (m) => (cond.time = { from_hour: parseHour(m[1]!, m[2] ?? m[4]), to_hour: parseHour(m[3]!, m[4]) }));
  take(/\bafter\s+(\d{1,2})\s*(am|pm)?\b/i, (m) => (cond.time = { from_hour: parseHour(m[1]!, m[2] ?? "pm"), to_hour: 6 }));
  take(/\b(?:at\s+night|raat\s+(?:ko|mein|me))\b/i, () => (cond.time = { from_hour: 22, to_hour: 7 }));
  take(/\b(?:about|mentioning|with the word)\s+["“']([^"”']{2,30})["”']/i, (m) => (cond.keywords_any = [m[1]!.trim().toLowerCase()]));

  // subject
  const target = extractTarget(t);
  // A bare "mat dikhana" with no subject is too vague to become a rule about everyone.
  if (!target || (target.type === "all" && !STRONG_REPLY_RE.test(text) && !ALL_WORD_RE.test(text))) return null;
  return { kind: "rule", effect, target, conditions: Object.keys(cond).length ? cond : null, expires_at };
}

const STOP = "(?:today|aaj|for\\s+\\d|until|till|when|after|between|unless|only|anymore|any\\s+more|again|ever|please|pls|plz|at\\s+night|ko|ke\\s+liye|mein|me|mat|hamesha|now|from\\s+now)";

const ALL_WORD_RE = /\b(?:everyone|everybody|anyone|anybody|all|any\s+chat|sab|sabko|sabke|kisi|koi)\b/i;

function extractTarget(t: string): Target | null {
  // "<name> group" / "groups"
  const g = t.match(/(?:^|\s)(?:for|in|to|from|on)?\s*(?:the\s+|my\s+)?([\p{L}\p{N}'’&.-]+(?:\s+[\p{L}\p{N}'’&.-]+){0,3}?)\s+groups?\b/iu);
  const allGroups = /\b(?:all|any|every|kisi\s+bhi|sab(?:hi)?|these)\s+groups?\b|\b(?:in|for)\s+groups\b|^\s*groups?\b/i;
  if (allGroups.test(t)) return { type: "all_groups" };
  if (g) {
    const words = g[1]!.split(/\s+/).filter((w) => !/^(repl(y|ies)|suggest\w*|drafts?|cards?|options?|show|me|any|no|never|don'?t|stop|the|in|for|mat|always)$/i.test(w));
    const name = cleanName(words.slice(-3).join(" "));
    if (name && !/^(all|any|every|sab|sabhi)$/i.test(name)) return { type: "name", name, hint: "group" };
    return { type: "all_groups" };
  }
  if (/\b(?:dms?|direct\s+messages?|personal\s+chats?|private\s+chats?|one[- ]on[- ]one)\b/i.test(t)) return { type: "all_dms" };

  // English: preposition + name
  const en = t.match(new RegExp(`\\b(?:for|to|from|with|in)\\s+(.+?)(?=\\s+${STOP}\\b|\\s*[,;]|\\s*$)`, "i"));
  // Hinglish: "<name> ko / ke liye / ke messages / mein ..."
  const hi = t.match(/^\s*(.+?)\s+(?:ko|ke\s+liye|ke\s+messages?\s+(?:pe|par|mein|me)|(?:pe|par)|mein|me)\b/i);
  const raw = en?.[1] ?? hi?.[1] ?? null;
  if (!raw) return { type: "all" };
  let name = cleanName(raw.replace(/^(?:me\s+)?(?:reply\s+)?(?:options|suggestions|replies|drafts|cards)\s+(?:for|to)\s+/i, ""));
  // strip leading verbs/nouns that slipped into the Hinglish capture
  name = name.replace(/^(?:please|pls|plz|ab|abhi|kabhi\s+bhi)\s+/i, "").trim();
  if (!name || REPLY_NOUN_RE.test(name) && name.split(/\s+/).length > 2) return { type: "all" };
  if (/^(?:everyone|everybody|anyone|anybody|all|all\s+chats|sab|sabko|sabke|kisi(?:\s+ko)?(?:\s+bhi)?)$/i.test(name)) return { type: "all" };
  const r = relationWord(name);
  if (r) return { type: "relation", relation: r, word: name.replace(/^my\s+/i, "") };
  return { type: "name", name: name.replace(/^my\s+/i, (m) => (/^my\s+(mom|dad|mum|mother|father)/i.test(name) ? "" : m)).trim(), hint: null };
}

// ---- model parse (JSON) ----------------------------------------------------------------------------------

export const RULE_PARSE_PROMPT =
  'You turn a user\'s instruction about WhatsApp reply suggestions (reply cards) into JSON. The text may be English or Hinglish ("mat" = don\'t, "aaj ke liye" = for today, "dikhana" = show, "hamesha" = always, "sirf" = only). ' +
  'Reply ONLY with JSON: {"is_rule": boolean, "kind": "rule"|"relation", "effect": "always"|"never"|"only", "target": {"type": "contact"|"group"|"relation"|"all"|"all_groups"|"all_dms", "name": string|null, "relation": "family"|"work"|"friend"|null}, "duration": "today"|"hours"|"week"|null, "hours": number|null, "mention_only": boolean, "keywords": [string], "from_hour": number|null, "to_hour": number|null}. ' +
  'kind "relation" means the user is telling you who someone is (e.g. "Priya is from work"): put the person in target.name and the relation in target.relation. is_rule=false if the text is not about reply suggestions or relations.';

export function buildRuleParseMessages(text: string): Array<{ role: "system" | "user"; content: string }> {
  return [
    { role: "system", content: RULE_PARSE_PROMPT },
    { role: "user", content: text.slice(0, 500) },
  ];
}

const EFFECTS: readonly RuleEffect[] = ["always", "never", "only"];

/**
 * Validate the model's JSON. Returns the command, "not_rule" when the model says it isn't one,
 * or null when the output is unusable (→ regex fallback).
 */
export function parseModelCommand(j: Record<string, unknown> | null, now: number): ParsedCommand | "not_rule" | null {
  if (!j || typeof j.is_rule !== "boolean") return null;
  if (!j.is_rule) return "not_rule";
  const tg = (j.target && typeof j.target === "object" ? j.target : {}) as Record<string, unknown>;
  const name = typeof tg.name === "string" ? cleanName(tg.name).slice(0, 60) : "";
  const relRaw = typeof tg.relation === "string" ? tg.relation.toLowerCase() : "";
  const relation: RelationBucket | null = relRaw === "family" || relRaw === "work" || relRaw === "friend" ? relRaw : null;
  if (j.kind === "relation") return name && relation ? { kind: "relation", name, relation } : null;
  const effect = EFFECTS.find((e) => e === j.effect);
  if (!effect) return null;
  let target: Target;
  switch (tg.type) {
    case "all":
    case "all_groups":
    case "all_dms":
      target = { type: tg.type };
      break;
    case "relation":
      if (!relation) return null;
      target = { type: "relation", relation, word: name || relation };
      break;
    case "contact":
    case "group":
      if (!name) return null;
      target = { type: "name", name, hint: tg.type };
      break;
    default:
      return null;
  }
  let expires_at: number | null = null;
  if (j.duration === "today") expires_at = endOfIstDay(now);
  else if (j.duration === "week") expires_at = now + 7 * 86_400_000;
  else if (j.duration === "hours" && typeof j.hours === "number" && j.hours > 0) expires_at = now + clamp(j.hours, 1, 24 * 30) * 3600_000;
  const cond: RuleConditions = {};
  if (j.mention_only === true) cond.mention_only = true;
  if (Array.isArray(j.keywords)) {
    const kw = j.keywords.filter((k): k is string => typeof k === "string" && k.trim().length > 1).map((k) => k.trim().toLowerCase().slice(0, 30)).slice(0, 5);
    if (kw.length) cond.keywords_any = kw;
  }
  if (typeof j.from_hour === "number" && typeof j.to_hour === "number") cond.time = { from_hour: Math.trunc(clamp(j.from_hour, 0, 23)), to_hour: Math.trunc(clamp(j.to_hour, 0, 24)) % 24 };
  return { kind: "rule", effect, target, conditions: Object.keys(cond).length ? cond : null, expires_at };
}

// ---- name resolution -----------------------------------------------------------------------------------------

export interface NameCandidate {
  type: "contact" | "group";
  key: string;
  label: string;
}

export type Resolution = { kind: "one"; c: NameCandidate; known: boolean } | { kind: "ambiguous"; options: NameCandidate[] };

const normKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 100);

/** Resolve a spoken name against known contacts and seen chats/groups. Unknown names resolve to themselves. */
export function resolveName(name: string, hint: "contact" | "group" | null, cands: readonly NameCandidate[]): Resolution {
  const q = normKey(name.replace(/^my\s+/i, ""));
  const pool = hint ? cands.filter((c) => c.type === hint) : cands;
  const uniq = (xs: NameCandidate[]) => [...new Map(xs.map((c) => [`${c.type}|${c.key}`, c])).values()];
  const exact = uniq(pool.filter((c) => c.key === q));
  if (exact.length === 1) return { kind: "one", c: exact[0]!, known: true };
  if (exact.length > 1) return { kind: "ambiguous", options: exact.slice(0, 3) };
  const partial = uniq(pool.filter((c) => c.key.split(" ").includes(q) || c.key.startsWith(`${q} `) || (q.length >= 4 && c.key.includes(q))));
  if (partial.length === 1) return { kind: "one", c: partial[0]!, known: true };
  if (partial.length > 1) return { kind: "ambiguous", options: partial.slice(0, 3) };
  return { kind: "one", c: { type: hint ?? "contact", key: q, label: name.replace(/^my\s+/i, "").trim() }, known: false };
}

/** Pick one of the offered options from the user's answer ("the group", "2", "Rahul Sharma"). */
export function pickOption(text: string, options: readonly NameCandidate[]): NameCandidate | null {
  const t = normKey(text);
  const n = t.match(/^(\d)\b/);
  if (n) return options[Number(n[1]) - 1] ?? null;
  const byLabel = options.filter((o) => t.includes(o.key));
  if (byLabel.length === 1) return byLabel[0]!;
  const wantsGroup = /\bgroup\b/.test(t);
  const wantsContact = /\b(person|contact|dm|chat with|them|him|her)\b/.test(t);
  if (wantsGroup !== wantsContact) {
    const byType = options.filter((o) => o.type === (wantsGroup ? "group" : "contact"));
    if (byType.length === 1) return byType[0]!;
  }
  return null;
}

/** Short confirmation line for a new rule. */
export function confirmLine(effect: RuleEffect, label: string, subject: SubjectType, expires_at: number | null, now: number): string {
  const where =
    subject === "all" ? "anyone" : subject === "all_groups" ? "any group" : subject === "all_dms" ? "your personal chats" : subject === "group" ? `the ${label} group` : label;
  const when = expires_at == null ? "" : expires_at <= endOfIstDay(now) ? " for today" : expires_at - now <= 36 * 3600_000 ? ` for ${Math.max(1, Math.round((expires_at - now) / 3600_000))} h` : " for a while";
  if (effect === "never") return `Okay, no reply suggestions for ${where}${when}.`;
  if (effect === "only") return `Got it, reply suggestions only for ${where}${when}.`;
  return `Got it, I'll always suggest replies for ${where}${when}.`;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
