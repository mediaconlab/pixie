import { describe, expect, it } from "vitest";
import {
  COLD_START, HALF_LIFE_MS, SHOW_THRESHOLD, type Counts, type DecideInput, type MessageContext, type ReplyRule, ZERO, combinePReply, decayed,
  decideReplyCard, endOfIstDay, heuristicReply, learnedRate, looksLikeReplyCommand, matchRule, mentionsUser, neverRuleFor, outcomeEvidence,
  parseModelCommand, parseRelationStatement, parseReplyCommand, pickOption, quickActions, recomputeStats, relationBucket, relationKey,
  resolveName, ruleScopeKey, showScore, subjectKey,
} from "../src/brain/replies";

// 12:00 IST
const NOW = Date.UTC(2026, 9, 16, 6, 30);

const ctx = (over: Partial<MessageContext> = {}): MessageContext => ({
  isGroup: false, contactKey: "rahul", groupKey: null, relation: "unknown", mentioned: true, text: "are you coming?", category: "question", now: NOW, ...over,
});
let n = 0;
const rule = (over: Partial<ReplyRule>): ReplyRule => ({
  id: `rr_${++n}`, effect: "never", subject_type: "all", subject_key: null, subject_label: "x", conditions: null, expires_at: null, source: "chat", utterance: null, created_at: NOW - 1000 + n, ...over,
});
const stats = (subject: Counts = ZERO, relation: Counts = ZERO, global: Counts = ZERO) => ({ subject, relation, global });
const input = (over: Partial<DecideInput> = {}): DecideInput => ({
  ctx: ctx(), rules: [], stats: stats(), history: { used: 0, total: 0 }, pReply: 0.75, names: { contact: "Rahul", group: null }, explore: { usedToday: 0, roll: 0.99 }, ...over,
});

