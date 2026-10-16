import { describe, expect, it } from "vitest";
import { applyFilePatch, applyPatch, classifyDiffLines, parsePatch, PatchError } from "../src/patch";

const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);
const file = (ls: string[], eol = "\n") => ls.join(eol) + eol;

describe("parsePatch", () => {
  it("parses headers, strips a/ b/ prefixes and timestamps", () => {
    const p = parsePatch(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "index 123..456 100644",
        "--- a/src/app.ts\t2024-01-01 00:00:00",
        "+++ b/src/app.ts\t2024-01-02 00:00:00",
        "@@ -1,2 +1,2 @@",
        " a",
        "-b",
        "+c",
      ].join("\n"),
    );
    expect(p).toHaveLength(1);
    expect(p[0].oldPath).toBe("src/app.ts");
    expect(p[0].newPath).toBe("src/app.ts");
    expect(p[0].hunks[0].lines).toEqual([
      { op: " ", text: "a" },
      { op: "-", text: "b" },
      { op: "+", text: "c" },
    ]);
  });

  it("parses multi-file diffs", () => {
    const p = parsePatch(
      ["--- a/x", "+++ b/x", "@@ -1 +1 @@", "-a", "+b", "--- a/y", "+++ b/y", "@@ -1 +1 @@", "-c", "+d", ""].join("\n"),
    );
    expect(p.map((f) => f.newPath)).toEqual(["x", "y"]);
  });

  it("does not mistake a removed '-- ' line for a file header", () => {
    const p = parsePatch(["--- a/q.sql", "+++ b/q.sql", "@@ -1,2 +1,1 @@", "--- comment", "+++ stays", ""].join("\n"));
    // header-looking pair is inside an incomplete hunk → hunk content
    expect(p).toHaveLength(1);
    expect(p[0].hunks[0].lines).toEqual([
      { op: "-", text: "-- comment" },
      { op: "+", text: "++ stays" },
    ]);
  });

  it("throws when there are no hunks", () => {
    expect(() => parsePatch("just some prose")).toThrow(PatchError);
  });
});

