import { describe, expect, it } from "vitest";
import { globToRegExp, isExcluded } from "../src/glob";

const DEFAULTS = ["**/.env*", "**/*.pem", "**/*.key", "**/*secret*", "**/node_modules/**"];

describe("globs", () => {
  it("converts globs", () => {
    expect(globToRegExp("**/*.ts").test("src/a/b.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("b.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(globToRegExp("*.{js,ts}").test("x.js")).toBe(true);
    expect(globToRegExp("file?.txt").test("file1.txt")).toBe(true);
  });

  it.each([
    [".env", true],
    ["config/.env.local", true],
    ["certs/server.pem", true],
    ["id.key", true],
    ["src/client_secret.json", true],
    ["src/mySecretThing.ts", false], // globs are case-sensitive by default
    ["node_modules/x/index.js", true],
    ["packages/a/node_modules/b/c.js", true],
    ["src/app.ts", false],
    ["src/environment.ts", false],
    ["keyboard.ts", false],
  ])("default excludes: %s → %s", (rel, expected) => {
    expect(isExcluded({ relative: rel }, DEFAULTS)).toBe(expected);
  });

  it("matches absolute paths and windows separators", () => {
    expect(isExcluded({ relative: "outside.pem", absolute: "C:\\keys\\outside.pem" }, DEFAULTS)).toBe(true);
    expect(isExcluded({ relative: "src\\.env" }, DEFAULTS)).toBe(true);
  });

  it("supports basename-only globs", () => {
    expect(isExcluded({ relative: "deep/dir/notes.private" }, ["*.private"])).toBe(true);
  });

  it("can be case-insensitive", () => {
    expect(isExcluded({ relative: "src/MySecret.ts" }, DEFAULTS, true)).toBe(true);
  });
});
