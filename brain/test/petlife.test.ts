import { beforeEach, describe, expect, it } from "vitest";
import { BACKGROUND_MODEL_BUDGET, BrainCore, type DeviceConn } from "../src/brain/core";
import { parseEnvelope, type DeviceKind } from "../src/protocol";
import { DEFAULT_LINE_BANK } from "../src/brain/voice";
import { FakeAi, memorySql, systemOf } from "./helpers";

const T0 = Date.UTC(2026, 9, 16, 6, 30); // Fri 12:00 IST
const DAY = 86_400_000;

const meteo = (code = 2, temp = 31.4) => ({
  latitude: 28.46, longitude: 77.03, utc_offset_seconds: 19800, timezone: "Asia/Kolkata",
  current: { time: 1760600000, temperature_2m: temp, weather_code: code, is_day: 1 },
  daily: { sunrise: [1760576400], sunset: [1760618100] },
});

function setup(opts: { born?: number } = {}) {
  const sql = memorySql();
  const ai = new FakeAi();
  const sent: Array<{ device: string; type: string; data: any }> = [];
  let now = opts.born ?? T0;
  const conns: DeviceConn[] = [];
  const fetches: string[] = [];
  let weather: { code: number; temp: number } | "fail" = { code: 2, temp: 31.4 };
  const core = new BrainCore({
    sql, ai, devices: () => [...conns], registeredDevices: async () => conns.map((c) => ({ id: c.id, kind: c.kind, name: c.name })),
    setAlarm: () => {}, now: () => now, log: () => {}, random: () => 0.5,
    fetch: async (url) => {
      fetches.push(url);
      if (weather === "fail") throw new Error("offline");
      return new Response(JSON.stringify(meteo(weather.code, weather.temp)), { status: 200 });
    },
  });
  core.setUserName("Ishaan");
  core.pet.profile(); // the pet is born now
  let n = 0;
  const send = async (from: string, kind: DeviceKind, type: string, data: unknown) => {
    const id = `evt_${++n}`;
    const r = parseEnvelope(JSON.stringify({ v: 1, id, ts: now, type, data }), now);
    if (!r.ok) throw new Error(r.message);
    await core.handleEvent(r.event, { deviceId: from, kind });
    return id;
  };
  const h = {
    sql, ai, sent, core, send, fetches,
    connect: (id: string, kind: DeviceKind) => conns.push({ id, kind, name: kind, send: (t) => { const e = JSON.parse(t); sent.push({ device: id, type: e.type, data: e.data }); } }),
    advance: (ms: number) => { now += ms; },
    setNow: (t: number) => { now = t; },
    get now() { return now; },
    setWeather: (w: typeof weather) => { weather = w; },
    of: (type: string) => sent.filter((s) => s.type === type),
    clear: () => { sent.length = 0; },
    say: (text: string, via: "typed" | "voice" = "typed") => send("mac1", "mac", "user.say", { text, via }),
    speak: (intent: string, extra: Record<string, unknown> = {}) => send("mac1", "mac", "pet.speak", { intent, ...extra }),
    lastPerform: () => sent.filter((s) => s.type === "bot.perform").at(-1)?.data,
  };
  return h;
}

type H = ReturnType<typeof setup>;
let h: H;

/** Routes the fake model by prompt kind. */
function voiceAi(h: H, line: string | ((attempt: number) => string) = "ooh, psst, hi there!") {
  let attempt = 0;
  h.ai.handler = (m) => {
    const s = systemOf(m);
    if (s.includes("speech bubble")) {
      const text = typeof line === "function" ? line(attempt++) : line;
      return JSON.stringify({ say: text, emotion: "happy", gesture: "bounce", intensity: 0.6 });
    }
    if (s.includes("line bank")) return JSON.stringify(Object.fromEntries(["sleepy", "waking", "playful_bid", "ate", "weather", "reaction"].map((k) => [k, Array.from({ length: 10 }, (_, i) => ({ text: `${k} line number ${i}`, emotion: "happy", gesture: "none" }))])));
    if (s.includes("nightly diary")) return JSON.stringify({ reflection: "Ishaan had a calm coding day.", diary: "We coded together today, hehe." });
    if (s.includes("consolidate")) return JSON.stringify({ episodes: [], preferences: [] });
    if (s.includes("instruction about how Pixie")) return JSON.stringify({ instruction: "quiet", minutes: 30 });
    return JSON.stringify({ say: "Hehe hi!", emotion: "happy", gesture: "wave", speak: true, appraisal: { event: "affection", intensity: 0.7 } });
  };
}