describe("applyPatch", () => {
  it("applies a single hunk", () => {
    const original = file(["const a = 1;", "const b = 2;", "console.log(a + b);"]);
    const patch = [
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,3 +1,3 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      " console.log(a + b);",
      "",
    ].join("\n");
    expect(applyPatch(original, patch)).toBe(file(["const a = 1;", "const b = 3;", "console.log(a + b);"]));
  });

  it("applies multiple hunks, including line-count changes", () => {
    const src = lines(30);
    const patch = [
      "--- a/f",
      "+++ b/f",
      "@@ -2,3 +2,4 @@",
      " line 2",
      " line 3",
      "+inserted after 3",
      " line 4",
      "@@ -20,3 +21,2 @@",
      " line 20",
      "-line 21",
      " line 22",
      "",
    ].join("\n");
    const out = applyPatch(file(src), patch)!.split("\n");
    expect(out[3]).toBe("inserted after 3");
    expect(out).not.toContain("line 21");
    expect(out.filter(Boolean)).toHaveLength(30);
  });

  it("tolerates hunks that are off by a few lines", () => {
    // Header claims line 10, but the content actually lives at line 14 (4 lines added above).
    const src = [...lines(4, "new"), ...lines(20)];
    const patch = ["@@ -10,3 +10,3 @@", " line 10", "-line 11", "+LINE ELEVEN", " line 12", ""].join("\n");
    const out = applyPatch(file(src), patch)!;
    expect(out).toContain("line 10\nLINE ELEVEN\nline 12");
    expect(out).not.toContain("line 11\n");
  });

  it("tolerates content earlier than stated, too", () => {
    const src = lines(20).slice(3); // lines 4..20 → "line 10" is at index 6
    const patch = ["@@ -10,2 +10,2 @@", " line 10", "-line 11", "+x", ""].join("\n");
    expect(applyPatch(file(src), patch)).toContain("line 10\nx\nline 12");
  });

  it("errors on context mismatch", () => {
    const patch = ["@@ -1,2 +1,2 @@", " hello", "-world", "+there", ""].join("\n");
    expect(() => applyPatch(file(["hello", "planet"]), patch)).toThrow(/context mismatch/);
  });

  it("errors when the drift exceeds the tolerance", () => {
    const src = [...lines(40, "pad"), ...lines(5)];
    const patch = ["@@ -1,2 +1,2 @@", " line 1", "-line 2", "+two", ""].join("\n");
    expect(() => applyPatch(file(src), patch)).toThrow(PatchError);
  });

  it("preserves CRLF line endings", () => {
    const original = file(["a", "b", "c"], "\r\n");
    const patch = ["--- a/w.txt", "+++ b/w.txt", "@@ -1,3 +1,4 @@", " a", "-b", "+B", "+B2", " c", ""].join("\n");
    const out = applyPatch(original, patch)!;
    expect(out).toBe("a\r\nB\r\nB2\r\nc\r\n");
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("applies a CRLF patch to a CRLF file", () => {
    const original = file(["a", "b"], "\r\n");
    const patch = ["@@ -1,2 +1,2 @@", " a", "-b", "+c", ""].join("\r\n");
    expect(applyPatch(original, patch)).toBe("a\r\nc\r\n");
  });

  it("creates a new file from /dev/null", () => {
    const patch = [
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,3 @@",
      "+export function hi() {",
      "+  return 1;",
      "+}",
      "",
    ].join("\n");
    const [fp] = parsePatch(patch);
    expect(fp.isNew).toBe(true);
    expect(fp.oldPath).toBeNull();
    expect(fp.newPath).toBe("src/new.ts");
    expect(applyFilePatch(null, fp)).toBe("export function hi() {\n  return 1;\n}\n");
  });

  it("refuses to create a file that already has content", () => {
    const patch = ["--- /dev/null", "+++ b/a", "@@ -0,0 +1 @@", "+x", ""].join("\n");
    expect(() => applyPatch("existing\n", patch)).toThrow(/already exists/);
  });

  it("returns null when the patch deletes a file", () => {
    const patch = ["--- a/gone.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye", ""].join("\n");
    expect(applyPatch("bye\n", patch)).toBeNull();
  });

  it("honours '\\ No newline at end of file'", () => {
    const patch = ["@@ -1,2 +1,2 @@", " a", "-b", "\\ No newline at end of file", "+c", "\\ No newline at end of file", ""].join("\n");
    expect(applyPatch("a\nb", patch)).toBe("a\nc");
    const addNl = ["@@ -1,2 +1,2 @@", " a", "-b", "\\ No newline at end of file", "+b", ""].join("\n");
    expect(applyPatch("a\nb", addNl)).toBe("a\nb\n");
  });

  it("keeps a missing final newline when the end is untouched", () => {
    const patch = ["@@ -1,2 +1,2 @@", "-a", "+A", " b", ""].join("\n");
    expect(applyPatch("a\nb\nc", patch)).toBe("A\nb\nc");
  });

  it("tolerates blank context lines whose leading space was stripped", () => {
    const original = "function f() {\n\n  return 1;\n}\n";
    const patch = ["@@ -1,4 +1,4 @@", " function f() {", "", "-  return 1;", "+  return 2;", " }", ""].join("\n");
    expect(applyPatch(original, patch)).toBe("function f() {\n\n  return 2;\n}\n");
  });

  it("tolerates trailing-whitespace differences in context", () => {
    const original = "a  \nb\n";
    const patch = ["@@ -1,2 +1,2 @@", " a", "-b", "+c", ""].join("\n");
    expect(applyPatch(original, patch)).toBe("a  \nc\n");
  });

  it("handles pure insertions at the top of a file", () => {
    const patch = ["@@ -0,0 +1 @@", "+// header", ""].join("\n");
    expect(applyPatch("x\n", patch)).toBe("// header\nx\n");
  });
});

describe("classifyDiffLines", () => {
  it("labels diff lines", () => {
    expect(classifyDiffLines("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n c").map((l) => l.kind)).toEqual([
      "meta",
      "meta",
      "hunk",
      "del",
      "add",
      "ctx",
    ]);
  });
});
