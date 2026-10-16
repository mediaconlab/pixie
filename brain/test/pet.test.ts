import { describe, expect, it } from "vitest";
import {
  BOND_DAILY_CAP, BOND_FLOOR, BOND_START, DEFAULT_RHYTHM, TRAIT_BOUNDS, TRAIT_DRIFT_MAX, TRAIT_NAMES, addBond, dailyLineCap, describePetState,
  driftTraits, ensureDayMood, fadeBond, familiarityFor, learnRhythm, newProfile, normalizeProfile, noteContact, profileWire, speakDecline,
  talkScale, updateFamiliarity, weeklyChattiness,
} from "../src/brain/pet";

const T0 = Date.UTC(2026, 9, 16, 6, 30); // 12:00 IST
const DAY = 86_400_000;
const seq = (...xs: number[]) => {
  let i = 0;
  return () => xs[i++ % xs.length]!;
};

describe("profile seeding", () => {
  it("seeds every trait once, in the moderate range", () => {
    const p = newProfile(T0, seq(0, 1, 0.5, 0.25, 0.75, 0.1));
    for (const n of TRAIT_NAMES) {
      expect(p.traits[n]).toBeGreaterThanOrEqual(0.35);
      expect(p.traits[n]).toBeLessThanOrEqual(0.65);
    }
    expect(p.traits.curiosity).toBe(0.35);
    expect(p.traits.chattiness).toBe(0.65);
    expect(p.seed).toEqual(p.traits);
    expect(p.bond).toBe(BOND_START);
    expect(p.familiarity).toBe(0);
    expect(p.rhythm).toEqual(DEFAULT_RHYTHM);
    expect(p.gossip_enabled).toBe(true);
  });
  it("normalizing a stored profile keeps its traits (no re-seed) and fills new fields", () => {
    const stored = { traits: { curiosity: 0.6, chattiness: 0.4, agreeableness: 0.5, sensitivity: 0.5, sass: 0.5, clinginess: 0.5 }, bond: 40 } as never;
    const p = normalizeProfile(stored, T0, () => 0.99);
    expect(p.traits.curiosity).toBe(0.6);
    expect(p.bond).toBe(40);
    expect(p.quiet_when).toEqual([]);
    expect(p.seed.curiosity).toBe(0.6);
  });
});

describe("talk scale and wire", () => {
  it("0.5 in the first 7 days, then 1.0; less_needy reduces it", () => {
    const p = newProfile(T0, () => 0.5);
    expect(talkScale(p, T0 + DAY)).toBe(0.5);
    expect(profileWire(p, T0 + DAY).first_week).toBe(true);
    expect(talkScale(p, T0 + 8 * DAY)).toBe(1);
    p.less_needy = 0.5;
    expect(talkScale(p, T0 + 8 * DAY)).toBe(0.75);
    expect(talkScale(p, T0 + DAY)).toBe(0.38);
  });
  it("wire form matches PROTOCOL §4.2 and hides an expired quiet_until", () => {
    const p = newProfile(T0, () => 0.5);
    p.quiet_until = T0 - 1;
    const w = profileWire(p, T0);
    expect(Object.keys(w).sort()).toEqual(["bond", "day_mood", "familiarity", "first_week", "gossip_enabled", "less_needy", "quiet_until", "rhythm", "talk_scale", "traits"]);
    expect(w.quiet_until).toBe(0);
    p.quiet_when = ["coding"];
    expect(profileWire(p, T0).quiet_when).toEqual(["coding"]);
  });
  it("daily line cap scales with talk_scale and chattiness", () => {
    const p = newProfile(T0, () => 0.5);
    const first = dailyLineCap(p, T0);
    const later = dailyLineCap(p, T0 + 8 * DAY);
    expect(later).toBeGreaterThan(first);
    p.traits.chattiness = 0.2;
    expect(dailyLineCap(p, T0 + 8 * DAY)).toBeLessThan(later);
  });
});

describe("bond", () => {
  it("small gains with a daily cap that resets the next day", () => {
    const p = newProfile(T0, () => 0.5);
    let total = 0;
    for (let i = 0; i < 20; i++) total += addBond(p, 1, "2026-10-16");
    expect(total).toBe(BOND_DAILY_CAP);
    expect(p.bond).toBe(BOND_START + BOND_DAILY_CAP);
    expect(addBond(p, 1, "2026-10-16")).toBe(0);
    expect(addBond(p, 1, "2026-10-17")).toBe(1);
  });
  it("never exceeds 100", () => {
    const p = newProfile(T0, () => 0.5);
    p.bond = 99.5;
    addBond(p, 3, "d");
    expect(p.bond).toBe(100);
  });
  it("fades only after several days without contact, slowly, with a floor", () => {
    const p = newProfile(T0, () => 0.5);
    p.bond = 30;
    p.last_contact_ts = T0;
    expect(fadeBond(p, T0 + 2 * DAY, "a")).toBe(false);
    expect(p.bond).toBe(30);
    expect(fadeBond(p, T0 + 5 * DAY, "b")).toBe(true);
    expect(p.bond).toBe(29);
    expect(fadeBond(p, T0 + 5 * DAY, "b")).toBe(false); // once per night
    for (let i = 0; i < 40; i++) fadeBond(p, T0 + (6 + i) * DAY, `n${i}`);
    expect(p.bond).toBe(BOND_FLOOR);
  });
  it("a bond already below the floor never fades", () => {
    const p = newProfile(T0, () => 0.5);
    p.last_contact_ts = T0;
    expect(fadeBond(p, T0 + 20 * DAY, "x")).toBe(false);
    expect(p.bond).toBe(BOND_START);
  });
});