describe("rule precedence", () => {
  it("contact beats group beats relation beats all_groups/all_dms beats all", () => {
    const all = rule({ effect: "always", subject_type: "all" });
    const dms = rule({ effect: "never", subject_type: "all_dms" });
    const rel = rule({ effect: "always", subject_type: "relation", subject_key: "family" });
    const con = rule({ effect: "never", subject_type: "contact", subject_key: "mom" });
    const c = ctx({ contactKey: "mom", relation: "family" });
    expect(matchRule([all], c)!.effect).toBe("always");
    expect(matchRule([all, dms], c)!.rule).toBe(dms);
    expect(matchRule([all, dms, rel], c)!.rule).toBe(rel);
    expect(matchRule([all, dms, rel, con], c)!.rule).toBe(con);

    const g = ctx({ isGroup: true, groupKey: "office", contactKey: "priya" });
    const grp = rule({ effect: "never", subject_type: "group", subject_key: "office" });
    const allG = rule({ effect: "always", subject_type: "all_groups" });
    expect(matchRule([allG, grp], g)!.rule).toBe(grp);
    // a contact rule covers DMs only unless it says otherwise
    const conDm = rule({ effect: "always", subject_type: "contact", subject_key: "priya" });
    expect(matchRule([grp, conDm], g)!.rule).toBe(grp);
    const conGroups = rule({ effect: "always", subject_type: "contact", subject_key: "priya", conditions: { chat: "group" } });
    expect(matchRule([grp, conGroups], g)!.rule).toBe(conGroups);
  });

  it("conditions add weight and must match", () => {
    const plain = rule({ effect: "never", subject_type: "group", subject_key: "office" });
    const mention = rule({ effect: "always", subject_type: "group", subject_key: "office", conditions: { mention_only: true }, created_at: NOW - 5000 });
    expect(matchRule([plain, mention], ctx({ isGroup: true, groupKey: "office", mentioned: true }))!.effect).toBe("always");
    expect(matchRule([plain, mention], ctx({ isGroup: true, groupKey: "office", mentioned: false }))!.effect).toBe("never");
    const kw = rule({ effect: "always", subject_type: "all", conditions: { keywords_any: ["invoice"] } });
    expect(matchRule([kw], ctx({ text: "where is the invoice" }))).not.toBeNull();
    expect(matchRule([kw], ctx({ text: "hi" }))).toBeNull();
    // 22:00-07:00 IST window; NOW is 12:00 IST
    const night = rule({ effect: "never", subject_type: "all", conditions: { time: { from_hour: 22, to_hour: 7 } } });
    expect(matchRule([night], ctx())).toBeNull();
    expect(matchRule([night], ctx({ now: NOW + 11 * 3600_000 }))).not.toBeNull(); // 23:00 IST
  });

  it("ties go to the newest rule; expired rules are ignored", () => {
    const older = rule({ effect: "never", subject_type: "contact", subject_key: "rahul", created_at: NOW - 10_000 });
    const newer = rule({ effect: "always", subject_type: "contact", subject_key: "rahul", created_at: NOW - 5_000 });
    expect(matchRule([older, newer], ctx())!.rule).toBe(newer);
    expect(matchRule([older, { ...newer, expires_at: NOW - 1 }], ctx())!.rule).toBe(older);
  });

  it("'only' = always for its subject, weak never for everyone else", () => {
    const only = rule({ effect: "only", subject_type: "contact", subject_key: "mom" });
    expect(matchRule([only], ctx({ contactKey: "mom" }))!.effect).toBe("always");
    expect(matchRule([only], ctx({ contactKey: "rahul" }))!.effect).toBe("never");
    // any explicit rule (even "all") outranks the implied never
    expect(matchRule([only, rule({ effect: "always", subject_type: "all" })], ctx({ contactKey: "rahul" }))!.effect).toBe("always");
  });

  it("rules win over the learned score both ways", () => {
    const never = rule({ effect: "never", subject_type: "contact", subject_key: "rahul" });
    expect(decideReplyCard(input({ rules: [never], stats: stats({ pos: 20, neg: 0 }) }))).toMatchObject({ show: false, reason: "rule_never" });
    const always = rule({ effect: "always", subject_type: "contact", subject_key: "rahul", subject_label: "Rahul" });
    const d = decideReplyCard(input({ rules: [always], stats: stats({ pos: 0, neg: 20 }), pReply: 0.1 }));
    expect(d).toMatchObject({ show: true, reason: "rule_always", why: "You asked me to always suggest replies for Rahul" });
    // "always" still skips messages with nothing to answer
    expect(decideReplyCard(input({ rules: [always], ctx: ctx({ category: "ack", text: "ok" }) })).show).toBe(false);
  });

  it("scope keys: same subject replaces, contact DM vs group differ", () => {
    const a = ruleScopeKey({ subject_type: "contact", subject_key: "rahul", conditions: null });
    expect(a).toBe(ruleScopeKey({ subject_type: "contact", subject_key: "rahul", conditions: { mention_only: true } }));
    expect(a).not.toBe(ruleScopeKey({ subject_type: "contact", subject_key: "rahul", conditions: { chat: "group" } }));
    expect(ruleScopeKey({ subject_type: "all", subject_key: null, conditions: null })).toBe("all:");
  });
});

describe("cold start", () => {
  it("uses the relation defaults", () => {
    const r = (relation: MessageContext["relation"]) => learnedRate(ctx({ relation }), stats());
    expect(r("family")).toBeCloseTo(COLD_START.family);
    expect(r("work")).toBeCloseTo(COLD_START.work);
    expect(r("friend")).toBeCloseTo(COLD_START.friend);
    expect(r("unknown")).toBeCloseTo(COLD_START.unknown);
    expect(learnedRate(ctx({ isGroup: true, groupKey: "g", mentioned: false }), stats())).toBeCloseTo(COLD_START.group);
    expect(learnedRate(ctx({ isGroup: true, groupKey: "g", mentioned: true }), stats())).toBeCloseTo(COLD_START.group_mentioned);
  });

  it("shows for a family question, not for unaddressed group chatter or low-likelihood messages", () => {
    expect(decideReplyCard(input({ ctx: ctx({ relation: "family" }), pReply: 0.75 })).show).toBe(true);
    expect(decideReplyCard(input({ ctx: ctx({ isGroup: true, groupKey: "g", mentioned: false }), pReply: 0.4 })).show).toBe(false);
    expect(decideReplyCard(input({ ctx: ctx({ isGroup: true, groupKey: "g", mentioned: true }), pReply: 0.75 })).show).toBe(true);
    expect(decideReplyCard(input({ ctx: ctx({ relation: "unknown", category: "info" }), pReply: 0.15 })).show).toBe(false);
    expect(showScore(0.6, 0.75)).toBeGreaterThan(SHOW_THRESHOLD);
  });

  it("why explains the decision", () => {
    expect(decideReplyCard(input({ ctx: ctx({ relation: "family" }), names: { contact: "Mom", group: null } })).why).toBe("Mom (family) asked you something");
    expect(decideReplyCard(input({ history: { used: 7, total: 8 }, names: { contact: "Priya", group: null } })).why).toBe("You used 7 of your last 8 suggestions for Priya");
  });

  it("exploration is capped at 3/day and labelled", () => {
    // unknown contact + plain plan message: score just under the threshold
    const base = input({ ctx: ctx({ category: "plan" }), pReply: 0.3, explore: { usedToday: 0, roll: 0.01 } });
    const d = decideReplyCard(base);
    expect(d).toMatchObject({ show: true, exploration: true, reason: "explore" });
    expect(d.why).toMatch(/learn/);
    expect(decideReplyCard({ ...base, explore: { usedToday: 3, roll: 0.01 } }).show).toBe(false);
    expect(decideReplyCard({ ...base, explore: { usedToday: 0, roll: 0.9 } }).show).toBe(false);
    expect(decideReplyCard({ ...base, ctx: ctx({ isGroup: true, groupKey: "g", mentioned: false, category: "plan" }) }).exploration).toBe(false);
  });
});

