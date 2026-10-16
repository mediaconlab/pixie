import { beforeEach, describe, expect, it } from "vitest";
import { BrainCore, type DeviceConn } from "../src/brain/core";
import { UserBrain } from "../src/brain/UserBrain";
import { MIGRATIONS, migrate } from "../src/brain/store";
import { parseEnvelope, type DeviceKind } from "../src/protocol";
import { FakeAi, memorySql, systemOf } from "./helpers";

// 12:00 IST
const T0 = Date.UTC(2026, 9, 16, 6, 30);

function setup(opts: { sql?: ReturnType<typeof memorySql>; random?: () => number } = {}) {
  const sql = opts.sql ?? memorySql();
  const ai = new FakeAi();
  const sent: Array<{ device: string; type: string; data: any }> = [];
  let now = T0;
  const conns: DeviceConn[] = [];
  const connect = (id: string, kind: DeviceKind) => conns.push({ id, kind, name: kind, send: (t) => { const e = JSON.parse(t); sent.push({ device: id, type: e.type, data: e.data }); } });
  const core = new BrainCore({
    sql, ai, devices: () => [...conns], registeredDevices: async () => [], setAlarm: () => {}, now: () => now, log: () => {}, random: opts.random ?? (() => 0.99),
  });
  core.setUserName("Ishaan");
  let n = 0;
  const send = async (from: string, kind: DeviceKind, type: string, data: unknown) => {
    const r = parseEnvelope(JSON.stringify({ v: 1, id: `evt_${++n}`, ts: now, type, data }), now);
    if (!r.ok) throw new Error(r.message);
    await core.handleEvent(r.event, { deviceId: from, kind });
  };
  return {
    sql, ai, sent, core, send, connect,
    advance: (ms: number) => { now += ms; },
    get now() { return now; },
    of: (type: string) => sent.filter((s) => s.type === type),
    clear: () => { sent.length = 0; },
  };
}

type H = ReturnType<typeof setup>;

/** Routes the fake model by prompt. `rule` answers the reply-rule parser (null → junk → regex fallback). */
function ai(h: H, o: { p_reply?: number; category?: string; draft?: string; rule?: Record<string, unknown> | null } = {}) {
  h.ai.handler = (m) => {
    const s = systemOf(m);
    if (s.includes("You triage phone notifications")) return JSON.stringify({ urgency: 0.3, summary: "asks something", expects_reply: true, ...(o.p_reply != null ? { p_reply: o.p_reply } : {}), category: o.category ?? "question" });
    if (s.includes("Draft a short WhatsApp reply")) return JSON.stringify({ text: o.draft ?? "Yes, coming!" });
    if (s.includes("reply suggestions (reply cards)")) return o.rule ? JSON.stringify(o.rule) : "not json";
    return JSON.stringify({ say: "ok", emotion: "happy", intensity: 0.5, gesture: "none", gaze: "user", speak: true });
  };
}

const dm = (from: string, preview = "Are you coming for dinner?", key = `k_${from}_${Math.random()}`) =>
  ({ app: "whatsapp", package: "com.whatsapp", from, conversation: null, preview, is_group: false, key, replyable: true });
const grp = (from: string, group: string, preview = "@Ishaan are you coming?", key = `g_${from}_${Math.random()}`) =>
  ({ app: "whatsapp", package: "com.whatsapp", from, conversation: group, preview, is_group: true, key, replyable: true });

const say = (h: H, text: string) => h.send("mac1", "mac", "user.say", { text, via: "typed" });
const lastPerform = (h: H) => String(h.of("bot.perform").at(-1)?.data.say ?? "");
const cards = (h: H) => h.of("bot.propose").filter((p) => p.data.kind === "whatsapp.reply");

let h: H;
beforeEach(() => {
  h = setup();
  h.connect("mac1", "mac");
  h.connect("and1", "android");
});

