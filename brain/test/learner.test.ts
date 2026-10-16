import { describe, expect, it } from "vitest";
import { heuristicPreferences, parseLearnerOutput, updatedImportance, type FeedbackRow } from "../src/brain/learner";

const fb = (verdict: string, draft: string, final: string | null = null, kind = "whatsapp.reply"): FeedbackRow => ({ kind, verdict, draft, final, ts: 0 });

describe("learner", () => {
  it("frequent contacts go up, quiet ones decay slowly", () => {
    expect(updatedImportance(0.4, 20)).toBeGreaterThan(0.4);
    const down = updatedImportance(0.85, 0);
    expect(down).toBeLessThan(0.85);
    expect(down).toBeGreaterThan(0.8);
    expect(updatedImportance(0.9, 1000)).toBeLessThanOrEqual(0.95);
  });
  it("detects 'too formal' rejections", () => {
    const rows = [fb("reject", "Dear Mom, kindly note I will call."), fb("reject", "Regards, I shall come."), fb("never", "I would like to inform you"), fb("approve", "ok!")];
    expect(heuristicPreferences(rows).join(" ")).toMatch(/too formal/);
  });
  it("detects shorter edits", () => {
    const rows = [1, 2, 3].map(() => fb("approve", "Sure, I will definitely be there by six this evening!", "ok 6"));
    expect(heuristicPreferences(rows).join(" ")).toMatch(/shorter/);
  });
  it("detects unwanted call-backs", () => {
    const rows = Array.from({ length: 5 }, () => ({ kind: "call.back", verdict: "reject", draft: null, final: null, ts: 0 }));
    expect(heuristicPreferences(rows).join(" ")).toMatch(/call-back/);
  });
  it("nothing from too little data", () => expect(heuristicPreferences([fb("reject", "Dear x")])).toEqual([]));
  it("parses model output defensively", () => {
    expect(parseLearnerOutput({ episodes: ["Ishaan fixed a nasty bug in the auth service today.", 4, "x"], preferences: "nope" })).toEqual({
      episodes: ["Ishaan fixed a nasty bug in the auth service today."],
      preferences: [],
    });
    expect(parseLearnerOutput(null)).toEqual({ episodes: [], preferences: [] });
  });
});
