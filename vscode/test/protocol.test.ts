import { describe, expect, it } from "vitest";
import {
  backoffDelay,
  BoundedQueue,
  emotionWord,
  isValidPairCode,
  makeEnvelope,
  newId,
  normaliseBrainUrl,
  normalisePerformance,
  parseFrame,
  wsUrlFor,
} from "../src/protocol";
import { DebouncedGate, Clock } from "../src/throttle";

describe("envelopes", () => {
  it("builds v1 envelopes with unique short ids", () => {
    const e = makeEnvelope("user.say", { text: "hi", via: "typed" }, 123);
    expect(e).toMatchObject({ v: 1, ts: 123, type: "user.say", data: { text: "hi", via: "typed" } });
    expect(e.id.length).toBeLessThanOrEqual(64);
    const ids = new Set(Array.from({ length: 1000 }, () => newId()));
    expect(ids.size).toBe(1000);
  });

  it("parses frames", () => {
    expect(parseFrame("pong")).toBe("pong");
    expect(parseFrame("not json")).toBeNull();
    expect(parseFrame('{"nope":1}')).toBeNull();
    expect(parseFrame('{"v":1,"id":"a","ts":1,"type":"welcome","data":{"user_name":"I"}}')).toMatchObject({
      type: "welcome",
      data: { user_name: "I" },
    });
  });
});

describe("performance", () => {
  it("falls back for unknown values", () => {
    const p = normalisePerformance({ say: "hi", emotion: "ecstatic", gesture: "moonwalk", gaze: "ceiling", intensity: 7 });
    expect(p).toMatchObject({ say: "hi", emotion: "neutral", gesture: "none", gaze: "user", intensity: 1, speak: false });
    expect(normalisePerformance(null).say).toBe("");
  });

  it("maps emotions to status words", () => {
    expect(emotionWord("curious")).toBe("curious");
    expect(emotionWord("neutral")).toBe("here");
    expect(emotionWord("bogus")).toBe("here");
  });
});

describe("backoff", () => {
  it("doubles from 1 s up to 30 s", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 10].map((a) => backoffDelay(a, 0))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ]);
  });
  it("jitters within bounds", () => {
    for (let a = 0; a < 10; a++) {
      const d = backoffDelay(a, 0.2, () => 0.999);
      expect(d).toBeGreaterThanOrEqual(1000);
      expect(d).toBeLessThanOrEqual(30000);
    }
  });
});

describe("BoundedQueue", () => {
  it("drops the oldest beyond the cap", () => {
    const q = new BoundedQueue<number>(100);
    for (let i = 0; i < 150; i++) q.push(i);
    expect(q.size).toBe(100);
    const d = q.drain();
    expect(d[0]).toBe(50);
    expect(d[99]).toBe(149);
    expect(q.size).toBe(0);
  });
});

describe("URLs and codes", () => {
  it("normalises brain URLs", () => {
    expect(normaliseBrainUrl("pixie.example.workers.dev/")).toBe("https://pixie.example.workers.dev");
    expect(normaliseBrainUrl("https://x.dev/v1/")).toBe("https://x.dev");
    expect(normaliseBrainUrl("http://localhost:8787")).toBe("http://localhost:8787");
    expect(() => normaliseBrainUrl("")).toThrow();
    expect(() => normaliseBrainUrl("ftp://x")).toThrow();
  });
  it("derives the ws URL", () => {
    expect(wsUrlFor("https://x.dev")).toBe("wss://x.dev/v1/ws");
    expect(wsUrlFor("http://localhost:8787/")).toBe("ws://localhost:8787/v1/ws");
  });
  it("validates pairing codes", () => {
    expect(isValidPairCode("482913")).toBe(true);
    expect(isValidPairCode("48291")).toBe(false);
    expect(isValidPairCode("48a913")).toBe(false);
  });
});

class FakeClock implements Clock {
  t = 0;
  timers: { at: number; fn: () => void; id: number }[] = [];
  private seq = 0;
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = ++this.seq;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  }
  clearTimeout(h: unknown) {
    this.timers = this.timers.filter((x) => x.id !== h);
  }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

describe("DebouncedGate", () => {
  it("debounces 3 s and fires at most once per 30 s", () => {
    const clock = new FakeClock();
    let fired: number[] = [];
    const g = new DebouncedGate(() => fired.push(clock.now()), 3000, 30000, clock);
    g.trigger();
    clock.advance(1000);
    g.trigger(); // resets the debounce
    clock.advance(2999);
    expect(fired).toEqual([]);
    clock.advance(1);
    expect(fired).toEqual([4000]);
    // Another change shortly after → waits until 30 s after the last fire.
    clock.advance(1000);
    g.trigger();
    clock.advance(10000);
    expect(fired).toEqual([4000]);
    clock.advance(30000);
    expect(fired).toEqual([4000, 34000]);
    fired = [];
    g.trigger();
    g.cancel();
    clock.advance(60000);
    expect(fired).toEqual([]);
  });
});