describe("reply cards on incoming messages", () => {
  it("a card carries why, quick_actions and exploration; nothing reaches the device without approval", async () => {
    ai(h);
    await h.send("and1", "android", "phone.message", dm("Mom"));
    const c = cards(h);
    expect(c).toHaveLength(1);
    expect(c[0]!.data).toMatchObject({
      kind: "whatsapp.reply", executor: "android", exploration: false, why: "Mom (family) asked you something",
      quick_actions: [{ id: "never_contact", label: "Not for Mom" }],
    });
    expect(h.of("bot.execute")).toHaveLength(0);
    // keys only, never message text
    expect(JSON.stringify(h.sql.exec("SELECT * FROM reply_cards").toArray())).not.toContain("dinner");
  });

  it("group cards offer both quick actions", async () => {
    ai(h);
    await h.send("and1", "android", "phone.message", grp("Rahul", "Football"));
    expect(cards(h)[0]!.data.quick_actions).toEqual([{ id: "never_contact", label: "Not for Rahul" }, { id: "never_group", label: "Not in Football" }]);
    expect(cards(h)[0]!.data.title).toBe("Reply to Rahul in Football?");
  });

  it("no card when the model says the message wants no reply, or for unaddressed group chatter", async () => {
    ai(h, { p_reply: 0.05, category: "ack" });
    await h.send("and1", "android", "phone.message", dm("Mom", "ok"));
    ai(h, { p_reply: 0.4 });
    await h.send("and1", "android", "phone.message", grp("Rahul", "Football", "anyone up for football?"));
    expect(cards(h)).toHaveLength(0);
  });

  it("cold start: unknown contact with a lukewarm message gets no card, family gets one", async () => {
    ai(h, { p_reply: 0.35, category: "plan" });
    await h.send("and1", "android", "phone.message", dm("Neha", "dinner tonight maybe"));
    expect(cards(h)).toHaveLength(0);
    await h.send("and1", "android", "phone.message", dm("Mom", "dinner tonight maybe"));
    expect(cards(h)).toHaveLength(1);
  });

  it("exploration: labelled, at most 3 per day", async () => {
    h = setup({ random: () => 0 });
    h.connect("mac1", "mac");
    h.connect("and1", "android");
    ai(h, { p_reply: 0.3, category: "plan" });
    // away: unanswered cards expire without counting against anyone
    await h.send("mac1", "mac", "state.update", { activity: "away" });
    for (let i = 0; i < 5; i++) await h.send("and1", "android", "phone.message", dm(`Stranger${i}`, "maybe later"));
    const c = cards(h);
    expect(c).toHaveLength(3);
    expect(c.every((x) => x.data.exploration === true)).toBe(true);
    h.advance(24 * 3600_000);
    await h.send("and1", "android", "phone.message", dm("Stranger9", "maybe later"));
    expect(cards(h)).toHaveLength(4);
  });
});

