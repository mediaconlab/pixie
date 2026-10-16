/** Brute-force vector utilities for per-user memory (a few thousand rows max). */

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!, y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface Scored<T> {
  item: T;
  score: number;
}

/** Top-k items by cosine similarity to `query`, highest first. Ignores items without a vector. */
export function topK<T>(query: ArrayLike<number>, items: T[], vec: (t: T) => ArrayLike<number> | null, k: number, minScore = -1): Scored<T>[] {
  if (k <= 0) return [];
  const out: Scored<T>[] = [];
  for (const item of items) {
    const v = vec(item);
    if (!v || v.length === 0) continue;
    const score = cosine(query, v);
    if (score < minScore) continue;
    if (out.length < k) {
      out.push({ item, score });
      out.sort((x, y) => y.score - x.score);
    } else if (score > out[out.length - 1]!.score) {
      out[out.length - 1] = { item, score };
      out.sort((x, y) => y.score - x.score);
    }
  }
  return out;
}

/** Index of the most similar existing vector with similarity > threshold, else -1. */
export function findDuplicate(v: ArrayLike<number>, existing: Array<ArrayLike<number> | null>, threshold: number): number {
  let best = -1, bestScore = threshold;
  for (let i = 0; i < existing.length; i++) {
    const e = existing[i];
    if (!e) continue;
    const s = cosine(v, e);
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  return best;
}

export interface MergeCandidate {
  id: number;
  vec: ArrayLike<number> | null;
  value: number;
  ts: number;
}

/**
 * Greedy near-duplicate clustering: returns pairs [keepId, dropId] with cosine > threshold.
 * The higher-value (then newer) memory is kept.
 */
export function nearDuplicatePairs(items: MergeCandidate[], threshold: number): Array<[number, number]> {
  const sorted = [...items].sort((a, b) => b.value - a.value || b.ts - a.ts);
  const kept: MergeCandidate[] = [];
  const pairs: Array<[number, number]> = [];
  for (const it of sorted) {
    if (!it.vec) {
      kept.push(it);
      continue;
    }
    const dup = kept.find((k) => k.vec && cosine(k.vec, it.vec!) > threshold);
    if (dup) pairs.push([dup.id, it.id]);
    else kept.push(it);
  }
  return pairs;
}

export interface EvictionCandidate {
  id: number;
  value: number;
  ts: number;
}

/** Which ids to drop to get down to `cap` rows: lowest value first, then oldest. */
export function evictionOrder(items: EvictionCandidate[], cap: number): number[] {
  if (items.length <= cap) return [];
  const sorted = [...items].sort((a, b) => a.value - b.value || a.ts - b.ts);
  return sorted.slice(0, items.length - cap).map((x) => x.id);
}

export function parseVec(json: unknown): number[] | null {
  if (typeof json !== "string" || !json) return null;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as number[]) : null;
  } catch {
    return null;
  }
}

/** Round floats to keep stored JSON small (bge-base is 768 dims). */
export function vecToJson(v: number[]): string {
  return JSON.stringify(v.map((x) => Math.round(x * 1e5) / 1e5));
}
