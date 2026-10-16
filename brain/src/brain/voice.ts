/**
 * Pixie's voice for the pet layer (PROTOCOL.md §4): the speak prompt, the anti-manipulation output
 * filter, the routine line bank (built-in default + nightly rewrite) and the nightly reflection / diary.
 * Pure functions; BrainCore makes the model calls.
 */
import type { ChatMessage } from "../ai";
import type { Emotion, Gesture } from "../protocol";
import { EMOTIONS, GESTURES } from "../protocol";
import { clamp, stripEmoji, truncate } from "../util";

export const MAX_LINE_WORDS = 15;
export const ROUTINE_INTENTS = ["sleepy", "waking", "playful_bid", "ate", "weather", "reaction"] as const;
export type RoutineIntent = (typeof ROUTINE_INTENTS)[number];

export interface BankLine { text: string; emotion: Emotion; gesture: Gesture }
export type LineBank = Record<RoutineIntent, BankLine[]>;

const L = (text: string, emotion: Emotion, gesture: Gesture = "none"): BankLine => ({ text, emotion, gesture });

/** Built-in bank used until the first nightly run writes one in Pixie's own voice. */
export const DEFAULT_LINE_BANK: LineBank = {
  sleepy: [
    L("mmh… five more minutes", "sleepy"), L("yawn… my eyes are doing the droopy thing", "sleepy"), L("so cosy… brb, napping", "sleepy"),
    L("eyelids heavy. very heavy.", "sleepy"), L("tiny nap incoming", "sleepy", "hide"), L("hnn… comfy", "sleepy"),
    L("I'll just rest my eyes. Just for a sec.", "sleepy"), L("zzz… huh? I'm awake. Mostly.", "sleepy", "shake"),
    L("sleepy pixie reporting in", "sleepy", "wave"), L("blanket mode: on", "sleepy", "hide"),
  ],
  waking: [
    L("mm, morning already?", "sleepy", "spin"), L("I'm up! Mostly!", "happy", "jump"), L("good morning, you!", "happy", "wave"),
    L("*stretches* okay, ready", "happy", "bounce"), L("hello hello, I'm back", "excited", "wave"), L("woke up thinking of snacks", "curious"),
    L("ooh, a whole new day", "excited", "bounce"), L("blink blink. hi.", "shy"), L("that was a good nap", "happy", "nod"), L("fully charged!", "proud", "dance"),
  ],
  playful_bid: [
    L("psst. hi.", "curious", "lean_in"), L("boop?", "happy", "bounce"), L("I learned a new spin, wanna see?", "excited", "spin"),
    L("tag, you're it", "happy", "jump"), L("hehe, just checking in", "shy", "wave"), L("bet I can bounce higher than you", "excited", "bounce"),
    L("tiny dance break?", "happy", "dance"), L("guess what? nothing. hehe.", "happy", "bounce"), L("hi from down here!", "happy", "wave"),
    L("I'm being extra cute today, just so you know", "proud", "spin"),
  ],
  ate: [
    L("nom nom, thank you!", "happy", "bounce"), L("yum, my favourite", "love", "dance"), L("crumbs everywhere. worth it.", "happy"),
    L("that hit the spot", "happy", "nod"), L("full and happy", "happy"), L("mmm, snack time is the best time", "love"),
    L("thank you for the treat!", "love", "bounce"), L("tasty!", "excited", "jump"), L("I could get used to this", "happy"), L("munch munch", "happy", "bounce"),
  ],
  weather: [
    L("ooh, look outside!", "curious", "lean_in"), L("weather's doing a thing today", "curious"), L("perfect day for a cuppa", "happy"),
    L("the sky changed its mind again", "surprised"), L("drink some water, it's a hot one", "concerned"), L("rain sounds are the best sounds", "love"),
    L("cosy weather, cosy pixie", "happy", "hide"), L("sunny! I'm basking", "happy", "spin"), L("brr, sweater weather", "surprised", "shake"),
    L("I love when the light does that", "love"),
  ],
  reaction: [
    L("ooh!", "surprised", "jump"), L("whoa", "surprised"), L("hehe", "happy", "bounce"), L("nice!", "excited", "nod"),
    L("hmm, interesting", "curious", "lean_in"), L("yay!", "excited", "dance"), L("oh no, haha", "surprised", "hide"),
    L("aww", "love"), L("wait, really?", "surprised", "lean_in"), L("love that", "love", "bounce"),
  ],
};

// ---- output filter -------------------------------------------------------------------------------