describe("learning from outcomes", () => {
  async function card(from = "Rahul", msg = dm(from)) {
    h.clear();
    await h.send("and1", "android", "phone.message", msg);
    return cards(h)[0]?.data.proposal_id as string | undefined;
  }

  it("approvals/edits are 'wanted', reject is 'not now'; a contact you keep dismissing stops getting cards", async () => {
    ai(h, { p_reply: 0.75 });
    const a = (await card())!;
    await h.send("mac1", "mac", "user.feedback", { proposal_id: a, verdict: "approve", edited_text: "yes" });
    const evs = () => h.sql.exec<{ outcome: string; subject_key: string }>("SELECT outcome, subject_key FROM reply_events ORDER BY id").toArray();
    expect(evs()).toEqual([{ outcome: "wanted", subject_key: "c:rahul" }]);
    let shown = 0;
    for (let i = 0; i < 20; i++) {
      const id = await card();
      if (!id) break;
      shown++;
      await h.send("mac1", "mac", "user.feedback", { proposal_id: id, verdict: "reject" });
    }
    // not-now is a weak negative: it takes several, but it does stop
    expect(shown).toBeGreaterThanOrEqual(3);
    expect(shown).toBeLessThan(20);
    expect(evs().filter((e) => e.outcome === "not_now")).toHaveLength(shown);
    expect(await card()).toBeUndefined();
    // a family contact still gets cards
    expect(await card("Mom")).toBeDefined();
  });

  it("why reflects history", async () => {
    ai(h, { p_reply: 0.75 });
    for (let i = 0; i < 3; i++) {
      const id = (await card("Priya"))!;
      await h.send("mac1", "mac", "user.feedback", { proposal_id: id, verdict: "approve" });
    }
    await card("Priya");
    expect(cards(h)[0]!.data.why).toBe("You used 3 of your last 3 suggestions for Priya");
  });

  it("cards that expire while the user is active count as ignored; while away they don't", async () => {
    ai(h, { p_reply: 0.75 });
    await card("Rahul");
    h.advance(31 * 60_000);
    await h.send("mac1", "mac", "state.update", { activity: "away" });
    await card("Priya");
    h.advance(31 * 60_000);
    await h.core.learn();
    const rows = h.sql.exec<{ subject_key: string; outcome: string; active: number }>("SELECT subject_key, outcome, active FROM reply_events ORDER BY subject_key").toArray();
    expect(rows).toEqual([
      { subject_key: "c:priya", outcome: "ignored", active: 0 },
      { subject_key: "c:rahul", outcome: "ignored", active: 1 },
    ]);
    const stat = (k: string) => h.sql.exec<{ neg: number }>("SELECT neg FROM reply_stats WHERE key = ?", k).toArray()[0];
    expect(Number(stat("c:rahul")!.neg)).toBeCloseTo(0.5);
    expect(stat("c:priya")).toBeUndefined();
  });

  it("nightly learner rebuilds decayed stats, expires temporary rules, purges events older than 120 days", async () => {
    h.sql.exec("INSERT INTO reply_events (subject_key, relation_key, is_group, outcome, active, ts) VALUES ('c:old','r:unknown',0,'wanted',1,?)", h.now - 121 * 86_400_000);
    h.sql.exec("INSERT INTO reply_events (subject_key, relation_key, is_group, outcome, active, ts) VALUES ('c:mid','r:unknown',0,'wanted',1,?)", h.now - 45 * 86_400_000);
    h.sql.exec("INSERT INTO reply_rules (id, effect, subject_type, subject_key, subject_label, scope_key, source, created_at, expires_at) VALUES ('rr_t','never','contact','x','X','contact:x:dm','chat',1,?)", h.now + 1000);
    h.advance(2000);
    await h.core.learn();
    expect(h.sql.exec("SELECT subject_key FROM reply_events").toArray()).toEqual([{ subject_key: "c:mid" }]);
    expect(Number(h.sql.exec<{ pos: number }>("SELECT pos FROM reply_stats WHERE key = 'c:mid'").toArray()[0]!.pos)).toBeCloseTo(0.5, 2);
    expect(h.sql.exec("SELECT * FROM reply_stats WHERE key = 'c:old'").toArray()).toHaveLength(0);
    expect(h.sql.exec("SELECT * FROM reply_rules").toArray()).toHaveLength(0);
  });
});

