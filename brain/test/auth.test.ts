import { describe, expect, it } from "vitest";
import { TOKEN_RE, extractToken, generateToken, hashToken } from "../src/auth";
import { CODE_RE, generateCode, pairLink } from "../src/pairing";
import { newId } from "../src/util";

describe("tokens", () => {
  it("are 43-char base64url from 32 random bytes", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const t = generateToken();
      expect(t).toMatch(TOKEN_RE);
      expect(t).toHaveLength(43);
      seen.add(t);
    }
    expect(seen.size).toBe(200);
  });
  it("hash is hex SHA-256, deterministic, not the token", async () => {
    const t = generateToken();
    const h = await hashToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashToken(t)).toBe(h);
    expect(h).not.toContain(t);
    // known vector
    expect(await hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("extracts bearer tokens; query only when allowed", () => {
    const t = generateToken();
    expect(extractToken(new Request("https://x/v1/devices", { headers: { Authorization: `Bearer ${t}` } }), false)).toBe(t);
    expect(extractToken(new Request(`https://x/v1/ws?token=${t}`), false)).toBe(null);
    expect(extractToken(new Request(`https://x/v1/ws?token=${t}`), true)).toBe(t);
    expect(extractToken(new Request("https://x", { headers: { Authorization: "Bearer short" } }), true)).toBe(null);
    expect(extractToken(new Request("https://x", { headers: { Authorization: `Basic ${t}` } }), false)).toBe(null);
  });
});

describe("pairing codes", () => {
  it("are 6 digits with leading zeros", () => {
    for (let i = 0; i < 500; i++) expect(generateCode()).toMatch(CODE_RE);
    expect(generateCode((b) => ((b[0] = 42), b))).toBe("000042");
  });
  it("reject values in the biased tail", () => {
    const vals = [0xffffffff, 0xfffffff0, 123456789];
    let i = 0;
    expect(generateCode((b) => ((b[0] = vals[i++]!), b))).toBe("456789");
    expect(i).toBe(3);
  });
  it("are roughly uniform over the first digit", () => {
    const counts = new Array(10).fill(0);
    for (let i = 0; i < 5000; i++) counts[Number(generateCode()[0])]++;
    for (const c of counts) expect(c).toBeGreaterThan(350);
  });
  it("link format", () => {
    expect(pairLink("https://pixie.example.workers.dev", "482913")).toBe("pixie://pair?u=https%3A%2F%2Fpixie.example.workers.dev&c=482913");
  });
  it("ids are prefixed and <= 64 chars", () => {
    const id = newId("prp");
    expect(id).toMatch(/^prp_[A-Za-z0-9_-]{16}$/);
  });
});