beforeEach(() => {
  h = setup({ born: T0 - 30 * DAY });
  h.connect("mac1", "mac");
  h.connect("and1", "android");
  h.setNow(T0);
  voiceAi(h);
});

describe("hello", () => {
  it("mac hello sends pet.profile, env.update, pet.lines (default bank) and pet.thoughts", async () => {
    await h.send("mac1", "mac", "hello", { kind: "mac", name: "Mac" });
    const types = h.sent.filter((s) => s.device === "mac1").map((s) => s.type);
    expect(types).toEqual(expect.arrayContaining(["welcome", "pet.profile", "env.update", "pet.lines", "pet.thoughts"]));
    const prof = h.of("pet.profile")[0]!.data;
    expect(prof).toMatchObject({ bond: 10, familiarity: 0, gossip_enabled: true, quiet_until: 0, rhythm: { wake_hour: 8.5 } });
    expect(Object.keys(prof.traits)).toHaveLength(6);
    expect(h.of("pet.lines")[0]!.data.lines).toEqual(DEFAULT_LINE_BANK);
    expect(h.of("env.update")[0]!.data).toMatchObject({ weather: null, holiday: null, weekend: false, tz: "Asia/Kolkata" });
    expect(h.ai.chatCalls).toHaveLength(0); // no model on hello
  });
  it("android hello gets no pet messages", async () => {
    await h.send("and1", "android", "hello", { kind: "android", name: "Pixel" });
    expect(h.of("pet.profile")).toHaveLength(0);
  });
  it("a brand-new pet is in its first week: talk_scale 0.5", async () => {
    const y = setup();
    y.connect("mac1", "mac");
    await y.send("mac1", "mac", "hello", { kind: "mac", name: "Mac" });
    expect(y.of("pet.profile")[0]!.data).toMatchObject({ first_week: true, talk_scale: 0.5 });
  });
});

describe("no model calls on body / surroundings events", () => {
  it("pet.state, pet.event, signals.update, location.update never call the model", async () => {
    await h.send("mac1", "mac", "pet.state", { phase: "sleepy", sleep_pressure: 0.8, energy: 0.3, social: 0.2, boredom: 0.1, snack: 0.4, mood: { p: 0, a: 0, d: 0 }, emotion: "sleepy", ladder: 0 });
    await h.send("mac1", "mac", "pet.event", { kind: "petted" });
    await h.send("mac1", "mac", "signals.update", { mic_in_use: true, camera_in_use: true, calendar_busy_now: false });
    await h.send("and1", "android", "location.update", { lat: 28.4567, lon: 77.0312, accuracy_m: 500, source: "phone" });
    expect(h.ai.chatCalls).toHaveLength(0);
  });
});

