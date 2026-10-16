import { describe, expect, it } from "vitest";
import {
  baseTier, confidence, consecutiveApprovals, decideTier, digestDue, expectsReply, isFocused, isForbidden, isPromotable,
  parseYesNo, patternKey, routeNotification, shouldDraftReply, shouldOfferPromotion, type DecisionRow,
} from "../src/brain/decide";

const empty = { promoted: new Set<string>(), blocked: new Set<string>() };
const approvals = (pattern: string, n: number, start = 1000): DecisionRow[] =>
  Array.from({ length: n }, (_, i) => ({ pattern, verdict: "approve" as const, ts: start + i }));

describe("baseTier", () => {
  it.each(["hold_notifications", "digest", "reminder.set", "pause_commentary"])("%s is auto", (k) => {
    expect(baseTier({ kind: k })).toBe("auto");
  });
  it.each(["whatsapp.reply", "call.back", "code.patch", "reminder"])("%s is propose", (k) => {
    expect(baseTier({ kind: k })).toBe("propose");
  });
  it.each(["payment", "upi.pay", "send_money_transfer", "password.read", "credentials", "delete_file", "file.delete", "system.settings", "account.update", "wipe", "uninstall", "bank.transfer", "otp.share"])(
    "%s is never",
    (k) => expect(baseTier({ kind: k })).toBe("never"),
  );
  it("unknown kinds fail closed", () => {
    expect(baseTier({ kind: "email.send" })).toBe("never");
    expect(baseTier({ kind: "" })).toBe("never");
  });
  it("sending without approval is never", () => {
    expect(baseTier({ kind: "whatsapp.reply", sendsWithoutApproval: true })).toBe("never");
  });
  it("a reply whose text shares an OTP or password is never", () => {
    expect(baseTier({ kind: "whatsapp.reply", text: "Sure, my OTP is 123456" })).toBe("never");
    expect(baseTier({ kind: "whatsapp.reply", text: "the password is hunter2" })).toBe("never");
    expect(baseTier({ kind: "whatsapp.reply", text: "I'll pay you tomorrow" })).toBe("never");
    expect(baseTier({ kind: "whatsapp.reply", text: "Sure, calling you at 6!" })).toBe("propose");
  });
  it("code patches may mention passwords (code is code)", () => {
    expect(baseTier({ kind: "code.patch", text: "fix password validation" })).toBe("propose");
  });
  it("is case-insensitive on kind", () => {
    expect(baseTier({ kind: "WhatsApp.Reply" })).toBe("propose");
  });
  it("isForbidden mirrors never", () => {
    expect(isForbidden({ kind: "payment" })).toBe(true);
    expect(isForbidden({ kind: "reminder" })).toBe(false);
  });
});

describe("confidence", () => {
  it("prior is 0.5", () => expect(confidence([], "a|b")).toBeCloseTo(0.5));
  it("rises with approvals and falls with rejections", () => {
    const now = 10_000;
    const up = confidence(approvals("p", 8), "p", now);
    const down = confidence(Array.from({ length: 8 }, (_, i) => ({ pattern: "p", verdict: "reject" as const, ts: i })), "p", now);
    expect(up).toBeGreaterThan(0.85);
    expect(down).toBeLessThan(0.15);
  });
  it("never counts heavier than reject", () => {
    const r = confidence([{ pattern: "p", verdict: "reject", ts: 0 }], "p", 0);
    const n = confidence([{ pattern: "p", verdict: "never", ts: 0 }], "p", 0);
    expect(n).toBeLessThan(r);
  });
  it("ignores other patterns and auto rows", () => {
    expect(confidence([{ pattern: "q", verdict: "approve", ts: 0 }, { pattern: "p", verdict: "auto", ts: 0 }], "p", 0)).toBeCloseTo(0.5);
  });
  it("old decisions weigh less", () => {
    const day = 86_400_000;
    const old = confidence([{ pattern: "p", verdict: "reject", ts: 0 }], "p", 120 * day);
    const fresh = confidence([{ pattern: "p", verdict: "reject", ts: 120 * day }], "p", 120 * day);
    expect(old).toBeGreaterThan(fresh);
  });
});

describe("consecutiveApprovals / promotion", () => {
  it("counts approvals since last non-approval", () => {
    const log: DecisionRow[] = [{ pattern: "p", verdict: "reject", ts: 1 }, ...approvals("p", 4, 10)];
    expect(consecutiveApprovals(log, "p")).toBe(4);
  });
  it("auto rows do not break the streak", () => {
    const log: DecisionRow[] = [...approvals("p", 3, 10), { pattern: "p", verdict: "auto", ts: 100 }];
    expect(consecutiveApprovals(log, "p")).toBe(3);
  });
  it("offers promotion after 10 approvals for promotable kinds", () => {
    const pat = patternKey("reminder", null);
    expect(shouldOfferPromotion(approvals(pat, 9), "reminder", pat, new Set(), new Set())).toBe(false);
    expect(shouldOfferPromotion(approvals(pat, 10), "reminder", pat, new Set(), new Set())).toBe(true);
  });
  it("asks only once", () => {
    const pat = patternKey("digest_rule", "family");
    expect(shouldOfferPromotion(approvals(pat, 12), "digest_rule", pat, new Set([pat]), new Set())).toBe(false);
    expect(shouldOfferPromotion(approvals(pat, 12), "digest_rule", pat, new Set(), new Set([pat]))).toBe(false);
  });
  it("NEVER offers to promote whatsapp.reply, call.back or code.patch", () => {
    for (const k of ["whatsapp.reply", "call.back", "code.patch"]) {
      const pat = patternKey(k, "Mom");
      expect(isPromotable(k)).toBe(false);
      expect(shouldOfferPromotion(approvals(pat, 50), k, pat, new Set(), new Set())).toBe(false);
    }
  });
});

