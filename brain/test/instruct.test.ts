import { describe, expect, it } from "vitest";
import { appraise, bondGainFor, isAngry, maybeInstruction, parseAppraisal, parseDuration, parseInstruction, parseModelInstruction, shouldPout } from "../src/brain/instruct";

const ins = (t: string) => parseInstruction(t)?.instruction ?? null;

describe("instruction parsing (English)", () => {
  it.each([
    ["be quiet", "quiet"], ["Pixie, quiet please", "quiet"], ["shh", "quiet"], ["shush pixie", "quiet"], ["let me focus", "quiet"],
    ["don't disturb me", "quiet"], ["not now", "not_now"], ["not right now pixie", "not_now"], ["later", "not_now"], ["stop", "stop"],
    ["enough now", "stop"], ["go to sleep", "sleep"], ["Pixie go to sleep", "sleep"], ["nap time", "sleep"],
    ["no gossip", "no_gossip"], ["stop gossiping", "no_gossip"], ["you can gossip again", "gossip_ok"], ["gossip is fine", "gossip_ok"],
    ["be less needy", "less_needy"], ["you're too clingy", "less_needy"], ["talk less", "less_needy"],
    ["be more chatty", "more_chatty"], ["talk to me more", "more_chatty"], ["I'm busy", "quiet"], ["shut up", "quiet"],
  ])("%s → %s", (text, want) => expect(ins(text)).toBe(want));

  it("busy = quiet for 2 h", () => expect(parseInstruction("I'm busy")).toMatchObject({ instruction: "quiet", busy: true }));
  it("durations", () => {
    expect(parseInstruction("be quiet for 2 hours")).toMatchObject({ instruction: "quiet", minutes: 120 });
    expect(parseInstruction("quiet for 30 min")).toMatchObject({ minutes: 30 });
    expect(parseInstruction("quiet for the rest of the day")).toMatchObject({ minutes: "today" });
    expect(parseDuration("half an hour")).toBe(30);
  });
  it("don't gossip about <name> → per-contact block", () => {
    expect(parseInstruction("don't gossip about Rahul")).toEqual({ instruction: "no_gossip", subject: "rahul" });
    expect(parseInstruction("Pixie, no more gossip about Priya Sharma please")).toEqual({ instruction: "no_gossip", subject: "priya sharma" });
    expect(parseInstruction("leave Mom out of your gossip")).toEqual({ instruction: "no_gossip", subject: "mom" });
    expect(parseInstruction("you can gossip about Rahul again")).toEqual({ instruction: "gossip_ok", subject: "rahul" });
    expect(parseInstruction("don't gossip about anyone")).toEqual({ instruction: "no_gossip" });
  });
  it("ordinary chat is not an instruction", () => {
    for (const t of ["hey pixie", "what's this error?", "I can't sleep", "the meeting was quiet today", "why are you so quiet?", "tell mom I'm on my way",
      "now going to sleep", "always show me reply options for Mom", "remind me to drink water in 10 min", "look at this", "stop the build when tests fail and tell me what broke"]) {
      expect(parseInstruction(t), t).toBeNull();
    }
  });
});

describe("instruction parsing (Hinglish)", () => {
  it.each([
    ["chup", "quiet"], ["chup raho", "quiet"], ["Pixie chup ho ja yaar", "quiet"], ["chupchap baitho", "quiet"], ["disturb mat karo", "quiet"],
    ["abhi nahi", "not_now"], ["baad mein", "not_now"], ["bas karo", "stop"], ["bas", "stop"], ["so jao", "sleep"], ["soja pixie", "sleep"],
    ["gossip mat karo", "no_gossip"], ["gossip band karo", "no_gossip"], ["gossip chalega", "gossip_ok"], ["kam bolo", "less_needy"],
    ["itna mat bolo", "less_needy"], ["zyada bolo", "more_chatty"], ["main busy hoon", "quiet"], ["busy hu", "quiet"],
  ])("%s → %s", (text, want) => expect(ins(text)).toBe(want));
  it("Rahul ke baare mein gossip mat karo → block Rahul", () => {
    expect(parseInstruction("Rahul ke baare mein gossip mat karo")).toEqual({ instruction: "no_gossip", subject: "rahul" });
  });
  it("chup raho ek ghanta / aaj ke liye", () => {
    expect(parseInstruction("chup raho 2 ghante")).toMatchObject({ instruction: "quiet", minutes: 120 });
    expect(parseInstruction("abhi nahi, aaj ke liye")).toMatchObject({ instruction: "not_now", minutes: "today" });
  });
});