describe("familiarity", () => {
  it("grows with days together and memories, bounded 0..1, never decreases", () => {
    expect(familiarityFor(0, 0)).toBe(0);
    expect(familiarityFor(7, 0)).toBeGreaterThan(0);
    expect(familiarityFor(30, 50)).toBeGreaterThan(familiarityFor(30, 0));
    expect(familiarityFor(365, 5000)).toBeLessThanOrEqual(1);
    const p = newProfile(T0, () => 0.5);
    p.familiarity = 0.5;
    updateFamiliarity(p, 0);
    expect(p.familiarity).toBe(0.5);
  });
  it("counts distinct days of contact", () => {
    const p = newProfile(T0, () => 0.5);
    noteContact(p, T0, "2026-10-16");
    noteContact(p, T0 + 1000, "2026-10-16");
    noteContact(p, T0 + DAY, "2026-10-17");
    expect(p.days_together).toBe(2);
  });
});

describe("day mood", () => {
  it("is sampled once per morning", () => {
    const p = newProfile(T0, () => 0.5);
    expect(ensureDayMood(p, "2026-10-16", () => 1)).toBe(true);
    const m = p.day_mood;
    expect(Math.abs(m)).toBeLessThanOrEqual(0.4);
    expect(ensureDayMood(p, "2026-10-16", () => 0)).toBe(false);
    expect(p.day_mood).toBe(m);
    ensureDayMood(p, "2026-10-17", () => 0);
    expect(p.day_mood).toBeLessThan(m);
  });
});

describe("trait drift", () => {
  it("drifts very slowly toward how the user treats Pixie, within bounds", () => {
    const p = newProfile(T0, () => 0.5);
    const start = p.traits.agreeableness;
    p.feel = { warm: 10, cold: 0, tease: 0 };
    driftTraits(p);
    expect(p.traits.agreeableness).toBeGreaterThan(start);
    expect(p.traits.agreeableness - start).toBeLessThanOrEqual(0.011);
    expect(p.feel).toEqual({ warm: 0, cold: 0, tease: 0 });
    for (let i = 0; i < 500; i++) {
      p.feel = { warm: 0, cold: 20, tease: 0 };
      driftTraits(p);
    }
    expect(p.traits.agreeableness).toBeGreaterThanOrEqual(p.seed.agreeableness - TRAIT_DRIFT_MAX - 1e-9);
    expect(p.traits.agreeableness).toBeGreaterThanOrEqual(TRAIT_BOUNDS[0]);
  });
  it("weekly: most proactive lines ignored → less chatty", () => {
    const p = newProfile(T0, () => 0.5);
    const c = p.traits.chattiness;
    expect(weeklyChattiness(p, { replied: 1, dismissed: 4, ignored: 5 }, T0 + DAY)).toBe(false); // not a week yet
    expect(weeklyChattiness(p, { replied: 1, dismissed: 4, ignored: 5 }, T0 + 8 * DAY)).toBe(true);
    expect(p.traits.chattiness).toBeCloseTo(c - 0.05, 5);
    expect(weeklyChattiness(p, { replied: 0, dismissed: 1, ignored: 1 }, T0 + 16 * DAY)).toBe(false); // too few samples
  });
});

describe("speak caps (pure)", () => {
  const base = (over: Partial<Parameters<typeof speakDecline>[0]> = {}) => ({
    profile: newProfile(T0 - 30 * DAY, () => 0.5), now: T0, intent: "playful_bid", activity: "idle", inMeeting: false,
    linesToday: 0, gossipToday: 0, theatricalToday: 0, modelBudgetLeft: 50, ...over,
  });
  it("goes ahead normally", () => expect(speakDecline(base())).toBeNull());
  it("declines when quiet, in quiet_when, in a meeting, over caps or low on budget", () => {
    const q = base();
    q.profile.quiet_until = T0 + 1000;
    expect(speakDecline(q)).toBe("quiet");
    const qw = base({ activity: "coding" });
    qw.profile.quiet_when = ["coding"];
    expect(speakDecline(qw)).toBe("quiet");
    expect(speakDecline(base({ inMeeting: true }))).toBe("busy");
    expect(speakDecline(base({ linesToday: 999 }))).toBe("cap");
    expect(speakDecline(base({ intent: "gossip", gossipToday: 2 }))).toBe("gossip_cap");
    expect(speakDecline(base({ intent: "gossip", gossipToday: 1 }))).toBeNull();
    expect(speakDecline(base({ intent: "rant", theatricalToday: 1 }))).toBe("theatrical_cap");
    expect(speakDecline(base({ intent: "sulk_line", theatricalToday: 1 }))).toBe("theatrical_cap");
    expect(speakDecline(base({ modelBudgetLeft: 1 }))).toBe("budget");
  });
  it("the line cap is halved in the first week", () => {
    const young = base({ profile: newProfile(T0 - DAY, () => 0.5) });
    const cap = dailyLineCap(young.profile, T0);
    expect(speakDecline({ ...young, linesToday: cap })).toBe("cap");
    expect(speakDecline({ ...base(), linesToday: cap })).toBeNull();
  });
});

