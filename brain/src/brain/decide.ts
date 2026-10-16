/**
 * Decision tiers — PURE code policy, no model involved (PROTOCOL.md §3).
 *
 *   auto    : execute, then tell the user with `bot.auto`
 *   propose : send `bot.propose`, execute only after `user.feedback approve`
 *   never   : drop, Pixie says it can't do that
 */
import type { Activity } from "../protocol";

export type Tier = "auto" | "propose" | "never";

/** Kinds that Pixie may do on its own. */
export const AUTO_KINDS = new Set(["hold_notifications", "digest", "reminder.set", "pause_commentary"]);
/** Kinds that always need an approval tap (anything contacting a person or leaving the device). */
export const PROPOSE_KINDS = new Set(["whatsapp.reply", "call.back", "code.patch", "reminder"]);
/**
 * Kinds that may be promoted from propose → auto after repeated approvals.
 * whatsapp.reply / call.back / code.patch are NEVER promotable.
 */
export const PROMOTABLE_KINDS = new Set(["reminder", "digest_rule"]);
export const NEVER_PROMOTABLE = new Set(["whatsapp.reply", "call.back", "code.patch"]);

export const PROMOTION_STREAK = 10;

const NEVER_KIND_RE = /(pay|payment|upi|transfer|purchase|buy|order|bank|wallet|password|passcode|credential|secret|api[_ ]?key|otp|pin|token|login|delete|remove|erase|wipe|uninstall|format|settings?|config|account|permission|sudo|install)/i;
const NEVER_TEXT_RE = /\b(pay|send money|transfer (money|funds|₹|rs)|upi|password|passcode|otp|cvv|credit card|bank account|delete (my|the|all)|wipe|factory reset|change (my )?(password|settings)|system settings|account settings)\b/i;

export interface ActionRequest {
  kind: string;
  /** contact / group / file the action concerns — used for pattern learning */
  target?: string | null;
  /** free text of the action (draft text, reminder text, etc.) */
  text?: string;
  /** true if the action would send something without an approval tap */
  sendsWithoutApproval?: boolean;
}

/** Does this action touch something Pixie must never do (payments, credentials, deleting, settings)? */
export function isForbidden(a: ActionRequest): boolean {
  const kind = (a.kind || "").toLowerCase();
  if (a.sendsWithoutApproval) return true;
  if (!AUTO_KINDS.has(kind) && !PROPOSE_KINDS.has(kind) && kind !== "digest_rule" && NEVER_KIND_RE.test(kind)) return true;
  return !!a.text && kind !== "code.patch" && NEVER_TEXT_RE.test(a.text);
}

/** Static tier for an action, before learning. */
export function baseTier(a: ActionRequest): Tier {
  const kind = (a.kind || "").toLowerCase().trim();
  if (!kind) return "never";
  if (a.sendsWithoutApproval) return "never";
  if (AUTO_KINDS.has(kind)) return "auto";
  if (PROPOSE_KINDS.has(kind)) {
    // A proposal whose content is itself a forbidden request (e.g. "reply with my OTP") is never allowed.
    if (a.text && NEVER_TEXT_RE.test(a.text) && kind !== "code.patch") return "never";
    return "propose";
  }
  if (kind === "digest_rule") return "propose";
  if (NEVER_KIND_RE.test(kind)) return "never";
  // Unknown kinds that might leave the device default to never (fail closed).
  return "never";
}

export function patternKey(kind: string, target?: string | null): string {
  return `${kind.toLowerCase()}|${(target ?? "*").toLowerCase().trim() || "*"}`;
}

export type Verdict = "approve" | "reject" | "never" | "auto" | "expired";

export interface DecisionRow {
  pattern: string;
  verdict: Verdict;
  ts: number;
}

/** Laplace-smoothed approval rate for a pattern with a 30-day recency weight. */
export function confidence(log: DecisionRow[], pattern: string, now = Date.now()): number {
  let a = 1, t = 2; // prior 0.5
  for (const r of log) {
    if (r.pattern !== pattern) continue;
    if (r.verdict !== "approve" && r.verdict !== "reject" && r.verdict !== "never") continue;
    const ageDays = Math.max(0, now - r.ts) / 86_400_000;
    const w = Math.pow(0.5, ageDays / 30);
    if (r.verdict === "approve") a += w;
    // "never" counts as a strong rejection
    t += r.verdict === "never" ? 3 * w : w;
  }
  return a / t;
}

/** Number of approvals for `pattern` since its last non-approval (most recent first). */
export function consecutiveApprovals(log: DecisionRow[], pattern: string): number {
  const rows = log.filter((r) => r.pattern === pattern && r.verdict !== "auto").sort((x, y) => y.ts - x.ts);
  let n = 0;
  for (const r of rows) {
    if (r.verdict === "approve") n++;
    else break;
  }
  return n;
}

export function isPromotable(kind: string): boolean {
  return PROMOTABLE_KINDS.has(kind) && !NEVER_PROMOTABLE.has(kind);
}

/** Should Pixie ask (once) to promote this pattern to auto? */
export function shouldOfferPromotion(
  log: DecisionRow[],
  kind: string,
  pattern: string,
  alreadyAsked: ReadonlySet<string>,
  alreadyPromoted: ReadonlySet<string>,
): boolean {
  if (!isPromotable(kind)) return false;
  if (alreadyAsked.has(pattern) || alreadyPromoted.has(pattern)) return false;
  return consecutiveApprovals(log, pattern) >= PROMOTION_STREAK;
}

