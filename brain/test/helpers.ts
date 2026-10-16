import { DatabaseSync } from "node:sqlite";
import type { Brainpower, ChatMessage, ChatOptions, ChatResult } from "../src/ai";
import type { SqlLike } from "../src/brain/store";

/** node:sqlite adapter matching the subset of DO SqlStorage we use. */
export function memorySql(): SqlLike & { db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    exec<T>(query: string, ...bindings: unknown[]) {
      const stmt = db.prepare(query);
      const rows = stmt.all(...(bindings as never[])) as unknown as T[];
      return { toArray: () => rows.map((r) => ({ ...(r as object) }) as T) };
    },
  };
}

/** Deterministic bag-of-words embedding (64 dims) so similar texts have high cosine. */
export function fakeEmbed(text: string): number[] {
  const v = new Array(64).fill(0);
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 0;
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % 64] += 1;
  }
  return v;
}

export type ChatHandler = (messages: ChatMessage[], opts?: ChatOptions) => string | Promise<string>;

export class FakeAi implements Brainpower {
  chatCalls: ChatMessage[][] = [];
  visionCalls = 0;
  embedCalls = 0;
  /** Queue of responses; falls back to `handler`. */
  queue: Array<string | Error> = [];
  handler: ChatHandler = () => JSON.stringify({ say: "Hi hi!", emotion: "happy", intensity: 0.6, gesture: "wave", gaze: "user", voice: { pace: "normal", pitch: 1 }, speak: true });
  visionText = "The user is watching a cooking video.";

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult> {
    this.chatCalls.push(messages);
    const q = this.queue.shift();
    if (q instanceof Error) throw q;
    const text = q ?? (await this.handler(messages, opts));
    return { text, model: "fake" };
  }
  async vision(): Promise<string> {
    this.visionCalls++;
    return this.visionText;
  }
  async embed(texts: string[]): Promise<number[][]> {
    this.embedCalls++;
    return texts.map(fakeEmbed);
  }
  lastSystem(): string {
    return this.chatCalls[this.chatCalls.length - 1]?.[0]?.content ?? "";
  }
}

/** Route a fake chat call by inspecting its system prompt. */
export function systemOf(m: ChatMessage[]): string {
  return m[0]?.content ?? "";
}