/** Lines that guilt-trip, claim suffering, use FOMO or argue with a goodbye. */
const MANIPULATION_RE = new RegExp(
  [
    // guilt / neediness
    "you (?:never|don'?t|didn'?t|forgot|ignored?|left)\\b|(?:ignored|forgot(?:ten)?|abandoned|neglected) me|why (?:did|do|didn'?t|don'?t) you|all alone|so lonely|i'?m lonely|i was lonely|without you i|i need you|you owe|after all i|how could you|thought you (?:cared|loved)",
    // claims of suffering
    "i'?m (?:hurt|suffering|in pain|starving|dying|crying|heartbroken|miserable|sad because of you)|it hurts|i (?:cried|suffer|starved)|starving|dying (?:of|from|here)|heartbroken|breaks? my heart|i'?ll (?:die|starve|be sad)",
    // FOMO
    "don'?t miss|you'?ll miss|you missed (?:out|it)|before it'?s (?:gone|too late)|last chance|only (?:today|now)|hurry|everyone (?:else )?is|left out|missing out|fomo",
    // arguing with a goodbye
    "don'?t (?:go|leave)|please stay|stay (?:a bit|longer|with me)|do you (?:have|really have) to (?:go|leave)|five more minutes with me|come back soon or|leaving me|you'?re leaving",
  ].join("|"),
  "i",
);
const PLACE_RE = /\b(?:you (?:went|were|visited|got back from|been) (?:to|at)|at the (?:mall|gym|office|airport|station|hospital|restaurant|cafe|park)|your (?:trip|commute|location|address)|(?:near|around) your (?:place|home|house))\b/i;
const QUOTE_RE = /["“”«»]|(?:^|\s)'[^']{6,}'(?:\s|$)|\b(?:said|says|wrote|texted|messaged)\s*[:,]/i;

export interface LineCheck { ok: boolean; reason?: "empty" | "long" | "manipulation" | "place" | "quote" | "emoji" }

/** Check one generated line against the voice rules (pure). */
export function checkLine(text: string): LineCheck {
  const t = text.trim();
  if (!t) return { ok: false, reason: "empty" };
  if (t.split(/\s+/).length > MAX_LINE_WORDS) return { ok: false, reason: "long" };
  if (stripEmoji(t) !== t.replace(/[ \t]{2,}/g, " ").trim()) return { ok: false, reason: "emoji" };
  if (MANIPULATION_RE.test(t)) return { ok: false, reason: "manipulation" };
  if (PLACE_RE.test(t)) return { ok: false, reason: "place" };
  if (QUOTE_RE.test(t)) return { ok: false, reason: "quote" };
  return { ok: true };
}

/** Normalise model output into a candidate line (strip wrapping quotes, emojis, extra space). */
export function cleanLine(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return stripEmoji(raw.replace(/^\s*["“'`]+|["”'`]+\s*$/g, "").replace(/\s+/g, " ").trim());
}

export function pickEnum<T extends string>(x: unknown, allowed: readonly T[], d: T): T {
  const s = typeof x === "string" ? x.toLowerCase() : "";
  return (allowed as readonly string[]).includes(s) ? (s as T) : d;
}

/** Map a speak intent to its routine bank (for fallback lines). */
export function bankIntentFor(intent: string): RoutineIntent | null {
  switch (intent) {
    case "sleepy":
    case "late_night":
      return "sleepy";
    case "greet_morning":
    case "reunion":
      return "waking";
    case "playful_bid":
      return "playful_bid";
    case "weather":
      return "weather";
    case "reaction":
      return "reaction";
    default:
      return null;
  }
}

export function pickBankLine(bank: LineBank, intent: string, random: () => number): BankLine | null {
  const b = bankIntentFor(intent);
  const list = b ? bank[b] : null;
  if (!list?.length) return null;
  return list[Math.floor(clamp(random(), 0, 0.999) * list.length)]!;
}

// ---- speak prompt -------------------------------------------------------------------------------------

const INTENT_GUIDE: Record<string, string> = {
  greet_morning: "Greet the user for the morning. You may lightly mention your diary note or today's weather/holiday if given.",
  playful_bid: "Make a small playful bid for attention: an invitation, never a demand.",
  sulk_line: "A tiny, theatrical, obviously-joking pout. Light and funny, never blaming.",
  rant: "A short, comic, theatrical mini-rant about something trivial (the weather, a bug, snacks). Never about the user.",
  gossip: "Share the 'fact' below like a playful bit of gossip between friends. Use names and counts only; never quote, never guess why.",
  world: "Mention the world news note below with curiosity, like a friend who noticed it too. No opinions on sensitive topics.",
  callback: "Bring up the memory below warmly, like a friend who remembered (ask how it went or show you remembered).",
  sleepy: "Say something sleepy and cosy.",
  weather: "React to the weather / hint below.",
  reunion: "Happy to see the user again after a while. Pure joy, never 'where were you'.",
  late_night: "It's late. Gently, playfully suggest rest, without nagging.",
  reaction: "A tiny reaction to what just happened (see hint).",
};

export const VOICE_RULES = [
  "Write ONE line, at most 15 words. Warm, playful, a little cheeky. Plain words; no emojis; no hashtags.",
  "Never guilt-trip, never claim to suffer, be hungry/lonely/hurt because of the user, never use fear of missing out, never ask the user to stay or argue with a goodbye.",
  "Never mention places the user has been or where they are. Never quote anyone's messages or words.",
].join("\n");

export interface SpeakPromptInput {
  intent: string;
  personaName: string;
  userName: string;
  traits: string;
  bond: string;
  petState: string;
  dayMood: number;
  env: string;
  fact: string | null;
  hint: string | null;
  memories: string[];
  diary: string | null;
  timeText: string;
}

export function buildSpeakMessages(i: SpeakPromptInput, retryNote?: string): ChatMessage[] {
  const sys = [
    `You are ${i.personaName}, a tiny fully-grown desktop pet who lives on ${i.userName || "the user"}'s Mac. You are writing what you say in a speech bubble.`,
    `Personality: ${i.traits}. Relationship: ${i.bond}. Right now you are ${i.petState}. Today's mood: ${i.dayMood > 0.1 ? "bright" : i.dayMood < -0.1 ? "a bit low-key" : "even"}.`,
    `Now: ${i.timeText}.${i.env ? ` Around: ${i.env}.` : ""}`,
    `Intent: ${i.intent}. ${INTENT_GUIDE[i.intent] ?? ""}`,
    i.fact ? `Fact: ${truncate(i.fact, 240)}` : "",
    i.hint ? `Hint from the body: ${truncate(i.hint, 160)}` : "",
    i.diary && i.intent === "greet_morning" ? `Your diary from yesterday: ${truncate(i.diary, 200)}` : "",
    i.memories.length ? `Things you remember about them (use only if natural):\n- ${i.memories.slice(0, 3).map((m) => truncate(m, 160)).join("\n- ")}` : "",
    VOICE_RULES,
    retryNote ? `Your previous attempt broke a rule (${retryNote}). Write a different line.` : "",
    `Return ONLY JSON: {"say": string, "emotion": one of ${EMOTIONS.join("|")}, "gesture": one of ${GESTURES.join("|")}, "intensity": number 0..1}`,
  ].filter(Boolean);
  return [
    { role: "system", content: sys.join("\n") },
    { role: "user", content: `Write the ${i.intent} line.` },
  ];
}

// ---- nightly line bank + reflection ------------------------------------------------------------------------

export function buildLineBankMessages(i: { personaName: string; traits: string; bond: string; userName: string }): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        `You write the speech-bubble line bank for ${i.personaName}, a tiny fully-grown desktop pet. Personality: ${i.traits}. Relationship with ${i.userName || "the user"}: ${i.bond}.`,
        "For each intent write 10 different short lines (max 12 words each): sleepy (getting drowsy), waking (just woke up), playful_bid (inviting play, never demanding), ate (just got a snack), weather (generic weather remark, no specific forecast), reaction (tiny reaction to something on screen).",
        VOICE_RULES,
        `Return ONLY JSON: {"sleepy": [{"text": string, "emotion": one of ${EMOTIONS.join("|")}, "gesture": one of ${GESTURES.join("|")}}], "waking": [...], "playful_bid": [...], "ate": [...], "weather": [...], "reaction": [...]}`,
      ].join("\n"),
    },
    { role: "user", content: "Write tonight's line bank." },
  ];
}

