import { describe, expect, it } from "vitest";
import { cosine, evictionOrder, findDuplicate, nearDuplicatePairs, parseVec, topK, vecToJson } from "../src/brain/vectors";

describe("cosine", () => {
  it("basic properties", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1);
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(cosine([], [])).toBe(0);
    expect(cosine([2, 2], [1, 1])).toBeCloseTo(1);
  });
});

describe("topK", () => {
  const items = [{ id: 1, v: [1, 0] }, { id: 2, v: [0.9, 0.1] }, { id: 3, v: [0, 1] }, { id: 4, v: null as number[] | null }, { id: 5, v: [-1, 0] }];
  it("returns the k most similar, highest first", () => {
    const r = topK([1, 0], items, (x) => x.v, 2);
    expect(r.map((x) => x.item.id)).toEqual([1, 2]);
  });
  it("respects minScore and skips null vectors", () => {
    expect(topK([1, 0], items, (x) => x.v, 10, 0.5).map((x) => x.item.id)).toEqual([1, 2]);
  });
  it("k=0", () => expect(topK([1, 0], items, (x) => x.v, 0)).toEqual([]));
  it("matches a full sort on random data", () => {
    const rnd = Array.from({ length: 300 }, (_, i) => ({ id: i, v: Array.from({ length: 8 }, () => Math.random() - 0.5) }));
    const q = Array.from({ length: 8 }, () => Math.random() - 0.5);
    const expected = [...rnd].sort((a, b) => cosine(q, b.v) - cosine(q, a.v)).slice(0, 5).map((x) => x.id);
    expect(topK(q, rnd, (x) => x.v, 5).map((x) => x.item.id)).toEqual(expected);
  });
});

describe("dedupe / merge / eviction", () => {
  it("findDuplicate", () => {
    expect(findDuplicate([1, 0], [[0, 1], [0.99, 0.01], null], 0.9)).toBe(1);
    expect(findDuplicate([1, 0], [[0, 1]], 0.9)).toBe(-1);
  });
  it("nearDuplicatePairs keeps higher value", () => {
    const pairs = nearDuplicatePairs(
      [
        { id: 1, vec: [1, 0], value: 0.5, ts: 1 },
        { id: 2, vec: [0.99, 0.02], value: 0.9, ts: 2 },
        { id: 3, vec: [0, 1], value: 0.5, ts: 3 },
      ],
      0.92,
    );
    expect(pairs).toEqual([[2, 1]]);
  });
  it("evictionOrder drops lowest value then oldest", () => {
    const items = [
      { id: 1, value: 0.5, ts: 1 }, { id: 2, value: 0.1, ts: 5 }, { id: 3, value: 0.5, ts: 0 }, { id: 4, value: 0.9, ts: 0 },
    ];
    expect(evictionOrder(items, 2)).toEqual([2, 3]);
    expect(evictionOrder(items, 10)).toEqual([]);
  });
  it("vec json roundtrip", () => {
    expect(parseVec(vecToJson([0.1234567, -1]))).toEqual([0.12346, -1]);
    expect(parseVec("bad")).toBe(null);
    expect(parseVec(null)).toBe(null);
  });
});
