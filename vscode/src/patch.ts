/**
 * Minimal, dependency-free unified-diff parser and applier.
 *
 * Pure: no vscode / fs imports, so it is unit-tested with vitest.
 *
 * - Supports several files per diff, several hunks per file.
 * - Tolerates hunks whose position is off by a few lines (MAX_OFFSET).
 * - Tolerates wrong line counts in hunk headers (common in model-written diffs).
 * - Preserves the original file's line endings (LF / CRLF) and final-newline state.
 * - Supports file creation (--- /dev/null) and deletion (+++ /dev/null).
 */

export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

export interface HunkLine {
  op: " " | "-" | "+";
  text: string;
}

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
  /** "\ No newline at end of file" seen after the last old-side line. */
  oldNoEol: boolean;
  /** "\ No newline at end of file" seen after the last new-side line. */
  newNoEol: boolean;
}

export interface FilePatch {
  /** Path from the `---` header (without a/ prefix), or null for /dev/null or a header-less diff. */
  oldPath: string | null;
  /** Path from the `+++` header (without b/ prefix), or null for /dev/null or a header-less diff. */
  newPath: string | null;
  isNew: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** How far (in lines) a hunk may drift from its stated position and still apply. */
export const MAX_OFFSET = 10;

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripPath(raw: string): string | null {
  // "--- a/src/x.ts\t2024-01-01 ..." → "src/x.ts"
  let p = raw.replace(/\t.*$/, "").trim();
  if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) p = p.slice(1, -1);
  if (p === "/dev/null" || p === "") return null;
  if (/^[ab]\//.test(p)) p = p.slice(2);
  return p;
}

/** Parse a unified diff into per-file patches. Throws PatchError if no hunk is found. */
export function parsePatch(text: string): FilePatch[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const files: FilePatch[] = [];
  let cur: FilePatch | null = null;
  let hunk: Hunk | null = null;
  let sawOldHeader = false;
  let oldHeaderPath: string | null = null;
  let oldHeaderDevNull = false;

  const newFile = (): FilePatch => {
    const f: FilePatch = { oldPath: null, newPath: null, isNew: false, isDelete: false, hunks: [] };
    files.push(f);
    return f;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff ")) {
      hunk = null;
      cur = newFile();
      sawOldHeader = false;
      continue;
    }
    if (
      line.startsWith("--- ") &&
      i + 1 < lines.length &&
      lines[i + 1].startsWith("+++ ") &&
      (hunk === null || hunkComplete(hunk))
    ) {
      hunk = null;
      oldHeaderPath = stripPath(line.slice(4));
      oldHeaderDevNull = line.slice(4).replace(/\t.*$/, "").trim() === "/dev/null";
      sawOldHeader = true;
      continue;
    }
    if (line.startsWith("+++ ") && sawOldHeader && hunk === null) {
      const newPath = stripPath(line.slice(4));
      const newDevNull = line.slice(4).replace(/\t.*$/, "").trim() === "/dev/null";
      if (!cur || cur.hunks.length > 0 || cur.oldPath !== null || cur.newPath !== null) cur = newFile();
      cur.oldPath = oldHeaderPath;
      cur.newPath = newPath;
      cur.isNew = oldHeaderDevNull;
      cur.isDelete = newDevNull;
      sawOldHeader = false;
      continue;
    }
    const m = HUNK_RE.exec(line);
    if (m) {
      if (!cur) cur = newFile();
      hunk = {
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
        oldNoEol: false,
        newNoEol: false,
      };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue; // preamble (index lines, "new file mode", commit message, ...)

    if (line.startsWith("\\")) {
      const prev = hunk.lines[hunk.lines.length - 1];
      if (prev) {
        if (prev.op !== "+") hunk.oldNoEol = true;
        if (prev.op !== "-") hunk.newNoEol = true;
      }
      continue;
    }
    const op = line[0];
    if (op === " " || op === "-" || op === "+") {
      hunk.lines.push({ op, text: line.slice(1) });
    } else if (line === "") {
      // Blank context line whose leading space was stripped by an editor / model.
      hunk.lines.push({ op: " ", text: "" });
    } else {
      // Anything else ends the hunk (e.g. trailing prose).
      hunk = null;
    }
  }

  // Trailing blank "context" lines produced by a final newline are not real context.
  for (const f of files) {
    for (const h of f.hunks) {
      while (h.lines.length > 0) {
        const last = h.lines[h.lines.length - 1];
        if (last.op === " " && last.text === "" && contextCount(h) > declaredContext(h)) h.lines.pop();
        else break;
      }
    }
  }

  const withHunks = files.filter((f) => f.hunks.length > 0 || f.isDelete);
  if (withHunks.length === 0) throw new PatchError("No hunks found in patch");
  return withHunks;
}

function hunkComplete(h: Hunk): boolean {
  let o = 0;
  let n = 0;
  for (const l of h.lines) {
    if (l.op !== "+") o++;
    if (l.op !== "-") n++;
  }
  return o >= h.oldCount && n >= h.newCount;
}

function contextCount(h: Hunk): number {
  return h.lines.filter((l) => l.op !== "+").length;
}
/** The old-side line count claimed by the header (used only to drop spurious trailing blanks). */
function declaredContext(h: Hunk): number {
  return h.oldCount;
}

interface SplitText {
  lines: string[];
  eol: string;
  finalNewline: boolean;
}

function splitText(text: string): SplitText {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  const eol = crlf > 0 && crlf >= lf ? "\r\n" : "\n";
  if (text === "") return { lines: [], eol, finalNewline: false };
  const lines = text.split(/\r?\n/);
  const finalNewline = lines[lines.length - 1] === "";
  if (finalNewline) lines.pop();
  return { lines, eol, finalNewline };
}

function matchesAt(src: string[], at: number, want: string[], loose: boolean): boolean {
  if (at < 0 || at + want.length > src.length) return false;
  for (let k = 0; k < want.length; k++) {
    const a = src[at + k];
    const b = want[k];
    if (loose ? a.trimEnd() !== b.trimEnd() : a !== b) return false;
  }
  return true;
}

function locate(src: string[], want: string[], expected: number, minIndex: number): number {
  for (const loose of [false, true]) {
    for (let d = 0; d <= MAX_OFFSET; d++) {
      for (const at of d === 0 ? [expected] : [expected - d, expected + d]) {
        if (at >= minIndex && matchesAt(src, at, want, loose)) return at;
      }
    }
  }
  return -1;
}

/**
 * Apply one file's hunks to `original` (null/"" for a file that does not exist).
 * Returns the new text, or null if the patch deletes the file.
 */
export function applyFilePatch(original: string | null, patch: FilePatch): string | null {
  if (patch.isDelete) return null;
  const src = splitText(original ?? "");
  if (patch.isNew && src.lines.length > 0) {
    throw new PatchError("Patch creates a file that already exists");
  }
  const out: string[] = [];
  let pos = 0; // next unconsumed line in src
  let finalNewline = src.finalNewline || src.lines.length === 0;
  let touchedEnd = false;

  patch.hunks.forEach((h, idx) => {
    const oldLines = h.lines.filter((l) => l.op !== "+").map((l) => l.text);

    let at: number;
    if (oldLines.length === 0) {
      // Pure insertion: "-N,0" means insert after line N (index N).
      const idx0 = h.oldCount === 0 ? h.oldStart : h.oldStart - 1;
      at = Math.min(Math.max(idx0, pos), src.lines.length);
    } else {
      const expected = Math.max(h.oldStart - 1, 0);
      at = locate(src.lines, oldLines, expected, pos);
      if (at < 0) {
        throw new PatchError(
          `Hunk ${idx + 1} does not match the file near line ${h.oldStart} (context mismatch)`,
        );
      }
    }
    out.push(...src.lines.slice(pos, at));
    // Context lines keep the file's own text (it may differ in trailing whitespace from the patch).
    let k = at;
    for (const l of h.lines) {
      if (l.op === " ") out.push(src.lines[k++] ?? l.text);
      else if (l.op === "-") k++;
      else out.push(l.text);
    }
    pos = at + oldLines.length;
    if (pos >= src.lines.length) {
      touchedEnd = true;
      if (h.newNoEol) finalNewline = false;
      else if (h.oldNoEol) finalNewline = true;
    }
  });
  out.push(...src.lines.slice(pos));

  if (!touchedEnd && patch.isNew) finalNewline = true;
  if (out.length === 0) return "";
  return out.join(src.eol) + (finalNewline ? src.eol : "");
}

/** Convenience: parse `patchText` and apply the single (or first) file patch in it. */
export function applyPatch(original: string | null, patchText: string): string | null {
  const files = parsePatch(patchText);
  return applyFilePatch(original, files[0]);
}

/** Lines of a diff, classified for rendering a preview. */
export function classifyDiffLines(patchText: string): { kind: "add" | "del" | "hunk" | "meta" | "ctx"; text: string }[] {
  return patchText
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((text) => {
      if (text.startsWith("+++ ") || text.startsWith("--- ") || text.startsWith("diff ") || text.startsWith("index "))
        return { kind: "meta" as const, text };
      if (text.startsWith("@@")) return { kind: "hunk" as const, text };
      if (text.startsWith("+")) return { kind: "add" as const, text };
      if (text.startsWith("-")) return { kind: "del" as const, text };
      return { kind: "ctx" as const, text };
    });
}