describe("learning", () => {
  it("evidence per outcome; ignore counts only when the user was active", () => {
    expect(outcomeEvidence("wanted", true)).toEqual({ pos: 1, neg: 0 });
    expect(outcomeEvidence("not_now", true)).toEqual({ pos: 0, neg: 0.5 });
    expect(outcomeEvidence("ignored", true)).toEqual({ pos: 0, neg: 0.5 });
    expect(outcomeEvidence("ignored", false)).toEqual({ pos: 0, neg: 0 });
  });

  it("approvals raise and not-nows lower the subject score; pooled toward the relation", () => {
    const c = ctx({ relation: "unknown" });
    const cold = learnedRate(c, stats());
    const up = learnedRate(c, stats({ pos: 5, neg: 0 }));
    const down = learnedRate(c, stats({ pos: 0, neg: 3 }));
    expect(up).toBeGreaterThan(0.7);
    expect(down).toBeLessThan(cold);
    // a contact the user always rejects ends up hidden
    expect(decideReplyCard(input({ stats: stats({ pos: 0, neg: 6 }), pReply: 0.75 })).show).toBe(false);
    // relation evidence moves a brand-new contact of that relation
    expect(learnedRate(c, stats(ZERO, { pos: 0, neg: 10 }))).toBeLessThan(cold);
    // global evidence moves everyone
    expect(learnedRate(c, stats(ZERO, ZERO, { pos: 30, neg: 0 }))).toBeGreaterThan(cold);
  });

  it("old evidence fades with a 45-day half-life", () => {
    expect(decayed({ pos: 4, neg: 2 }, NOW - HALF_LIFE_MS, NOW)).toEqual({ pos: 2, neg: 1 });
    const ev = [{ subject_key: "c:rahul", relation_key: "r:unknown", is_group: 0, outcome: "wanted", active: 1, ts: NOW - 2 * HALF_LIFE_MS }];
    const s = recomputeStats(ev, NOW);
    expect(s.get("c:rahul")!.pos).toBeCloseTo(0.25);
    expect(s.get("r:unknown")!.pos).toBeCloseTo(0.25);
    expect(s.get("*:dm")!.pos).toBeCloseTo(0.25);
    expect(s.has("*:group")).toBe(false);
  });

  it("combinePReply prefers the model, then expects_reply, then the heuristic", () => {
    expect(combinePReply(0.2, true, 0.9)).toBe(0.2);
    expect(combinePReply(null, true, 0.3)).toBe(0.6);
    expect(combinePReply(null, false, 0.7)).toBe(0.1);
    expect(combinePReply(null, null, 0.42)).toBe(0.42);
  });

  it("heuristic reply likelihood (English + Hinglish)", () => {
    expect(heuristicReply("Are you coming for dinner?", false)).toMatchObject({ category: "question" });
    expect(heuristicReply("kal kab aa rahe ho", false).p_reply).toBeGreaterThan(0.5);
    expect(heuristicReply("ok", false)).toMatchObject({ category: "ack", p_reply: 0.05 });
    expect(heuristicReply("Your OTP is 1234", false).category).toBe("automated");
    expect(heuristicReply("anyone up for football?", true).p_reply).toBeLessThan(heuristicReply("anyone up for football?", false).p_reply);
  });

  it("mention detection", () => {
    expect(mentionsUser("@Ishaan are you coming?", "Ishaan Pare")).toBe(true);
    expect(mentionsUser("ishaan bhai kal?", "Ishaan")).toBe(true);
    expect(mentionsUser("Ishaanvi said hi", "Ishaan")).toBe(false);
    expect(mentionsUser("lol", "Ishaan")).toBe(false);
  });
});