describe("location + weather", () => {
  it("keeps only the latest coordinates (2 decimals), fetches weather, sends env.update", async () => {
    await h.send("and1", "android", "location.update", { lat: 28.45678, lon: 77.03123, accuracy_m: 500, source: "phone" });
    expect(h.core["kv"].get("location", null)).toEqual({ lat: 28.46, lon: 77.03 });
    expect(h.fetches[0]).toContain("latitude=28.46&longitude=77.03");
    const env = h.of("env.update").at(-1)!.data;
    expect(env.weather).toEqual({ temp_c: 31, condition: "cloudy", is_day: true });
    expect(env.sunrise).toBe(1760576400000);
    await h.send("and1", "android", "location.update", { lat: 19.07, lon: 72.88, accuracy_m: 500, source: "phone" });
    expect(h.core["kv"].get("location", null)).toEqual({ lat: 19.07, lon: 72.88 }); // replaced, no history
  });
  it("caches for 30 min and maps ≥ 35 °C to hot on refresh", async () => {
    await h.send("and1", "android", "location.update", { lat: 28.46, lon: 77.03, accuracy_m: 500, source: "phone" });
    expect(h.fetches).toHaveLength(1);
    h.setWeather({ code: 0, temp: 39 });
    h.advance(10 * 60_000);
    await h.send("mac1", "mac", "hello", { kind: "mac", name: "Mac" });
    expect(h.fetches).toHaveLength(1); // cached
    h.advance(61 * 60_000);
    h.clear();
    await h.core.alarm();
    expect(h.fetches).toHaveLength(2);
    expect(h.of("env.update").at(-1)!.data.weather.condition).toBe("hot");
  });
  it("tolerates fetch failures (weather null, no throw, backoff)", async () => {
    h.setWeather("fail");
    await h.send("and1", "android", "location.update", { lat: 28.46, lon: 77.03, accuracy_m: 500, source: "phone" });
    expect(h.of("error")).toHaveLength(0);
    await h.send("mac1", "mac", "hello", { kind: "mac", name: "Mac" });
    expect(h.of("env.update").at(-1)!.data.weather).toBeNull();
    expect(h.fetches).toHaveLength(1); // backoff: hello right after a failure does not refetch
  });
  it("ignores the Mac's location while a phone fix is under an hour old", async () => {
    await h.send("and1", "android", "location.update", { lat: 28.46, lon: 77.03, accuracy_m: 50, source: "phone" });
    h.advance(59 * 60_000);
    await h.send("mac1", "mac", "location.update", { lat: 19.07, lon: 72.88, accuracy_m: 5000, source: "mac" });
    expect(h.core["kv"].get("location", null)).toEqual({ lat: 28.46, lon: 77.03 });
    expect(h.fetches).toHaveLength(1);
    h.advance(2 * 60_000);
    await h.send("mac1", "mac", "location.update", { lat: 19.07, lon: 72.88, accuracy_m: 5000, source: "mac" });
    expect(h.core["kv"].get("location", null)).toEqual({ lat: 19.07, lon: 72.88 });
  });
  it("forget clears the location", async () => {
    await h.send("and1", "android", "location.update", { lat: 28.46, lon: 77.03, accuracy_m: 500, source: "phone" });
    h.core.forget();
    expect(h.core["kv"].get("location", null)).toBeNull();
  });
});

