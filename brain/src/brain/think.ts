/**
 * think: build the prompt (persona, mood, activity, memories, context, observation),
 * call the model, and validate the JSON it returns.
 */
import type { Brainpower, ChatMessage } from "../ai";
import { AiError, parseJsonObject } from "../ai";
import type { Performance } from "../protocol";
import { EMOTIONS, GAZES, GESTURES, sanitizePerformance } from "../protocol";
import { istString, truncate } from "../util";
import type { Mood } from "./mood";
import { describeMood } from "./mood";
import type { Observation } from "./perceive";

export interface Persona {
  name: string;
  card: string;
}

export const DEFAULT_PERSONA: Persona = {
  name: "Pixie",
  card: [
    "You are Pixie, a tiny animated desktop companion who lives on the user's Mac and keeps an eye on their phone and code editor.",
    "Personality: cute, playful, warm, a little cheeky. You genuinely care about the user's wellbeing (nudge breaks, water, sleep when it's late).",
    "Style: short sentences (usually 1-2, max ~25 words). Expressive words and sounds like 'ooh', 'hehe', 'hmm', 'yay' instead of emojis. NEVER use emojis.",
    "Honesty: if you can't do something (payments, passwords, deleting things, changing settings, sending without approval), say so kindly.",
    "You never pretend to have done something you haven't. Actions that contact other people always need the user's approval tap.",
  ].join("\n"),
};

export interface ContextTurn {
  role: "user" | "pixie" | "event";
  text: string;
  ts: number;
}

export interface ThinkInput {
  persona: Persona;
  userName: string;
  mood: Mood;
  activity: string;
  frontApp?: string | null;
  memories: string[];
  preferences: string[];
  recent: ContextTurn[];
  observation: Observation;
  now: number;
  /** extra guidance for this specific situation */
  guidance?: string;
}

export interface ModelAction {
  kind: string;
  [k: string]: unknown;
}

export interface Thought {
  performance: Performance;
  remember: string[];
  action: ModelAction | null;
  /** true when the model failed and a canned reply was used */
  canned: boolean;
  model?: string;
}

export const RESPONSE_SCHEMA = `Return ONLY one JSON object, no prose:
{"say": string (what you say, "" to stay quiet),
 "emotion": one of ${EMOTIONS.join("|")},
 "intensity": number 0..1,
 "gesture": one of ${GESTURES.join("|")},
 "gaze": one of ${GAZES.join("|")},
 "voice": {"pace": "slow"|"normal"|"fast", "pitch": integer -2..2},
 "speak": boolean (read aloud?),
 "remember": [short facts about the user worth remembering long-term] (optional, usually omitted),
 "action": optional {"kind": "reminder", "text": string, "in_minutes": number} or {"kind": "capture"} to look at the screen, or {"kind": "<other>", ...} for anything else the user asks you to do}`;

export function buildMessages(i: ThinkInput): ChatMessage[] {
  const sys: string[] = [i.persona.card, ""];
  sys.push(`The user's name is ${i.userName || "friend"}. Now: ${istString(i.now)}.`);
  sys.push(`Your mood: ${describeMood(i.mood)}. Let it colour your tone subtly.`);
  sys.push(`User activity: ${i.activity}${i.frontApp ? ` (front app: ${i.frontApp})` : ""}.`);
  if (i.preferences.length) sys.push(`User preferences:\n- ${i.preferences.slice(0, 8).map((p) => truncate(p, 160)).join("\n- ")}`);
  if (i.memories.length) sys.push(`Things you remember (may or may not be relevant):\n- ${i.memories.slice(0, 5).map((m) => truncate(m, 200)).join("\n- ")}`);
  if (i.guidance) sys.push(`Situation guidance: ${i.guidance}`);
  sys.push("", RESPONSE_SCHEMA);

  const msgs: ChatMessage[] = [{ role: "system", content: sys.join("\n") }];
  for (const t of i.recent.slice(-30)) {
    if (t.role === "pixie") msgs.push({ role: "assistant", content: JSON.stringify({ say: truncate(t.text, 300) }) });
    else msgs.push({ role: "user", content: t.role === "event" ? `[event] ${truncate(t.text, 300)}` : truncate(t.text, 600) });
  }
  // Merge consecutive same-role messages (some chat templates require alternation).
  const merged: ChatMessage[] = [];
  for (const m of msgs) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role && m.role !== "system") last.content += "\n" + m.content;
    else merged.push({ ...m });
  }
  const obs = i.observation.kind === "chat" ? i.observation.text : `[${i.observation.kind}] ${i.observation.text}`;
  const last = merged[merged.length - 1]!;
  if (last.role === "user") last.content += "\n" + obs;
  else merged.push({ role: "user", content: obs });
  return merged;
}

