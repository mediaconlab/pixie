import { describe, expect, it } from "vitest";
import { BASELINE, HALF_LIFE_MS, decay, energyBaseline, initialMood, isLateNight, moodEventFromText, moodForWire, nudge } from "../src/brain/mood";

// 2026-10-16 06:30 UTC = 12:00 IST
const NOON_IST = Date.UTC(2026, 9, 16, 6, 30);
// 2026-10-16 21:30 UTC = 03:00 IST (17th)
const THREE_AM_IST = Date.UTC(2026, 9, 16, 21, 30);

describe("mood", () => {
  it("starts at baseline", () => {
    const m = initialMood(NOON_IST);
    expect(m.valence).toBe(BASELINE.valence);
    expect(m.energy).toBe(BASELINE.energy);
  });
  it("decays halfway to baseline after one half-life", () => {
    const m = { valence: 1, energy: 1, ts: NOON_IST };
    const d = decay(m, NOON_IST + HALF_LIFE_MS);
    expect(d.valence).toBeCloseTo(BASELINE.valence + (1 - BASELINE.valence) / 2, 5);
    expect(d.energy).toBeCloseTo(BASELINE.energy + (1 - BASELINE.energy) / 2, 5);
  });
  it("converges to baseline over long time", () => {
    const d = decay({ valence: -1, energy: 0, ts: NOON_IST }, NOON_IST + 20 * HALF_LIFE_MS);
    expect(d.valence).toBeCloseTo(BASELINE.valence, 3);
    expect(d.energy).toBeCloseTo(BASELINE.energy, 3);
  });
  it("no time passed → unchanged", () => {
    const m = { valence: 0.7, energy: 0.2, ts: NOON_IST };
    expect(decay(m, NOON_IST)).toEqual(m);
  });
  it("pats and compliments raise valence", () => {
    const m = initialMood(NOON_IST);
    expect(nudge(m, "pat", NOON_IST).valence).toBeGreaterThan(m.valence);
    expect(nudge(m, "compliment", NOON_IST).valence).toBeGreaterThan(m.valence);
    expect(nudge(m, "fixed_error", NOON_IST).valence).toBeGreaterThan(m.valence);
  });
  it("repeated errors lower valence slightly", () => {
    const m = initialMood(NOON_IST);
    const n = nudge(m, "repeated_error", NOON_IST);
    expect(n.valence).toBeLessThan(m.valence);
    expect(m.valence - n.valence).toBeLessThan(0.1);
  });
  it("is clamped", () => {
    let m = initialMood(NOON_IST);
    for (let i = 0; i < 50; i++) m = nudge(m, "pat", NOON_IST);
    expect(m.valence).toBe(1);
    for (let i = 0; i < 50; i++) m = nudge(m, "rude", NOON_IST);
    expect(m.valence).toBe(-1);
    for (let i = 0; i < 50; i++) m = nudge(m, "rate_limited", NOON_IST);
    expect(m.energy).toBe(0);
  });
  it("late night in IST lowers energy", () => {
    expect(isLateNight(THREE_AM_IST)).toBe(true);
    expect(isLateNight(NOON_IST)).toBe(false);
    expect(energyBaseline(THREE_AM_IST)).toBeLessThan(energyBaseline(NOON_IST));
    const m = { valence: 0.2, energy: 0.6, ts: THREE_AM_IST - 2 * HALF_LIFE_MS };
    expect(decay(m, THREE_AM_IST).energy).toBeLessThan(0.6);
    const day = nudge(initialMood(NOON_IST), "chat", NOON_IST);
    const night = nudge({ ...initialMood(THREE_AM_IST) }, "chat", THREE_AM_IST);
    expect(night.energy).toBeLessThan(day.energy);
  });
  it("text → mood event", () => {
    expect(moodEventFromText("*pats head*")).toBe("pat");
    expect(moodEventFromText("good job pixie")).toBe("compliment");
    expect(moodEventFromText("thank you!")).toBe("thanks");
    expect(moodEventFromText("shut up")).toBe("rude");
    expect(moodEventFromText("what's the time")).toBe(null);
  });
  it("wire format rounds", () => {
    expect(moodForWire({ valence: 0.12345, energy: 0.6789, ts: 0 })).toEqual({ valence: 0.12, energy: 0.68 });
  });
});