describe("instructions in user.say", () => {
  it("quiet → profile quiet_until, pet.obey with pout, short ack, no chat call", async () => {
    await h.say("be quiet");
    const ob = h.of("pet.obey")[0]!.data;
    expect(ob).toEqual({ instruction: "quiet", until: T0 + 60 * 60_000, pout: true });
    expect(h.of("pet.profile").at(-1)!.data.quiet_until).toBe(T0 + 60 * 60_000);
    const p = h.lastPerform();
    expect(p.say.split(" ").length).toBeLessThanOrEqual(5);
    expect(p.speak).toBe(false);
    expect(h.ai.chatCalls).toHaveLength(0);
  });
  it("voice instructions get a spoken ack", async () => {
    await h.say("chup raho", "voice");
    expect(h.lastPerform().speak).toBe(true);
    expect(h.lastPerform().say).toMatch(/chup|Theek/i);
  });
  it("busy = quiet 2 h", async () => {
    await h.say("I'm busy");
    expect(h.of("pet.obey")[0]!.data).toMatchObject({ instruction: "quiet", until: T0 + 120 * 60_000 });
  });
  it("same instruction within 24 h → no pout", async () => {
    await h.say("be quiet");
    h.advance(2 * 3600_000);
    await h.say("shh");
    expect(h.of("pet.obey").map((o) => o.data.pout)).toEqual([true, false]);
    h.advance(25 * 3600_000);
    await h.say("be quiet");
    expect(h.of("pet.obey").at(-1)!.data.pout).toBe(true);
  });
  it("angry text or a meeting → no pout", async () => {
    await h.say("SHUT UP");
    expect(h.of("pet.obey")[0]!.data.pout).toBe(false);
    await h.send("mac1", "mac", "state.update", { activity: "meeting" });
    await h.say("not now");
    expect(h.of("pet.obey").at(-1)!.data).toMatchObject({ instruction: "not_now", pout: false });
  });
  it("don't gossip about <name> → per-contact blocklist, no pout; gossip stays enabled", async () => {
    await h.say("don't gossip about Rahul");
    // Per-person: no pet.obey (the Mac would turn gossip off globally); the filtered thoughts are re-sent instead.
    expect(h.of("pet.obey")).toHaveLength(0);
    expect(h.of("pet.thoughts")).toHaveLength(1);
    const p = h.core.pet.profile();
    expect(p.gossip_block).toEqual([{ key: "rahul", label: "rahul" }]);
    expect(p.gossip_enabled).toBe(true);
    await h.say("you can gossip about Rahul again");
    expect(h.of("pet.obey")).toHaveLength(0);
    expect(h.of("pet.thoughts")).toHaveLength(2);
    expect(h.core.pet.profile().gossip_block).toEqual([]);
    await h.say("no gossip");
    expect(h.of("pet.obey")[0]!.data).toMatchObject({ instruction: "no_gossip", until: null });
    expect(h.core.pet.profile().gossip_enabled).toBe(false);
    await h.say("gossip is fine");
    expect(h.core.pet.profile().gossip_enabled).toBe(true);
  });
  it("less needy / more chatty change talk_scale", async () => {
    await h.say("be less needy");
    expect(h.of("pet.profile").at(-1)!.data).toMatchObject({ less_needy: 0.5, talk_scale: 0.75 });
    await h.say("talk to me more");
    expect(h.of("pet.profile").at(-1)!.data).toMatchObject({ less_needy: 0, talk_scale: 1 });
  });
  it("repeated quiet requests while coding teach quiet_when ['coding']", async () => {
    await h.send("mac1", "mac", "state.update", { activity: "coding" });
    await h.say("be quiet");
    h.advance(DAY);
    await h.say("shh");
    expect(h.core.pet.profile().quiet_when).toEqual([]);
    h.advance(DAY);
    await h.say("chup");
    expect(h.of("pet.profile").at(-1)!.data.quiet_when).toEqual(["coding"]);
    // and Pixie now declines to speak while coding, even after the timed quiet ends
    h.advance(DAY);
    await h.speak("playful_bid");
    expect(h.lastPerform().say).toBe("");
  });
  it("ambiguous phrasing uses one model parse", async () => {
    await h.say("pixie could you tone down the talking for a bit");
    expect(h.ai.chatCalls).toHaveLength(1);
    expect(systemOf(h.ai.chatCalls[0]!)).toContain("instruction about how Pixie");
    expect(h.of("pet.obey")[0]!.data).toMatchObject({ instruction: "quiet", until: T0 + 30 * 60_000 });
  });
  it("ordinary chat still reaches the chat model", async () => {
    await h.say("what's for dinner?");
    expect(h.of("pet.obey")).toHaveLength(0);
    expect(h.lastPerform().say).toBe("Hehe hi!");
  });
});

describe("pet.appraisal", () => {
  it("heuristic appraisal is sent without asking the model for one", async () => {
    await h.say("thank you so much pixie!");
    expect(h.of("pet.appraisal")[0]!.data).toMatchObject({ event: "thanks" });
    expect(systemOf(h.ai.chatCalls[0]!)).not.toContain('"appraisal"');
    expect(h.core.pet.profile().bond).toBeGreaterThan(10);
  });
  it("ambiguous messages take the appraisal from the same chat call (no extra call)", async () => {
    await h.say("you are my favourite little blob");
    expect(h.ai.chatCalls).toHaveLength(1);
    expect(systemOf(h.ai.chatCalls[0]!)).toContain('"appraisal"');
    expect(h.of("pet.appraisal")[0]!.data).toEqual({ event: "affection", intensity: 0.7 });
  });
  it("bond gains are capped per day", async () => {
    for (let i = 0; i < 15; i++) await h.say("love you pixie!!");
    expect(h.core.pet.profile().bond).toBe(15);
  });
});

