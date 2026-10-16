import { beforeEach, describe, expect, it } from "vitest";
import { BrainCore, MAX_MEMORIES, MAX_MODEL_CALLS_PER_HOUR, type DeviceConn } from "../src/brain/core";
import { parseEnvelope, type DeviceKind } from "../src/protocol";
import { FakeAi, memorySql, systemOf } from "./helpers";

interface Sent {
  device: string;
  type: string;
  data: any;
}

// 12:00 IST
const T0 = Date.UTC(2026, 9, 16, 6, 30);

function setup() {
  const sql = memorySql();
  const ai = new FakeAi();
  const sent: Sent[] = [];
  let now = T0;
  let alarm: number | null = null;
  const conns: DeviceConn[] = [];
  const connect = (id: string, kind: DeviceKind) => {
    conns.push({ id, kind, name: kind, send: (t) => { const e = JSON.parse(t); sent.push({ device: id, type: e.type, data: e.data }); } });
  };
  const disconnect = (id: string) => {
    const i = conns.findIndex((c) => c.id === id);
    if (i >= 0) conns.splice(i, 1);
  };
  const logs: Array<Record<string, unknown>> = [];
  const core = new BrainCore({
    sql, ai,
    devices: () => [...conns],
    registeredDevices: async () => conns.map((c) => ({ id: c.id, kind: c.kind, name: c.name })),
    setAlarm: (ts) => { alarm = ts; },
    now: () => now,
    log: (r) => logs.push(r),
  });
  core.setUserName("Ishaan");
  let n = 0;
  const send = async (from: string, kind: DeviceKind, type: string, data: unknown) => {
    const r = parseEnvelope(JSON.stringify({ v: 1, id: `evt_${++n}`, ts: now, type, data }), now);
    if (!r.ok) throw new Error(r.message);
    await core.handleEvent(r.event, { deviceId: from, kind });
  };
  return {
    sql, ai, sent, core, send, connect, disconnect, logs,
    advance: (ms: number) => { now += ms; },
    get now() { return now; },
    get alarm() { return alarm; },
    of: (type: string, device?: string) => sent.filter((s) => s.type === type && (!device || s.device === device)),
    clear: () => { sent.length = 0; },
  };
}

/** A fake AI that routes by prompt kind. */
function routedAi(h: ReturnType<typeof setup>, opts: { urgency?: number; expects?: boolean; draft?: string; say?: string; extra?: Record<string, unknown> } = {}) {
  h.ai.handler = (m) => {
    const s = systemOf(m);
    if (s.includes("You triage phone notifications")) return JSON.stringify({ urgency: opts.urgency ?? 0.3, summary: "wants to know about dinner", expects_reply: opts.expects ?? true });
    if (s.includes("Draft a short WhatsApp reply")) return JSON.stringify({ text: opts.draft ?? "Yes, coming at 8!" });
    return JSON.stringify({ say: opts.say ?? "Hehe hi!", emotion: "happy", intensity: 0.6, gesture: "wave", gaze: "user", voice: { pace: "normal", pitch: 1 }, speak: true, ...(opts.extra ?? {}) });
  };
}

let h: ReturnType<typeof setup>;
beforeEach(() => {
  h = setup();
  h.connect("mac1", "mac");
  h.connect("and1", "android");
  h.connect("ide1", "ide");
});

