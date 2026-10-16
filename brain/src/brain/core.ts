/**
 * BrainCore: the per-user brain logic, independent of the Durable Object runtime.
 * perceive → think → decide → perform/notify. The DO (UserBrain.ts) is a thin shell
 * that provides storage, sockets, alarms and the AI binding.
 *
 * Privacy: never console.log message previews, OCR, transcripts or model text.
 */
import type { Brainpower } from "../ai";
import type {
  Activity, AudioTranscriptData, DeviceKind, Executor, ExecResultData, HelloData, IdeContextData, ParsedEvent,
  Performance, PhoneCallData, PhoneMessageData, ProposalKind, ProposeData, ScreenFrameData, StateUpdateData,
  UserFeedbackData, UserSayData,
} from "../protocol";
import { envelope, perf, sanitizePerformance } from "../protocol";
import { clamp, newId, truncate } from "../util";
import {
  type DecisionRow, type Verdict, DIGEST_INTERVAL_MS, PROPOSAL_TTL_MS, decideTier, digestDue, isFocused, parseYesNo, patternKey,
  routeNotification, shouldDraftReply, shouldOfferPromotion,
} from "./decide";
import { buildLearnerMessages, heuristicPreferences, parseLearnerOutput, updatedImportance, type FeedbackRow } from "./learner";
import { type Mood, type MoodEvent, decay, initialMood, moodEventFromText, moodForWire, nudge } from "./mood";
import {
  type Contact, type Observation, type TranscriptChunk, VISION_PROMPT, appendTranscript, blendUrgency, callObservation,
  classifyMessage, codeWindow, frameFingerprint, guessImportance, guessRelation, hasEmergencyKeyword, heuristicUrgency,
  ideObservation, messageObservation, needsCodingHelp, ocrHasErrors, phoneHash, screenObservation, shouldCaption,
  watchObservation,
} from "./perceive";
import { KV, type SqlLike, initSchema, nameKey } from "./store";
import {
  type ContextTurn, type ModelAction, type Persona, DEFAULT_PERSONA, buildCodingMessages, buildDraftMessages,
  buildMessages, draftReply, think, thinkCoding,
} from "./think";
import { evictionOrder, findDuplicate, nearDuplicatePairs, parseVec, topK, vecToJson } from "./vectors";
import { parseJsonObject } from "../ai";

// ---- constants -----------------------------------------------------------------------------

export const MAX_MODEL_CALLS_PER_HOUR = 120;
/** Background (unasked) model work stops earlier so chat keeps headroom. */
export const BACKGROUND_MODEL_BUDGET = 100;
export const MAX_MEMORIES = 2000;
export const CONTEXT_TURNS = 30;
export const CONTEXT_KEEP_ROWS = 600;
export const REMEMBER_DEDUPE = 0.9;
export const MERGE_DEDUPE = 0.92;
export const WATCH_INTERVAL_MS = 45_000;
export const REPEAT_WINDOW_MS = 10 * 60 * 1000;
export const ASK_TIMEOUT_MS = 20_000;

// ---- runtime interfaces ----------------------------------------------------------------------

export interface DeviceConn {
  id: string;
  kind: DeviceKind;
  name: string;
  send(text: string): void;
}

export interface Runtime {
  sql: SqlLike;
  ai: Brainpower;
  /** Currently connected device sockets. */
  devices(): DeviceConn[];
  /** All registered devices (D1) for `welcome`. */
  registeredDevices(): Promise<Array<{ id: string; kind: string; name: string }>>;
  /** Set (or clear with null) the single wake-up alarm. */
  setAlarm(ts: number | null): Promise<void> | void;
  now?: () => number;
  log?: (rec: Record<string, unknown>) => void;
}

interface UserState {
  activity: Activity;
  front_app: string | null;
  focus_mode: boolean;
  watching: boolean;
  inCall: boolean;
  callFrom: string | null;
}

const DEFAULT_STATE: UserState = { activity: "idle", front_app: null, focus_mode: false, watching: false, inCall: false, callFrom: null };

interface MemRow {
  id: number;
  kind: string;
  text: string;
  vec: number[] | null;
  value: number;
  ts: number;
}

interface ProposalRow {
  id: string;
  kind: string;
  title: string;
  detail: string;
  payload: string;
  executor: string;
  pattern: string;
  target_device: string | null;
  status: string;
  created_at: number;
  expires_at: number;
  [k: string]: string | number | null;
}

type ContactRowT = { name: string; phone_hash: string | null; relation: string | null; importance: number };

type Origin = { deviceId: string; kind: DeviceKind; eventId: string };

export class BrainCore {
  private readonly sql: SqlLike;
  private readonly kv: KV;
  private readonly now: () => number;
  private chain: Promise<unknown> = Promise.resolve();
  private memCache: MemRow[] | null = null;

  constructor(private readonly rt: Runtime) {
    this.sql = rt.sql;
    this.now = rt.now ?? Date.now;
    initSchema(this.sql);
    this.kv = new KV(this.sql);
  }

  // ---- serialization -------------------------------------------------------------------------

  /** Run `fn` after every previously queued turn (one turn at a time per user). */
  serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  // ---- small state helpers --------------------------------------------------------------------

  private get state(): UserState {
    return { ...DEFAULT_STATE, ...this.kv.get<Partial<UserState>>("state", {}) };
  }
  private setState(patch: Partial<UserState>): UserState {
    const s = { ...this.state, ...patch };
    this.kv.set("state", s);
    return s;
  }

  get userName(): string {
    return this.kv.get<string>("user_name", "");
  }
  setUserName(name: string | null | undefined): void {
    if (name && name !== this.userName) this.kv.set("user_name", name.slice(0, 100));
  }

  get persona(): Persona {
    return this.kv.get<Persona>("persona", DEFAULT_PERSONA);
  }

  mood(): Mood {
    const m = this.kv.get<Mood | null>("mood", null) ?? initialMood(this.now());
    return decay(m, this.now());
  }
  private moodEvent(ev: MoodEvent, scale = 1): void {
    const m = this.kv.get<Mood | null>("mood", null) ?? initialMood(this.now());
    this.kv.set("mood", nudge(m, ev, this.now(), scale));
  }

  private log(rec: Record<string, unknown>): void {
    (this.rt.log ?? ((r) => console.log(JSON.stringify(r))))(rec);
  }

  // ---- transport --------------------------------------------------------------------------------

  private online(kind?: DeviceKind): DeviceConn[] {
    const all = this.rt.devices();
    return kind ? all.filter((d) => d.kind === kind) : all;
  }

