/**
 * Instructions and appraisal from user.say (English + Hinglish). Regex first; the model is asked only
 * for ambiguous phrasing that mentions Pixie and a quiet/gossip/sleep/talk keyword. Pure functions.
 */
import type { ChatMessage } from "../ai";
import { clamp, truncate } from "../util";
import type { ObeyInstruction } from "./pet";

export interface ParsedInstruction {
  instruction: ObeyInstruction;
  /** quiet length in minutes, or "today" (until the end of the local day); absent = the instruction's default */
  minutes?: number | "today";
  /** "don't gossip about <name>" / "you can gossip about <name>" */
  subject?: string;
  /** "busy" (quiet 2 h) */
  busy?: boolean;
}

export const DEFAULT_MINUTES: Partial<Record<ObeyInstruction, number>> = { quiet: 60, not_now: 30, stop: 20 };
export const BUSY_MINUTES = 120;

const FILLER_RE = /^(?:(?:hey|oye|oi|arre|arey|acha|accha|ok|okay)\s+)?(?:pixie[\s,:!-]+)?|(?:[\s,]+(?:pixie|please|pls|plz|yaar|na|ok|okay|thanks|thank you))+$/gi;

/** Lowercase, strip punctuation (keeps apostrophes), fillers and the pet's name at either end. */
export function normalizeInstruction(text: string): string {
  let t = text.toLowerCase().replace(/[’`]/g, "'").replace(/[^\p{L}\p{N}'\s]/gu, " ").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 2; i++) t = t.replace(FILLER_RE, "").trim();
  return t;
}

const words = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

/** "for 2 hours", "30 min", "aadha ghanta", "aaj", "for the rest of the day" → minutes / "today". */
export function parseDuration(t: string): number | "today" | undefined {
  if (/\b(?:today|rest of the day|for the day|aaj(?: ke liye| bhar)?|poore din)\b/.test(t)) return "today";
  if (/\b(?:half an hour|half hour|aadha ghanta|aadhe ghante)\b/.test(t)) return 30;
  if (/\b(?:an hour|one hour|ek ghanta|ek ghante)\b/.test(t)) return 60;
  const m = t.match(/\b(\d{1,3})\s*(min|mins|minute|minutes|m|hour|hours|hr|hrs|h|ghanta|ghante|ghanton)\b/);
  if (m) {
    const n = Number(m[1]);
    const mins = /^(?:h|hr|hrs|hour|hours|ghanta|ghante|ghanton)$/.test(m[2]!) ? n * 60 : n;
    return clamp(mins, 5, 12 * 60);
  }
  return undefined;
}

const NAME_STOP = /^(?:me|myself|anyone|anybody|everyone|everybody|people|others|other people|someone|them|anything|it|that|this)$/;

function cleanName(raw: string): string {
  return raw.replace(/\b(?:please|pls|plz|anymore|any more|again|ever|okay|ok|yaar|na)\b/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
}

const QUIET_CORE =
  /^(?:shut up|shut it|be quiet|quiet(?: down)?|keep quiet|stay quiet|sh+|shush|hush|silence|chup(?: (?:raho|reh|rah|kar|karo|ho ja|ho jao|chap|chaap|baith))?|chupchap(?: (?:raho|baitho|reh))?|khamosh|mute|no talking|stop talking|don't talk|dont talk|do not talk|let me (?:focus|work|concentrate)|leave me alone|give me (?:some )?space|don't disturb(?: me)?|dont disturb(?: me)?|do not disturb(?: me)?|(?:mujhe )?disturb mat kar(?:o|na)?|shant (?:raho|ho jao))\b(.*)$/;
const NOT_NOW_CORE = /^(?:not now|not right now|abhi nahi|abhi nahin|abhi mat|later|baad mein|baad me|maybe later)\b(.*)$/;
const STOP_RE = /^(?:stop(?: (?:it|that|now))?|bas(?: (?:karo|kar|kar do|ho gaya|bas))?|band karo|enough|enough now|cut it out|ruk ja|ruko)$/;
const BUSY_RE = /^(?:(?:i'?m|i am|im) (?:really |so |very |a bit )?busy|busy(?: (?:hoon|hu|hun|right now))?|(?:main )?busy (?:hoon|hu|hun)|kaam kar (?:raha|rahi) (?:hoon|hu|hun))\b(.*)$/;
const SLEEP_RE = /^(?:go (?:to )?sleep|go to bed|sleep now|time to sleep|nap time|take a nap|go nap|go take a nap|so ja|so jao|soja|sone ja|sone jao|ja ke so ja|jaake so jao|jao so jao)\b(.*)$/;
const NO_GOSSIP_RE = /^(?:no (?:more )?gossip(?:ing)?|stop (?:the )?gossip(?:ing)?|enough gossip|don't gossip|dont gossip|do not gossip|gossip (?:mat kar(?:o|na)?|band kar(?:o|do)?|nahi|nahin|band))\b(.*)$/;
const NO_GOSSIP_ABOUT = [
  /^(?:don't|dont|do not|no|stop|never) (?:gossip(?:ing)?|talk(?:ing)?) about (.+)$/,
  /^no (?:more )?gossip(?:ing)? about (.+)$/,
  /^leave (.+?) out of (?:your |the )?gossip$/,
  /^(.+?) (?:ke|ki|ka) (?:baare|bare) (?:mein|me|main) (?:gossip|baat) mat kar(?:o|na)?$/,
];
const GOSSIP_OK_ABOUT = [/^(?:you can|it's ok to|its ok to|feel free to) gossip about (.+?)(?: again)?$/, /^(.+?) (?:ke|ki|ka) (?:baare|bare) (?:mein|me|main) gossip kar sakt(?:e|i) ho$/];
const GOSSIP_OK_RE =
  /^(?:gossip (?:is )?(?:ok|okay|fine|allowed)|you can gossip(?: again)?|gossip again|(?:start|resume) gossiping(?: again)?|i (?:like|love|miss) (?:your |the )?gossip|gossip (?:kar sakt(?:e|i) ho|chalega|theek hai|thik hai|kar lo|karo))\b/;
const LESS_NEEDY_RE =
  /\b(?:be less (?:needy|clingy|chatty|talkative)|less (?:needy|clingy)|(?:you'?re|you are|ur) (?:too|so|being) (?:needy|clingy)|too (?:needy|clingy)|talk less|stop being (?:so )?(?:needy|clingy)|kam bol(?:o|a karo)?|itna mat bol(?:o|a karo)?|zyada mat bol(?:o)?)\b/;
const MORE_CHATTY_RE =
  /\b(?:be (?:more )?(?:chatty|chattier|talkative)|more (?:chatty|talkative)|talk (?:to me )?more|you can talk (?:more|again)|i miss your (?:chatter|talking|voice)|zyada bol(?:o|a karo)|aur bol(?:o|a karo)|chat more)\b/;

/** Recognise an instruction to Pixie (pure). Returns null for ordinary chat. */
export function parseInstruction(text: string): ParsedInstruction | null {
  const t = normalizeInstruction(text);
  if (!t || words(t) > 16) return null;
  for (const re of NO_GOSSIP_ABOUT) {
    const m = t.match(re);
    if (m) {
      const name = cleanName(m[1]!);
      if (!name) continue;
      if (NAME_STOP.test(name)) return { instruction: "no_gossip" };
      if (words(name) <= 4) return { instruction: "no_gossip", subject: name };
    }
  }
  for (const re of GOSSIP_OK_ABOUT) {
    const m = t.match(re);
    if (m) {
      const name = cleanName(m[1]!);
      if (name && !NAME_STOP.test(name) && words(name) <= 4) return { instruction: "gossip_ok", subject: name };
    }
  }
  if (GOSSIP_OK_RE.test(t)) return { instruction: "gossip_ok" };
  const ng = t.match(NO_GOSSIP_RE);
  if (ng && words(ng[1] ?? "") <= 4) return { instruction: "no_gossip" };
  const question = /\?\s*$/.test(text.trim()) || /^(?:why|what|how|when|do you|can you|are you|kya|kyun|kyu)\b/.test(t);
  if (!question && words(t) <= 10) {
    if (MORE_CHATTY_RE.test(t)) return { instruction: "more_chatty" };
    if (LESS_NEEDY_RE.test(t)) return { instruction: "less_needy" };
  }
  const sl = t.match(SLEEP_RE);
  if (sl && words(sl[1] ?? "") <= 4) return { instruction: "sleep" };
  const busy = t.match(BUSY_RE);
  if (busy && words(busy[1] ?? "") <= 4) {
    const d = parseDuration(t);
    return { instruction: "quiet", busy: true, ...(d !== undefined ? { minutes: d } : {}) };
  }
  const nn = t.match(NOT_NOW_CORE);
  if (nn && words(nn[1] ?? "") <= 4) {
    const d = parseDuration(t);
    return { instruction: "not_now", ...(d !== undefined ? { minutes: d } : {}) };
  }
  if (STOP_RE.test(t)) return { instruction: "stop" };
  const q = t.match(QUIET_CORE);
  if (q && words(q[1] ?? "") <= 6) {
    const d = parseDuration(t);
    return { instruction: "quiet", ...(d !== undefined ? { minutes: d } : {}) };
  }
  return null;
}

const AMBIG_KEY_RE = /\b(?:quiet|silent|silence|shut|talk|talking|noise|noisy|disturb|bother|gossip|sleep|nap|needy|clingy|chatty|bolo|bol|baat|chup|space|focus|alone)\b/;
const AMBIG_YOU_RE = /\b(?:pixie|you|your|u|ur|tum|tu|tumhe|tujhe|aap)\b/;

/** Phrasing that might be an instruction but no regex caught (worth one cheap model parse). */
export function maybeInstruction(text: string): boolean {
  const t = text.toLowerCase();
  return t.length <= 140 && AMBIG_KEY_RE.test(t) && AMBIG_YOU_RE.test(t);
}

export function buildInstructionMessages(text: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        'You decide whether a message to a desktop pet called Pixie is an instruction about how Pixie should behave. Messages may be English or Hinglish. Instructions: quiet (be quiet for a while), not_now, stop, sleep (Pixie should go to sleep), less_needy (talk less / less clingy overall), more_chatty, no_gossip (optionally about one named person), gossip_ok, busy (the user is busy). Ordinary chat, questions and statements about the user themselves are "none". Return ONLY JSON: {"instruction": "none"|"quiet"|"not_now"|"stop"|"sleep"|"less_needy"|"more_chatty"|"no_gossip"|"gossip_ok"|"busy", "minutes": number|null, "about": string|null}',
    },
    { role: "user", content: truncate(text, 300) },
  ];
}

const MODEL_INSTRUCTIONS = ["quiet", "not_now", "stop", "sleep", "less_needy", "more_chatty", "no_gossip", "gossip_ok", "busy"] as const;

export function parseModelInstruction(j: Record<string, unknown> | null): ParsedInstruction | null {
  if (!j) return null;
  const k = typeof j.instruction === "string" ? j.instruction.trim().toLowerCase() : "";
  if (!(MODEL_INSTRUCTIONS as readonly string[]).includes(k)) return null;
  const minutes = typeof j.minutes === "number" && Number.isFinite(j.minutes) && j.minutes > 0 ? clamp(Math.round(j.minutes), 5, 12 * 60) : undefined;
  const about = typeof j.about === "string" ? cleanName(j.about.toLowerCase()) : "";
  if (k === "busy") return { instruction: "quiet", busy: true, ...(minutes ? { minutes } : {}) };
  const out: ParsedInstruction = { instruction: k as ObeyInstruction };
  if (minutes && (k === "quiet" || k === "not_now" || k === "stop")) out.minutes = minutes;
  if (about && !NAME_STOP.test(about) && words(about) <= 4 && (k === "no_gossip" || k === "gossip_ok")) out.subject = about;
  return out;
}

// ---- tone ----------------------------------------------------------------------------------------

const ANGRY_RE =
  /\b(?:shut up|shut it|stupid|useless|dumb|idiot|hate you|annoying|irritating|wtf|damn|dammit|ffs|for god'?s sake|seriously|bakwas|pagal|bewakoof|bevakoof|dimag mat kha|dimaag mat kha|dimag kharab|bhaad mein|gussa|ugh+)\b/i;

function isShouting(text: string): boolean {
  const letters = text.replace(/[^A-Za-z]/g, "");
  return letters.length >= 4 && letters.replace(/[^A-Z]/g, "").length / letters.length >= 0.7;
}

/** The user's words read angry (rude words, shouting caps, or an exclamation pile). */
export function isAngry(text: string): boolean {
  if (ANGRY_RE.test(text)) return true;
  if (/!{2,}/.test(text) && words(text) <= 6) return true;
  return isShouting(text);
}

const HINGLISH_RE = /\b(?:hai|nahi|nahin|mat|karo|kar|raho|jao|yaar|abhi|baad|kam|zyada|bolo|chup|baare|mein|hoon|theek|thik|chalega|soja|bas|accha|acha)\b/i;
export function isHinglish(text: string): boolean {
  return HINGLISH_RE.test(text);
}

/** Pout only when the moment allows it (PROTOCOL §4.2 pet.obey). */
export function shouldPout(i: { instruction: ObeyInstruction; repeatWithin24h: boolean; aboutPerson: boolean; angry: boolean; inMeeting: boolean }): boolean {
  if (i.instruction === "gossip_ok" || i.instruction === "more_chatty") return false;
  return !(i.repeatWithin24h || i.aboutPerson || i.angry || i.inMeeting);
}

const ACKS: Record<ObeyInstruction | "busy" | "no_gossip_about" | "gossip_ok_about", { en: string[]; hi: string[] }> = {
  quiet: { en: ["Okay, shh.", "Zipping it.", "Quiet mode."], hi: ["Theek hai, chup.", "Okay, chup."] },
  busy: { en: ["Got it, I'll stay quiet.", "Okay, you focus."], hi: ["Theek hai, kaam karo.", "Okay, chup rahungi."] },
  not_now: { en: ["Okay, later.", "Sure, later."], hi: ["Theek hai, baad mein.", "Okay, baad mein."] },
  stop: { en: ["Okay, stopping.", "Okay."], hi: ["Okay, bas.", "Theek hai."] },
  sleep: { en: ["Okay... night night.", "Yawn, okay."], hi: ["Theek hai, so rahi hoon.", "Okay, good night."] },
  less_needy: { en: ["Okay, I'll give you space.", "Got it, less from me."], hi: ["Theek hai, kam bolungi.", "Okay, kam bolungi."] },
  more_chatty: { en: ["Yay, okay!", "Ooh, okay!"], hi: ["Yay, theek hai!", "Accha, zyada bolungi!"] },
  no_gossip: { en: ["Okay, no gossip.", "Got it, no gossip."], hi: ["Theek hai, no gossip.", "Okay, gossip band."] },
  gossip_ok: { en: ["Hehe, okay!", "Ooh, okay!"], hi: ["Hehe, theek hai!", "Accha, okay!"] },
  no_gossip_about: { en: ["Got it, not about them.", "Okay, they're off-limits."], hi: ["Theek hai, unke baare mein nahi.", "Okay, unke baare mein nahi."] },
  gossip_ok_about: { en: ["Okay, noted.", "Got it."], hi: ["Theek hai.", "Okay, noted."] },
};

export function ackLine(p: ParsedInstruction, text: string, random: () => number): string {
  const key = p.subject ? (p.instruction === "no_gossip" ? "no_gossip_about" : "gossip_ok_about") : p.busy ? "busy" : p.instruction;
  const set = ACKS[key];
  const list = isHinglish(text) ? set.hi : set.en;
  return list[Math.floor(clamp(random(), 0, 0.999) * list.length)]!;
}

// ---- appraisal (PROTOCOL §4.2 pet.appraisal) --------------------------------------------------------

export const APPRAISAL_EVENTS = ["praise", "scold", "tease", "affection", "apology", "thanks", "goodbye"] as const;
export type AppraisalEvent = (typeof APPRAISAL_EVENTS)[number];
export interface Appraisal { event: AppraisalEvent; intensity: number }

const AP_RULES: Array<[AppraisalEvent, RegExp]> = [
  ["apology", /\b(?:sorry|my bad|i apologi[sz]e|forgive me|maaf(?: karo| kar do| kijiye)?|maafi)\b/i],
  ["scold", /\b(?:bad pixie|shut up|stupid|useless|dumb|idiot|annoying|irritating|hate you|stop it|bakwas|pagal|bewakoof|galat|kya kar rahi ho|dimag mat kha|naughty pixie|that was rude|not cool)\b/i],
  ["goodbye", /(?:^|\b)(?:bye+|bye bye|good ?night|gn|see (?:you|ya)(?: later| tomorrow)?|ttyl|talk later|later pixie|gotta go|i'?m (?:off|leaving|logging off|heading out)|going to (?:sleep|bed)|chalta hoon|chalti hoon|alvida|phir milenge|shubh ratri|so raha hoon|so rahi hoon)\b/i],
  ["thanks", /\b(?:thanks|thank you|thank u|thx|ty|tysm|shukriya|dhanyavaad|dhanyawad|thanku)\b/i],
  ["affection", /(?:\*\s*(?:head ?)?pats?\s*\*|\b(?:love you|luv you|ily|hugs?|huggies|miss(?:ed)? you|cutie|sweetie|aww+|pyaar|pyar|boop|pat pat|you'?re (?:so )?(?:cute|adorable)|my (?:little )?(?:buddy|friend))\b)/i],
  ["praise", /\b(?:good (?:job|girl|boy|bot|work)|well done|nice (?:work|one|job)|great (?:job|work)|you'?re (?:the best|amazing|awesome|so smart|smart|a genius)|you rock|smart pixie|clever|genius|shabash|shabaash|badhiya|bahut accha|mast|kamaal|wah|waah)\b/i],
  ["tease", /\b(?:silly|goofball|dummy|potato|chubby|lazy(?:bones)?|sleepyhead|nerd|drama queen|weirdo|pagli|buddhu|lol you|haha you)\b/i],
];

const INTENSIFIER_RE = /\b(?:so|very|really|super|soo+|bahut|bohot|ekdum|totally|so much)\b/i;

/** Heuristic appraisal of the user's words (pure). Null when nothing clear. */
export function appraise(text: string): Appraisal | null {
  const t = text.trim();
  if (!t) return null;
  for (const [event, re] of AP_RULES) {
    if (!re.test(t)) continue;
    // Teasing that comes with laughter reads playful; insult words with anger read as a scold.
    if (event === "tease" && isAngry(t)) return { event: "scold", intensity: 0.6 };
    let i = 0.5;
    if (INTENSIFIER_RE.test(t)) i += 0.2;
    if (/!/.test(t)) i += 0.1;
    if ((t.match(re) ?? []).length > 1 || /(\w)\1{2,}/.test(t)) i += 0.1;
    if (event === "scold" && isAngry(t)) i += 0.15;
    if (isShouting(t)) i += 0.1;
    if (event === "tease" && /\b(?:haha|hehe|lol|lmao)\b/i.test(t)) i -= 0.1;
    return { event, intensity: Math.round(clamp(i, 0.1, 1) * 100) / 100 };
  }
  return null;
}

/** Parse the optional `appraisal` field of the chat model's JSON output. */
export function parseAppraisal(x: unknown): Appraisal | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const ev = typeof o.event === "string" ? o.event.toLowerCase() : "";
  if (!(APPRAISAL_EVENTS as readonly string[]).includes(ev)) return null;
  const n = typeof o.intensity === "number" ? o.intensity : Number(o.intensity ?? 0.5);
  return { event: ev as AppraisalEvent, intensity: Math.round(clamp(Number.isFinite(n) ? n : 0.5, 0, 1) * 100) / 100 };
}

/** Bond gain for a warm appraisal (0 for anything else). */
export function bondGainFor(a: Appraisal | null): number {
  if (!a) return 0;
  const base: Partial<Record<AppraisalEvent, number>> = { praise: 1, affection: 1.5, thanks: 0.75, apology: 0.5 };
  return (base[a.event] ?? 0) * (0.6 + 0.4 * a.intensity);
}
