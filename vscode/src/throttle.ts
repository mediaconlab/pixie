/**
 * Debounce + minimum-interval gate used for automatic diagnostics sharing:
 * fire `debounceMs` after the last trigger, but never more often than once per `minIntervalMs`.
 * Time and timers are injectable so the logic can be unit-tested.
 */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class DebouncedGate {
  private timer: unknown = undefined;
  private lastFired = -Infinity;

  constructor(
    private readonly fire: () => void,
    private readonly debounceMs: number,
    private readonly minIntervalMs: number,
    private readonly clock: Clock = realClock,
  ) {}

  trigger(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    const sinceLast = this.clock.now() - this.lastFired;
    const wait = Math.max(this.debounceMs, this.minIntervalMs - sinceLast);
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      this.lastFired = this.clock.now();
      this.fire();
    }, wait);
  }

  cancel(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