describe("hello / chat", () => {
  it("hello → welcome to the connecting device only", async () => {
    await h.send("mac1", "mac", "hello", { kind: "mac", name: "MacBook Air", app_version: "1.0.0", capabilities: [] });
    const w = h.of("welcome");
    expect(w).toHaveLength(1);
    expect(w[0]!.device).toBe("mac1");
    expect(w[0]!.data).toMatchObject({ user_name: "Ishaan", persona: { name: "Pixie" }, mood: { valence: 0.2, energy: 0.6 } });
    expect(w[0]!.data.devices).toHaveLength(3);
    expect(w[0]!.data.devices.every((d: any) => d.online)).toBe(true);
  });

  it("user.say from mac → bot.perform to mac with reply_to", async () => {
    routedAi(h, { say: "Hiii Ishaan!" });
    await h.send("mac1", "mac", "user.say", { text: "hey pixie", via: "typed" });
    const p = h.of("bot.perform");
    expect(p).toHaveLength(1);
    expect(p[0]!.device).toBe("mac1");
    expect(p[0]!.data).toMatchObject({ say: "Hiii Ishaan!", emotion: "happy", reply_to: "evt_1" });
  });

  it("user.say from ide → perform goes to mac and ide", async () => {
    routedAi(h);
    await h.send("ide1", "ide", "user.say", { text: "hello", via: "typed" });
    expect(h.of("bot.perform").map((s) => s.device).sort()).toEqual(["ide1", "mac1"]);
  });

  it("does not repeat the current user message in the prompt", async () => {
    routedAi(h);
    await h.send("mac1", "mac", "user.say", { text: "unique-question-xyz", via: "typed" });
    const all = h.ai.chatCalls[0]!.map((m) => m.content).join("\n");
    expect(all.split("unique-question-xyz").length - 1).toBe(1);
  });

  it("stores context turns and includes them next time", async () => {
    routedAi(h, { say: "I remember!" });
    await h.send("mac1", "mac", "user.say", { text: "my cat is called Mochi", via: "typed" });
    await h.send("mac1", "mac", "user.say", { text: "what's my cat called?", via: "typed" });
    const last = h.ai.chatCalls.at(-1)!;
    expect(last.map((m) => m.content).join("\n")).toContain("my cat is called Mochi");
  });

  it("canned reply when the model returns garbage twice", async () => {
    h.ai.handler = () => "not json";
    await h.send("mac1", "mac", "user.say", { text: "hi", via: "typed" });
    const p = h.of("bot.perform")[0]!.data;
    expect(p.say.length).toBeGreaterThan(0);
    expect(h.ai.chatCalls).toHaveLength(2);
  });

  it("serializes turns: concurrent events do not interleave", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    h.ai.handler = async (m) => {
      const txt = m.at(-1)!.content;
      order.push(`start:${txt.includes("one") ? "one" : "two"}`);
      if (first) { first = false; await gate; }
      order.push(`end:${txt.includes("one") ? "one" : "two"}`);
      return JSON.stringify({ say: "ok" });
    };
    const a = h.send("mac1", "mac", "user.say", { text: "one", via: "typed" });
    const b = h.send("mac1", "mac", "user.say", { text: "two", via: "typed" });
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(["start:one", "end:one", "start:two", "end:two"]);
  });

  it("logs only event types and timings (no content)", async () => {
    routedAi(h);
    await h.send("mac1", "mac", "user.say", { text: "secret diary entry", via: "typed" });
    for (const l of h.logs) {
      expect(Object.keys(l).sort()).toEqual(["evt", "ms"]);
      expect(JSON.stringify(l)).not.toContain("secret");
    }
  });
});

describe("remember", () => {
  it("stores model remember strings as deduped facts", async () => {
    routedAi(h, { extra: { remember: ["Ishaan's cat is called Mochi"] } });
    await h.send("mac1", "mac", "user.say", { text: "my cat is Mochi", via: "typed" });
    await h.send("mac1", "mac", "user.say", { text: "Mochi is my cat", via: "typed" });
    const mem = h.core.memoryDump();
    expect(mem.facts).toHaveLength(1);
    expect((mem.facts[0] as any).text).toBe("Ishaan's cat is called Mochi");
  });
  it("relevant memories are injected into the prompt", async () => {
    await h.core.remember(["Ishaan loves masala chai in the evening"]);
    routedAi(h);
    await h.send("mac1", "mac", "user.say", { text: "Ishaan loves masala chai, right?", via: "typed" });
    expect(h.ai.chatCalls.at(-1)![0]!.content).toContain("masala chai");
  });
  it("caps stored memories at 2000, dropping lowest-value oldest", async () => {
    h.sql.db.exec("BEGIN");
    for (let i = 0; i < MAX_MEMORIES; i++) h.sql.exec("INSERT INTO memories (kind, text, embedding, value, ts) VALUES ('fact', ?, NULL, ?, ?)", `filler ${i}`, i === 0 ? 0.01 : 0.5, i);
    h.sql.db.exec("COMMIT");
    expect(await h.core.remember(["Ishaan plays the guitar on weekends"])).toBe(1);
    const n = h.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM memories").toArray()[0]!.n;
    expect(n).toBe(MAX_MEMORIES);
    expect(h.sql.exec("SELECT id FROM memories WHERE text = 'filler 0'").toArray()).toHaveLength(0);
    expect(h.sql.exec("SELECT id FROM memories WHERE text LIKE '%guitar%'").toArray()).toHaveLength(1);
  });
  it("DELETE memory (forget) wipes memories, prefs, decisions, mood", async () => {
    await h.core.remember(["a fact about Ishaan"]);
    h.sql.exec("INSERT INTO preferences (text, ts) VALUES ('likes short replies', 1)");
    h.sql.exec("INSERT INTO decisions (kind, pattern, verdict, ts) VALUES ('x','x|*','approve',1)");
    routedAi(h);
    await h.send("mac1", "mac", "user.say", { text: "*pats*", via: "typed" });
    h.core.forget();
    expect(h.core.memoryDump()).toEqual({ facts: [], memories: [], preferences: [] });
    expect(h.sql.exec("SELECT COUNT(*) AS n FROM decisions").toArray()[0]).toMatchObject({ n: 0 });
    expect(h.core.mood().valence).toBeCloseTo(0.2);
  });
});

