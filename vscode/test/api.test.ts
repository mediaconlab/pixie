import { describe, expect, it } from "vitest";
import { ApiError, claimPairing, describeApiError } from "../src/api";

function fakeFetch(status: number, body: unknown, calls: { url: string; init: any }[] = []) {
  return async (url: string, init: any) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
  };
}

describe("claimPairing", () => {
  it("POSTs the code with device kind ide", async () => {
    const calls: { url: string; init: any }[] = [];
    const res = await claimPairing(
      "pixie.example.dev/",
      " 482913 ",
      "VS Code",
      fakeFetch(200, { user_id: "u", device_id: "d", token: "t".repeat(43) }, calls),
    );
    expect(res.token).toHaveLength(43);
    expect(calls[0].url).toBe("https://pixie.example.dev/v1/pair/claim");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body)).toEqual({ code: "482913", device: { kind: "ide", name: "VS Code" } });
  });

  it("maps bad_code errors", async () => {
    const err = await claimPairing("https://x.dev", "000000", "n", fakeFetch(404, { error: "bad_code" })).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("bad_code");
    expect(describeApiError(err)).toMatch(/wrong or has expired/);
  });

  it("reports network failures", async () => {
    const err = await claimPairing("https://x.dev", "000000", "n", async () => {
      throw new Error("ECONNREFUSED");
    }).catch((e) => e);
    expect(err.code).toBe("network_error");
  });
});