describe("rhythm learning", () => {
  const IST = 5.5 * 3600_000;
  const lh = (ts: number) => {
    const d = new Date(ts + IST);
    return d.getUTCHours() + d.getUTCMinutes() / 60;
  };
  // local (IST) wall-clock time on day i of the window → UTC ms
  const at = (i: number, h: number, m = 0) => Date.UTC(2026, 9, 1 + i, h, m) - IST;
  const days = Array.from({ length: 5 }, (_, i) => ({ start: at(i, 4), end: at(i + 1, 4) }));

  it("keeps defaults with too little evidence", () => {
    expect(learnRhythm(DEFAULT_RHYTHM, [], days, lh)).toEqual(DEFAULT_RHYTHM);
  });
  it("moves wake / sleep / lunch / dinner toward observed history", () => {
    const rows: Array<{ activity: string; ts: number }> = [];
    for (let i = 0; i < 5; i++) {
      rows.push({ activity: "browsing", ts: at(i, 7) }); // up at 07:00
      rows.push({ activity: "away", ts: at(i, 12, 30) }); // lunch 12:30-13:15
      rows.push({ activity: "coding", ts: at(i, 13, 15) });
      rows.push({ activity: "away", ts: at(i, 19) }); // dinner 19:00-19:50
      rows.push({ activity: "idle", ts: at(i, 19, 50) });
      rows.push({ activity: "browsing", ts: at(i + 1, 1, 30) }); // still up at 01:30
      rows.push({ activity: "away", ts: at(i + 1, 2) }); // to bed at 02:00
    }
    const r = learnRhythm(DEFAULT_RHYTHM, rows, days, lh);
    expect(r.wake_hour).toBeLessThan(DEFAULT_RHYTHM.wake_hour);
    expect(r.wake_hour).toBeGreaterThanOrEqual(7);
    expect(r.sleep_hour).toBeGreaterThan(DEFAULT_RHYTHM.sleep_hour);
    expect(r.sleep_hour).toBeLessThan(2.01);
    expect(r.lunch_hour).toBeLessThan(DEFAULT_RHYTHM.lunch_hour);
    expect(r.dinner_hour).toBeLessThan(DEFAULT_RHYTHM.dinner_hour);
    // repeated nights converge
    let rr = DEFAULT_RHYTHM;
    for (let k = 0; k < 20; k++) rr = learnRhythm(rr, rows, days, lh);
    expect(rr.wake_hour).toBeCloseTo(7, 0);
    expect(rr.sleep_hour).toBeCloseTo(2, 0);
  });
  it("rounds to quarter hours before wrapping, so a late bedtime never comes out as 24", () => {
    const rows: Array<{ activity: string; ts: number }> = [];
    for (let i = 0; i < 5; i++) {
      rows.push({ activity: "browsing", ts: at(i, 23, 50) });
      rows.push({ activity: "away", ts: at(i + 1, 0, 15) }); // to bed at 00:15 (24.25)
    }
    // 23.75 + (24.25 - 23.75) * 0.3 = 23.9 → rounds to 24 → wraps to 0 (wrapping first gave 24)
    const r = learnRhythm({ ...DEFAULT_RHYTHM, sleep_hour: 23.75 }, rows, days, lh);
    expect(r.sleep_hour).toBe(0);
    for (const v of Object.values(r)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(24);
      expect(v * 4).toBe(Math.round(v * 4));
    }
  });
  it("pet wake signals count as waking up", () => {
    const sig = [0, 1, 2, 3].map((i) => at(i, 6));
    const r = learnRhythm(DEFAULT_RHYTHM, [], days, lh, sig);
    expect(r.wake_hour).toBeLessThan(DEFAULT_RHYTHM.wake_hour);
  });
});

describe("pet.state in words", () => {
  it("renders phase and needs", () => {
    expect(describePetState(null)).toBe("awake");
    const s = describePetState({ phase: "sleepy", sleep_pressure: 0.8, energy: 0.2, social: 0.8, boredom: 0.7, snack: 0.9, mood: { p: 0.5, a: 0, d: 0 }, emotion: "sleepy", ladder: 0 });
    expect(s).toContain("getting sleepy");
    expect(s).toContain("low on energy");
    expect(s).toContain("peckish");
  });
});
