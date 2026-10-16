import type { UserBrain } from "./brain/UserBrain";

export interface Env {
  AI: Ai;
  DB: D1Database;
  USER_BRAIN: DurableObjectNamespace<UserBrain>;
  /** "1" allows new users to register after the owner exists. */
  ALLOW_SIGNUP?: string;
  /** Comma-separated chat model list, tried in order. */
  MODELS?: string;
  VISION_MODEL?: string;
  EMBED_MODEL?: string;
}