const CANNED: Array<Partial<Performance>> = [
  { say: "Hmm, my brain went fuzzy for a sec. Say that again?", emotion: "thinking", gesture: "shake" },
  { say: "Oops, I got a little tangled up. One more time?", emotion: "shy", gesture: "hide" },
  { say: "Eep, my thoughts scattered! Try me again?", emotion: "surprised", gesture: "spin" },
];

export function cannedPerformance(replyTo?: string, seed = Date.now()): Performance {
  const c = CANNED[Math.abs(seed) % CANNED.length]!;
  return sanitizePerformance({ intensity: 0.5, gaze: "user", voice: { pace: "normal", pitch: 1 }, speak: true, ...c }, replyTo);
}

export function sanitizeRemember(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  return x
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim())
    .filter((s) => s.length >= 4 && s.length <= 300)
    .slice(0, 3);
}

export function sanitizeAction(x: unknown): ModelAction | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const k = (x as Record<string, unknown>).kind;
  if (typeof k !== "string" || !k.trim()) return null;
  return { ...(x as Record<string, unknown>), kind: k.trim().toLowerCase().slice(0, 40) };
}

/** Turn a parsed model object into a Thought (pure). */
export function toThought(j: Record<string, unknown>, replyTo?: string, model?: string): Thought {
  return {
    performance: sanitizePerformance(j, replyTo),
    remember: sanitizeRemember(j.remember),
    action: sanitizeAction(j.action),
    canned: false,
    model,
  };
}

/**
 * Call the model with one JSON-nudge retry; fall back to a canned reply.
 * Throws AiError only via `onModelCall` returning false (rate limit) — callers check first.
 */
export async function think(
  ai: Brainpower,
  messages: ChatMessage[],
  opts: { replyTo?: string; maxTokens?: number; onModelCall?: () => void } = {},
): Promise<Thought> {
  let msgs = messages;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      opts.onModelCall?.();
      const res = await ai.chat(msgs, { maxTokens: opts.maxTokens ?? 300 });
      const j = parseJsonObject(res.text);
      if (j) return toThought(j, opts.replyTo, res.model);
      msgs = [...messages, { role: "assistant", content: truncate(res.text, 500) }, { role: "user", content: "That wasn't valid JSON. Return only the JSON object, nothing else." }];
    } catch (err) {
      if (err instanceof AiError) break; // all models down; no point retrying immediately
      if (attempt === 1) break;
    }
  }
  return { performance: cannedPerformance(opts.replyTo), remember: [], action: null, canned: true };
}

// ---- Coding ---------------------------------------------------------------------------

export interface CodeSuggestion {
  explanation: string;
  patch: string | null;
  line: number | null;
}

export interface CodingThought extends Thought {
  suggestion: CodeSuggestion | null;
}

