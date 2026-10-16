import { beforeEach, describe, expect, it } from "vitest";
import { AiError, DEFAULT_MODELS, WorkersAiBrainpower, cooldownFor, extractText, parseJsonObject, resetModelCooldowns, type AiRunner } from "../src/ai";

class FakeRunner implements AiRunner {
  calls: Array<{ model: string; inputs: Record<string, unknown> }> = [];
  constructor(private readonly impl: (model: string, inputs: Record<string, unknown>) => unknown) {}
  async run(model: string, inputs: Record<string, unknown>) {
    this.calls.push({ model, inputs });
    const r = this.impl(model, inputs);
    if (r instanceof Error) throw r;
    return r;
  }
}

beforeEach(() => resetModelCooldowns());

describe("WorkersAiBrainpower.chat", () => {
  it("uses the first model with the required options", async () => {
    const r = new FakeRunner(() => ({ response: "{\"say\":\"hi\"}" }));
    const ai = new WorkersAiBrainpower(r);
    const out = await ai.chat([{ role: "user", content: "x" }]);
    expect(out.model).toBe(DEFAULT_MODELS[0]);
    expect(r.calls[0]!.inputs).toMatchObject({ chat_template_kwargs: { enable_thinking: false }, response_format: { type: "json_object" } });
  });
  it("falls back and puts the failing model on cooldown", async () => {
    let t = 0;
    const r = new FakeRunner((m) => (m === DEFAULT_MODELS[0] ? new Error("InferenceUpstreamError") : { choices: [{ message: { content: "{}" } }] }));
    const ai = new WorkersAiBrainpower(r, {}, () => t);
    expect((await ai.chat([])).model).toBe(DEFAULT_MODELS[1]);
    r.calls = [];
    t = 30_000;
    await ai.chat([]);
    expect(r.calls.map((c) => c.model)).toEqual([DEFAULT_MODELS[1]]); // first still cooling down
    r.calls = [];
    t = 61_000;
    await ai.chat([]).catch(() => {});
    expect(r.calls[0]!.model).toBe(DEFAULT_MODELS[0]); // retried after 60 s
  });
  it("long cooldown for 5035 / 403 / paid", () => {
    expect(cooldownFor(new Error("AiError: 5035: requires paid plan"))).toBe(6 * 3600_000);
    expect(cooldownFor(new Error("403 Forbidden"))).toBe(6 * 3600_000);
    expect(cooldownFor(new Error("timeout"))).toBe(60_000);
  });
  it("throws AiError when all fail", async () => {
    const ai = new WorkersAiBrainpower(new FakeRunner(() => new Error("x")));
    await expect(ai.chat([])).rejects.toBeInstanceOf(AiError);
  });
  it("honours MODELS env override", async () => {
    const r = new FakeRunner(() => ({ response: "{}" }));
    await new WorkersAiBrainpower(r, { models: " @cf/a/one , @cf/b/two " }).chat([]);
    expect(r.calls[0]!.model).toBe("@cf/a/one");
  });
  it("empty response counts as a failure", async () => {
    const r = new FakeRunner((m) => (m === DEFAULT_MODELS[0] ? { response: "" } : { response: "{}" }));
    expect((await new WorkersAiBrainpower(r).chat([])).model).toBe(DEFAULT_MODELS[1]);
  });
});

describe("vision license", () => {
  it("agrees once and retries", async () => {
    let agreed = false;
    const r = new FakeRunner((_m, i) => {
      if (i.prompt === "agree") {
        agreed = true;
        return { response: "Thank you for agreeing" };
      }
      return agreed ? { response: "A code editor with an error" } : new Error("5016: Prior to using this model, you must submit the prompt 'agree' to accept the license");
    });
    const ai = new WorkersAiBrainpower(r);
    expect(await ai.vision("what?", "data:image/jpeg;base64,AAA")).toBe("A code editor with an error");
    expect(r.calls.filter((c) => c.inputs.prompt === "agree")).toHaveLength(1);
    expect(r.calls[0]!.inputs.image).toBe("data:image/jpeg;base64,AAA");
  });
});

describe("embed", () => {
  it("returns data", async () => {
    const r = new FakeRunner(() => ({ shape: [1, 3], data: [[1, 2, 3]] }));
    expect(await new WorkersAiBrainpower(r).embed(["x"])).toEqual([[1, 2, 3]]);
    expect(r.calls[0]!.inputs).toEqual({ text: ["x"] });
  });
});

describe("parsing helpers", () => {
  it("extractText handles shapes", () => {
    expect(extractText({ response: "a" })).toBe("a");
    expect(extractText({ response: { say: "x" } })).toBe("{\"say\":\"x\"}");
    expect(extractText({ choices: [{ message: { content: "b" } }] })).toBe("b");
    expect(extractText("c")).toBe("c");
    expect(extractText(null)).toBe("");
  });
  it("parseJsonObject tolerates prose", () => {
    expect(parseJsonObject("Sure: {\"a\":1} hope that helps")).toEqual({ a: 1 });
    expect(parseJsonObject("[1,2]")).toBe(null);
    expect(parseJsonObject("nothing")).toBe(null);
  });
});
