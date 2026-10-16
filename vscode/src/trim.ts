/** Content trimming for ide.context. Pure; unit-tested. */

export const MAX_CONTENT = 20000;

/**
 * Return at most `max` chars of `content`, centred on the [focusStart, focusEnd) character range
 * (the selection, or the cursor when start === end). When the focus range itself is longer than
 * `max`, the window starts at the focus start.
 */
export function trimAround(content: string, focusStart: number, focusEnd: number = focusStart, max = MAX_CONTENT): string {
  if (content.length <= max) return content;
  const s = clamp(Math.min(focusStart, focusEnd), 0, content.length);
  const e = clamp(Math.max(focusStart, focusEnd), 0, content.length);
  let start: number;
  if (e - s >= max) {
    start = s;
  } else {
    const mid = Math.floor((s + e) / 2);
    start = mid - Math.floor(max / 2);
  }
  start = clamp(start, 0, content.length - max);
  return content.slice(start, start + max);
}

/** Truncate plain text (e.g. a huge selection) to `max` chars. */
export function truncate(text: string, max = MAX_CONTENT): string {
  return text.length <= max ? text : text.slice(0, max);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
