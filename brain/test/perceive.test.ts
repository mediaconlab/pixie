import { describe, expect, it } from "vitest";
import {
  PERIODIC_EVERY_N, VISION_MIN_INTERVAL_MS, appendTranscript, blendUrgency, repeatBoost, callObservation, callUrgency, classifyMessage,
  codeWindow, frameFingerprint, guessImportance, guessRelation, hasEmergencyKeyword, heuristicUrgency, ideObservation,
  needsCodingHelp, normalizePhone, ocrHasErrors, phoneHash, shouldCaption,
} from "../src/brain/perceive";
import type { IdeContextData, PhoneMessageData } from "../src/protocol";
import { FakeAi } from "./helpers";

describe("contacts", () => {
  it("normalizes phone numbers", () => {
    expect(normalizePhone("+91 98765-43210")).toBe("9876543210");
    expect(normalizePhone("09876543210")).toBe("9876543210");
  });
  it("hashes equivalent numbers equally and never returns the number", async () => {
    const a = await phoneHash("+919876543210");
    const b = await phoneHash("09876543210");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await phoneHash("12")).toBe(null);
  });
  it("guesses importance", () => {
    expect(guessImportance("Mom")).toBeGreaterThan(0.8);
    expect(guessImportance("Papa")).toBeGreaterThan(0.8);
    expect(guessImportance("HDFC Bank")).toBeLessThan(0.2);
    expect(guessImportance("+91 99999 88888")).toBeLessThan(0.3);
    expect(guessImportance("Rahul")).toBeCloseTo(0.45);
    expect(guessRelation("Mom")).toBe("family");
    expect(guessRelation("Boss")).toBe("work");
  });
});

describe("calls", () => {
  it("urgency follows importance", () => {
    expect(callUrgency(0.9, "ringing")).toBeGreaterThan(callUrgency(0.2, "ringing"));
    expect(callUrgency(1, "ringing")).toBeLessThanOrEqual(1);
  });
  it("observation uses contact name", () => {
    const o = callObservation({ state: "ringing", number: "+911234567890", name: null }, { name: "Mom", phone_hash: "x", relation: "family", importance: 0.9 });
    expect(o.summary).toBe("Mom is calling");
    expect(o.urgency).toBeGreaterThan(0.9);
  });
});

describe("message urgency heuristics", () => {
  const base = { preview: "hey", importance: 0.4, recentFromSender: 1, isGroup: false };
  it("keywords raise urgency", () => {
    for (const w of ["URGENT pls", "emergency!!", "call me asap", "in the hospital"]) {
      expect(heuristicUrgency({ ...base, preview: w })).toBeGreaterThanOrEqual(0.6);
    }
    expect(heuristicUrgency(base)).toBeLessThan(0.3);
  });
  it("repeated messages raise urgency (after blending)", () => {
    expect(repeatBoost(1)).toBe(0);
    expect(repeatBoost(2)).toBe(0.1);
    expect(repeatBoost(4)).toBe(0.3);
    expect(blendUrgency(0.3, 0.3, false, 4)).toBeCloseTo(0.6);
    expect(blendUrgency(0.3, 0.3, false, 1)).toBeCloseTo(0.3);
  });
  it("important contacts raise urgency; groups lower it", () => {
    expect(heuristicUrgency({ ...base, importance: 0.9 })).toBeGreaterThan(heuristicUrgency(base));
    expect(heuristicUrgency({ ...base, isGroup: true })).toBeLessThan(heuristicUrgency(base));
  });
  it("is clamped 0..1", () => {
    const u = heuristicUrgency({ preview: "EMERGENCY call me now!!! ???", importance: 1, recentFromSender: 10, isGroup: false });
    expect(u).toBeLessThanOrEqual(1);
    expect(heuristicUrgency({ preview: "promo", importance: 0, recentFromSender: 0, isGroup: true })).toBeGreaterThanOrEqual(0);
  });
  it("blends with model and keeps emergency floor", () => {
    expect(blendUrgency(0.2, null, false)).toBe(0.2);
    expect(blendUrgency(0.2, 1, false)).toBeCloseTo(0.55 + 0.09);
    expect(blendUrgency(0.3, 0.1, true)).toBe(0.6);
    expect(hasEmergencyKeyword("ambulance called")).toBe(true);
  });
});