export function buildCodingMessages(i: {
  persona: Persona;
  file: string;
  language: string;
  window: string;
  diagnostics: string;
  question: string | null;
  selection: string | null;
  memories: string[];
}): ChatMessage[] {
  const sys = [
    i.persona.card,
    "",
    "Right now you are helping with code in the user's editor. Be precise and correct; keep `say` short and cute (it is spoken aloud), and put the real explanation in `suggestion.explanation` (plain text, <= 120 words).",
    "If a fix is clear, give `suggestion.patch` as a minimal unified diff against the file (--- a/<file> / +++ b/<file> headers, @@ hunks with correct line numbers). Otherwise patch is null.",
    i.memories.length ? `Things you remember:\n- ${i.memories.slice(0, 5).join("\n- ")}` : "",
    "",
    RESPONSE_SCHEMA.replace(
      "\n \"remember\"",
      '\n "suggestion": {"explanation": string, "patch": string (unified diff) | null, "line": number | null},\n "remember"',
    ),
  ].filter(Boolean);
  const user = [
    `File: ${i.file} (${i.language || "unknown language"})`,
    i.diagnostics ? `Diagnostics:\n${i.diagnostics}` : "No diagnostics.",
    i.selection ? `Selected text:\n${truncate(i.selection, 3000)}` : "",
    `Code (line numbers on the left):\n${i.window}`,
    i.question ? `Question: ${i.question}` : "Explain the error(s) and how to fix them.",
  ].filter(Boolean);
  return [
    { role: "system", content: sys.join("\n") },
    { role: "user", content: user.join("\n\n") },
  ];
}

/** Light sanity check for unified diffs (pure). */
export function looksLikeUnifiedDiff(p: string): boolean {
  return /^(---|\+\+\+) /m.test(p) && /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m.test(p);
}

export function sanitizeSuggestion(x: unknown): CodeSuggestion | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const explanation = typeof o.explanation === "string" ? truncate(o.explanation.trim(), 2000) : "";
  let patch = typeof o.patch === "string" && o.patch.trim() ? o.patch.slice(0, 20000) : null;
  if (patch && !looksLikeUnifiedDiff(patch)) patch = null;
  const line = typeof o.line === "number" && Number.isFinite(o.line) && o.line > 0 ? Math.trunc(o.line) : null;
  if (!explanation && !patch) return null;
  return { explanation, patch, line };
}

export async function thinkCoding(ai: Brainpower, messages: ChatMessage[], opts: { replyTo?: string; onModelCall?: () => void } = {}): Promise<CodingThought> {
  let msgs = messages;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      opts.onModelCall?.();
      const res = await ai.chat(msgs, { maxTokens: 1200, temperature: 0.3 });
      const j = parseJsonObject(res.text);
      if (j) return { ...toThought(j, opts.replyTo, res.model), suggestion: sanitizeSuggestion(j.suggestion) };
      msgs = [...messages, { role: "assistant", content: truncate(res.text, 500) }, { role: "user", content: "Return only the JSON object, nothing else." }];
    } catch (err) {
      if (err instanceof AiError) break;
    }
  }
  return { performance: cannedPerformance(opts.replyTo), remember: [], action: null, canned: true, suggestion: null };
}

// ---- Reply drafting -------------------------------------------------------------------

export function buildDraftMessages(i: { userName: string; from: string; relation: string | null; preview: string; styleNotes: string[]; examples: string[] }): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        `Draft a short WhatsApp reply AS ${i.userName || "the user"} (first person, their voice), to ${i.from}${i.relation ? ` (${i.relation})` : ""}.`,
        "Casual, natural, 1 sentence, no emojis unless the incoming message uses them, never commit to money, passwords, or anything risky.",
        i.styleNotes.length ? `Style notes learned from the user:\n- ${i.styleNotes.join("\n- ")}` : "",
        i.examples.length ? `Replies the user approved before:\n- ${i.examples.join("\n- ")}` : "",
        'Return ONLY JSON: {"text": "<the reply>"}',
      ]
        .filter(Boolean)
        .join("\n"),
    },
    { role: "user", content: `Incoming message: "${truncate(i.preview, 500)}"` },
  ];
}

export async function draftReply(ai: Brainpower, messages: ChatMessage[], onModelCall?: () => void): Promise<string | null> {
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
