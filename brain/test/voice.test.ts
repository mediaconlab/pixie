import { describe, expect, it } from "vitest";
import { DEFAULT_LINE_BANK, ROUTINE_INTENTS, bankIntentFor, checkLine, cleanLine, parseLineBank, parseReflection, pickBankLine } from "../src/brain/voice";

describe("line filter", () => {
  it("accepts warm short lines", () => {
    for (const t of ["psst. hi.", "ooh, it's raining!", "Rahul's on a texting spree today, hehe", "night night, sleep well"]) expect(checkLine(t), t).toEqual({ ok: true });
  });
  it.each([
    ["you never play with me anymore", "manipulation"],
    ["I was so lonely without you", "manipulation"],
    ["I'm starving, feed me", "manipulation"],
    ["it hurts when you ignore me", "manipulation"],
    ["don't miss this, hurry!", "manipulation"],
    ["don't go, stay a bit longer", "manipulation"],
    ["how was the mall? you went to the gym after", "place"],
    ["Rahul said: \"call me now\"", "quote"],
    ["this line is definitely going to be way too long for a tiny pet speech bubble okay", "long"],
    ["", "empty"],
  ])("%s → %s", (t, reason) => expect(checkLine(t)).toEqual({ ok: false, reason }));
  it("cleanLine strips quotes and emojis", () => {
    expect(cleanLine('"hello there 🎉"')).toBe("hello there");
    expect(cleanLine(42)).toBe("");
  });
});

describe("line bank", () => {
  it("default bank has ~10 lines per routine intent, all passing the filter", () => {
    for (const i of ROUTINE_INTENTS) {
      expect(DEFAULT_LINE_BANK[i].length).toBeGreaterThanOrEqual(10);
      for (const l of DEFAULT_LINE_BANK[i]) expect(checkLine(l.text), l.text).toEqual({ ok: true });
    }
  });
  it("speak intents map to the bank for fallback; gossip has none", () => {
    expect(bankIntentFor("late_night")).toBe("sleepy");
    expect(bankIntentFor("greet_morning")).toBe("waking");
    expect(bankIntentFor("gossip")).toBeNull();
    expect(pickBankLine(DEFAULT_LINE_BANK, "weather", () => 0)).toEqual(DEFAULT_LINE_BANK.weather[0]);
    expect(pickBankLine(DEFAULT_LINE_BANK, "callback", () => 0)).toBeNull();
  });
  it("nightly bank: keeps good lines, drops bad ones, falls back per intent", () => {
    const good = Array.from({ length: 8 }, (_, i) => ({ text: `sleepy line ${i}`, emotion: "sleepy", gesture: "none" }));
    const bad = [{ text: "you never let me sleep", emotion: "sad", gesture: "none" }, { text: "I'm dying of tiredness", emotion: "sad" }];
    const { bank, replaced } = parseLineBank({ sleepy: [...bad, ...good, good[0]], ate: [{ text: "yum" }] }, DEFAULT_LINE_BANK);
    expect(replaced).toBe(1);
    expect(bank.sleepy.map((l) => l.text)).toEqual(good.map((g) => g.text));
    expect(bank.ate).toBe(DEFAULT_LINE_BANK.ate);
    expect(parseLineBank(null, DEFAULT_LINE_BANK).replaced).toBe(0);
  });
  it("reflection parse", () => {
    expect(parseReflection({ reflection: "Ishaan coded most of the day.", diary: "Today we coded a lot, hehe." })).toEqual({ reflection: "Ishaan coded most of the day.", diary: "Today we coded a lot, hehe." });
    expect(parseReflection({ diary: "you ignored me all day" }).diary).toBeNull();
  });
});
