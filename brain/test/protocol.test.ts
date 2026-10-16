import { describe, expect, it } from "vitest";
import { MIN_PROTOCOL, PROTOCOL_VERSION, envelope, needsUpdate, parseEnvelope, perf, sanitizePerformance, updateRequiredData } from "../src/protocol";

const env = (type: string, data: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ v: 1, id: "evt_1", ts: 123, type, data, ...extra });

describe("parseEnvelope", () => {
  it("rejects invalid JSON / missing id / unknown type / wrong version", () => {
    expect(parseEnvelope("nope")).toMatchObject({ ok: false, code: "bad_event" });
    expect(parseEnvelope(JSON.stringify({ type: "hello" }))).toMatchObject({ ok: false });
    expect(parseEnvelope(JSON.stringify({ id: "x".repeat(65), type: "hello" }))).toMatchObject({ ok: false });
    expect(parseEnvelope(env("teleport", {}))).toMatchObject({ ok: false, id: "evt_1" });
    expect(parseEnvelope(env("hello", { kind: "mac" }, { v: 2 }))).toMatchObject({ ok: false });
  });
  it("rejects oversized frames", () => {
    expect(parseEnvelope("x".repeat(1024 * 1024 + 1))).toMatchObject({ ok: false, message: "frame too large" });
  });
  it("parses hello", () => {
    const r = parseEnvelope(env("hello", { kind: "mac", name: "MacBook Air", app_version: "1.0.0", capabilities: ["screen", 3] }));
    expect(r).toMatchObject({ ok: true, event: { type: "hello", id: "evt_1", ts: 123, data: { kind: "mac", capabilities: ["screen"] } } });
    expect(parseEnvelope(env("hello", { kind: "toaster" }))).toMatchObject({ ok: false });
  });
  it("hello.protocol defaults to 1 when missing or invalid", () => {
    const get = (data: Record<string, unknown>) => {
      const r = parseEnvelope(env("hello", { kind: "mac", ...data }));
      return r.ok && r.event.type === "hello" ? r.event.data.protocol : -1;
    };
    expect(get({})).toBe(1);
    expect(get({ protocol: "2" })).toBe(1);
    expect(get({ protocol: 0 })).toBe(1);
    expect(get({ protocol: 1.5 })).toBe(1);
    expect(get({ protocol: 3 })).toBe(3);
  });
  it("update_required gating", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(MIN_PROTOCOL).toBe(1);
    expect(needsUpdate(1)).toBe(false);
    expect(needsUpdate(MIN_PROTOCOL - 1)).toBe(true);
    expect(updateRequiredData()).toEqual({ min_protocol: 1, latest_protocol: 1, message: "Please update Pixie to keep using it." });
  });
  it("parses ArrayBuffer frames", () => {
    const r = parseEnvelope(new TextEncoder().encode(env("user.say", { text: "hi" })).buffer as ArrayBuffer);
    expect(r.ok).toBe(true);
  });
  it("defaults ts to now", () => {
    const r = parseEnvelope(JSON.stringify({ id: "a", type: "user.say", data: { text: "hi" } }), 999);
    expect(r.ok && r.event.ts).toBe(999);
  });
  it("user.say requires text", () => {
    expect(parseEnvelope(env("user.say", { text: "  " }))).toMatchObject({ ok: false });
    expect(parseEnvelope(env("user.say", { text: "yo", via: "carrier pigeon" }))).toMatchObject({ ok: true, event: { data: { via: "typed" } } });
  });
  it("state.update only keeps provided fields", () => {
    const r = parseEnvelope(env("state.update", { watching: true }));
    expect(r.ok && r.event.data).toEqual({ watching: true });
  });
  it("phone.call validates state", () => {
    expect(parseEnvelope(env("phone.call", { state: "ringing", number: "+91", name: "Mom" }))).toMatchObject({ ok: true });
    expect(parseEnvelope(env("phone.call", { state: "exploded", number: "1" }))).toMatchObject({ ok: false });
  });
  it("phone.message normalizes", () => {
    const r = parseEnvelope(env("phone.message", { app: "telegram", from: "Mom", preview: "hi", key: "k", replyable: "yes" }));
    expect(r).toMatchObject({ ok: true, event: { data: { app: "other", replyable: false, is_group: false, conversation: null } } });
  });
  it("screen.frame drops non-data-url images", () => {
    const r = parseEnvelope(env("screen.frame", { image: "http://evil", reason: "asked" }));
    expect(r.ok && (r.event.data as { image?: string }).image).toBeUndefined();
  });
  it("ide.context parses diagnostics and selection", () => {
    const r = parseEnvelope(env("ide.context", { file: "a.ts", diagnostics: [{ line: 3, severity: "error", message: "bad" }, "junk"], selection: { start_line: 1, end_line: 2, text: "x" }, question: null, reason: "asked" }));
    expect(r).toMatchObject({ ok: true, event: { data: { diagnostics: [{ line: 3, severity: "error" }], selection: { start_line: 1 } } } });
  });
  it("user.feedback requires id and verdict", () => {
    expect(parseEnvelope(env("user.feedback", { proposal_id: "prp_1", verdict: "approve", edited_text: "hey" }))).toMatchObject({ ok: true, event: { data: { edited_text: "hey" } } });
    expect(parseEnvelope(env("user.feedback", { proposal_id: "prp_1", verdict: "maybe" }))).toMatchObject({ ok: false });
  });
  it("exec.result", () => {
    expect(parseEnvelope(env("exec.result", { proposal_id: "p", ok: true }))).toMatchObject({ ok: true, event: { data: { ok: true } } });
  });
});