describe("'never' from a card", () => {
  it("on a group card blocks the group, not that person's DMs", async () => {
    ai(h, { p_reply: 0.75 });
    await h.send("and1", "android", "phone.message", grp("Rahul", "Football"));
    const id = cards(h)[0]!.data.proposal_id;
    await h.send("mac1", "mac", "user.feedback", { proposal_id: id, verdict: "never" });
    expect(lastPerform(h)).toBe("Got it, no more reply suggestions in Football.");
    h.clear();
    await h.send("and1", "android", "phone.message", grp("Priya", "Football"));
    expect(cards(h)).toHaveLength(0);
    await h.send("and1", "android", "phone.message", dm("Rahul"));
    expect(cards(h)).toHaveLength(1);
    expect(h.sql.exec("SELECT subject_key FROM reply_events WHERE outcome = 'never'").toArray()).toEqual([{ subject_key: "g:football" }]);
  });

  it("scope contact on a group card: that person in groups only", async () => {
    ai(h, { p_reply: 0.75 });
    await h.send("and1", "android", "phone.message", grp("Rahul", "Football"));
    await h.send("mac1", "mac", "user.feedback", { proposal_id: cards(h)[0]!.data.proposal_id, verdict: "never", scope: "contact" });
    expect(lastPerform(h)).toBe("Got it, no more reply suggestions for Rahul in groups.");
    h.clear();
    await h.send("and1", "android", "phone.message", grp("Rahul", "Office"));
    expect(cards(h)).toHaveLength(0);
    await h.send("and1", "android", "phone.message", dm("Rahul"));
    expect(cards(h)).toHaveLength(1);
  });

  it("on a DM card blocks the contact; the rule is listed and deleting it restores cards", async () => {
    ai(h, { p_reply: 0.75 });
    await h.send("and1", "android", "phone.message", dm("Mom"));
    await h.send("mac1", "mac", "user.feedback", { proposal_id: cards(h)[0]!.data.proposal_id, verdict: "never" });
    h.clear();
    await h.send("and1", "android", "phone.message", dm("Mom"));
    expect(cards(h)).toHaveLength(0);
    const rules = h.core.replyRulesDump().rules as any[];
    expect(rules).toEqual([expect.objectContaining({ effect: "never", subject_type: "contact", subject_label: "Mom", source: "button", conditions: null, expires_at: null, utterance: null })]);
    expect(h.core.deleteReplyRule(rules[0].id)).toBe(true);
    expect(h.core.deleteReplyRule(rules[0].id)).toBe(false);
    await h.send("and1", "android", "phone.message", dm("Mom"));
    expect(cards(h)).toHaveLength(1);
  });
});