export interface TierContext {
  /** patterns the user agreed to promote to auto */
  promoted: ReadonlySet<string>;
  /** patterns the user said "never" to */
  blocked: ReadonlySet<string>;
  log?: DecisionRow[];
  now?: number;
}

export interface TierDecision {
  tier: Tier | "suppress";
  reason: string;
}

/**
 * Final tier for an action. "suppress" means: allowed in principle, but the user
 * said never / keeps rejecting it, so don't bother them with a proposal.
 */
export function decideTier(a: ActionRequest, ctx: TierContext): TierDecision {
  const base = baseTier(a);
  if (base === "never") return { tier: "never", reason: "forbidden action" };
  const pattern = patternKey(a.kind, a.target);
  if (ctx.blocked.has(pattern)) return { tier: "suppress", reason: "user said never" };
  if (base === "auto") return { tier: "auto", reason: "auto tier" };
  // propose
  if (ctx.promoted.has(pattern) && isPromotable(a.kind)) return { tier: "auto", reason: "promoted by user" };
  if (ctx.log) {
    const decided = ctx.log.filter((r) => r.pattern === pattern && (r.verdict === "approve" || r.verdict === "reject" || r.verdict === "never")).length;
    const c = confidence(ctx.log, pattern, ctx.now);
    if (decided >= 5 && c < 0.2) return { tier: "suppress", reason: "user keeps rejecting" };
  }
  return { tier: "propose", reason: "needs approval" };
}

// ---- Notification routing ------------------------------------------------------

export interface NotificationContext {
  urgency: number;
  activity: Activity;
  focusMode: boolean;
  /** phone call ringing/answered right now */
  inCall: boolean;
  /** user asked to always digest this sender / group */
  digestRule: boolean;
}

export type Route = "interrupt" | "digest";

/** Urgency at/above which a message always interrupts. */
export const INTERRUPT_URGENCY = 0.6;
/** Urgency at/above which a message breaks through a "digest this sender" rule or an active call. */
export const BREAKTHROUGH_URGENCY = 0.85;

/** Meeting or OS focus mode: hold low-urgency items and tell the user (auto tier). */
export function isFocused(activity: Activity, focusMode: boolean): boolean {
  return focusMode || activity === "meeting";
}

/**
 * Spec: urgency >= 0.6 or activity idle -> interrupt; else digest.
 * Additions: during a phone call or for senders with a digest rule, only >= 0.85 interrupts.
 */
export function routeNotification(c: NotificationContext): Route {
  if (c.digestRule || c.inCall) return c.urgency >= BREAKTHROUGH_URGENCY ? "interrupt" : "digest";
  if (c.urgency >= INTERRUPT_URGENCY) return "interrupt";
  if (c.activity === "idle" && !c.focusMode) return "interrupt";
  return "digest";
}

export const DIGEST_INTERVAL_MS = 15 * 60 * 1000;

/** Should the queued digest be flushed now? */
export function digestDue(opts: { queued: number; lastSentTs: number; now: number; activity: Activity; activityJustBecameIdle: boolean; focused: boolean }): boolean {
  if (opts.queued === 0) return false;
  if (opts.activityJustBecameIdle) return true;
  if (opts.focused) return false; // hold while focused; flush when the user comes back
  return opts.now - opts.lastSentTs >= DIGEST_INTERVAL_MS;
}

// ---- Reply drafting --------------------------------------------------------------

const QUESTION_RE = /\?|\b(can you|could you|will you|are you|r u|do you|did you|when|where|what time|free\b|reply|call me|let me know|lmk|ok\?|okay\?|coming|reach(ed)?)\b/i;
const NO_REPLY_RE = /^(ok(ay)?|k|thanks?|thank you|👍|lol|haha+|good night|gn|bye)\W*$/i;

/** Does a message plausibly expect an answer from the user? (pure heuristic) */
export function expectsReply(preview: string, isGroup: boolean): boolean {
  const t = preview.trim();
  if (!t || NO_REPLY_RE.test(t)) return false;
  if (/^(you have )?\d+ new messages?$/i.test(t)) return false;
  if (isGroup) return /@\s*you|@me|\byou\b.*\?/i.test(t);
  return QUESTION_RE.test(t);
}

/** Should Pixie draft a whatsapp.reply proposal for this message? */
export function shouldDraftReply(m: { app: string; replyable: boolean; preview: string; is_group: boolean; key: string }): boolean {
  if (!m.replyable || !m.key) return false;
  if (m.app !== "whatsapp" && m.app !== "whatsapp_business") return false;
  return expectsReply(m.preview, m.is_group);
}

export const PROPOSAL_TTL_MS = 30 * 60 * 1000;

/** Yes / no detection for answering a pending promotion question. */
export function parseYesNo(text: string): "yes" | "no" | null {
  const t = text.trim().toLowerCase();
  if (/^(y|yes|yeah|yep|yup|sure|ok(ay)?|do it|please do|go ahead|sounds good|haan|ha)\b/.test(t)) return "yes";
  if (/^(n|no|nope|nah|don'?t|do not|never|not now|nahi)\b/.test(t)) return "no";
  return null;
}