describe("decideTier", () => {
  it("whatsapp.reply stays propose even if someone put it in promoted", () => {
    const pat = patternKey("whatsapp.reply", "Mom");
    const d = decideTier({ kind: "whatsapp.reply", target: "Mom" }, { promoted: new Set([pat]), blocked: new Set(), log: approvals(pat, 100) });
    expect(d.tier).toBe("propose");
  });
  it("promoted promotable pattern becomes auto", () => {
    const pat = patternKey("digest_rule", "Work group");
    expect(decideTier({ kind: "digest_rule", target: "Work group" }, { promoted: new Set([pat]), blocked: new Set() }).tier).toBe("auto");
  });
  it("blocked patterns are suppressed", () => {
    const pat = patternKey("call.back", "Spam");
    expect(decideTier({ kind: "call.back", target: "Spam" }, { promoted: new Set(), blocked: new Set([pat]) }).tier).toBe("suppress");
  });
  it("forbidden beats everything", () => {
    expect(decideTier({ kind: "payment" }, { promoted: new Set([patternKey("payment", null)]), blocked: new Set() }).tier).toBe("never");
  });
  it("suppresses after many rejections", () => {
    const pat = patternKey("call.back", "Bob");
    const log: DecisionRow[] = Array.from({ length: 6 }, (_, i) => ({ pattern: pat, verdict: "reject" as const, ts: i }));
    expect(decideTier({ kind: "call.back", target: "Bob" }, { ...empty, log, now: 10 }).tier).toBe("suppress");
  });
  it("auto kinds are auto", () => {
    expect(decideTier({ kind: "reminder.set" }, empty).tier).toBe("auto");
  });
});

describe("routeNotification", () => {
  const base = { urgency: 0.3, activity: "browsing" as const, focusMode: false, inCall: false, digestRule: false };
  it("urgent interrupts", () => expect(routeNotification({ ...base, urgency: 0.6 })).toBe("interrupt"));
  it("idle interrupts even if low urgency", () => expect(routeNotification({ ...base, activity: "idle" })).toBe("interrupt"));
  it("low urgency while busy is digested", () => expect(routeNotification(base)).toBe("digest"));
  it("meeting holds low urgency", () => expect(routeNotification({ ...base, activity: "meeting" })).toBe("digest"));
  it("coding holds low urgency", () => expect(routeNotification({ ...base, activity: "coding" })).toBe("digest"));
  it("focus mode while idle still digests low urgency", () => expect(routeNotification({ ...base, activity: "idle", focusMode: true })).toBe("digest"));
  it("in call: only very urgent breaks through", () => {
    expect(routeNotification({ ...base, inCall: true, urgency: 0.7 })).toBe("digest");
    expect(routeNotification({ ...base, inCall: true, urgency: 0.9 })).toBe("interrupt");
  });
  it("digest rule holds unless very urgent", () => {
    expect(routeNotification({ ...base, activity: "idle", digestRule: true, urgency: 0.5 })).toBe("digest");
    expect(routeNotification({ ...base, digestRule: true, urgency: 0.95 })).toBe("interrupt");
  });
  it("isFocused", () => {
    expect(isFocused("meeting", false)).toBe(true);
    expect(isFocused("idle", true)).toBe(true);
    expect(isFocused("video", false)).toBe(false);
  });
});

describe("digestDue", () => {
  const b = { queued: 2, lastSentTs: 0, now: 16 * 60_000, activity: "browsing" as const, activityJustBecameIdle: false, focused: false };
  it("after 15 minutes", () => expect(digestDue(b)).toBe(true));
  it("not before 15 minutes", () => expect(digestDue({ ...b, now: 14 * 60_000 })).toBe(false));
  it("not when empty", () => expect(digestDue({ ...b, queued: 0 })).toBe(false));
  it("held while focused", () => expect(digestDue({ ...b, focused: true })).toBe(false));
  it("when returning to idle", () => expect(digestDue({ ...b, now: 1000, activityJustBecameIdle: true })).toBe(true));
});

describe("reply heuristics", () => {
  it("questions expect replies", () => {
    expect(expectsReply("Are you coming for dinner?", false)).toBe(true);
    expect(expectsReply("Call me when free", false)).toBe(true);
    expect(expectsReply("ok", false)).toBe(false);
    expect(expectsReply("Thanks!", false)).toBe(false);
    expect(expectsReply("3 new messages", false)).toBe(false);
  });
  it("group messages need a mention-ish question", () => {
    expect(expectsReply("Anyone up for football?", true)).toBe(false);
    expect(expectsReply("@you are you coming?", true)).toBe(true);
  });
  it("shouldDraftReply requires whatsapp + replyable + key", () => {
    const m = { app: "whatsapp", replyable: true, preview: "Are you free at 6?", is_group: false, key: "k1" };
    expect(shouldDraftReply(m)).toBe(true);
    expect(shouldDraftReply({ ...m, app: "sms" })).toBe(false);
    expect(shouldDraftReply({ ...m, replyable: false })).toBe(false);
    expect(shouldDraftReply({ ...m, key: "" })).toBe(false);
  });
  it("parseYesNo", () => {
    expect(parseYesNo("yes please")).toBe("yes");
    expect(parseYesNo("Sure")).toBe("yes");
    expect(parseYesNo("nope")).toBe("no");
    expect(parseYesNo("what's the weather")).toBe(null);
  });
});