describe("phone.call", () => {
  it("ringing → bot.notice interrupt + excited perform", async () => {
    await h.send("and1", "android", "phone.call", { state: "ringing", number: "+919876543210", name: "Mom" });
    const n = h.of("bot.notice");
    expect(n).toHaveLength(1);
    expect(n[0]!.device).toBe("mac1");
    expect(n[0]!.data).toMatchObject({ kind: "call", from: "Mom", interrupt: true });
    expect(n[0]!.data.urgency).toBeGreaterThan(0.9);
    const p = h.of("bot.perform")[0]!.data;
    expect(p.say).toBe("Mom is calling!");
    expect(["excited", "surprised"]).toContain(p.emotion);
    expect(h.ai.chatCalls).toHaveLength(0); // no model needed
  });
  it("missed → propose call.back to mac with android executor", async () => {
    await h.send("and1", "android", "phone.call", { state: "missed", number: "+919876543210", name: "Mom" });
    const pr = h.of("bot.propose");
    expect(pr).toHaveLength(1);
    expect(pr[0]!.device).toBe("mac1");
    expect(pr[0]!.data).toMatchObject({ kind: "call.back", executor: "android", payload: { number: "+919876543210", name: "Mom" } });
    expect(pr[0]!.data.proposal_id).toMatch(/^prp_/);
    expect(pr[0]!.data.expires_at).toBeGreaterThan(h.now);
  });
  it("contact lookup by number hash finds the name later", async () => {
    await h.send("and1", "android", "phone.call", { state: "ended", number: "+919876543210", name: "Mom" });
    h.clear();
    await h.send("and1", "android", "phone.call", { state: "ringing", number: "09876543210", name: null });
    expect(h.of("bot.notice")[0]!.data.from).toBe("Mom");
  });
  it("ringing pauses watch commentary (bot.auto)", async () => {
    await h.send("mac1", "mac", "state.update", { watching: true });
    h.clear();
    await h.send("and1", "android", "phone.call", { state: "ringing", number: "+911111111111", name: "Rahul" });
    expect(h.of("bot.auto")[0]!.data).toMatchObject({ action: "pause_commentary" });
  });
});