describe("bubble replies that were really dismissals", () => {
  const outcomes = () => Object.fromEntries(h.sql.exec<{ name: string; n: number }>("SELECT name, COUNT(*) AS n FROM pet_log WHERE kind = 'event' GROUP BY name").toArray().map((r) => [r.name, Number(r.n)]));
  for (const text of ["be quiet", "not now", "stop", "be less needy"]) {
    it(`"${text}" within 10 s of bubble_replied → bubble_dismissed, bond gain undone`, async () => {
      const before = h.core.pet.profile().bond;
      await h.send("mac1", "mac", "pet.event", { kind: "bubble_replied", intent: "weather" });
      expect(h.core.pet.profile().bond).toBe(before + 0.5);
      h.advance(5_000);
      await h.say(text);
      expect(outcomes()).toMatchObject({ bubble_dismissed: 1 });
      expect(outcomes().bubble_replied).toBeUndefined();
      expect(h.core.pet.profile().bond).toBe(before);
      expect(h.core.pet.profile().bond_today).toBe(0);
    });
  }
  it("the instruction arriving just before the Mac's reply event also counts", async () => {
    const before = h.core.pet.profile().bond;
    await h.say("be quiet");
    h.advance(1_000);
    await h.send("mac1", "mac", "pet.event", { kind: "bubble_replied", intent: "weather" });
    expect(outcomes()).toMatchObject({ bubble_dismissed: 1 });
    expect(h.core.pet.profile().bond).toBe(before);
  });
  it("after 10 s, or for other instructions, the reply stands", async () => {
    await h.send("mac1", "mac", "pet.event", { kind: "bubble_replied" });
    h.advance(11_000);
    await h.say("be quiet");
    h.advance(11_000);
    await h.send("mac1", "mac", "pet.event", { kind: "bubble_replied" });
    h.advance(11_000);
    await h.send("mac1", "mac", "pet.event", { kind: "bubble_replied" });
    h.advance(2_000);
    await h.say("talk to me more");
    expect(outcomes()).toMatchObject({ bubble_replied: 3 });
    expect(outcomes().bubble_dismissed).toBeUndefined();
  });
  it("re-labelled replies count as dismissed in the weekly chattiness check", async () => {
    const before = h.core.pet.profile().traits.chattiness;
    for (let i = 0; i < 7; i++) {
      await h.send("mac1", "mac", "pet.event", { kind: "bubble_replied" });
      h.advance(3_000);
      await h.say(i % 2 ? "not now" : "stop");
      h.advance(60_000);
    }
    await h.core.learn();
    expect(h.core.pet.profile().traits.chattiness).toBeLessThan(before);
  });
});