describe("classifyMessage", () => {
  const msg: PhoneMessageData = { app: "whatsapp", from: "Mom", conversation: null, preview: "Call me when free", is_group: false, key: "k", replyable: true };
  it("parses model JSON", async () => {
    const ai = new FakeAi();
    ai.queue.push(JSON.stringify({ urgency: 0.7, summary: "Mom wants a call back", expects_reply: true }));
    const c = await classifyMessage(ai, msg, "family");
    expect(c).toEqual({ urgency: 0.7, summary: "Mom wants a call back", expects_reply: true });
  });
  it("clamps and falls back", async () => {
    const ai = new FakeAi();
    ai.queue.push(JSON.stringify({ urgency: 7 }));
    const c = await classifyMessage(ai, msg, null);
    expect(c.urgency).toBe(1);
    expect(c.summary).toBe("Mom sent a message");
  });
  it("never throws on model failure", async () => {
    const ai = new FakeAi();
    ai.queue.push(new Error("boom"));
    expect((await classifyMessage(ai, msg, null)).urgency).toBe(null);
  });
});

describe("vision gate", () => {
  const g = { reason: "periodic" as const, watching: false, hasImage: true, now: 100_000, lastVisionTs: 0, periodicSinceCaption: PERIODIC_EVERY_N, changed: true };
  it("asked always captions", () => expect(shouldCaption({ ...g, reason: "asked", lastVisionTs: g.now - 1 })).toBe(true));
  it("no image → no caption", () => expect(shouldCaption({ ...g, reason: "asked", hasImage: false })).toBe(false));
  it("at most one per 20 s when not asked", () => {
    expect(shouldCaption({ ...g, lastVisionTs: g.now - VISION_MIN_INTERVAL_MS + 1 })).toBe(false);
    expect(shouldCaption({ ...g, reason: "watch", lastVisionTs: g.now - 5_000 })).toBe(false);
  });
  it("periodic needs Nth frame and a change", () => {
    expect(shouldCaption(g)).toBe(true);
    expect(shouldCaption({ ...g, periodicSinceCaption: PERIODIC_EVERY_N - 1 })).toBe(false);
    expect(shouldCaption({ ...g, changed: false })).toBe(false);
  });
  it("watch mode captions on change", () => {
    expect(shouldCaption({ ...g, reason: "watch", periodicSinceCaption: 0 })).toBe(true);
    expect(shouldCaption({ ...g, reason: "watch", periodicSinceCaption: 0, changed: false, lastVisionTs: g.now - 30_000 })).toBe(false);
  });
  it("fingerprint changes with content", () => {
    const a = frameFingerprint({ reason: "periodic", front_app: "Safari", window: "a", ocr: "x" });
    const b = frameFingerprint({ reason: "periodic", front_app: "Safari", window: "a", ocr: "y" });
    expect(a).not.toBe(b);
  });
  it("detects errors in OCR", () => {
    expect(ocrHasErrors("TypeError: undefined is not a function")).toBe(true);
    expect(ocrHasErrors("Hello world")).toBe(false);
  });
});

describe("transcript buffer", () => {
  it("drops old and oversized chunks", () => {
    let buf = appendTranscript([], { text: "old", ts: 0 });
    buf = appendTranscript(buf, { text: "new", ts: 4 * 60_000 });
    expect(buf.map((c) => c.text)).toEqual(["new"]);
    for (let i = 0; i < 20; i++) buf = appendTranscript(buf, { text: "x".repeat(300), ts: 4 * 60_000 + i });
    expect(buf.reduce((n, c) => n + c.text.length, 0)).toBeLessThanOrEqual(3000);
  });
});

describe("ide", () => {
  const d: IdeContextData = {
    file: "src/app.ts", language: "typescript",
    content: Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n"),
    selection: null,
    diagnostics: [{ line: 100, severity: "error", message: "Cannot find name 'foo'" }],
    question: null, reason: "diagnostics",
  };
  it("needs help on errors or questions", () => {
    expect(needsCodingHelp(d)).toBe(true);
    expect(needsCodingHelp({ ...d, diagnostics: [{ line: 1, severity: "warning", message: "w" }] })).toBe(false);
    expect(needsCodingHelp({ ...d, diagnostics: [], question: "why?" })).toBe(true);
  });
  it("code window centers on first error with line numbers", () => {
    const w = codeWindow(d, 5);
    expect(w.start).toBe(95);
    expect(w.text.split("\n")).toHaveLength(11);
    expect(w.text).toContain(" 100| line 100");
  });
  it("observation mentions errors", () => {
    expect(ideObservation(d).text).toContain("line 100");
  });
});