describe("phone.message routing", () => {
  const msg = (over: Record<string, unknown> = {}) => ({ app: "whatsapp", package: "com.whatsapp", from: "Rahul", conversation: null, preview: "lol nice", is_group: false, key: "k1", replyable: true, ...over });

  it("idle → interrupt notice + perform", async () => {
    routedAi(h, { urgency: 0.2, expects: false });
    await h.send("and1", "android", "phone.message", msg());
    expect(h.of("bot.notice")[0]!.data).toMatchObject({ kind: "message", from: "Rahul", interrupt: true, app: "whatsapp" });
    expect(h.of("bot.perform")).toHaveLength(1);
  });

  it("low urgency while browsing → digest, sent after 15 min via alarm", async () => {
    routedAi(h, { urgency: 0.1, expects: false });
    await h.send("mac1", "mac", "state.update", { activity: "browsing" });
    await h.send("and1", "android", "phone.message", msg());
    expect(h.of("bot.notice")).toHaveLength(0);
    expect(h.alarm).not.toBeNull();
    expect(h.alarm).toBe(h.now + 15 * 60_000);
    h.advance(10 * 60_000);
    await h.core.alarm();
    expect(h.of("bot.digest")).toHaveLength(0);
    h.advance(6 * 60_000);
    await h.core.alarm();
    const d = h.of("bot.digest");
    expect(d).toHaveLength(1);
    expect(d[0]!.data.items[0]).toMatchObject({ from: "Rahul", app: "whatsapp" });
    expect(d[0]!.data.items[0].preview).toBeUndefined();
  });

  it("meeting → held + bot.auto hold_notifications; flushed when idle again", async () => {
    routedAi(h, { urgency: 0.2, expects: false });
    await h.send("mac1", "mac", "state.update", { activity: "meeting" });
    await h.send("and1", "android", "phone.message", msg());
    await h.send("and1", "android", "phone.message", msg({ from: "Priya" }));
    expect(h.of("bot.notice")).toHaveLength(0);
    expect(h.of("bot.auto")[0]!.data).toMatchObject({ action: "hold_notifications" });
    h.advance(20 * 60_000);
    await h.core.alarm();
    expect(h.of("bot.digest")).toHaveLength(0); // still in the meeting
    await h.send("mac1", "mac", "state.update", { activity: "idle" });
    expect(h.of("bot.digest")[0]!.data.items).toHaveLength(2);
  });

  it("urgent keywords interrupt even while busy", async () => {
    routedAi(h, { urgency: 0.5, expects: false });
    await h.send("mac1", "mac", "state.update", { activity: "coding" });
    await h.send("and1", "android", "phone.message", msg({ from: "Mom", preview: "EMERGENCY call me now" }));
    const n = h.of("bot.notice")[0]!.data;
    expect(n.interrupt).toBe(true);
    expect(n.urgency).toBeGreaterThanOrEqual(0.6);
  });

  it("repeated messages from the same sender raise urgency", async () => {
    routedAi(h, { urgency: 0.3, expects: false });
    await h.send("mac1", "mac", "state.update", { activity: "browsing" });
    for (let i = 0; i < 4; i++) await h.send("and1", "android", "phone.message", msg({ from: "Mom", preview: "hello?" }));
    expect(h.of("bot.notice").length).toBeGreaterThan(0);
  });

  it("question → whatsapp.reply proposal with android executor, sent to mac", async () => {
    routedAi(h, { urgency: 0.3, expects: true, draft: "Yes, coming at 8!" });
    await h.send("mac1", "mac", "state.update", { activity: "browsing" });
    await h.send("and1", "android", "phone.message", msg({ preview: "Are you coming for dinner?", key: "notif-key-1" }));
    const pr = h.of("bot.propose");
    expect(pr).toHaveLength(1);
    expect(pr[0]!.device).toBe("mac1");
    expect(pr[0]!.data).toMatchObject({ kind: "whatsapp.reply", executor: "android", payload: { key: "notif-key-1", to: "Rahul", text: "Yes, coming at 8!" } });
    expect(h.of("bot.execute")).toHaveLength(0); // never executes without approval
  });

  it("does not propose drafts that leak an OTP", async () => {
    routedAi(h, { urgency: 0.3, expects: true, draft: "My OTP is 123456" });
    await h.send("and1", "android", "phone.message", msg({ preview: "what's the code?" }));
    expect(h.of("bot.propose")).toHaveLength(0);
  });

  it("group chatter without a question to the user is not drafted", async () => {
    routedAi(h, { urgency: 0.2, expects: true });
    await h.send("and1", "android", "phone.message", msg({ is_group: true, conversation: "Football", preview: "Anyone up for football?" }));
    expect(h.of("bot.propose")).toHaveLength(0);
  });
});

