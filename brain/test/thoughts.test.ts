import { describe, expect, it } from "vitest";
import {
  type ActivityLogRow, type GossipInput, activityDurations, callbackCandidates, detectWorld, extendWorld, gossipAllowed, gossipCandidates, isSensitive,
  sameStory, thoughtsWire,
} from "../src/brain/thoughts";

const IST = 5.5 * 3600_000;
const DAY = 86_400_000;
const at = (dayOffset: number, h: number, m = 0) => Date.UTC(2026, 9, 16 + dayOffset, h, m) - IST; // local IST wall clock
const dayStart = at(0, 4);
const lh = (ts: number) => {
  const d = new Date(ts + IST);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
};

function input(over: Partial<GossipInput> = {}): GossipInput {
  return {
    now: at(0, 20), dayStart, dayKey: "2026-10-16", localHour: lh, messages: [], activity: [],
    contacts: new Map([["rahul", { name: "Rahul", relation: null }], ["boss", { name: "Boss", relation: "work" }], ["jaanu", { name: "Jaanu", relation: null }]]),
    profile: { gossip_enabled: true, gossip_block: [] },
    ...over,
  };
}

const burst = (who: string, n: number, base = at(0, 10)) => Array.from({ length: n }, (_, i) => ({ who_key: who, ts: base + i * 60_000 }));

describe("gossip candidates", () => {
  it("unusually many messages from a contact today → names and counts only", () => {
    const g = gossipCandidates(input({ messages: [...burst("rahul", 12), { who_key: "rahul", ts: at(-3, 10) }] }));
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ kind: "gossip", subject_key: "rahul" });
    expect(g[0]!.fact).toMatch(/Rahul has sent 12 messages today/);
    expect(g[0]!.expires_at).toBe(dayStart + DAY);
  });
  it("normal volume is not gossip", () => {
    const usual = Array.from({ length: 14 }, (_, d) => burst("rahul", 8, at(-d - 1, 10))).flat();
    expect(gossipCandidates(input({ messages: [...burst("rahul", 9), ...usual] }))).toHaveLength(0);
  });
  it("work contacts and romantic-looking names are off-limits", () => {
    expect(gossipCandidates(input({ messages: burst("boss", 20) }))).toHaveLength(0);
    expect(gossipCandidates(input({ messages: burst("jaanu", 20) }))).toHaveLength(0);
  });
  it("respects gossip_enabled and the per-contact blocklist", () => {
    const msgs = burst("rahul", 12);
    expect(gossipCandidates(input({ messages: msgs, profile: { gossip_enabled: false, gossip_block: [] } }))).toHaveLength(0);
    expect(gossipCandidates(input({ messages: msgs, profile: { gossip_enabled: true, gossip_block: [{ key: "rahul", label: "Rahul" }] } }))).toHaveLength(0);
  });
  it("coding streak, shows watched several evenings, late nights, long app time", () => {
    const act: ActivityLogRow[] = [];
    for (let d = 0; d < 4; d++) {
      act.push({ activity: "coding", front_app: "Xcode", ts: at(-d, 10) }, { activity: "idle", front_app: "Finder", ts: at(-d, 11, 30) });
      act.push({ activity: "video", front_app: "Netflix", ts: at(-d, 21) }, { activity: "away", front_app: null, ts: at(-d, 22, 30) });
    }
    act.push({ activity: "browsing", front_app: "Safari", ts: at(0, 1, 30) }, { activity: "away", front_app: null, ts: at(0, 2, 30) });
    act.push({ activity: "browsing", front_app: "Safari", ts: at(-1, 1, 30) }, { activity: "away", front_app: null, ts: at(-1, 2, 30) });
    act.sort((a, b) => a.ts - b.ts);
    const facts = gossipCandidates(input({ now: at(1, 0), activity: act })).map((g) => g.fact);
    expect(facts.some((f) => /4-day coding streak/.test(f))).toBe(true);
    expect(facts.some((f) => /evening in a row watching something on Netflix/.test(f))).toBe(true);
    expect(facts.some((f) => /past 1 am on 2 of the last 3 nights/.test(f))).toBe(true);
  });
  it("sensitive apps never become gossip (health, money, dating, maps, work tools)", () => {
    for (const app of ["Practo", "Zerodha Kite", "Tinder", "Google Maps", "Slack", "Paytm"]) {
      const act: ActivityLogRow[] = [{ activity: "browsing", front_app: app, ts: at(0, 9) }, { activity: "browsing", front_app: app, ts: at(0, 10, 50) }, { activity: "browsing", front_app: app, ts: at(0, 12, 40) }, { activity: "away", front_app: null, ts: at(0, 14) }];
      expect(gossipCandidates(input({ activity: act })).filter((g) => g.fact.includes(app)), app).toHaveLength(0);
    }
  });
  it("durations cap long gaps and skip away", () => {
    const d = activityDurations([{ activity: "coding", front_app: "Xcode", ts: 0 }, { activity: "away", front_app: null, ts: 10 * 3600_000 }], 0, 12 * 3600_000);
    expect(d.get("coding|Xcode")).toBe(2 * 3600_000);
  });
});