describe("group vs DM keys", () => {
  it("group messages learn on a group key, DMs on a contact key", () => {
    expect(subjectKey(ctx({ contactKey: "rahul" }))).toBe("c:rahul");
    expect(subjectKey(ctx({ isGroup: true, contactKey: "rahul", groupKey: "football" }))).toBe("g:football");
    expect(relationKey(ctx({ relation: "work" }))).toBe("r:work");
    expect(relationKey(ctx({ isGroup: true, relation: "work" }))).toBe("r:group");
    expect(relationBucket("Family")).toBe("family");
    expect(relationBucket(null)).toBe("unknown");
  });

  it("'Never' on a group card blocks the group, not the person's DMs", () => {
    const card = { isGroup: true, contactKey: "rahul", contactName: "Rahul", groupKey: "football", groupName: "Football", category: "question" };
    const r = neverRuleFor(undefined, card);
    expect(r).toMatchObject({ subject_type: "group", subject_key: "football" });
    const full = { ...r, id: "x", created_at: NOW, expires_at: null, source: "button" as const, utterance: null };
    expect(matchRule([full], ctx({ contactKey: "rahul" }))).toBeNull(); // Rahul's DM unaffected
    // "Not for Rahul" on a group card: Rahul in groups only
    const c = neverRuleFor("contact", card);
    expect(c).toMatchObject({ subject_type: "contact", subject_key: "rahul", conditions: { chat: "group" } });
    const cf = { ...c, id: "y", created_at: NOW, expires_at: null, source: "button" as const, utterance: null };
    expect(matchRule([cf], ctx({ contactKey: "rahul" }))).toBeNull();
    expect(matchRule([cf], ctx({ isGroup: true, contactKey: "rahul", groupKey: "family" }))!.effect).toBe("never");
    // DM card default + like_this
    expect(neverRuleFor(undefined, { ...card, isGroup: false, groupKey: null, groupName: null })).toMatchObject({ subject_type: "contact", conditions: null });
    expect(neverRuleFor("like_this", card)).toMatchObject({ subject_type: "group", conditions: { categories: ["question"] } });
  });

  it("quick actions", () => {
    expect(quickActions(false, "Priya", null)).toEqual([{ id: "never_contact", label: "Not for Priya" }]);
    expect(quickActions(true, "Priya", "Family")).toEqual([{ id: "never_contact", label: "Not for Priya" }, { id: "never_group", label: "Not in Family" }]);
  });
});

describe("natural-language rules (regex)", () => {
  it("English", () => {
    expect(parseReplyCommand("always show me reply options for Mom", NOW)).toEqual({ kind: "rule", effect: "always", target: { type: "name", name: "Mom", hint: null }, conditions: null, expires_at: null });
    expect(parseReplyCommand("don't suggest replies in groups", NOW)).toMatchObject({ effect: "never", target: { type: "all_groups" } });
    expect(parseReplyCommand("never suggest replies for my family", NOW)).toMatchObject({ effect: "never", target: { type: "relation", relation: "family" } });
    expect(parseReplyCommand("only suggest replies for Mom", NOW)).toMatchObject({ effect: "only", target: { type: "name", name: "Mom" } });
    expect(parseReplyCommand("stop reply suggestions for Rahul for 2 hours", NOW)).toMatchObject({ effect: "never", target: { name: "Rahul" }, expires_at: NOW + 2 * 3600_000 });
    expect(parseReplyCommand("no reply suggestions in the Cricket Gang group unless I'm mentioned", NOW)).toMatchObject({
      effect: "never", target: { type: "name", name: "Cricket Gang", hint: "group" }, conditions: { unless_mentioned: true },
    });
  });

  it("Hinglish", () => {
    expect(parseReplyCommand("office group mein reply suggest mat karna", NOW)).toMatchObject({ effect: "never", target: { type: "name", name: "office", hint: "group" } });
    expect(parseReplyCommand("Rahul ko aaj ke liye mat dikhana", NOW)).toMatchObject({ effect: "never", target: { type: "name", name: "Rahul" }, expires_at: endOfIstDay(NOW) });
    expect(parseReplyCommand("Mom ke messages pe hamesha reply suggest karna", NOW)).toMatchObject({ effect: "always", target: { name: "Mom" } });
    expect(endOfIstDay(NOW)).toBe(Date.UTC(2026, 9, 16, 18, 30)); // midnight IST
  });

  it("relation statements", () => {
    expect(parseReplyCommand("Priya is from work", NOW)).toEqual({ kind: "relation", name: "Priya", relation: "work" });
    expect(parseRelationStatement("Priya office se hai")).toEqual({ name: "Priya", relation: "work" });
    expect(parseRelationStatement("Rahul is my friend")).toEqual({ name: "Rahul", relation: "friend" });
    expect(parseRelationStatement("this is from work")).toBeNull();
  });

  it("prefilter ignores ordinary chat", () => {
    for (const t of ["what's the weather", "don't give me options", "can you reply to Mom for me", "I never reply on time lol"]) {
      expect(parseReplyCommand(t, NOW), t).toBeNull();
    }
    expect(looksLikeReplyCommand("what's the weather")).toBe(false);
    expect(looksLikeReplyCommand("always show me reply options for Mom")).toBe(true);
    expect(parseReplyCommand("screen mat dikhana", NOW)).toBeNull(); // no subject, no reply word
  });
});