describe("feedback / execute", () => {
  async function proposeReply() {
    routedAi(h, { urgency: 0.3, expects: true, draft: "Yes, coming at 8!" });
    await h.send("and1", "android", "phone.message", { app: "whatsapp", from: "Mom", conversation: null, preview: "Coming for dinner?", is_group: false, key: "nk", replyable: true });
    return h.of("bot.propose")[0]!.data.proposal_id as string;
  }

  it("approve → bot.execute to the online android with the draft", async () => {
    const id = await proposeReply();
    h.clear();
    await h.send("mac1", "mac", "user.feedback", { proposal_id: id, verdict: "approve" });
    const ex = h.of("bot.execute");
    expect(ex).toHaveLength(1);
    expect(ex[0]!.device).toBe("and1");
    expect(ex[0]!.data).toEqual({ proposal_id: id, kind: "whatsapp.reply", payload: { key: "nk", text: "Yes, coming at 8!" } });
  });

  it("edited_text replaces the draft", async () => {
    const id = await proposeReply();
    h.clear();
    await h.send("mac1", "mac", "user.feedback", { proposal_id: id, verdict: "approve", edited_text: "yes 8" });
    expect(h.of("bot.execute")[0]!.data.payload.text).toBe("yes 8");
    const row = h.sql.exec("SELECT draft, final FROM decisions WHERE proposal_id = ?", id).toArray()[0];
    expect(row).toMatchObject({ draft: "Yes, coming at 8!", final: "yes 8" });
  });

  it("double approval executes only once", async () => {
    const id = await proposeReply();
    h.clear();
    await h.send("mac1", "mac", "user.feedback", { proposal_id: id, verdict: "approve" });
    await h.send("and1", "android", "user.feedback", { proposal_id: id, verdict: "approve" });
    expect(h.of("bot.execute")).toHaveLength(1);
  });

  it("no android online → tell the user via perform, no execute", async () => {
    const id = await proposeReply();
    h.disconnect("and1");
    h.clear();
    await h.send("mac1", "mac", "user.feedback", { proposal_id: id, verdict: "approve" });
    expect(h.of("bot.execute")).toHaveLength(0);
    expect(h.of("bot.perform")[0]!.data.say).toMatch(/phone isn't connected/);
  });

  it("reject logs a decision; never blocks the pattern", async () => {
    const id = await proposeReply();
    await h.send("mac1", "mac", "user.feedback", { proposal_id: id, verdict: "never" });
    expect(h.sql.exec("SELECT verdict FROM decisions WHERE proposal_id = ?", id).toArray()[0]).toMatchObject({ verdict: "never" });
    h.clear();
    await h.send("and1", "android", "phone.message", { app: "whatsapp", from: "Mom", conversation: null, preview: "Are you there?", is_group: false, key: "nk2", replyable: true });
    expect(h.of("bot.propose")).toHaveLength(0);
  });

  it("expired proposals do not execute", async () => {
    const id = await proposeReply();
    h.advance(31 * 60_000);
    h.clear();
    await h.send("mac1", "mac", "user.feedback", { proposal_id: id, verdict: "approve" });
    expect(h.of("bot.execute")).toHaveLength(0);
  });

  it("unknown proposal → error bad_event", async () => {
    await h.send("mac1", "mac", "user.feedback", { proposal_id: "prp_nope", verdict: "approve" });
    expect(h.of("error")[0]!.data).toMatchObject({ code: "bad_event" });
  });

  it("whatsapp.reply never offers promotion even after many approvals", async () => {
    for (let i = 0; i < 12; i++) {
      h.clear();
      const id = await proposeReply();
      await h.send("mac1", "mac", "user.feedback", { proposal_id: id, verdict: "approve" });
      expect(h.of("bot.perform").some((p) => /automatically/.test(p.data.say))).toBe(false);
    }
  });

  it("exec.result ok → happy perform", async () => {
    const id = await proposeReply();
    await h.send("mac1", "mac", "user.feedback", { proposal_id: id, verdict: "approve" });
    h.clear();
    await h.send("and1", "android", "exec.result", { proposal_id: id, ok: true });
    expect(h.of("bot.perform")[0]!.data.say).toBe("Sent!");
  });
});

describe("model actions & tiers", () => {
  it("reminder action → auto tier: bot.auto reminder.set, then fires via alarm", async () => {
    routedAi(h, { say: "Okie, I'll remind you!", extra: { action: { kind: "reminder", text: "drink water", in_minutes: 10 } } });
    await h.send("mac1", "mac", "user.say", { text: "remind me to drink water in 10 min", via: "typed" });
    expect(h.of("bot.auto")[0]!.data).toMatchObject({ action: "reminder.set" });
    expect(h.alarm).toBe(h.now + 10 * 60_000);
    h.clear();
    h.advance(10 * 60_000);
    await h.core.alarm();
    expect(h.of("bot.perform")[0]!.data.say).toContain("drink water");
  });

  it("forbidden action from the model → Pixie says it can't", async () => {
    routedAi(h, { say: "Paying now!", extra: { action: { kind: "payment", amount: 500 } } });
    await h.send("mac1", "mac", "user.say", { text: "pay 500 to Rahul", via: "typed" });
    const p = h.of("bot.perform");
    expect(p).toHaveLength(1);
    expect(p[0]!.data.say).toMatch(/can't/);
    expect(h.of("bot.execute")).toHaveLength(0);
  });

  it("model can't send whatsapp without approval: becomes a proposal", async () => {
    routedAi(h, { urgency: 0.2, expects: false });
    await h.send("and1", "android", "phone.message", { app: "whatsapp", from: "Mom", conversation: null, preview: "hi", is_group: false, key: "mk", replyable: true });
    routedAi(h, { say: "Drafted it!", extra: { action: { kind: "whatsapp.reply", to: "Mom", text: "On my way!" } } });
    h.clear();
    await h.send("mac1", "mac", "user.say", { text: "tell mom I'm on my way", via: "typed" });
    expect(h.of("bot.execute")).toHaveLength(0);
    expect(h.of("bot.propose")[0]!.data).toMatchObject({ kind: "whatsapp.reply", payload: { key: "mk", to: "Mom", text: "On my way!" } });
  });
});

describe("alarm scheduling", () => {
  it("does not spin when the digest is overdue but the Mac is offline; delivers on hello", async () => {
    routedAi(h, { urgency: 0.1, expects: false });
    await h.send("mac1", "mac", "state.update", { activity: "browsing" });
    await h.send("and1", "android", "phone.message", { app: "whatsapp", from: "Rahul", conversation: null, preview: "lol", is_group: false, key: "k", replyable: true });
    h.disconnect("mac1");
    h.advance(20 * 60_000);
    await h.core.alarm();
    expect(h.alarm).toBeNull();
    expect(h.of("bot.digest")).toHaveLength(0);
    h.connect("mac1", "mac");
    await h.send("mac1", "mac", "hello", { kind: "mac", name: "Mac" });
    expect(h.of("bot.digest", "mac1")).toHaveLength(1);
  });
  it("does not spin during a call; flushes when the call ends", async () => {
    routedAi(h, { urgency: 0.1, expects: false });
    await h.send("and1", "android", "phone.call", { state: "answered", number: "+911", name: "Rahul" });
    await h.send("and1", "android", "phone.message", { app: "whatsapp", from: "Priya", conversation: null, preview: "lol", is_group: false, key: "k", replyable: true });
    h.advance(20 * 60_000);
    await h.core.alarm();
    expect(h.alarm).toBeNull();
    await h.send("and1", "android", "phone.call", { state: "ended", number: "+911", name: "Rahul" });
    expect(h.of("bot.digest")).toHaveLength(1);
  });
});

describe("rate limit", () => {
  it("beyond 120 calls/hour → error rate_limited + sleepy perform", async () => {
    for (let i = 0; i < MAX_MODEL_CALLS_PER_HOUR; i++) h.sql.exec("INSERT INTO model_calls (ts) VALUES (?)", h.now);
    await h.send("mac1", "mac", "user.say", { text: "hi", via: "typed" });
    expect(h.of("error", "mac1")[0]!.data).toMatchObject({ code: "rate_limited" });
    expect(h.of("bot.perform")[0]!.data.emotion).toBe("sleepy");
    expect(h.ai.chatCalls).toHaveLength(0);
    h.advance(3601_000);
    routedAi(h);
    h.clear();
    await h.send("mac1", "mac", "user.say", { text: "hi", via: "typed" });
    expect(h.of("error")).toHaveLength(0);
  });
});

describe("screen + watch", () => {
  const frame = (over: Record<string, unknown> = {}) => ({ image: "data:image/jpeg;base64,AAAA", width: 768, height: 480, front_app: "Safari", window: "YouTube", ocr: "", reason: "periodic", ...over });

  it("'look at this' → capture.request, then the asked frame answers", async () => {
    routedAi(h, { say: "Ooh, a cooking video!" });
    await h.send("mac1", "mac", "user.say", { text: "look at this", via: "voice" });
    expect(h.of("capture.request")[0]!.data).toEqual({ reason: "asked" });
    h.clear();
    await h.send("mac1", "mac", "screen.frame", frame({ reason: "asked" }));
    expect(h.ai.visionCalls).toBe(1);
    const p = h.of("bot.perform");
    expect(p[0]!.data).toMatchObject({ say: "Ooh, a cooking video!", reply_to: "evt_1" });
  });

  it("periodic frames rarely trigger vision (cost control)", async () => {
    for (let i = 0; i < 12; i++) {
      await h.send("mac1", "mac", "screen.frame", frame({ ocr: `text ${i}` }));
      h.advance(5_000);
    }
    expect(h.ai.visionCalls).toBeLessThanOrEqual(2);
  });

  it("watch mode comments at most once per 45 s; pauses during calls", async () => {
    routedAi(h, { say: "Haha, that chef dropped the egg!" });
    await h.send("mac1", "mac", "state.update", { watching: true });
    h.clear();
    await h.send("mac1", "mac", "screen.frame", frame({ reason: "watch" }));
    await h.send("mac1", "mac", "audio.transcript", { text: "oops the egg fell", seconds: 10, source: "system" });
    h.advance(46_000);
    await h.core.alarm();
    expect(h.of("bot.perform").map((p) => p.data.say)).toContain("Haha, that chef dropped the egg!");
    h.clear();
    h.advance(10_000);
    await h.core.alarm();
    expect(h.of("bot.perform")).toHaveLength(0);

    await h.send("and1", "android", "phone.call", { state: "answered", number: "+911", name: "Rahul" });
    h.clear();
    await h.send("mac1", "mac", "audio.transcript", { text: "more stuff", seconds: 10, source: "system" });
    h.advance(50_000);
    await h.core.alarm();
    expect(h.of("bot.perform").filter((p) => p.data.say)).toHaveLength(0);
  });

  it("model may stay quiet in watch mode (say \"\")", async () => {
    routedAi(h, { say: "" });
    await h.send("mac1", "mac", "state.update", { watching: true });
    h.clear();
    await h.send("mac1", "mac", "audio.transcript", { text: "boring bit", seconds: 10, source: "system" });
    h.advance(46_000);
    await h.core.alarm();
    expect(h.of("bot.perform")).toHaveLength(0);
  });

  it("transcripts are ignored when not watching", async () => {
    await h.send("mac1", "mac", "audio.transcript", { text: "x", seconds: 10, source: "mic" });
    expect(h.core["kv"].get("transcript", [])).toEqual([]);
  });
});

describe("ide", () => {
  const diff = "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -2,1 +2,1 @@\n-foo()\n+bar()\n";
  const ctx = (over: Record<string, unknown> = {}) => ({
    file: "src/app.ts", language: "typescript", content: "a\nfoo()\nc", selection: null,
    diagnostics: [{ line: 2, severity: "error", message: "Cannot find name 'foo'" }], question: "why does this fail?", reason: "asked", ...over,
  });

  it("question → ide.suggestion to ide, short perform to mac+ide, code.patch proposal to mac+ide", async () => {
    h.ai.handler = () => JSON.stringify({ say: "Ooh, foo doesn't exist! Try bar?", emotion: "curious", gesture: "lean_in", suggestion: { explanation: "foo is undefined; bar is the right function.", patch: diff, line: 2 } });
    await h.send("ide1", "ide", "ide.context", ctx());
    const s = h.of("ide.suggestion");
    expect(s).toHaveLength(1);
    expect(s[0]!.device).toBe("ide1");
    expect(s[0]!.data).toEqual({ file: "src/app.ts", explanation: "foo is undefined; bar is the right function.", patch: diff, line: 2 });
    expect(h.of("bot.perform").map((p) => p.device).sort()).toEqual(["ide1", "mac1"]);
    const pr = h.of("bot.propose");
    expect(pr.map((p) => p.device).sort()).toEqual(["ide1", "mac1"]);
    expect(pr[0]!.data).toMatchObject({ kind: "code.patch", executor: "ide", payload: { file: "src/app.ts", patch: diff } });
    expect(h.ai.lastSystem()).toContain("unified diff");
  });

  it("approve code.patch → bot.execute to the ide", async () => {
    h.ai.handler = () => JSON.stringify({ say: "fix!", suggestion: { explanation: "x", patch: diff, line: 2 } });
    await h.send("ide1", "ide", "ide.context", ctx());
    const id = h.of("bot.propose")[0]!.data.proposal_id;
    h.clear();
    await h.send("mac1", "mac", "user.feedback", { proposal_id: id, verdict: "approve" });
    expect(h.of("bot.execute")[0]).toMatchObject({ device: "ide1", data: { kind: "code.patch", payload: { file: "src/app.ts", patch: diff } } });
  });

  it("save without errors does nothing; fixing errors → proud perform + mood up", async () => {
    h.ai.handler = () => JSON.stringify({ say: "hmm", suggestion: { explanation: "x", patch: null } });
    await h.send("ide1", "ide", "ide.context", ctx({ question: null, reason: "diagnostics" }));
    const before = h.core.mood().valence;
    h.clear();
    h.advance(10_000);
    await h.send("ide1", "ide", "ide.context", ctx({ question: null, reason: "save", diagnostics: [] }));
    expect(h.of("bot.perform")[0]!.data.emotion).toBe("proud");
    expect(h.core.mood().valence).toBeGreaterThan(before);
    h.clear();
    await h.send("ide1", "ide", "ide.context", ctx({ question: null, reason: "save", diagnostics: [] }));
    expect(h.sent).toHaveLength(0);
  });

  it("same unasked diagnostics twice → only one model call", async () => {
    h.ai.handler = () => JSON.stringify({ say: "hmm", suggestion: { explanation: "x", patch: null } });
    await h.send("ide1", "ide", "ide.context", ctx({ question: null, reason: "diagnostics" }));
    h.advance(120_000);
    await h.send("ide1", "ide", "ide.context", ctx({ question: null, reason: "diagnostics" }));
    expect(h.ai.chatCalls).toHaveLength(1);
  });
});

describe("nightly learn", () => {
  it("creates episodes, merges duplicates, derives prefs, updates contact importance", async () => {
    routedAi(h);
    await h.send("mac1", "mac", "user.say", { text: "I finished the auth refactor today", via: "typed" });
    await h.send("mac1", "mac", "user.say", { text: "now going to sleep", via: "typed" });
    // near-duplicate memories
    h.sql.exec("INSERT INTO memories (kind, text, embedding, value, ts) VALUES ('fact','a', ?, 0.5, 1)", JSON.stringify([1, 0, 0]));
    h.sql.exec("INSERT INTO memories (kind, text, embedding, value, ts) VALUES ('fact','b', ?, 0.6, 2)", JSON.stringify([0.99, 0.01, 0]));
    // formal drafts rejected
    for (const d of ["Dear Mom, kindly note", "Regards, I shall", "I would like to inform you"]) {
      h.sql.exec("INSERT INTO decisions (kind, pattern, verdict, draft, ts) VALUES ('whatsapp.reply','whatsapp.reply|mom','reject',?,?)", d, h.now);
    }
    // frequent contact
    for (let i = 0; i < 10; i++) await h.send("and1", "android", "phone.call", { state: "ended", number: "+919999999999", name: "Rahul" });
    const before = Number(h.sql.exec<{ importance: number }>("SELECT importance FROM contacts WHERE name_key = 'rahul'").toArray()[0]!.importance);

    h.ai.handler = (m) =>
      systemOf(m).includes("consolidate")
        ? JSON.stringify({ episodes: ["Ishaan finished the auth refactor and went to sleep early."], preferences: [] })
        : JSON.stringify({ say: "x" });
    const r = await h.core.learn();
    expect(r.episodes).toBe(1);
    expect(r.merged).toBe(1);
    expect(r.preferences).toBeGreaterThanOrEqual(1);
    expect(r.contacts).toBeGreaterThanOrEqual(1);
    const dump = h.core.memoryDump();
    expect(dump.memories.map((m: any) => m.text)).toContain("Ishaan finished the auth refactor and went to sleep early.");
    expect(dump.preferences.map((p: any) => p.text).join(" ")).toMatch(/too formal/);
    const after = Number(h.sql.exec<{ importance: number }>("SELECT importance FROM contacts WHERE name_key = 'rahul'").toArray()[0]!.importance);
    expect(after).toBeGreaterThan(before);
  });
});
