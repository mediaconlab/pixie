/**
 * The single gateway to Workers AI. Everything else talks to `Brainpower`,
 * so tests can inject a fake.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  /** Ask for a JSON object response (default true). */
  json?: boolean;
}

export interface ChatResult {
  text: string;
  model: string;
}

export interface Brainpower {
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
  vision(prompt: string, imageDataUrl: string): Promise<string>;
  embed(texts: string[]): Promise<number[][]>;
}

export const DEFAULT_MODELS = ["@cf/zai-org/glm-5.3-flash", "@cf/google/gemma-4-26b-a4b-it"];
export const DEFAULT_VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
export const DEFAULT_EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";

export class AiError extends Error {
  constructor(message: string, readonly attempts: string[] = []) {
    super(message);
    this.name = "AiError";
  }
}

/** Minimal shape of the Workers AI binding we rely on. */
export interface AiRunner {
  run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}

const SHORT_COOLDOWN_MS = 60_000;
const LONG_COOLDOWN_MS = 6 * 3600_000;

/** Cooldown length for a failed model call; same policy as the pixie-brain worker. */
export function cooldownFor(err: unknown): number {
  const msg = errMessage(err);
  return /5035|403|paid/i.test(msg) ? LONG_COOLDOWN_MS : SHORT_COOLDOWN_MS;
}

export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return typeof err === "string" ? err : JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Extract the text from the various response shapes Workers AI models return. */
export function extractText(out: unknown): string {
  if (typeof out === "string") return out;
  if (!out || typeof out !== "object") return "";
  const o = out as Record<string, unknown>;
  const r = o.response;
  if (typeof r === "string") return r;
  if (r && typeof r === "object") return JSON.stringify(r); // already-parsed JSON mode output
  const choices = o.choices as Array<{ message?: { content?: unknown }; text?: unknown }> | undefined;
  if (Array.isArray(choices) && choices.length) {
    const c = choices[0];
    const content = c?.message?.content ?? c?.text;
    if (typeof content === "string") return content;
    if (Array.isArray(content))
      return content.map((p) => (typeof p === "string" ? p : (p as { text?: string })?.text ?? "")).join("");
    if (content && typeof content === "object") return JSON.stringify(content);
  }
  if (typeof o.result === "object" && o.result) return extractText(o.result);
  if (typeof o.description === "string") return o.description;
  return "";
}

/**
 * Process-wide model availability (shared across DO instances in the same isolate).
 * Keyed by model id → unix ms when it becomes available again.
 */
const unavailableUntil = new Map<string, number>();

export function resetModelCooldowns(): void {
  unavailableUntil.clear();
}

export class WorkersAiBrainpower implements Brainpower {
  private readonly models: string[];
  private licenseAgreed = false;

  constructor(
    private readonly ai: AiRunner,
    opts: { models?: string; visionModel?: string; embedModel?: string } = {},
    private readonly now: () => number = Date.now,
  ) {
    const list = (opts.models ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    this.models = list.length ? list : DEFAULT_MODELS;
    this.visionModel = opts.visionModel || DEFAULT_VISION_MODEL;
    this.embedModel = opts.embedModel || DEFAULT_EMBED_MODEL;
  }

  private readonly visionModel: string;
  private readonly embedModel: string;

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const attempts: string[] = [];
    const now = this.now();
    let candidates = this.models.filter((m) => (unavailableUntil.get(m) ?? 0) <= now);
    // If everything is cooling down, still try the first one rather than failing outright.
    if (!candidates.length) candidates = [this.models[0]!];
    for (const model of candidates) {
      const inputs: Record<string, unknown> = {
        messages,
        max_tokens: opts.maxTokens ?? 400,
        temperature: opts.temperature ?? 0.7,
        chat_template_kwargs: { enable_thinking: false },
      };
      if (opts.json !== false) inputs.response_format = { type: "json_object" };
      try {
        const out = await this.ai.run(model, inputs);
        const text = extractText(out);
        if (!text.trim()) throw new Error("empty response");
        return { text, model };
      } catch (err) {
        unavailableUntil.set(model, this.now() + cooldownFor(err));
        attempts.push(`${model}: ${errMessage(err).slice(0, 160)}`);
      }
    }
    throw new AiError("all chat models failed", attempts);
  }

  async vision(prompt: string, imageDataUrl: string): Promise<string> {
    const inputs = {
      messages: [{ role: "user", content: prompt }],
      image: imageDataUrl,
      max_tokens: 200,
    };
    try {
      return extractText(await this.ai.run(this.visionModel, inputs));
    } catch (err) {
      if (!this.licenseAgreed && /licen[cs]e|agree/i.test(errMessage(err))) {
        this.licenseAgreed = true;
        try {
          await this.ai.run(this.visionModel, { prompt: "agree" });
        } catch {
          /* the agree call itself usually "fails" with a thank-you; ignore */
        }
        return extractText(await this.ai.run(this.visionModel, inputs));
      }
      throw err;
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const out = (await this.ai.run(this.embedModel, { text: texts.map((t) => t.slice(0, 2000)) })) as {
      data?: number[][];
    };
    if (!out || !Array.isArray(out.data)) throw new AiError("embedding response missing data");
    return out.data;
  }
}

/** Parse a model reply that should be a JSON object. Tolerates code fences and leading prose. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const t = text.trim();
  const direct = tryParse(t);
  if (direct) return direct;
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const f = tryParse(fence[1]!.trim());
    if (f) return f;
  }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) return tryParse(t.slice(start, end + 1));
  return null;
}