describe("natural-language rules (model JSON)", () => {
  it("validates the model output and falls back on junk", () => {
    expect(parseModelCommand({ is_rule: true, kind: "rule", effect: "never", target: { type: "contact", name: "Rahul" }, duration: "today" }, NOW)).toEqual({
      kind: "rule", effect: "never", target: { type: "name", name: "Rahul", hint: "contact" }, conditions: null, expires_at: endOfIstDay(NOW),
    });
    expect(parseModelCommand({ is_rule: true, kind: "relation", target: { name: "Priya", relation: "work" } }, NOW)).toEqual({ kind: "relation", name: "Priya", relation: "work" });
    expect(parseModelCommand({ is_rule: false }, NOW)).toBe("not_rule");
    expect(parseModelCommand({ is_rule: true, effect: "maybe", target: { type: "all" } }, NOW)).toBeNull();
    expect(parseModelCommand({ is_rule: true, effect: "never", target: { type: "contact", name: "" } }, NOW)).toBeNull();
    expect(parseModelCommand(null, NOW)).toBeNull();
    expect(parseModelCommand({ is_rule: true, kind: "rule", effect: "always", target: { type: "group", name: "Office" }, mention_only: true, keywords: ["deploy", 3] }, NOW)).toMatchObject({
      conditions: { mention_only: true, keywords_any: ["deploy"] },
    });
  });
});

describe("name resolution", () => {
  const cands = [
    { type: "contact" as const, key: "mom", label: "Mom" },
    { type: "contact" as const, key: "rahul sharma", label: "Rahul Sharma" },
    { type: "contact" as const, key: "rahul verma", label: "Rahul Verma" },
    { type: "group" as const, key: "office team", label: "Office Team" },
    { type: "contact" as const, key: "priya", label: "Priya" },
    { type: "group" as const, key: "priya", label: "Priya" },
  ];
  it("exact, partial, unknown and ambiguous", () => {
    expect(resolveName("Mom", null, cands)).toMatchObject({ kind: "one", c: { key: "mom" }, known: true });
    expect(resolveName("office", "group", cands)).toMatchObject({ kind: "one", c: { type: "group", key: "office team", label: "Office Team" } });
    expect(resolveName("Neha", null, cands)).toMatchObject({ kind: "one", c: { type: "contact", key: "neha", label: "Neha" }, known: false });
    const amb = resolveName("Rahul", null, cands);
    expect(amb.kind).toBe("ambiguous");
    expect(resolveName("Priya", null, cands).kind).toBe("ambiguous");
    expect(resolveName("Priya", "contact", cands)).toMatchObject({ kind: "one", c: { type: "contact" } });
  });
  it("picks an option from the answer", () => {
    const opts = [cands[1]!, cands[2]!];
    expect(pickOption("2", opts)).toBe(cands[2]);
    expect(pickOption("rahul sharma", opts)).toBe(cands[1]);
    expect(pickOption("the group", [cands[4]!, cands[5]!])).toBe(cands[5]);
    expect(pickOption("whatever", opts)).toBeNull();
  });
});