describe("pet.speak", () => {
  it("writes one short line, speak false, reply_to the request", async () => {
    const id = await h.speak("playful_bid");
    const p = h.lastPerform();
    expect(p).toMatchObject({ say: "ooh, psst, hi there!", speak: false, reply_to: id });
    const sys = systemOf(h.ai.chatCalls[0]!);
    expect(sys).toContain("Intent: playful_bid");
    expect(sys).toContain("at most 15 words");
  });
  it("includes the latest pet.state in words", async () => {
    await h.send("mac1", "mac", "pet.state", { phase: "sleepy", sleep_pressure: 0.8, energy: 0.2, social: 0.2, boredom: 0.1, snack: 0.9, mood: { p: 0, a: 0, d: 0 }, emotion: "sleepy", ladder: 0 });
    await h.speak("sleepy");
    expect(systemOf(h.ai.chatCalls[0]!)).toContain("getting sleepy");
  });
  it("filters a manipulative line and regenerates once", async () => {
    voiceAi(h, (n) => (n === 0 ? "you never play with me anymore" : "tiny dance break?"));
    await h.speak("playful_bid");
    expect(h.ai.chatCalls).toHaveLength(2);
    expect(systemOf(h.ai.chatCalls[1]!)).toContain("broke a rule (manipulation)");
    expect(h.lastPerform().say).toBe("tiny dance break?");
  });
  it("falls back to the line bank when both attempts fail the filter", async () => {
    voiceAi(h, () => "don't go, stay with me");
    await h.speak("sleepy");
    expect(DEFAULT_LINE_BANK.sleepy.map((l) => l.text)).toContain(h.lastPerform().say);
  });
  it("falls back to the line bank when the model is down", async () => {
    h.ai.handler = () => { throw new Error("down"); };
    await h.speak("weather");
    expect(DEFAULT_LINE_BANK.weather.map((l) => l.text)).toContain(h.lastPerform().say);
  });
  it("declines with say '' when quiet or in a meeting", async () => {
    await h.say("be quiet");
    h.ai.chatCalls.length = 0;
    await h.speak("playful_bid");
    expect(h.lastPerform()).toMatchObject({ say: "", speak: false });
    expect(h.ai.chatCalls).toHaveLength(0);
    h.advance(61 * 60_000);
    await h.send("mac1", "mac", "signals.update", { calendar_busy_now: true });
    await h.speak("playful_bid");
    expect(h.lastPerform().say).toBe("");
  });
  it("declines when the model budget is low", async () => {
    for (let i = 0; i < BACKGROUND_MODEL_BUDGET; i++) h.sql.exec("INSERT INTO model_calls (ts) VALUES (?)", h.now);
    await h.speak("playful_bid");
    expect(h.lastPerform().say).toBe("");
  });
  it("daily cap (× talk_scale), 1 theatrical line a day", async () => {
    await h.speak("rant");
    expect(h.lastPerform().say).not.toBe("");
    await h.speak("sulk_line");
    expect(h.lastPerform().say).toBe("");
    let spoken = 1;
    for (let i = 0; i < 40; i++) {
      await h.speak("reaction");
      if (h.lastPerform().say) spoken++;
    }
    expect(spoken).toBeLessThan(30);
    expect(spoken).toBeGreaterThan(5);
    await h.speak("reaction");
    expect(h.lastPerform().say).toBe("");
    h.advance(DAY);
    await h.speak("reaction");
    expect(h.lastPerform().say).not.toBe("");
  });
  it("gossip: voices a thought by id, marks it used, max 2 a day, declines without a thought", async () => {
    await h.speak("gossip");
    expect(h.lastPerform().say).toBe(""); // no thoughts yet
    for (let i = 0; i < 12; i++) await h.send("and1", "android", "phone.message", { app: "whatsapp", from: "Rahul", conversation: null, preview: "lol", is_group: false, key: `k${i}`, replyable: false });
    for (let i = 0; i < 12; i++) await h.send("and1", "android", "phone.message", { app: "whatsapp", from: "Priya", conversation: null, preview: "lol", is_group: false, key: `p${i}`, replyable: false });
    for (let i = 0; i < 12; i++) await h.send("and1", "android", "phone.message", { app: "whatsapp", from: "Aman", conversation: null, preview: "lol", is_group: false, key: `a${i}`, replyable: false });
    h.clear();
    await h.send("mac1", "mac", "hello", { kind: "mac", name: "Mac" });
    const items = h.of("pet.thoughts")[0]!.data.items;
    expect(items.length).toBe(3);
    expect(Object.keys(items[0]).sort()).toEqual(["expires_at", "id", "kind", "salience"]);
    voiceAi(h, "Rahul's on a texting spree today, hehe");
    await h.speak("gossip", { thought_id: items[0].id });
    expect(h.lastPerform().say).toContain("texting spree");
    expect(systemOf(h.ai.chatCalls.at(-1)!)).toMatch(/Fact: \w+ has sent 12 messages today/);
    expect(h.of("pet.thoughts").at(-1)!.data.items.map((t: any) => t.id)).not.toContain(items[0].id);
    await h.speak("gossip", { thought_id: items[1].id });
    expect(h.lastPerform().say).not.toBe("");
    await h.speak("gossip", { thought_id: items[2].id });
    expect(h.lastPerform().say).toBe("");
  });
  it("gossip respects the blocklist and no_gossip", async () => {
    for (let i = 0; i < 12; i++) await h.send("and1", "android", "phone.message", { app: "whatsapp", from: "Rahul", conversation: null, preview: "lol", is_group: false, key: `k${i}`, replyable: false });
    await h.send("mac1", "mac", "hello", { kind: "mac", name: "Mac" });
    expect(h.of("pet.thoughts").at(-1)!.data.items).toHaveLength(1);
    await h.say("don't gossip about Rahul");
    expect(h.of("pet.thoughts").at(-1)!.data.items).toHaveLength(0);
    await h.speak("gossip");
    expect(h.lastPerform().say).toBe("");
  });
  it("replies to the user's own voice messages keep speak true", async () => {
    await h.say("what's up", "voice");
    expect(h.lastPerform().speak).toBe(true);
  });
});

