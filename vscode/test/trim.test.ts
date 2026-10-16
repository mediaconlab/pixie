import { describe, expect, it } from "vitest";
import { trimAround, truncate } from "../src/trim";

describe("trimAround", () => {
  it("returns short content unchanged", () => {
    expect(trimAround("hello", 2)).toBe("hello");
  });

  it("centres the window on the cursor", () => {
    const s = "a".repeat(50) + "X" + "b".repeat(49);
    const out = trimAround(s, 50, 50, 10);
    expect(out).toHaveLength(10);
    expect(out).toContain("X");
    expect(out.indexOf("X")).toBe(5);
  });

  it("clamps at the start and end", () => {
    const s = "0123456789".repeat(10);
    expect(trimAround(s, 0, 0, 10)).toBe("0123456789");
    expect(trimAround(s, 100, 100, 10)).toBe(s.slice(90));
  });

  it("centres a selection, starting at it when it is longer than max", () => {
    const s = "x".repeat(100) + "S".repeat(20) + "y".repeat(100);
    const out = trimAround(s, 100, 120, 40);
    expect(out).toBe("x".repeat(10) + "S".repeat(20) + "y".repeat(10));
    expect(trimAround(s, 100, 120, 10)).toBe("S".repeat(10));
  });

  it("defaults to 20000 chars", () => {
    expect(trimAround("z".repeat(50000), 25000)).toHaveLength(20000);
  });
});

describe("truncate", () => {
  it("truncates long text", () => {
    expect(truncate("abcdef", 3)).toBe("abc");
    expect(truncate("ab", 3)).toBe("ab");
  });
});
