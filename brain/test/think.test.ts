import { describe, expect, it } from "vitest";
import { AiError } from "../src/ai";
import { initialMood } from "../src/brain/mood";
import {
  DEFAULT_PERSONA, buildMessages, cannedPerformance, draftReply, looksLikeUnifiedDiff, sanitizeAction, sanitizeRemember,
  sanitizeSuggestion, think, thinkCoding,
} from "../src/brain/think";
import { FakeAi } from "./helpers";

const input = {
  persona: DEFAULT_PERSONA, userName: "Ishaan", mood: initialMood(0), activity: "coding", frontApp: "Xcode",
  memories: ["Ishaan likes chai"], preferences: ["Keep replies casual"],
  recent: [
    { role: "user" as const, text: "hi", ts: 1 },
    { role: "pixie" as const, text: "hello!", ts: 2 },
    { role: "event" as const, text: "Mom messaged", ts: 3 },
  ],
  observation: { kind: "chat" as const, text: "how are you?" }, now: 0,
};

describe("buildMessages", () => {
  it("includes persona, mood, activity, memories and the observation last", () => {
    const m = buildMessages(input);
    expect(m[0]!.role).toBe("system");
    expect(m[0]!.content).toContain("Pixie");
    expect(m[0]!.content).toContain("Ishaan likes chai");
    expect(m[0]!.content).toContain("coding");
    expect(m[0]!.content).toContain("NEVER use emojis");
    expect(m.at(-1)!.role).toBe("user");
    expect(m.at(-1)!.content).toContain("how are you?");
    // event + observation merged into one user message (alternation)
    for (let i = 2; i < m.length; i++) expect(m[i]!.role === m[i - 1]!.role).toBe(false);
  });
});

describe("think", () => {
  it("returns a validated thought", async () => {
    const ai = new FakeAi();
    ai.queue.push(JSON.stringify({ say: "Heya!", emotion: "happy", intensity: 2, gesture: "wave", gaze: "user", voice: { pace: "fast", pitch: 1 }, speak: true, remember: ["Ishaan has a cat named Mochi"], action: { kind: "Reminder", text: "drink water", in_minutes: 30 } }));
    const t = await think(ai, buildMessages(input), { replyTo: "evt_1" });
    expect(t.canned).toBe(false);
    expect(t.performance).toMatchObject({ say: "Heya!", intensity: 1, reply_to: "evt_1" });
    expect(t.remember).toEqual(["Ishaan has a cat named Mochi"]);
    expect(t.action).toMatchObject({ kind: "reminder", in_minutes: 30 });
  });
  it("retries once with a JSON nudge", async () => {
    const ai = new FakeAi();
    ai.queue.push("Sure! Here you go", JSON.stringify({ say: "ok!", emotion: "happy" }));
    const t = await think(ai, buildMessages(input));
    expect(ai.chatCalls).toHaveLength(2);
    expect(ai.chatCalls[1]!.at(-1)!.content).toMatch(/only the JSON/i);
    expect(t.performance.say).toBe("ok!");
  });
  it("falls back to canned after two bad replies", async () => {
    const ai = new FakeAi();
    ai.queue.push("nope", "still nope");
    const t = await think(ai, buildMessages(input));
    expect(t.canned).toBe(true);
    expect(t.performance.say.length).toBeGreaterThan(0);
  });
  it("falls back immediately when all models are down", async () => {
    const ai = new FakeAi();
    ai.queue.push(new AiError("all down"));
    const t = await think(ai, buildMessages(input));
    expect(ai.chatCalls).toHaveLength(1);
    expect(t.canned).toBe(true);
  });
  it("accepts JSON wrapped in a code fence", async () => {
    const ai = new FakeAi();
    ai.queue.push("```json\n{\"say\":\"fenced\",\"emotion\":\"shy\"}\n```");
    expect((await think(ai, buildMessages(input))).performance).toMatchObject({ say: "fenced", emotion: "shy" });
  });
  it("counts model calls", async () => {
    const ai = new FakeAi();
    let n = 0;
    ai.queue.push("bad", "bad");
    await think(ai, buildMessages(input), { onModelCall: () => n++ });
    expect(n).toBe(2);
  });
});

describe("sanitizers", () => {
  it("remember", () => {
    expect(sanitizeRemember(["ok fact here", 5, "x", "a".repeat(400), "b fact", "c fact", "d fact"])).toEqual(["ok fact here", "b fact", "c fact"]);
    expect(sanitizeRemember("nope")).toEqual([]);
  });
  it("action", () => {
    expect(sanitizeAction({ kind: " Call " })).toEqual({ kind: "call" });
    expect(sanitizeAction({})).toBe(null);
    expect(sanitizeAction([1])).toBe(null);
  });
  it("canned is valid", () => {
    const p = cannedPerformance("e", 1);
    expect(p.reply_to).toBe("e");
    expect(p.speak).toBe(true);
  });
});

describe("coding", () => {
  const diff = "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,1 +1,1 @@\n-foo()\n+bar()\n";
  it("validates diffs", () => {
    expect(looksLikeUnifiedDiff(diff)).toBe(true);
    expect(looksLikeUnifiedDiff("just change foo to bar")).toBe(false);
    expect(sanitizeSuggestion({ explanation: "x", patch: "nonsense", line: 3 })).toEqual({ explanation: "x", patch: null, line: 3 });
    expect(sanitizeSuggestion({ explanation: "", patch: null })).toBe(null);
    expect(sanitizeSuggestion({ explanation: "e", patch: diff, line: -1 })).toEqual({ explanation: "e", patch: diff, line: null });
  });
  it("thinkCoding returns suggestion", async () => {
    const ai = new FakeAi();
    ai.queue.push(JSON.stringify({ say: "Found it!", emotion: "proud", suggestion: { explanation: "typo", patch: diff, line: 1 } }));
    const t = await thinkCoding(ai, [{ role: "user", content: "x" }]);
    expect(t.suggestion?.patch).toBe(diff);
  });
});

describe("draftReply", () => {
  it("extracts text", async () => {
    const ai = new FakeAi();
    ai.queue.push(JSON.stringify({ text: "\"Sure, calling at 6!\"" }));
    expect(await draftReply(ai, [])).toBe("Sure, calling at 6!");
  });
  it("null on failure", async () => {
    const ai = new FakeAi();
    ai.queue.push(new Error("x"));
    expect(await draftReply(ai, [])).toBe(null);
  });
});