describe("natural-language rules via user.say", () => {
  it("'always show me reply options for Mom' (model JSON) → rule + short confirmation, no chat turn", async () => {
    ai(h, { rule: { is_rule: true, kind: "rule", effect: "always", target: { type: "contact", name: "Mom" } } });
    await h.send("and1", "android", "phone.message", { ...dm("Mom", "ok"), replyable: false });
    h.clear();
    const before = h.ai.chatCalls.length;
    await say(h, "always show me reply options for Mom");
    expect(lastPerform(h)).toBe("Got it, I'll always suggest replies for Mom.");
    expect(h.ai.chatCalls.length - before).toBe(1); // only the rule parse, no chat reply
    expect(h.core.replyRulesDump().rules).toEqual([expect.objectContaining({ effect: "always", subject_type: "contact", subject_label: "Mom", source: "chat", utterance: "always show me reply options for Mom" })]);
    // even a low-likelihood message now gets a card
    ai(h, { p_reply: 0.1, category: "info" });
    await h.send("and1", "android", "phone.message", dm("Mom", "reached home"));
    expect(cards(h)).toHaveLength(1);
    expect(cards(h)[0]!.data.why).toBe("You asked me to always suggest replies for Mom");
  });

  it("Hinglish group rule via regex fallback resolves against seen group names", async () => {
    ai(h, { p_reply: 0.75, rule: null });
    await h.send("and1", "android", "phone.message", grp("Priya", "Office Team", "lunch?"));
    h.clear();
    await say(h, "office group mein reply suggest mat karna");
    expect(lastPerform(h)).toBe("Okay, no reply suggestions for the Office Team group.");
    h.clear();
    await h.send("and1", "android", "phone.message", grp("Priya", "Office Team"));
    expect(cards(h)).toHaveLength(0);
  });

  it("'Rahul ko aaj ke liye mat dikhana' is temporary; a new rule for the same subject replaces it", async () => {
    ai(h, { p_reply: 0.75, rule: null });
    await say(h, "Rahul ko aaj ke liye mat dikhana");
    expect(lastPerform(h)).toBe("Okay, no reply suggestions for Rahul for today.");
    const r = h.core.replyRulesDump().rules as any[];
    expect(r).toHaveLength(1);
    expect(r[0].expires_at).toBe(Date.UTC(2026, 9, 16, 18, 30));
    await h.send("and1", "android", "phone.message", dm("Rahul"));
    expect(cards(h)).toHaveLength(0);
    h.advance(12 * 3600_000); // next day
    await h.send("and1", "android", "phone.message", dm("Rahul"));
    expect(cards(h)).toHaveLength(1);
    await say(h, "always suggest replies for Rahul");
    expect(h.sql.exec("SELECT effect FROM reply_rules").toArray()).toEqual([{ effect: "always" }]);
  });

  it("'Priya is from work' sets the relation", async () => {
    ai(h, { rule: null });
    await h.send("and1", "android", "phone.message", { ...dm("Priya", "hi"), replyable: false });
    await say(h, "Priya is from work");
    expect(lastPerform(h)).toBe("Got it, Priya is from work.");
    expect(h.sql.exec("SELECT relation FROM contacts WHERE name_key = 'priya'").toArray()).toEqual([{ relation: "work" }]);
    expect(h.core.replyRulesDump().rules).toHaveLength(0);
  });

  it("asks when a name is ambiguous, then applies the answer", async () => {
    ai(h, { rule: null });
    for (const n of ["Rahul Sharma", "Rahul Verma"]) await h.send("and1", "android", "phone.message", { ...dm(n, "hi"), replyable: false });
    await say(h, "never suggest replies for Rahul");
    expect(lastPerform(h)).toMatch(/Which one do you mean\? 1\) Rahul Sharma, 2\) Rahul Verma/);
    expect(h.core.replyRulesDump().rules).toHaveLength(0);
    await say(h, "2");
    expect(lastPerform(h)).toBe("Okay, no reply suggestions for Rahul Verma.");
    expect((h.core.replyRulesDump().rules as any[])[0].subject_label).toBe("Rahul Verma");
  });

  it("ordinary chat is not treated as a rule", async () => {
    ai(h);
    await say(h, "what's for dinner?");
    expect(h.core.replyRulesDump().rules).toHaveLength(0);
    expect(h.ai.chatCalls.some((m) => systemOf(m).includes("reply suggestions (reply cards)"))).toBe(false);
  });
});