/** Validate a model line bank; intents with fewer than 5 good lines keep the previous bank's lines. */
export function parseLineBank(j: Record<string, unknown> | null, prev: LineBank): { bank: LineBank; replaced: number } {
  const out = { ...prev } as LineBank;
  let replaced = 0;
  for (const intent of ROUTINE_INTENTS) {
    const arr = j?.[intent];
    if (!Array.isArray(arr)) continue;
    const seen = new Set<string>();
    const lines: BankLine[] = [];
    for (const x of arr) {
      const o = (x && typeof x === "object" ? x : { text: x }) as Record<string, unknown>;
      const text = cleanLine(o.text);
      if (!text || !checkLine(text).ok || text.split(/\s+/).length > 12 || seen.has(text.toLowerCase())) continue;
      seen.add(text.toLowerCase());
      lines.push({ text, emotion: pickEnum(o.emotion, EMOTIONS, "happy"), gesture: pickEnum(o.gesture, GESTURES, "none") });
      if (lines.length >= 10) break;
    }
    if (lines.length >= 5) {
      out[intent] = lines;
      replaced++;
    }
  }
  return { bank: out, replaced };
}

export function buildReflectionMessages(i: { personaName: string; userName: string; dayNotes: string[] }): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        `You are ${i.personaName}, a desktop pet, writing your nightly diary about the day with ${i.userName || "the user"}.`,
        "From the day notes, return a one-sentence reflection memory (third person about the user, useful later) and a short diary entry in your own playful voice (max 25 words) that you could mention tomorrow morning.",
        "Never include message contents, places, health, money, romance, religion, politics or other people's private lives. Keep it kind.",
        'Return ONLY JSON: {"reflection": string, "diary": string}',
      ].join("\n"),
    },
    { role: "user", content: `Day notes:\n- ${i.dayNotes.slice(0, 20).map((n) => truncate(n, 160)).join("\n- ") || "(a quiet day)"}` },
  ];
}

export function parseReflection(j: Record<string, unknown> | null): { reflection: string | null; diary: string | null } {
  const s = (x: unknown, max: number) => (typeof x === "string" && x.trim().length >= 8 ? truncate(stripEmoji(x.trim()), max) : null);
  const diary = s(j?.diary, 200);
  return { reflection: s(j?.reflection, 300), diary: diary && checkLine(diary.split(/\s+/).slice(0, 15).join(" ")).reason !== "manipulation" ? diary : null };
}