describe("world notes", () => {
  it("a notable headline in a window title becomes a world thought (rarely re-checked)", async () => {
    await h.send("mac1", "mac", "screen.frame", { front_app: "Safari", window: "India wins the T20 World Cup final - YouTube", ocr: "", reason: "periodic" });
    await h.send("mac1", "mac", "hello", { kind: "mac", name: "Mac" });
    const items = h.of("pet.thoughts").at(-1)!.data.items;
    expect(items).toEqual([expect.objectContaining({ kind: "world", expires_at: T0 + 3 * DAY })]);
    voiceAi(h, "did you see? India won the final!");
    await h.speak("world");
    expect(systemOf(h.ai.chatCalls.at(-1)!)).toContain("Fact: India wins the T20 World Cup final");
  });
  it("a recurring story extends the note instead of adding another", async () => {
    await h.send("mac1", "mac", "screen.frame", { front_app: "Safari", window: "India wins the T20 World Cup final - YouTube", reason: "periodic" });
    h.advance(DAY);
    await h.send("mac1", "mac", "screen.frame", { front_app: "Safari", window: "World Cup final: India celebrates - BBC", reason: "periodic" });
    const rows = h.sql.exec<{ expires_at: number }>("SELECT expires_at FROM thoughts WHERE kind = 'world'").toArray();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.expires_at)).toBe(T0 + DAY + 3 * DAY);
  });
});

describe("nightly learner (pet)", () => {
  it("writes the line bank, sends pet.lines, stores a reflection + diary, learns familiarity", async () => {
    await h.say("love you pixie");
    h.clear();
    const r = await h.core.learn();
    expect(r.pet).toEqual({ rhythm: false, lines: 6, diary: true });
    const lines = h.of("pet.lines")[0]!.data.lines;
    expect(lines.sleepy).toHaveLength(10);
    expect(lines.sleepy[0].text).toBe("sleepy line number 0");
    expect(h.core.memoryDump().memories.map((m: any) => m.text)).toContain("Ishaan had a calm coding day.");
    // the diary reaches the morning greeting
    await h.speak("greet_morning");
    expect(systemOf(h.ai.chatCalls.at(-1)!)).toContain("We coded together today");
    // the stored bank is sent on the next hello
    h.clear();
    await h.send("mac1", "mac", "hello", { kind: "mac", name: "Mac" });
    expect(h.of("pet.lines")[0]!.data.lines.ate[0].text).toBe("ate line number 0");
  });
  it("a garbage line bank keeps the default", async () => {
    h.ai.handler = (m) => (systemOf(m).includes("line bank") ? "nope" : JSON.stringify({}));
    await h.core.learn();
    expect(h.of("pet.lines")[0]!.data.lines).toEqual(DEFAULT_LINE_BANK);
  });
  it("weekly check lowers chattiness when most bubbles were ignored", async () => {
    const before = h.core.pet.profile().traits.chattiness;
    for (let i = 0; i < 8; i++) await h.send("mac1", "mac", "pet.event", { kind: "bubble_ignored", intent: "playful_bid" });
    await h.send("mac1", "mac", "pet.event", { kind: "bubble_replied" });
    await h.core.learn(); // the pet is 30 days old, so the weekly check is due
    expect(h.core.pet.profile().traits.chattiness).toBeLessThan(before);
    const after = h.core.pet.profile().traits.chattiness;
    await h.core.learn(); // not again within the same week
    expect(h.core.pet.profile().traits.chattiness).toBe(after);
  });
});