describe("sanitizePerformance", () => {
  it("clamps and defaults everything", () => {
    const p = sanitizePerformance({ say: "hi", emotion: "furious", intensity: 7, gesture: "backflip", gaze: "ceiling", voice: { pace: "warp", pitch: 9.4 } });
    expect(p).toEqual({ say: "hi", emotion: "neutral", intensity: 1, gesture: "none", gaze: "user", voice: { pace: "normal", pitch: 2 }, speak: true });
  });
  it("tolerates garbage", () => {
    const p = sanitizePerformance("lol");
    expect(p.emotion).toBe("neutral");
    expect(p.speak).toBe(false);
    expect(sanitizePerformance(null).intensity).toBe(0.5);
  });
  it("accepts valid values and case", () => {
    const p = sanitizePerformance({ say: "Ooh", emotion: "Excited", intensity: 0.8, gesture: "JUMP", gaze: "screen", voice: { pace: "fast", pitch: -2 }, speak: true }, "evt_9");
    expect(p).toMatchObject({ emotion: "excited", gesture: "jump", gaze: "screen", voice: { pace: "fast", pitch: -2 }, reply_to: "evt_9" });
  });
  it("strips emojis and trims long text", () => {
    const p = sanitizePerformance({ say: "Yay 🎉🎉 done ✨" + "a".repeat(1000) });
    expect(p.say.startsWith("Yay done")).toBe(true);
    expect(p.say.length).toBeLessThanOrEqual(400);
  });
  it("empty say never speaks", () => {
    expect(sanitizePerformance({ say: "", speak: true }).speak).toBe(false);
  });
  it("negative intensity / NaN pitch", () => {
    const p = sanitizePerformance({ say: "x", intensity: -3, voice: { pitch: "abc" } });
    expect(p.intensity).toBe(0);
    expect(p.voice.pitch).toBe(0);
  });
  it("perf helper fills defaults", () => {
    expect(perf({ say: "hey", emotion: "happy" })).toMatchObject({ gesture: "none", gaze: "user", speak: true });
  });
});

describe("envelope", () => {
  it("builds v1 envelopes", () => {
    const e = JSON.parse(envelope("bot.perform", { say: "x" }, 5));
    expect(e).toMatchObject({ v: 1, ts: 5, type: "bot.perform", data: { say: "x" } });
    expect(typeof e.id).toBe("string");
    expect(e.id.length).toBeLessThanOrEqual(64);
  });
});