describe("privacy filter", () => {
  it.each([
    "Mom has been at the hospital", "salary credited", "Priya's boyfriend", "temple visit", "election results", "trip to Goa",
    "Jira ticket", "funeral", "court date", "lost weight", "Rahul visited Delhi",
  ])("%s is sensitive", (t) => expect(isSensitive(t)).toBe(true));
  it.each(["Rahul has sent 12 messages today", "4-day coding streak", "watching something on Netflix"])("%s is fine", (t) => expect(isSensitive(t)).toBe(false));
  it("blocklist matches by key and by name in the fact", () => {
    const p = { gossip_enabled: true, gossip_block: [{ key: "rahul", label: "Rahul" }] };
    expect(gossipAllowed({ fact: "Rahul has sent 12 messages", subject_key: "someone" }, p)).toBe(false);
    expect(gossipAllowed({ fact: "coding streak", subject_key: "coding" }, p)).toBe(true);
  });
});

describe("world notes", () => {
  it("detects notable events in window titles, keeps the headline", () => {
    const w = detectWorld("India wins the T20 World Cup final - YouTube", "window", "Safari");
    expect(w).not.toBeNull();
    expect(w!.note).toBe("India wins the T20 World Cup final");
  });
  it("transcripts / OCR / chat are never quoted: only keywords", () => {
    const w = detectWorld("and in breaking news ISRO launches Gaganyaan crew capsule today", "transcript");
    expect(w!.note).toMatch(/^Something about/);
    expect(w!.note).not.toContain("breaking news ISRO launches");
  });
  it("ignores messaging apps, sensitive topics and ordinary text", () => {
    expect(detectWorld("India wins the final", "window", "WhatsApp")).toBeNull();
    expect(detectWorld("Election results live updates - BBC", "window", "Safari")).toBeNull();
    expect(detectWorld("main.ts - pixie - Visual Studio Code", "window", "Code")).toBeNull();
  });
  it("same story recognition and bounded extension", () => {
    expect(sameStory(["cup", "india", "world"], ["final", "india", "world"])).toBe(true);
    expect(sameStory(["cup", "india"], ["launch", "isro"])).toBe(false);
    const t0 = 1_000_000;
    const e = extendWorld({ salience: 0.4, expires_at: t0 + 3 * DAY, created_at: t0 }, t0 + 2 * DAY);
    expect(e.expires_at).toBe(t0 + 5 * DAY);
    expect(e.salience).toBe(0.5);
    expect(extendWorld({ salience: 0.9, expires_at: t0 + 6 * DAY, created_at: t0 }, t0 + 6 * DAY).expires_at).toBe(t0 + 7 * DAY);
  });
});

describe("callbacks and wire", () => {
  const mems = [
    { id: 1, kind: "episode", text: "Ishaan finished the auth refactor", value: 0.8, ts: at(-5, 10) },
    { id: 2, kind: "fact", text: "Ishaan went to Goa last week", value: 0.9, ts: at(-5, 10) },
    { id: 3, kind: "fact", text: "Ishaan has a doctor appointment", value: 0.9, ts: at(-5, 10) },
    { id: 4, kind: "fact", text: "Ishaan likes chai", value: 0.3, ts: at(-5, 10) },
  ];
  it("only once familiarity is moderate; skips places, sensitive and minor memories", () => {
    expect(callbackCandidates(mems, 0.1, at(0, 12), dayStart, "d")).toEqual([]);
    const c = callbackCandidates(mems, 0.5, at(0, 12), dayStart, "d");
    expect(c.map((t) => t.subject_key)).toEqual(["1"]);
    expect(c[0]!.kind).toBe("callback");
  });
  it("wire has no text and drops expired", () => {
    const w = thoughtsWire([{ id: "th_a", kind: "gossip", salience: 0.5, expires_at: 10, fact: "secret", subject_key: "x" }, { id: "th_b", kind: "world", salience: 0.4, expires_at: 1, fact: "x", subject_key: null }], 5);
    expect(w).toEqual([{ id: "th_a", kind: "gossip", salience: 0.5, expires_at: 10 }]);
  });
});