describe("forget / reset learning", () => {
  it("DELETE /v1/memory clears the reply tables; reset-learning keeps rules", async () => {
    ai(h, { p_reply: 0.75, rule: null });
    const pid = (await (async () => { await h.send("and1", "android", "phone.message", dm("Mom")); return cards(h)[0]!.data.proposal_id; })());
    await h.send("mac1", "mac", "user.feedback", { proposal_id: pid, verdict: "approve" });
    await say(h, "never suggest replies for Rahul");
    const count = (t: string) => Number(h.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`).toArray()[0]!.n);
    expect(count("reply_events")).toBe(1);
    h.core.resetReplyLearning();
    expect(count("reply_events") + count("reply_stats") + count("reply_cards")).toBe(0);
    expect(count("reply_rules")).toBe(1);
    h.core.forget();
    for (const t of ["reply_rules", "reply_events", "reply_stats", "reply_cards", "conversations"]) expect(count(t), t).toBe(0);
  });
});

describe("migration of legacy blocked reply patterns", () => {
  it("copies kv blocked whatsapp.reply entries into reply_rules once, idempotently", () => {
    const sql = memorySql();
    migrate(sql, MIGRATIONS.slice(0, 1));
    sql.exec("INSERT INTO contacts (name, name_key, importance, interactions, last_ts) VALUES ('Mom', 'mom', 0.8, 1, 1)");
    sql.exec("INSERT INTO kv (key, value) VALUES ('blocked', ?)", JSON.stringify(["whatsapp.reply|mom", "whatsapp.reply|rahul", "call.back|mom"]));
    expect(migrate(sql)).toBe(MIGRATIONS.length);
    const rows = () => sql.exec<any>("SELECT id, effect, subject_type, subject_key, subject_label, source FROM reply_rules ORDER BY subject_key").toArray();
    expect(rows()).toEqual([
      expect.objectContaining({ effect: "never", subject_type: "contact", subject_key: "mom", subject_label: "Mom", source: "migrated" }),
      expect.objectContaining({ effect: "never", subject_type: "contact", subject_key: "rahul", subject_label: "rahul", source: "migrated" }),
    ]);
    // re-running the migration statements changes nothing
    for (const s of MIGRATIONS[2]!.statements) sql.exec(s);
    expect(rows()).toHaveLength(2);

    // the migrated rule works, is listed with source "migrated", and deleting it unblocks Mom fully
    const h2 = setup({ sql });
    h2.connect("mac1", "mac");
    h2.connect("and1", "android");
    ai(h2, { p_reply: 0.75 });
    return (async () => {
      await h2.send("and1", "android", "phone.message", dm("Mom"));
      expect(cards(h2)).toHaveLength(0);
      const mom = (h2.core.replyRulesDump().rules as any[]).find((r) => r.subject_label === "Mom");
      expect(mom.source).toBe("migrated");
      h2.core.deleteReplyRule(mom.id);
      expect(JSON.parse(sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'blocked'").toArray()[0]!.value)).toEqual(["whatsapp.reply|rahul", "call.back|mom"]);
      await h2.send("and1", "android", "phone.message", dm("Mom"));
      expect(cards(h2)).toHaveLength(1);
    })();
  });
});

describe("DO REST routes", () => {
  function brain() {
    const sql = memorySql();
    const ctx = {
      storage: { sql, deleteAlarm: async () => {}, getAlarm: async () => null, setAlarm: async () => {} },
      setWebSocketAutoResponse: () => {},
      getWebSockets: () => [],
      waitUntil: () => {},
    };
    const env = { AI: { run: async () => ({}) }, DB: {} } as any;
    (globalThis as any).WebSocketRequestResponsePair ??= class { constructor(public a: string, public b: string) {} };
    return { b: new UserBrain(ctx as any, env), sql };
  }

  it("GET /reply-rules, DELETE /reply-rules/:id, POST /reply-rules/reset-learning", async () => {
    const { b, sql } = brain();
    sql.exec("INSERT INTO reply_rules (id, effect, subject_type, subject_key, subject_label, scope_key, source, created_at) VALUES ('rr_a','always','contact','mom','Mom','contact:mom:dm','chat',5)");
    sql.exec("INSERT INTO reply_rules (id, effect, subject_type, subject_key, subject_label, scope_key, source, created_at, expires_at) VALUES ('rr_old','never','all',NULL,'everyone','all:','chat',1,2)");
    sql.exec("INSERT INTO reply_stats (key, pos, neg, updated_at) VALUES ('c:mom', 1, 0, 1)");
    const get = await (await b.fetch(new Request("https://brain/reply-rules"))).json();
    expect(get).toEqual({ rules: [{ id: "rr_a", effect: "always", subject_type: "contact", subject_label: "Mom", conditions: null, expires_at: null, source: "chat", utterance: null, created_at: 5 }] });
    expect(await (await b.fetch(new Request("https://brain/reply-rules/reset-learning", { method: "POST" }))).json()).toEqual({ ok: true });
    expect(sql.exec("SELECT * FROM reply_stats").toArray()).toHaveLength(0);
    expect(await (await b.fetch(new Request("https://brain/reply-rules/rr_a", { method: "DELETE" }))).json()).toEqual({ ok: true });
    expect((await b.fetch(new Request("https://brain/reply-rules/rr_a", { method: "DELETE" }))).status).toBe(404);
    await b.fetch(new Request("https://brain/memory", { method: "DELETE" }));
    expect(sql.exec("SELECT * FROM reply_rules").toArray()).toHaveLength(0);
  });
});
