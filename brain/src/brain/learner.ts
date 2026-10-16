/** Nightly learner helpers (pure). */
import type { ChatMessage } from "../ai";
import { clamp, truncate } from "../util";
import type { ContextTurn } from "./think";

export interface FeedbackRow {
  kind: string;
  verdict: string;
  draft: string | null;
  final: string | null;
  ts: number;
}

/** Contacts the user interacts with often drift up; quiet ones drift slowly toward their floor. */
export function updatedImportance(old: number, interactions7d: number, approvedReplies7d = 0): number {
  const target = clamp(0.3 + 0.06 * interactions7d + 0.05 * approvedReplies7d, 0, 0.95);
  // Only move up quickly; decay down slowly so family stays important on quiet weeks.
  const rate = target > old ? 0.3 : 0.05;
  return Math.round(clamp(old + (target - old) * rate, 0, 1) * 1000) / 1000;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const FORMAL_RE = /\b(dear|regards|kindly|sincerely|i would like to|please be informed|i shall)\b/i;

/** Derive simple style preferences from reply feedback without a model. */
export function heuristicPreferences(rows: FeedbackRow[]): string[] {
  const drafts = rows.filter((r) => r.kind === "whatsapp.reply" && r.draft);
  const out: string[] = [];
  const edited = drafts.filter((r) => r.verdict === "approve" && r.final && r.final !== r.draft);
  const shorter = edited.filter((r) => r.final!.length < r.draft!.length * 0.7);
  if (edited.length >= 3 && shorter.length / edited.length >= 0.6) out.push("User prefers shorter WhatsApp replies than Pixie drafts.");
  const rejected = drafts.filter((r) => r.verdict === "reject" || r.verdict === "never");
  const approved = drafts.filter((r) => r.verdict === "approve");
  if (rejected.length >= 3) {
    const formalRejected = rejected.filter((r) => FORMAL_RE.test(r.draft!)).length;
    if (formalRejected / rejected.length >= 0.5) out.push("User rejects reply drafts that are too formal; keep them casual.");
    if (approved.length >= 2 && avg(rejected.map((r) => r.draft!.length)) > 1.5 * avg(approved.map((r) => r.draft!.length)))
      out.push("User rejects long reply drafts; keep them brief.");
  }
  const calls = rows.filter((r) => r.kind === "call.back");
  if (calls.length >= 5 && calls.filter((r) => r.verdict !== "approve").length / calls.length >= 0.8)
    out.push("User rarely wants call-back suggestions.");
  return out;
}

export function buildLearnerMessages(userName: string, turns: ContextTurn[], feedback: FeedbackRow[]): ChatMessage[] {
  const transcript = turns
    .slice(-120)
    .map((t) => `${t.role === "pixie" ? "Pixie" : t.role === "user" ? userName || "User" : "Event"}: ${truncate(t.text, 200)}`)
    .join("\n");
  const fb = feedback
    .filter((f) => f.draft)
    .slice(-30)
    .map((f) => `${f.verdict}: "${truncate(f.draft!, 120)}"${f.final && f.final !== f.draft ? ` -> edited to "${truncate(f.final, 120)}"` : ""}`)
    .join("\n");
  return [
    {
      role: "system",
      content:
        "You consolidate a desktop companion's memory at the end of the day. From today's conversation log write 1-3 short episode memories (third person about the user, one sentence each, concrete and useful later; skip trivia). From the reply-draft feedback, infer up to 2 preferences about how the user likes replies written (only if clearly supported). Never include passwords, codes, numbers or message contents verbatim. Return ONLY JSON: {\"episodes\": [string], \"preferences\": [string]}",
    },
    { role: "user", content: `Today's log:\n${transcript || "(empty)"}\n\nReply-draft feedback:\n${fb || "(none)"}` },
  ];
}

export function parseLearnerOutput(j: Record<string, unknown> | null): { episodes: string[]; preferences: string[] } {
  const list = (x: unknown, n: number) =>
    Array.isArray(x)
      ? x.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter((s) => s.length >= 8 && s.length <= 300).slice(0, n)
      : [];
  return { episodes: list(j?.episodes, 3), preferences: list(j?.preferences, 2) };
}