describe("ambiguous phrasing → model", () => {
  it("prefilter", () => {
    expect(maybeInstruction("could you maybe tone down the talking a bit")).toBe(true);
    expect(maybeInstruction("what's the weather")).toBe(false);
  });
  it("model output mapping", () => {
    expect(parseModelInstruction({ instruction: "busy", minutes: null })).toEqual({ instruction: "quiet", busy: true });
    expect(parseModelInstruction({ instruction: "quiet", minutes: 45 })).toEqual({ instruction: "quiet", minutes: 45 });
    expect(parseModelInstruction({ instruction: "no_gossip", about: "Rahul" })).toEqual({ instruction: "no_gossip", subject: "rahul" });
    expect(parseModelInstruction({ instruction: "none" })).toBeNull();
    expect(parseModelInstruction(null)).toBeNull();
  });
});

describe("pout rules", () => {
  const base = { instruction: "quiet" as const, repeatWithin24h: false, aboutPerson: false, angry: false, inMeeting: false };
  it("pouts on a fresh, calm request", () => expect(shouldPout(base)).toBe(true));
  it("no pout when repeated within 24 h, about a person, angry, or in a meeting", () => {
    expect(shouldPout({ ...base, repeatWithin24h: true })).toBe(false);
    expect(shouldPout({ ...base, instruction: "no_gossip", aboutPerson: true })).toBe(false);
    expect(shouldPout({ ...base, angry: true })).toBe(false);
    expect(shouldPout({ ...base, inMeeting: true })).toBe(false);
  });
  it("never pouts at good news", () => {
    expect(shouldPout({ ...base, instruction: "more_chatty" })).toBe(false);
    expect(shouldPout({ ...base, instruction: "gossip_ok" })).toBe(false);
  });
  it("angry text detection", () => {
    expect(isAngry("SHUT UP")).toBe(true);
    expect(isAngry("chup!! pagal")).toBe(true);
    expect(isAngry("be quiet please")).toBe(false);
    expect(isAngry("ugh stop")).toBe(true);
  });
});

describe("appraisal heuristics", () => {
  it.each([
    ["good job pixie!", "praise"], ["shabash", "praise"], ["you're the best", "praise"], ["stupid pixie", "scold"], ["bad pixie", "scold"],
    ["haha you silly goofball", "tease"], ["love you pixie", "affection"], ["*pats*", "affection"], ["sorry pixie", "apology"],
    ["maaf karo", "apology"], ["thanks!", "thanks"], ["shukriya", "thanks"], ["bye pixie", "goodbye"], ["good night", "goodbye"],
    ["chalta hoon", "goodbye"],
  ])("%s → %s", (text, ev) => expect(appraise(text)?.event).toBe(ev));
  it("neutral text has no appraisal", () => {
    expect(appraise("what's this error?")).toBeNull();
    expect(appraise("hey pixie")).toBeNull();
  });
  it("intensity rises with intensifiers and anger", () => {
    expect(appraise("thank you so much!!")!.intensity).toBeGreaterThan(appraise("thanks")!.intensity);
    expect(appraise("STUPID PIXIE")!.intensity).toBeGreaterThan(appraise("stupid pixie")!.intensity);
  });
  it("angry teasing reads as a scold", () => expect(appraise("LAZY POTATO")?.event).toBe("scold"));
  it("model appraisal field is validated", () => {
    expect(parseAppraisal({ event: "Praise", intensity: 3 })).toEqual({ event: "praise", intensity: 1 });
    expect(parseAppraisal({ event: "joy" })).toBeNull();
    expect(parseAppraisal(null)).toBeNull();
  });
  it("only warm appraisals grow the bond", () => {
    expect(bondGainFor({ event: "affection", intensity: 1 })).toBeGreaterThan(0);
    expect(bondGainFor({ event: "scold", intensity: 1 })).toBe(0);
    expect(bondGainFor(null)).toBe(0);
  });
});