  private sendTo(conns: DeviceConn[], type: string, data: unknown, id?: string): number {
    const text = envelope(type, data, this.now(), id);
    let n = 0;
    const seen = new Set<string>();
    for (const c of conns) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      try {
        c.send(text);
        n++;
      } catch {
        /* socket closing; ignore */
      }
    }
    return n;
  }

  private sendToDevice(deviceId: string, type: string, data: unknown): number {
    return this.sendTo(this.online().filter((d) => d.id === deviceId), type, data);
  }

  /** bot.perform → every mac, plus the originating ide device when replying to the ide. */
  private perform(p: Performance, origin?: Origin): void {
    const targets = this.online("mac");
    if (origin?.kind === "ide") targets.push(...this.online().filter((d) => d.id === origin.deviceId));
    this.sendTo(targets, "bot.perform", p);
    if (p.say) this.addTurn("pixie", p.say);
  }

  private error(conn: Origin | undefined, code: "rate_limited" | "bad_event" | "model_error", message: string): void {
    if (conn) this.sendToDevice(conn.deviceId, "error", { code, message });
  }

  // ---- connection lifecycle ------------------------------------------------------------------------

  async welcome(deviceId: string): Promise<void> {
    const online = new Set(this.online().map((d) => d.id));
    let devices: Array<{ id: string; kind: string; name: string; online: boolean }> = [];
    try {
      devices = (await this.rt.registeredDevices()).map((d) => ({ id: d.id, kind: d.kind, name: d.name, online: online.has(d.id) }));
    } catch {
      devices = this.online().map((d) => ({ id: d.id, kind: d.kind, name: d.name, online: true }));
    }
    this.sendToDevice(deviceId, "welcome", {
      user_name: this.userName,
      persona: { name: this.persona.name },
      mood: moodForWire(this.mood()),
      devices,
    });
  }

  /** Entry point for every device frame (already parsed). Serialized per user. */
  handleEvent(ev: ParsedEvent, from: { deviceId: string; kind: DeviceKind }): Promise<void> {
    return this.serialize(async () => {
      const t0 = this.now();
      const origin: Origin = { deviceId: from.deviceId, kind: from.kind, eventId: ev.id };
      try {
        await this.dispatch(ev, origin);
      } catch (err) {
        this.log({ evt: ev.type, error: err instanceof Error ? err.name : "error" });
        this.error(origin, "model_error", "something went wrong handling that event");
      }
      this.log({ evt: ev.type, ms: this.now() - t0 });
      await this.scheduleNextAlarm();
    });
  }

  private async dispatch(ev: ParsedEvent, o: Origin): Promise<void> {
    switch (ev.type) {
      case "hello":
        return this.onHello(ev.data, o);
      case "user.say":
        return this.onUserSay(ev.data, o);
      case "state.update":
        return this.onState(ev.data, o);
      case "phone.call":
        return this.onCall(ev.data, o);
      case "phone.message":
        return this.onMessage(ev.data, o);
      case "screen.frame":
        return this.onFrame(ev.data, o);
      case "audio.transcript":
        return this.onTranscript(ev.data, ev.ts);
      case "ide.context":
        return this.onIde(ev.data, o);
      case "user.feedback":
        return this.onFeedback(ev.data, o);
      case "exec.result":
        return this.onExecResult(ev.data);
    }
  }

  // ---- rate limiting ---------------------------------------------------------------------------------

  modelCallsLastHour(): number {
    const r = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM model_calls WHERE ts > ?", this.now() - 3600_000).toArray();
    return Number(r[0]?.n ?? 0);
  }
  private noteModelCall = (): void => {
    this.sql.exec("INSERT INTO model_calls (ts) VALUES (?)", this.now());
  };
  /** True if a model call is allowed. For user-facing calls, tells the user when it isn't. */
  private budget(kind: "user" | "background", origin?: Origin): boolean {
    const used = this.modelCallsLastHour();
    const limit = kind === "user" ? MAX_MODEL_CALLS_PER_HOUR : BACKGROUND_MODEL_BUDGET;
    if (used < limit) return true;
    if (kind === "user") {
      this.error(origin, "rate_limited", `model call limit reached (${MAX_MODEL_CALLS_PER_HOUR}/hour)`);
      const last = this.kv.get<number>("rate_limited_perf_ts", 0);
      if (this.now() - last > 5 * 60_000) {
        this.kv.set("rate_limited_perf_ts", this.now());
        this.moodEvent("rate_limited");
        this.perform(
          perf({ say: "Yawn... my brain needs a little nap. Talk again in a bit?", emotion: "sleepy", intensity: 0.7, gesture: "none", gaze: "away", voice: { pace: "slow", pitch: -1 } }, origin?.eventId),
          origin,
        );
      }
    }
    return false;
  }

  // ---- context turns ----------------------------------------------------------------------------------

  private addTurn(role: ContextTurn["role"], text: string): void {
    if (!text.trim()) return;
    this.sql.exec("INSERT INTO context (role, text, ts) VALUES (?, ?, ?)", role, truncate(text, 1000), this.now());
    this.sql.exec("DELETE FROM context WHERE id <= (SELECT MAX(id) FROM context) - ?", CONTEXT_KEEP_ROWS);
  }

  recentTurns(n = CONTEXT_TURNS): ContextTurn[] {
    return this.sql
      .exec<{ role: string; text: string; ts: number }>("SELECT role, text, ts FROM context ORDER BY id DESC LIMIT ?", n)
      .toArray()
      .reverse()
      .map((r) => ({ role: r.role as ContextTurn["role"], text: r.text, ts: Number(r.ts) }));
  }

  // ---- memory -------------------------------------------------------------------------------------------

  private memories(): MemRow[] {
    if (!this.memCache) {
      this.memCache = this.sql
        .exec<{ id: number; kind: string; text: string; embedding: string | null; value: number; ts: number }>(
          "SELECT id, kind, text, embedding, value, ts FROM memories",
        )
        .toArray()
        .map((r) => ({ id: Number(r.id), kind: r.kind, text: r.text, vec: parseVec(r.embedding), value: Number(r.value), ts: Number(r.ts) }));
    }
    return this.memCache;
  }

  private async embedOne(text: string): Promise<number[] | null> {
    try {
      const [v] = await this.rt.ai.embed([truncate(text, 1000)]);
      return v ?? null;
    } catch {
      return null;
    }
  }

  /** Top-5 relevant memory texts for an observation. Bumps their value slightly. */
  async relevantMemories(text: string, k = 5): Promise<string[]> {
    const mems = this.memories();
    if (!mems.length) return [];
    const q = await this.embedOne(text);
    if (!q) return [];
    const top = topK(q, mems, (m) => m.vec, k, 0.35);
    for (const t of top) {
      this.sql.exec("UPDATE memories SET hits = hits + 1, value = MIN(1.0, value + 0.01) WHERE id = ?", t.item.id);
      t.item.value = Math.min(1, t.item.value + 0.01);
    }
    return top.map((t) => t.item.text);
  }

  /** Store facts (dedupe by cosine > 0.9). Returns number stored. */
  async remember(texts: string[], kind: "fact" | "episode" | "preference" = "fact", value = 0.6): Promise<number> {
    if (!texts.length) return 0;
    let vecs: number[][] = [];
    try {
      vecs = await this.rt.ai.embed(texts);
    } catch {
      return 0;
    }
    let stored = 0;
    for (let i = 0; i < texts.length; i++) {
      const v = vecs[i];
      if (!v) continue;
      const mems = this.memories();
      const dup = findDuplicate(v, mems.map((m) => m.vec), REMEMBER_DEDUPE);
      if (dup >= 0) {
        const m = mems[dup]!;
        this.sql.exec("UPDATE memories SET ts = ?, value = MIN(1.0, value + 0.05) WHERE id = ?", this.now(), m.id);
        m.ts = this.now();
        continue;
      }
      this.sql.exec("INSERT INTO memories (kind, text, embedding, value, ts) VALUES (?, ?, ?, ?, ?)", kind, truncate(texts[i]!, 300), vecToJson(v), value, this.now());
      this.memCache = null;
      stored++;
    }
    this.enforceMemoryCap();
    return stored;
  }

  private enforceMemoryCap(): void {
    const mems = this.memories();
    const drop = evictionOrder(mems, MAX_MEMORIES);
    for (const id of drop) this.sql.exec("DELETE FROM memories WHERE id = ?", id);
    if (drop.length) this.memCache = null;
  }

  memoryDump(): { facts: unknown[]; memories: unknown[]; preferences: unknown[] } {
    const rows = this.sql.exec<{ id: number; kind: string; text: string; ts: number }>("SELECT id, kind, text, ts FROM memories ORDER BY ts DESC").toArray();
    const prefs = this.sql.exec<{ id: number; text: string; source: string; ts: number }>("SELECT id, text, source, ts FROM preferences ORDER BY ts DESC").toArray();
    const fmt = (r: { id: number; text: string; ts: number }) => ({ id: Number(r.id), text: r.text, ts: Number(r.ts) });
    return {
      facts: rows.filter((r) => r.kind === "fact").map(fmt),
      memories: rows.filter((r) => r.kind === "episode").map(fmt),
      preferences: [
        ...prefs.map((p) => ({ id: `pref_${p.id}`, text: p.text, source: p.source, ts: Number(p.ts) })),
        ...rows.filter((r) => r.kind === "preference").map(fmt),
      ],
    };
  }

  /** "Forget me": wipes memories, preferences, decisions, mood (and other personal history). */
  forget(): void {
    for (const t of ["memories", "preferences", "decisions", "proposals", "context", "digest", "contacts", "interactions", "threads", "reminders"]) {
      this.sql.exec(`DELETE FROM ${t}`);
    }
    for (const k of ["mood", "promoted", "blocked", "promotion_asked", "pending_promotion", "transcript", "last_caption", "pending_ask", "digest_rules", "ide_state"]) this.kv.delete(k);
    this.memCache = null;
  }

  private preferences(): string[] {
    return this.sql.exec<{ text: string }>("SELECT text FROM preferences ORDER BY ts DESC LIMIT 12").toArray().map((r) => r.text);
  }

  // ---- contacts ------------------------------------------------------------------------------------------

  private async findContact(name: string | null, number: string | null): Promise<Contact | null> {
    if (number) {
      const h = await phoneHash(number);
      if (h) {
        const r = this.sql.exec<ContactRowT>("SELECT name, phone_hash, relation, importance FROM contacts WHERE phone_hash = ? LIMIT 1", h).toArray();
        if (r[0]) return { ...r[0], importance: Number(r[0].importance) };
      }
    }
    if (name) {
      const r = this.sql.exec<ContactRowT>("SELECT name, phone_hash, relation, importance FROM contacts WHERE name_key = ?", nameKey(name)).toArray();
      if (r[0]) return { ...r[0], importance: Number(r[0].importance) };
    }
    return null;
  }

  /** Upsert by name; record an interaction (no content). */
  private async touchContact(name: string | null, number: string | null, type: string): Promise<Contact> {
    const existing = await this.findContact(name, number);
    const h = number ? await phoneHash(number) : null;
    const displayName = name || existing?.name || (number ? `Unknown ${number.slice(-4)}` : "Unknown");
    const key = nameKey(existing?.name ?? displayName);
    if (!existing) {
      const relation = guessRelation(displayName);
      const importance = guessImportance(displayName, relation);
      this.sql.exec(
        "INSERT INTO contacts (name, name_key, phone_hash, relation, importance, interactions, last_ts) VALUES (?, ?, ?, ?, ?, 1, ?) ON CONFLICT(name_key) DO NOTHING",
        displayName, key, h, relation, importance, this.now(),
      );
    } else {
      this.sql.exec(
        "UPDATE contacts SET interactions = interactions + 1, last_ts = ?, phone_hash = COALESCE(phone_hash, ?) WHERE name_key = ?",
        this.now(), h, key,
      );
    }
    this.sql.exec("INSERT INTO interactions (who_key, type, ts) VALUES (?, ?, ?)", key, type, this.now());
    return (await this.findContact(displayName, number)) ?? { name: displayName, phone_hash: h, relation: null, importance: guessImportance(displayName) };
  }

  private recentFrom(key: string, type: string): number {
    const r = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM interactions WHERE who_key = ? AND type = ? AND ts > ?", key, type, this.now() - REPEAT_WINDOW_MS).toArray();
    return Number(r[0]?.n ?? 0);
  }

  private setThread(who: string, patch: { msg_key?: string; number?: string }): void {
    const key = nameKey(who);
    this.sql.exec(
      `INSERT INTO threads (who_key, who, msg_key, number, ts) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(who_key) DO UPDATE SET who = excluded.who, msg_key = COALESCE(excluded.msg_key, threads.msg_key),
       number = COALESCE(excluded.number, threads.number), ts = excluded.ts`,
      key, who, patch.msg_key ?? null, patch.number ?? null, this.now(),
    );
    this.sql.exec("DELETE FROM threads WHERE ts < ?", this.now() - 24 * 3600_000);
  }

  private thread(who: string): { who: string; msg_key: string | null; number: string | null } | null {
    const key = nameKey(who);
    const r = this.sql
      .exec<{ who: string; msg_key: string | null; number: string | null }>(
        "SELECT who, msg_key, number FROM threads WHERE (who_key = ? OR who_key LIKE ?) AND ts > ? ORDER BY ts DESC LIMIT 1",
        key, `%${key}%`, this.now() - 24 * 3600_000,
      )
      .toArray();
    return r[0] ?? null;
  }

  // ---- decisions / proposals ---------------------------------------------------------------------------------

  private set(key: string): Set<string> {
    return new Set(this.kv.get<string[]>(key, []));
  }
  private addToSet(key: string, v: string): void {
    const s = this.set(key);
    s.add(v);
    this.kv.set(key, [...s]);
  }

  private decisionLog(pattern?: string): DecisionRow[] {
    const rows = pattern
      ? this.sql.exec<{ pattern: string; verdict: string; ts: number }>("SELECT pattern, verdict, ts FROM decisions WHERE pattern = ? ORDER BY ts DESC LIMIT 200", pattern).toArray()
      : this.sql.exec<{ pattern: string; verdict: string; ts: number }>("SELECT pattern, verdict, ts FROM decisions ORDER BY ts DESC LIMIT 1000").toArray();
    return rows.map((r) => ({ pattern: r.pattern, verdict: r.verdict as Verdict, ts: Number(r.ts) }));
  }

  private logDecision(p: { proposal_id: string | null; kind: string; pattern: string; verdict: Verdict; draft?: string | null; final?: string | null }): void {
    this.sql.exec(
      "INSERT INTO decisions (proposal_id, kind, pattern, verdict, draft, final, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
      p.proposal_id, p.kind, p.pattern, p.verdict, p.draft ?? null, p.final ?? null, this.now(),
    );
  }

  private tierFor(kind: string, target: string | null, text?: string) {
    const pattern = patternKey(kind, target);
    return {
      pattern,
      ...decideTier({ kind, target, text }, { promoted: this.set("promoted"), blocked: this.set("blocked"), log: this.decisionLog(pattern), now: this.now() }),
    };
  }

  private propose(p: { kind: ProposalKind | "digest_rule"; title: string; detail: string; payload: Record<string, unknown>; executor: Executor; pattern: string; targetDevice?: string | null }): ProposeData {
    const id = newId("prp");
    const now = this.now();
    const data: ProposeData = {
      proposal_id: id,
      kind: p.kind as ProposalKind,
      title: truncate(p.title, 120),
      detail: truncate(p.detail, 600),
      payload: p.payload,
      executor: p.executor,
      expires_at: now + PROPOSAL_TTL_MS,
    };
    this.sql.exec(
      "INSERT INTO proposals (id, kind, title, detail, payload, executor, pattern, target_device, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
      id, p.kind, data.title, data.detail, JSON.stringify(p.payload), p.executor, p.pattern, p.targetDevice ?? null, now, data.expires_at,
    );
    this.sql.exec("DELETE FROM proposals WHERE created_at < ?", now - 7 * 86_400_000);
    const targets = this.online("mac");
    if (p.kind === "code.patch") {
      targets.push(...(p.targetDevice ? this.online().filter((d) => d.id === p.targetDevice) : this.online("ide")));
    }
    this.sendTo(targets, "bot.propose", data);
    return data;
  }

  private auto(action: "hold_notifications" | "digest" | "reminder.set" | "pause_commentary", detail: string): void {
    this.sendTo(this.online("mac"), "bot.auto", { action, detail });
    this.logDecision({ proposal_id: null, kind: action, pattern: patternKey(action, null), verdict: "auto" });
  }

  private cantDo(origin?: Origin, what = "that"): void {
    this.perform(
      perf({ say: `Sorry, I can't do ${what}. Things like payments, passwords, deleting stuff or settings are off-limits for me!`, emotion: "shy", intensity: 0.6, gesture: "shake", gaze: "user" }, origin?.eventId),
      origin,
    );
  }

  // ---- handlers ----------------------------------------------------------------------------------------------------

  private async onHello(d: HelloData, o: Origin): Promise<void> {
    await this.welcome(o.deviceId);
    if (o.kind === "mac") {
      // Catch up on anything that waited for the Mac.
      this.deliverDueReminders();
      await this.flushDigest(false);
    }
    void d;
  }

  private async onUserSay(d: UserSayData, o: Origin): Promise<void> {
    const text = d.text;
    this.addTurn("user", text);
    const me = moodEventFromText(text);
    if (me) this.moodEvent(me);
    else this.moodEvent("chat");

    // Pending "promote to auto?" question
    const pending = this.kv.get<{ pattern: string; kind: string; ts: number } | null>("pending_promotion", null);
    if (pending && this.now() - pending.ts < 3600_000) {
      const yn = parseYesNo(text);
      if (yn) {
        this.kv.delete("pending_promotion");
        if (yn === "yes") {
          this.addToSet("promoted", pending.pattern);
          this.perform(perf({ say: "Okay! I'll just handle that one myself from now on.", emotion: "proud", intensity: 0.7, gesture: "nod" }, o.eventId), o);
        } else {
          this.perform(perf({ say: "Got it, I'll keep asking first.", emotion: "happy", intensity: 0.5, gesture: "nod" }, o.eventId), o);
        }
        return;
      }
    }

    // "look at this" → fresh frame first
    if (o.kind === "mac" && /\b(look at|see) (this|that|my screen|the screen)\b|\bwhat('?s| is) on (my |the )?screen\b|\bwhat am i (looking at|watching)\b|\bscreen\b.*\?/i.test(text)) {
      const cap = this.kv.get<{ caption: string; ts: number } | null>("last_caption", null);
      if (!cap || this.now() - cap.ts > 15_000) {
        if (this.online("mac").length) {
          this.kv.set("pending_ask", { text, eventId: o.eventId, deviceId: o.deviceId, kind: o.kind, ts: this.now() });
          this.sendTo(this.online("mac"), "capture.request", { reason: "asked" });
          this.perform(perf({ say: "", emotion: "curious", intensity: 0.6, gesture: "lean_in", gaze: "screen", speak: false }, o.eventId), o);
          return;
        }
      }
    }

    if (!this.budget("user", o)) return;
    await this.respond({ kind: "chat", text }, o);
  }

  /** Generic think → perform → remember → act. */
  private async respond(obs: Observation, o: Origin | undefined, guidance?: string, quietOk = false): Promise<Performance | null> {
    const st = this.state;
    const memories = await this.relevantMemories(obs.text);
    let recent = this.recentTurns();
    // The current user message was already logged as a turn; don't send it twice.
    const lastTurn = recent[recent.length - 1];
    if (obs.kind === "chat" && lastTurn?.role === "user" && obs.text.startsWith(lastTurn.text)) recent = recent.slice(0, -1);
    const msgs = buildMessages({
      persona: this.persona,
      userName: this.userName,
      mood: this.mood(),
      activity: st.inCall ? "on a phone call" : st.activity + (st.focus_mode ? " (focus mode on)" : ""),
      frontApp: st.front_app,
      memories,
      preferences: this.preferences(),
      recent,
      observation: obs,
      now: this.now(),
      guidance,
    });
    const th = await think(this.rt.ai, msgs, { replyTo: o?.eventId, onModelCall: this.noteModelCall });
    let p = th.performance;
    if (th.action) {
      const handled = await this.handleModelAction(th.action, o, p);
      if (handled) p = handled;
    }
    if (p.say || !quietOk) this.perform(p, o);
    if (th.remember.length) await this.remember(th.remember, "fact");
    return p;
  }

  /** Model-suggested actions go through code-tier policy. Returns an overriding performance if needed. */
  private async handleModelAction(a: ModelAction, o: Origin | undefined, p: Performance): Promise<Performance | null> {
    const kind = a.kind === "reminder" ? "reminder.set" : a.kind === "call" ? "call.back" : a.kind;
    const text = typeof a.text === "string" ? a.text : "";
    if (kind === "capture") {
      if (this.online("mac").length) this.sendTo(this.online("mac"), "capture.request", { reason: "asked" });
      return null;
    }
    if (kind === "reminder.set") {
      const t = this.tierFor(kind, null, text);
      if (t.tier !== "auto") return this.cantDoPerf(o);
      const mins = typeof a.in_minutes === "number" ? a.in_minutes : null;
      const at = typeof a.at === "number" && a.at > this.now() ? a.at : mins != null ? this.now() + clamp(mins, 1, 60 * 24 * 30) * 60_000 : null;
      if (!at || !text.trim()) return null;
      this.sql.exec("INSERT INTO reminders (text, at) VALUES (?, ?)", truncate(text, 200), at);
      const mins2 = Math.round((at - this.now()) / 60_000);
      this.auto("reminder.set", `Reminder set for ${mins2 < 60 ? `${mins2} min` : `${Math.round(mins2 / 60)} h`} from now: ${truncate(text, 80)}`);
      return null;
    }
    if (kind === "whatsapp.reply") {
      const to = typeof a.to === "string" ? a.to : "";
      const t = this.tierFor(kind, to || null, text);
      if (t.tier === "never") return this.cantDoPerf(o);
      if (t.tier === "suppress") return null;
      const th = to ? this.thread(to) : null;
      if (!th?.msg_key || !text.trim()) {
        return sanitizePerformance({ say: "I can only reply to chats that pinged your phone recently. Can you open it on your phone?", emotion: "shy", intensity: 0.5, gesture: "shake", speak: true }, o?.eventId);
      }
      this.propose({ kind: "whatsapp.reply", title: `Reply to ${th.who}?`, detail: `"${truncate(text, 300)}"`, payload: { key: th.msg_key, to: th.who, text: truncate(text, 1000) }, executor: "android", pattern: t.pattern });
      return null;
    }
    if (kind === "call.back") {
      const name = typeof a.name === "string" ? a.name : typeof a.to === "string" ? a.to : "";
      const th = name ? this.thread(name) : null;
      const number = typeof a.number === "string" ? a.number : th?.number ?? null;
      const t = this.tierFor(kind, th?.who ?? name ?? null);
      if (t.tier === "never") return this.cantDoPerf(o);
      if (!number) return sanitizePerformance({ say: "I don't have their number handy. Can you call from your phone?", emotion: "shy", intensity: 0.5, gesture: "shake", speak: true }, o?.eventId);
      if (t.tier === "propose") this.propose({ kind: "call.back", title: `Call ${th?.who ?? name ?? number}?`, detail: "Opens the dialer on your phone", payload: { number, name: th?.who ?? name ?? null }, executor: "android", pattern: t.pattern });
      return null;
    }
    if (kind === "digest_rule") {
      const target = typeof a.target === "string" ? a.target : typeof a.from === "string" ? a.from : "";
      if (!target) return null;
      const t = this.tierFor(kind, target);
      if (t.tier === "auto") {
        this.addDigestRule(target);
        this.auto("digest", `I'll quietly digest messages from ${target}`);
      } else if (t.tier === "propose") {
        this.propose({ kind: "digest_rule", title: `Always digest ${target}?`, detail: `Messages from ${target} will wait in your digest unless they're urgent.`, payload: { target }, executor: "brain", pattern: t.pattern });
      }
      return null;
    }
    // Anything else: code policy decides; unknown kinds fail closed.
    const t = this.tierFor(kind, null, text);
    if (t.tier === "never") return this.cantDoPerf(o);
    void p;
    return null;
  }

  private cantDoPerf(o?: Origin): Performance {
    return sanitizePerformance(
      { say: "Sorry, I can't do that one. Payments, passwords, deleting things and settings are off-limits for me!", emotion: "shy", intensity: 0.6, gesture: "shake", gaze: "user", speak: true },
      o?.eventId,
    );
  }

  private addDigestRule(target: string): void {
    this.addToSet("digest_rules", nameKey(target));
  }

  private async onState(d: StateUpdateData, o: Origin): Promise<void> {
    const prev = this.state;
    const next = this.setState({
      ...(d.activity ? { activity: d.activity } : {}),
      ...(d.front_app !== undefined ? { front_app: d.front_app } : {}),
      ...(d.focus_mode !== undefined ? { focus_mode: d.focus_mode } : {}),
      ...(d.watching !== undefined ? { watching: d.watching } : {}),
    });
    const becameIdle = prev.activity !== "idle" && next.activity === "idle";
    if (becameIdle || (prev.focus_mode && !next.focus_mode && next.activity === "idle")) await this.flushDigest(true);
    if (!prev.watching && next.watching) {
      this.kv.set("watch", { lastTick: this.now(), lastComment: 0 });
      this.kv.set("transcript", []);
      this.perform(perf({ say: "Ooh, watching together? Yay! I'll keep my comments short.", emotion: "excited", intensity: 0.7, gesture: "bounce", gaze: "screen" }, o.eventId), o);
    } else if (prev.watching && !next.watching) {
      this.kv.set("transcript", []);
    }
    if (!isFocused(prev.activity, prev.focus_mode) && isFocused(next.activity, next.focus_mode)) this.kv.set("held_count", 0);
  }

  private async onCall(d: PhoneCallData, o: Origin): Promise<void> {
    const contact = await this.touchContact(d.name, d.number || null, `call.${d.state}`);
    const obs = callObservation(d, contact);
    const who = String(obs.meta?.who ?? contact.name);
    if (d.number) this.setThread(who, { number: d.number });
    this.addTurn("event", obs.text);
    const st = this.state;

    if (d.state === "ringing") {
      this.setState({ inCall: true, callFrom: who });
      if (st.watching) this.auto("pause_commentary", `Paused watch commentary: ${who} is calling`);
      const imp = obs.importance ?? 0.4;
      this.sendTo(this.online("mac"), "bot.notice", {
        kind: "call", from: who, preview: "", app: "phone", urgency: round2(obs.urgency ?? 0.6),
        summary: `${who} is calling`, interrupt: true,
      });
      if (imp >= 0.7) this.moodEvent("loved_one_call");
      this.perform(
        perf({
          say: `${who} is calling!`,
          emotion: imp >= 0.7 ? "excited" : "surprised",
          intensity: clamp(0.5 + imp * 0.5, 0, 1),
          gesture: imp >= 0.7 ? "jump" : "bounce",
          gaze: "phone",
          voice: { pace: "fast", pitch: 1 },
        }, o.eventId),
      );
    } else if (d.state === "answered") {
      this.setState({ inCall: true, callFrom: who });
      this.perform(perf({ say: "", emotion: "happy", intensity: 0.4, gesture: "hide", gaze: "away", speak: false }));
    } else if (d.state === "ended") {
      this.setState({ inCall: false, callFrom: null });
      await this.flushDigest(false);
      this.perform(perf({ say: "", emotion: "happy", intensity: 0.4, gesture: "wave", gaze: "user", speak: false }));
    } else if (d.state === "missed") {
      this.setState({ inCall: false, callFrom: null });
      this.moodEvent("missed_call");
      this.sendTo(this.online("mac"), "bot.notice", {
        kind: "call", from: who, preview: "", app: "phone", urgency: round2(obs.urgency ?? 0.4),
        summary: `Missed call from ${who}`, interrupt: (obs.urgency ?? 0) >= 0.6,
      });
      const t = this.tierFor("call.back", who);
      if (t.tier === "propose" && d.number) {
        this.propose({ kind: "call.back", title: `Call ${who} back?`, detail: `You missed a call from ${who}.`, payload: { number: d.number, name: d.name ?? who }, executor: "android", pattern: t.pattern });
        this.perform(perf({ say: `Aww, you missed ${who}. Call back?`, emotion: "concerned", intensity: 0.5, gesture: "lean_in", gaze: "user" }, o.eventId));
      }
    }
  }

  private async onMessage(d: PhoneMessageData, o: Origin): Promise<void> {
    const senderKey = nameKey(d.from);
    const contact = await this.touchContact(d.from, null, "message");
    if (d.replyable && d.key) this.setThread(d.from, { msg_key: d.key });
    const repeats = this.recentFrom(senderKey, "message");
    const heur = heuristicUrgency({ preview: d.preview, importance: contact.importance, recentFromSender: repeats, isGroup: d.is_group });
    let cls = { urgency: null as number | null, summary: `${d.from} sent a message${d.is_group && d.conversation ? ` in ${d.conversation}` : ""}`, expects_reply: null as boolean | null };
    if (this.budget("background")) {
      this.noteModelCall();
      cls = await classifyMessage(this.rt.ai, d, contact.relation);
    }
    const urgency = blendUrgency(heur, cls.urgency, hasEmergencyKeyword(d.preview), repeats);
    const obs = messageObservation(d, urgency, contact.importance, cls.summary);
    this.addTurn("event", `${d.from} messaged (${cls.summary})`);
    if (urgency >= 0.8) this.moodEvent("urgent_message");

    const st = this.state;
    const rules = this.set("digest_rules");
    const digestRule = rules.has(senderKey) || (!!d.conversation && rules.has(nameKey(d.conversation)));
    const route = routeNotification({ urgency, activity: st.activity, focusMode: st.focus_mode, inCall: st.inCall, digestRule });

    if (route === "interrupt") {
      this.sendTo(this.online("mac"), "bot.notice", {
        kind: "message", from: d.from, preview: truncate(d.preview, 300), app: d.app, urgency: round2(urgency), summary: cls.summary, interrupt: true,
      });
      if (!st.inCall) {
        const urgent = urgency >= 0.75;
        this.perform(
          perf({
            say: urgent ? `${d.from} needs you! ${cls.summary}.` : `Psst, ${d.from}: ${cls.summary}.`,
            emotion: urgent ? "concerned" : "curious",
            intensity: clamp(0.4 + urgency * 0.5, 0, 1),
            gesture: urgent ? "jump" : "lean_in",
            gaze: "phone",
            voice: { pace: urgent ? "fast" : "normal", pitch: urgent ? 1 : 0 },
            speak: true,
          }, o.eventId),
        );
      }
    } else {
      const wasEmpty = Number(this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM digest").toArray()[0]?.n ?? 0) === 0;
      // A new batch window starts with the first queued item, so it waits up to 15 min for company.
      if (wasEmpty && this.now() - this.kv.get<number>("digest_last_ts", 0) >= DIGEST_INTERVAL_MS) this.kv.set("digest_last_ts", this.now());
      this.sql.exec("INSERT INTO digest (sender, app, summary, urgency, ts) VALUES (?, ?, ?, ?, ?)", d.from, d.app, cls.summary, round2(urgency), this.now());
      if (isFocused(st.activity, st.focus_mode) || st.inCall) {
        const held = this.kv.get<number>("held_count", 0) + 1;
        this.kv.set("held_count", held);
        const lastAuto = this.kv.get<number>("held_auto_ts", 0);
        if (held === 1 || this.now() - lastAuto > 10 * 60_000) {
          this.kv.set("held_auto_ts", this.now());
          const where = st.inCall ? "you're on a call" : st.activity === "meeting" ? "you're in a meeting" : "you're focusing";
          this.auto("hold_notifications", `Held ${held} low-priority message${held === 1 ? "" : "s"} while ${where}`);
        }
      }
    }

    // Draft a reply if the message seems to expect one.
    if (shouldDraftReply(d) && cls.expects_reply !== false) {
      const t = this.tierFor("whatsapp.reply", d.from);
      if (t.tier === "propose" && this.budget("background")) {
        const fb = this.sql
          .exec<{ final: string | null }>("SELECT final FROM decisions WHERE kind = 'whatsapp.reply' AND verdict = 'approve' AND final IS NOT NULL ORDER BY ts DESC LIMIT 4")
          .toArray()
          .map((r) => truncate(r.final!, 120));
        const draft = await draftReply(
          this.rt.ai,
          buildDraftMessages({ userName: this.userName, from: d.from, relation: contact.relation, preview: d.preview, styleNotes: this.preferences().slice(0, 5), examples: fb }),
          this.noteModelCall,
        );
        if (draft && decideTier({ kind: "whatsapp.reply", target: d.from, text: draft }, { promoted: new Set(), blocked: new Set() }).tier === "propose") {
          this.propose({
            kind: "whatsapp.reply",
            title: `Reply to ${d.from}?`,
            detail: `"${draft}"`,
            payload: { key: d.key, to: d.from, text: draft },
            executor: "android",
            pattern: t.pattern,
          });
        }
      }
    }
    void obs;
  }

  private async onFrame(d: ScreenFrameData, o: Origin): Promise<void> {
    const st = this.state;
    const fp = frameFingerprint(d);
    const vs = this.kv.get<{ lastVisionTs: number; periodic: number; fp: string }>("vision", { lastVisionTs: 0, periodic: 0, fp: "" });
    const changed = fp !== vs.fp;
    if (d.reason === "periodic") vs.periodic++;
    vs.fp = fp;
    const pendingAsk = this.kv.get<{ text: string; eventId: string; deviceId: string; kind: DeviceKind; ts: number } | null>("pending_ask", null);
    const asked = d.reason === "asked" || (!!pendingAsk && this.now() - pendingAsk.ts < ASK_TIMEOUT_MS);
    let caption: string | null = null;
    if (shouldCaption({ reason: asked ? "asked" : d.reason, watching: st.watching, hasImage: !!d.image, now: this.now(), lastVisionTs: vs.lastVisionTs, periodicSinceCaption: vs.periodic, changed })) {
      if (this.budget(asked ? "user" : "background", asked ? o : undefined)) {
        this.noteModelCall();
        vs.lastVisionTs = this.now();
        vs.periodic = 0;
        try {
          caption = truncate((await this.rt.ai.vision(VISION_PROMPT, d.image!)).trim(), 600) || null;
        } catch {
          caption = null;
        }
      }
    }
    this.kv.set("vision", vs);
    if (caption || d.ocr) {
      this.kv.set("last_caption", { caption: caption ?? this.kv.get<{ caption: string } | null>("last_caption", null)?.caption ?? "", ocr: truncate(d.ocr ?? "", 1500), front_app: d.front_app ?? null, ts: this.now(), fresh: !!caption });
    }

    if (asked) {
      this.kv.delete("pending_ask");
      const origin: Origin = pendingAsk ? { deviceId: pendingAsk.deviceId, kind: pendingAsk.kind, eventId: pendingAsk.eventId } : o;
      if (!this.budget("user", origin)) return;
      const obs = screenObservation(d, caption);
      const q = pendingAsk?.text ?? "What do you see on my screen?";
      await this.respond({ kind: "chat", text: `${q}\n[${obs.text}]` }, origin, "The user asked you to look at their screen; the [Screen: ...] note describes it. Answer about it directly.");
      return;
    }

    // Unasked: comment on visible errors while coding (rarely), never during calls/meetings/watch.
    if (!st.watching && !st.inCall && caption && !isFocused(st.activity, st.focus_mode) && ocrHasErrors(`${caption} ${d.ocr ?? ""}`)) {
      const last = this.kv.get<number>("screen_comment_ts", 0);
      if (this.now() - last > 10 * 60_000 && this.budget("background")) {
        this.kv.set("screen_comment_ts", this.now());
        this.moodEvent("error");
        await this.respond(screenObservation(d, caption), undefined, "You noticed an error on screen. Offer help in one short, gentle sentence, or return say \"\" if it's not worth interrupting.", true);
      }
    }
  }

  private async onTranscript(d: AudioTranscriptData, ts: number): Promise<void> {
    if (!this.state.watching || !d.text.trim()) return;
    const buf = this.kv.get<TranscriptChunk[]>("transcript", []);
    this.kv.set("transcript", appendTranscript(buf, { text: d.text, ts: Math.min(ts, this.now()) }));
  }

  private async onIde(d: IdeContextData, o: Origin): Promise<void> {
    const errs = d.diagnostics.filter((x) => x.severity === "error");
    const prev = this.kv.get<{ file: string; errors: number; sig: string; ts: number; streak: number }>("ide_state", { file: "", errors: 0, sig: "", ts: 0, streak: 0 });
    const sig = errs.map((e) => `${e.line}:${e.message}`).join("|");
    const sameFile = prev.file === d.file;

    if (sameFile && prev.errors > 0 && errs.length === 0) {
      this.moodEvent("fixed_error");
      if (this.now() - prev.ts > 5_000) {
        this.perform(perf({ say: "Yay, it's clean now! Nice fix.", emotion: "proud", intensity: 0.7, gesture: "dance", gaze: "user" }, o.eventId), o);
      }
    } else if (sameFile && errs.length > 0 && sig === prev.sig) {
      this.moodEvent("repeated_error");
    } else if (errs.length > 0) {
      this.moodEvent("error");
    }
    const streak = sameFile && errs.length && sig === prev.sig ? prev.streak + 1 : 0;
    this.kv.set("ide_state", { file: d.file, errors: errs.length, sig, ts: this.now(), streak });

    if (!needsCodingHelp(d)) return;
    // Unasked diagnostics: only when the error set changed, max once per minute.
    if (d.reason !== "asked" && !d.question) {
      if (sig === prev.sig && sameFile) return;
      const last = this.kv.get<number>("ide_auto_ts", 0);
      if (this.now() - last < 60_000) return;
      this.kv.set("ide_auto_ts", this.now());
    }
    if (!this.budget(d.question || d.reason === "asked" ? "user" : "background", o)) return;

    const obs = ideObservation(d);
    if (d.question) this.addTurn("user", d.question);
    else this.addTurn("event", obs.text);
    const win = codeWindow(d);
    const memories = await this.relevantMemories(obs.text);
    const th = await thinkCoding(
      this.rt.ai,
      buildCodingMessages({
        persona: this.persona,
        file: d.file,
        language: d.language ?? "",
        window: win.text,
        diagnostics: d.diagnostics.slice(0, 10).map((x) => `line ${x.line} ${x.severity}: ${x.message}`).join("\n"),
        question: d.question,
        selection: d.selection?.text ?? null,
        memories,
      }),
      { replyTo: o.eventId, onModelCall: this.noteModelCall },
    );
    if (th.suggestion) {
      this.sendToDevice(o.deviceId, "ide.suggestion", {
        file: d.file,
        explanation: th.suggestion.explanation,
        patch: th.suggestion.patch,
        ...(th.suggestion.line ? { line: th.suggestion.line } : {}),
      });
      if (th.suggestion.patch) {
        const t = this.tierFor("code.patch", d.file);
        if (t.tier === "propose") {
          this.propose({ kind: "code.patch", title: `Apply fix to ${d.file.split("/").pop()}?`, detail: truncate(th.suggestion.explanation, 300), payload: { file: d.file, patch: th.suggestion.patch }, executor: "ide", pattern: t.pattern, targetDevice: o.deviceId });
        }
      }
    }
    const p = { ...th.performance, gaze: th.performance.gaze === "user" ? ("screen" as const) : th.performance.gaze };
    if (!p.say && th.suggestion) p.say = "I left a note in your editor!";
    // Short spoken perform to the mac; full text goes to the ide via ide.suggestion.
    this.perform(sanitizePerformance({ ...p, say: truncate(p.say, 160) }, o.eventId), o);
    if (th.remember.length) await this.remember(th.remember, "fact");
  }

  private async onFeedback(d: UserFeedbackData, o: Origin): Promise<void> {
    const rows = this.sql.exec<ProposalRow>("SELECT * FROM proposals WHERE id = ?", d.proposal_id).toArray();
    const p = rows[0];
    if (!p) {
      this.error(o, "bad_event", "unknown proposal_id");
      return;
    }
    if (p.status !== "pending") {
      // already handled on another device: say so instead of silently ignoring the tap
      this.error(o, "bad_event", `proposal already handled (${p.status})`);
      return;
    }
    const payload = JSON.parse(p.payload) as Record<string, unknown>;
    const draft = typeof payload.text === "string" ? payload.text : null;

    if (this.now() > Number(p.expires_at)) {
      this.sql.exec("UPDATE proposals SET status = 'expired' WHERE id = ?", p.id);
      this.logDecision({ proposal_id: p.id, kind: p.kind, pattern: p.pattern, verdict: "expired", draft });
      this.perform(perf({ say: "Oops, that suggestion went stale. Want me to try again?", emotion: "shy", intensity: 0.4, gesture: "shake" }, o.eventId), o);
      return;
    }

    if (d.verdict !== "approve") {
      this.sql.exec("UPDATE proposals SET status = ? WHERE id = ?", d.verdict === "never" ? "never" : "rejected", p.id);
      this.logDecision({ proposal_id: p.id, kind: p.kind, pattern: p.pattern, verdict: d.verdict, draft });
      if (d.verdict === "never") {
        this.addToSet("blocked", p.pattern);
        this.perform(perf({ say: "Got it, I won't suggest that again.", emotion: "neutral", intensity: 0.4, gesture: "nod" }, o.eventId), o);
      } else {
        this.perform(perf({ say: "", emotion: "neutral", intensity: 0.3, gesture: "nod", speak: false }, o.eventId), o);
      }
      return;
    }

    // approve
    let finalText = draft;
    if (d.edited_text && p.kind === "whatsapp.reply") {
      // The edited text must still pass policy (no OTPs/passwords/payments).
      if (decideTier({ kind: "whatsapp.reply", text: d.edited_text }, { promoted: new Set(), blocked: new Set() }).tier === "never") {
        this.sql.exec("UPDATE proposals SET status = 'rejected' WHERE id = ?", p.id);
        this.cantDo(o, "send that");
        return;
      }
      finalText = d.edited_text;
      payload.text = d.edited_text;
    }
    this.logDecision({ proposal_id: p.id, kind: p.kind, pattern: p.pattern, verdict: "approve", draft, final: finalText });

    const exec = p.executor as Executor;
    if (exec === "brain") {
      if (p.kind === "digest_rule" && typeof payload.target === "string") this.addDigestRule(payload.target);
      this.sql.exec("UPDATE proposals SET status = 'done' WHERE id = ?", p.id);
      this.perform(perf({ say: "Done!", emotion: "happy", intensity: 0.5, gesture: "nod" }, o.eventId), o);
    } else {
      const execPayload =
        p.kind === "whatsapp.reply" ? { key: payload.key, to: payload.to ?? null, text: payload.text } : p.kind === "call.back" ? { number: payload.number, name: payload.name ?? null } : payload;
      let targets = this.online(exec as DeviceKind);
      // A proposal tied to one device (e.g. the editor that asked for a patch) only ever executes there.
      if (p.target_device) targets = targets.filter((t) => t.id === p.target_device);
      const target = targets[0];
      if (!target) {
        this.sql.exec("UPDATE proposals SET status = 'undelivered', payload = ? WHERE id = ?", JSON.stringify(payload), p.id);
        const where = exec === "android" ? "your phone" : exec === "ide" ? "your editor" : "your Mac";
        this.perform(perf({ say: `Hmm, ${where} isn't connected right now, so I couldn't do it. Sorry!`, emotion: "sad", intensity: 0.5, gesture: "shake", gaze: "user" }, o.eventId), o);
        return;
      }
      this.sql.exec("UPDATE proposals SET status = 'executing', payload = ? WHERE id = ?", JSON.stringify(payload), p.id);
      this.sendTo([target], "bot.execute", { proposal_id: p.id, kind: p.kind, payload: execPayload });
    }

    // Promotion offer (only for promotable kinds; never whatsapp.reply).
    if (shouldOfferPromotion(this.decisionLog(p.pattern), p.kind, p.pattern, this.set("promotion_asked"), this.set("promoted"))) {
      this.addToSet("promotion_asked", p.pattern);
      this.kv.set("pending_promotion", { pattern: p.pattern, kind: p.kind, ts: this.now() });
      this.perform(perf({ say: `You've said yes to this ${10} times in a row. Want me to just do it automatically from now on?`, emotion: "curious", intensity: 0.6, gesture: "lean_in" }, o.eventId), o);
    }
  }

  private async onExecResult(d: ExecResultData): Promise<void> {
    const rows = this.sql.exec<ProposalRow>("SELECT * FROM proposals WHERE id = ?", d.proposal_id).toArray();
    const p = rows[0];
    if (!p) return;
    this.sql.exec("UPDATE proposals SET status = ? WHERE id = ?", d.ok ? "done" : "failed", p.id);
    if (d.ok) {
      const say = p.kind === "whatsapp.reply" ? "Sent!" : p.kind === "code.patch" ? "Patched! Fingers crossed." : "";
      this.perform(perf({ say, emotion: "happy", intensity: 0.5, gesture: "nod", speak: !!say }));
    } else {
      this.perform(perf({ say: "Uh oh, that didn't work on the device. Maybe try it by hand?", emotion: "sad", intensity: 0.5, gesture: "shake" }));
    }
  }

  // ---- digest / alarms / watch ------------------------------------------------------------------------------------

  async flushDigest(force = false): Promise<number> {
    const items = this.sql.exec<{ id: number; sender: string; app: string; summary: string; urgency: number; ts: number }>("SELECT * FROM digest ORDER BY ts").toArray();
    if (!items.length) return 0;
    const st = this.state;
    const last = this.kv.get<number>("digest_last_ts", 0);
    if (!force && !digestDue({ queued: items.length, lastSentTs: last, now: this.now(), activity: st.activity, activityJustBecameIdle: false, focused: isFocused(st.activity, st.focus_mode) || st.inCall })) return 0;
    if (!this.online("mac").length) return 0; // keep queued until the Mac is back
    this.sendTo(this.online("mac"), "bot.digest", {
      items: items.map((i) => ({ from: i.sender, app: i.app, summary: i.summary, urgency: Number(i.urgency), ts: Number(i.ts) })),
    });
    this.sql.exec("DELETE FROM digest WHERE id <= ?", Math.max(...items.map((i) => Number(i.id))));
    this.kv.set("digest_last_ts", this.now());
    this.kv.set("held_count", 0);
    return items.length;
  }

  /** Deliver due reminders (only when a Mac is there to show them; otherwise they wait). */
  private deliverDueReminders(): void {
    if (!this.online("mac").length) return;
    const due = this.sql.exec<{ id: number; text: string }>("SELECT id, text FROM reminders WHERE at <= ? ORDER BY at", this.now()).toArray();
    for (const r of due) {
      this.sql.exec("DELETE FROM reminders WHERE id = ?", r.id);
      this.perform(perf({ say: `Reminder! ${r.text}`, emotion: "excited", intensity: 0.7, gesture: "wave", gaze: "user", voice: { pace: "normal", pitch: 1 } }));
    }
  }

  /** Alarm entry point: reminders, digest, watch commentary. */
  alarm(): Promise<void> {
    return this.serialize(async () => {
      const now = this.now();
      this.deliverDueReminders();
      await this.flushDigest(false);
      await this.watchTick();
      this.log({ evt: "alarm", ms: this.now() - now });
      await this.scheduleNextAlarm();
    });
  }

  private async watchTick(): Promise<void> {
    const st = this.state;
    if (!st.watching) return;
    const w = this.kv.get<{ lastTick: number; lastComment: number }>("watch", { lastTick: 0, lastComment: 0 });
    const now = this.now();
    if (now - w.lastTick < WATCH_INTERVAL_MS - 1000) return;
    const prevTick = w.lastTick;
    w.lastTick = now;
    this.kv.set("watch", w);
    if (st.inCall || st.activity === "meeting") return; // commentary paused
    if (now - w.lastComment < WATCH_INTERVAL_MS) return;
    const cap = this.kv.get<{ caption: string; ts: number; front_app: string | null } | null>("last_caption", null);
    const buf = this.kv.get<TranscriptChunk[]>("transcript", []);
    const newCaption = cap && cap.ts >= prevTick ? cap.caption : null;
    const newAudio = buf.filter((c) => c.ts >= prevTick);
    if (!newCaption && !newAudio.length) return; // nothing new → skip
    if (!this.budget("background")) return;
    const obs = watchObservation(newCaption ?? cap?.caption ?? null, buf, cap?.front_app ?? st.front_app);
    const p = await this.respond(
      obs,
      undefined,
      "You're watching something together with the user. React like a friend on the couch: one short line, only if something is genuinely interesting, funny or touching. Otherwise return say \"\". Don't summarize; don't repeat yourself.",
      true,
    );
    if (p?.say) {
      w.lastComment = this.now();
      this.kv.set("watch", w);
    }
  }

  /**
   * Compute and set the next alarm time. Work that is blocked (no Mac online, user focused or on
   * a call) is not scheduled; it is picked up by the event that unblocks it (hello, state, call end).
   */
  async scheduleNextAlarm(): Promise<void> {
    const now = this.now();
    const st = this.state;
    const macOnline = this.online("mac").length > 0;
    const cands: number[] = [];
    if (macOnline) {
      const r = this.sql.exec<{ at: number | null }>("SELECT MIN(at) AS at FROM reminders").toArray();
      if (r[0]?.at != null) cands.push(Number(r[0].at));
      const queued = Number(this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM digest").toArray()[0]?.n ?? 0);
      if (queued && !isFocused(st.activity, st.focus_mode) && !st.inCall) cands.push(this.kv.get<number>("digest_last_ts", now) + DIGEST_INTERVAL_MS);
      if (st.watching) {
        const w = this.kv.get<{ lastTick: number }>("watch", { lastTick: now });
        cands.push(Math.max(now + 5_000, w.lastTick + WATCH_INTERVAL_MS));
      }
    }
    const next = cands.length ? Math.max(now + 1000, Math.min(...cands)) : null;
    await this.rt.setAlarm(next);
  }

  // ---- nightly learner ---------------------------------------------------------------------------------------------

  async learn(): Promise<{ episodes: number; merged: number; preferences: number; contacts: number }> {
    return this.serialize(async () => {
      const t0 = this.now();
      const since = this.kv.get<number>("last_learn_ts", t0 - 86_400_000);
      const turns = this.sql
        .exec<{ role: string; text: string; ts: number }>("SELECT role, text, ts FROM context WHERE ts > ? ORDER BY id", since)
        .toArray()
        .map((x) => ({ role: x.role as ContextTurn["role"], text: x.text, ts: Number(x.ts) }));
      const feedback: FeedbackRow[] = this.sql
        .exec<{ kind: string; verdict: string; draft: string | null; final: string | null; ts: number }>(
          "SELECT kind, verdict, draft, final, ts FROM decisions WHERE ts > ? AND verdict IN ('approve','reject','never') ORDER BY ts",
          t0 - 14 * 86_400_000,
        )
        .toArray()
        .map((x) => ({ ...x, ts: Number(x.ts) }));

      // 1) episodes + model-derived preferences
      let episodes = 0;
      let modelPrefs: string[] = [];
      if (turns.filter((t) => t.role !== "event").length >= 2 && this.budget("background")) {
        try {
          this.noteModelCall();
          const res = await this.rt.ai.chat(buildLearnerMessages(this.userName, turns, feedback), { maxTokens: 400, temperature: 0.3 });
          const out = parseLearnerOutput(parseJsonObject(res.text));
          episodes = await this.remember(out.episodes, "episode", 0.5);
          modelPrefs = out.preferences;
        } catch {
          /* try again tomorrow */
        }
      }

      // 2) merge near-duplicate memories
      const mems = this.memories();
      const pairs = nearDuplicatePairs(mems.map((m) => ({ id: m.id, vec: m.vec, value: m.value, ts: m.ts })), MERGE_DEDUPE);
      for (const [keep, drop] of pairs) {
        this.sql.exec("UPDATE memories SET value = MIN(1.0, value + 0.05) WHERE id = ?", keep);
        this.sql.exec("DELETE FROM memories WHERE id = ?", drop);
      }
      if (pairs.length) this.memCache = null;

      // 3) preferences from feedback
      let prefCount = 0;
      for (const p of [...heuristicPreferences(feedback), ...modelPrefs]) {
        const before = Number(this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM preferences").toArray()[0]?.n ?? 0);
        this.sql.exec("INSERT INTO preferences (text, source, ts) VALUES (?, 'learned', ?) ON CONFLICT(text) DO UPDATE SET ts = excluded.ts", truncate(p, 300), t0);
        const after = Number(this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM preferences").toArray()[0]?.n ?? 0);
        prefCount += after - before;
      }
      this.sql.exec("DELETE FROM preferences WHERE id NOT IN (SELECT id FROM preferences ORDER BY ts DESC LIMIT 50)");

      // 4) contact importance
      const counts = this.sql
        .exec<{ who_key: string; n: number }>("SELECT who_key, COUNT(*) AS n FROM interactions WHERE ts > ? GROUP BY who_key", t0 - 7 * 86_400_000)
        .toArray();
      const countMap = new Map(counts.map((c) => [c.who_key, Number(c.n)]));
      const approvals = this.sql
        .exec<{ pattern: string; n: number }>("SELECT pattern, COUNT(*) AS n FROM decisions WHERE verdict = 'approve' AND ts > ? GROUP BY pattern", t0 - 7 * 86_400_000)
        .toArray();
      const apprMap = new Map<string, number>();
      for (const a of approvals) {
        const target = a.pattern.split("|")[1] ?? "";
        apprMap.set(target, (apprMap.get(target) ?? 0) + Number(a.n));
      }
      const contacts = this.sql.exec<{ name_key: string; importance: number }>("SELECT name_key, importance FROM contacts").toArray();
      let contactUpdates = 0;
      for (const c of contacts) {
        const ni = updatedImportance(Number(c.importance), countMap.get(c.name_key) ?? 0, apprMap.get(c.name_key) ?? 0);
        if (Math.abs(ni - Number(c.importance)) > 1e-3) {
          this.sql.exec("UPDATE contacts SET importance = ? WHERE name_key = ?", ni, c.name_key);
          contactUpdates++;
        }
      }

      // housekeeping
      this.sql.exec("DELETE FROM interactions WHERE ts < ?", t0 - 30 * 86_400_000);
      this.sql.exec("DELETE FROM model_calls WHERE ts < ?", t0 - 3600_000);
      this.sql.exec("DELETE FROM decisions WHERE ts < ?", t0 - 180 * 86_400_000);
      this.kv.set("last_learn_ts", t0);
      this.log({ evt: "learn", ms: this.now() - t0 });
      return { episodes, merged: pairs.length, preferences: prefCount, contacts: contactUpdates };
    });
  }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
