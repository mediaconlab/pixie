/**
 * Small glob matcher (subset of minimatch) for pixie.excludeGlobs. Pure; unit-tested.
 * Supports: ** (any number of path segments), * (within a segment), ?, {a,b}, [abc].
 * Matching is case-insensitive on Windows-style paths only if `nocase` is set.
 */

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string, nocase = false): RegExp {
  const key = (nocase ? "i:" : "s:") + glob;
  const hit = cache.get(key);
  if (hit) return hit;
  let re = "";
  let i = 0;
  let inBrace = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**/" → zero or more directories; trailing "**" → anything.
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (c === "?") re += "[^/]";
    else if (c === "{") {
      inBrace++;
      re += "(?:";
    } else if (c === "}" && inBrace > 0) {
      inBrace--;
      re += ")";
    } else if (c === "," && inBrace > 0) re += "|";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end > i) {
        let cls = glob.slice(i + 1, end);
        if (cls.startsWith("!")) cls = "^" + cls.slice(1);
        re += "[" + cls.replace(/\\/g, "\\\\") + "]";
        i = end + 1;
        continue;
      }
      re += "\\[";
    } else if (/[.+^$()|\\]/.test(c)) re += "\\" + c;
    else re += c;
    i++;
  }
  const compiled = new RegExp("^" + re + "$", nocase ? "i" : "");
  cache.set(key, compiled);
  return compiled;
}

function normalise(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * True if `path` matches any glob. Both the workspace-relative path and the absolute path are tried,
 * and globs without a slash also match against the basename (like `matchBase`).
 */
export function isExcluded(paths: { relative: string; absolute?: string }, globs: readonly string[], nocase = false): boolean {
  const candidates = [normalise(paths.relative)];
  if (paths.absolute) candidates.push(normalise(paths.absolute));
  const base = candidates[0].split("/").pop() ?? candidates[0];
  for (const g of globs) {
    if (!g) continue;
    const re = globToRegExp(normalise(g), nocase);
    if (candidates.some((c) => re.test(c) || re.test(c.replace(/^\/+/, "")))) return true;
    if (!g.includes("/") && re.test(base)) return true;
  }
  return false;
}
