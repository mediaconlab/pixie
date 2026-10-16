/**
 * PetLife: the brain side of the pet (PROTOCOL.md §4) — relationship, surroundings, thought reservoir
 * and voice. BrainCore owns it and routes the pet events here; it talks back through a small host
 * interface so it stays testable without the Durable Object runtime.
 *
 * No LLM calls on pet.state / pet.event / signals.update / location.update. The model is used only for
 * pet.speak lines, ambiguous instructions, and the nightly line bank / reflection.
 * Privacy: never log line text, facts, transcripts or locations.
 */
import type { Brainpower } from "../ai";
import { parseJsonObject } from "../ai";
import type { DeviceConn } from "./core";
import type {
  Activity, LocationUpdateData, PetEventData, PetSpeakData, PetStateData, Performance, SignalsUpdateData,
} from "../protocol";
import { perf, sanitizePerformance, EMOTIONS, GESTURES } from "../protocol";
import { IST_OFFSET_MS, istString, truncate } from "../util";
import {
  type Appraisal, type ParsedInstruction, BUSY_MINUTES, DEFAULT_MINUTES, ackLine, appraise, bondGainFor, buildInstructionMessages,
  isAngry, maybeInstruction, parseInstruction, parseModelInstruction, shouldPout,
} from "./instruct";
import {
  type ObeyInstruction, type PetProfile, type ProfileWire, THEATRICAL_INTENTS, addBond, describeBond, describePetState, describeTraits,
  driftTraits, ensureDayMood, fadeBond, learnRhythm, noteContact, normalizeProfile, nudgeTrait, profileWire, speakDecline,
  updateFamiliarity, weeklyChattiness, type SpeakDecline,
} from "./pet";
import type { KV, SqlLike } from "./store";
import { nameKey } from "./store";
import {
  type EnvWire, type FetchLike, type WeatherCache, dayKey, dayStartOf, describeEnv, envWire, fetchWeather, localHour,
  nextLocalMidnight, weatherFresh, weatherRetryAllowed,
} from "./surroundings";
import {
  type MemoryLite, type Thought, type ThoughtKind, WORLD_CHECK_INTERVAL_MS, WORLD_MAX_NEW_PER_DAY, callbackCandidates, detectWorld,
  extendWorld, gossipAllowed, gossipCandidates, newWorldThought, sameStory, thoughtsWire,
} from "./thoughts";
import {
  type LineBank, DEFAULT_LINE_BANK, buildLineBankMessages, buildReflectionMessages, buildSpeakMessages, checkLine, cleanLine,
  parseLineBank, parseReflection, pickBankLine, pickEnum,
} from "./voice";

export const PET_TICK_MS = 3600_000;
export const QUIET_CODING_WINDOW_MS = 14 * 86_400_000;
/** A phone fix this fresh wins over the Mac's own (coarser) location. */
export const PHONE_FIX_PRIORITY_MS = 3600_000;
/** A quiet-type instruction this soon after a bubble "reply" means the reply was really a dismissal. */
export const DISMISS_WINDOW_MS = 10_000;
const DISMISSIVE: readonly string[] = ["quiet", "not_now", "stop", "less_needy"];
const DAY = 86_400_000;

export interface PetHost {
  sql: SqlLike;
  kv: KV;
  ai: Brainpower;
  fetch: FetchLike;
  now(): number;
  random(): number;
  macs(): DeviceConn[];
  send(conns: DeviceConn[], type: string, data: unknown): void;
  /** bot.perform to the given devices (logs the line as a context turn) */
  perform(p: Performance, to: DeviceConn[]): void;
  user(): { activity: Activity; inCall: boolean; front_app: string | null };
  userName(): string;
  personaName(): string;
  /** model calls still allowed for background work this hour */
  backgroundBudgetLeft(): number;
  userBudgetOk(): boolean;
  noteModelCall(): void;
  relevantMemories(text: string, k: number): Promise<string[]>;
  memories(): MemoryLite[];
  remember(texts: string[], kind: "episode" | "fact", value: number): Promise<number>;
}

interface Signals extends SignalsUpdateData {}

export class PetLife {
  constructor(private readonly h: PetHost) {}

  private get kv(): KV {
    return this.h.kv;
  }
  private get sql(): SqlLike {
    return this.h.sql;
  }

  // ---- profile ---------------------------------------------------------------------------------

  profile(): PetProfile {
    const stored = this.kv.get<Partial<PetProfile> | null>("pet_profile", null);
    const p = normalizeProfile(stored, this.h.now(), this.h.random);
    if (!stored) {
      // An existing user meeting the pet layer: the pet has known them since their first conversation.
      const first = this.sql.exec<{ ts: number | null }>("SELECT MIN(ts) AS ts FROM context").toArray()[0]?.ts;
      if (first != null && Number(first) < p.born_ts) p.born_ts = Number(first);
      this.kv.set("pet_profile", p);
    }
    return p;
  }
  private saveProfile(p: PetProfile): void {
    this.kv.set("pet_profile", p);
  }

  /** Mutate the profile and send pet.profile if its wire form changed. */
  private updateProfile(fn: (p: PetProfile) => void, opts: { notify?: boolean } = {}): PetProfile {
    const p = this.profile();
    fn(p);
    this.saveProfile(p);
    if (opts.notify !== false) this.sendProfile(false);
    return p;
  }

  profileWire(): ProfileWire {
    return profileWire(this.profile(), this.h.now());
  }

  private sendProfile(force: boolean, to?: DeviceConn[]): void {
    const w = this.profileWire();
    const sig = JSON.stringify(w);
    if (!force && sig === this.kv.get<string>("pet_profile_sent", "")) return;
    const targets = to ?? this.h.macs();
    if (!targets.length) return;
    this.kv.set("pet_profile_sent", sig);
    this.h.send(targets, "pet.profile", w);
  }

  // ---- time helpers -------------------------------------------------------------------------------

  private offset(): number {
    return this.kv.get<WeatherCache | null>("weather", null)?.offset_ms ?? IST_OFFSET_MS;
  }
  private dayKey(ts = this.h.now()): string {
    return dayKey(ts, this.offset());
  }
  private dayStart(ts = this.h.now()): number {
    return dayStartOf(ts, this.offset());
  }

  private signals(): Signals {
    return this.kv.get<Signals>("signals", {});
  }

  /** In a meeting / call / screen-share-ish moment (no pouting, no proactive lines). */
  inMeeting(): boolean {
    const u = this.h.user();
    const s = this.signals();
    return u.activity === "meeting" || u.inCall || !!s.calendar_busy_now || (!!s.mic_in_use && !!s.camera_in_use);
  }

  // ---- hello / tick ----------------------------------------------------------------------------------

  /** A Mac said hello: profile, surroundings, line bank and thoughts. */
  async onMacHello(conn: DeviceConn[]): Promise<void> {
    this.kv.set("pet_tick_ts", 0);
    await this.tick(false, false);
    this.sendProfile(true, conn);
    this.sendEnv(true, conn);
    this.h.send(conn, "pet.lines", { lines: this.lineBank() });
    this.sendThoughts(true, conn);
  }

  /**
   * Periodic upkeep, at most hourly (or forced by the alarm): day mood, weather refresh, thoughts,
   * holiday / weekend changes. No model calls.
   */
  async tick(fromAlarm: boolean, announce = true): Promise<void> {
    const now = this.h.now();
    const last = this.kv.get<number>("pet_tick_ts", 0);
    if (now - last < (fromAlarm ? PET_TICK_MS - 60_000 : PET_TICK_MS)) return;
    this.kv.set("pet_tick_ts", now);
    const day = this.dayKey(now);
    const memCount = this.h.memories().length;
    this.updateProfile((p) => {
      ensureDayMood(p, day, this.h.random);
      updateFamiliarity(p, memCount);
    });
    await this.refreshWeather(false);
    this.refreshThoughts();
    if (!announce) return;
    // Hourly from the alarm (PROTOCOL §4.2 env.update), otherwise only on change.
    this.sendEnv(fromAlarm);
    this.sendThoughts(false);
  }

  tickDue(): boolean {
    return this.h.now() - this.kv.get<number>("pet_tick_ts", 0) >= PET_TICK_MS - 60_000;
  }

  /** When the next hourly env/pet tick is due (only worth an alarm when there is weather to refresh). */
  nextTickAt(): number | null {
    if (!this.kv.get<{ lat: number } | null>("location", null)) return null;
    return this.kv.get<number>("pet_tick_ts", 0) + PET_TICK_MS;
  }

  // ---- surroundings -------------------------------------------------------------------------------------

  async onLocation(d: LocationUpdateData): Promise<void> {
    const now = this.h.now();
    if (d.source === "phone") this.kv.set("phone_fix_ts", now);
    else if (now - this.kv.get<number>("phone_fix_ts", -Infinity) < PHONE_FIX_PRIORITY_MS) return;
    const prev = this.kv.get<{ lat: number; lon: number } | null>("location", null);
    // Only the latest coordinates (already re-rounded to 2 decimals on parse) are kept. No history.
    this.kv.set("location", { lat: d.lat, lon: d.lon });
    if (prev && prev.lat === d.lat && prev.lon === d.lon) return;
    await this.refreshWeather(true);
    this.sendEnv(false);
  }

  private async refreshWeather(force: boolean): Promise<void> {
    const loc = this.kv.get<{ lat: number; lon: number } | null>("location", null);
    if (!loc) return;
    const now = this.h.now();
    const c = this.kv.get<WeatherCache | null>("weather", null);
    if (!force && weatherFresh(c, loc.lat, loc.lon, now)) return;
    if (!weatherRetryAllowed(c, loc.lat, loc.lon, now)) return;
    const r = await fetchWeather(this.h.fetch, loc.lat, loc.lon);
    if (!r) {
      // Keep the last good reading (envWire hides it once stale); just remember the failure for backoff.
      const kept: WeatherCache = c && c.lat === loc.lat && c.lon === loc.lon ? { ...c, failed_ts: now } : { lat: loc.lat, lon: loc.lon, ts: 0, failed_ts: now, weather: null, sunrise: null, sunset: null, tz: c?.tz ?? "Asia/Kolkata", offset_ms: c?.offset_ms ?? IST_OFFSET_MS };
      this.kv.set("weather", kept);
      return;
    }
    this.kv.set("weather", { lat: loc.lat, lon: loc.lon, ts: now, failed_ts: 0, ...r });
  }

  envNow(): EnvWire {
    return envWire(this.kv.get<WeatherCache | null>("weather", null), this.h.now());
  }

  private sendEnv(force: boolean, to?: DeviceConn[]): void {
    const e = this.envNow();
    const sig = JSON.stringify(e);
    if (!force && sig === this.kv.get<string>("env_sent", "")) return;
    const macs = to ?? this.h.macs();
    if (!macs.length) return;
    this.kv.set("env_sent", sig);
    this.h.send(macs, "env.update", e);
  }

  // ---- body signals ---------------------------------------------------------------------------------------

  onSignals(d: SignalsUpdateData): void {
    this.kv.set("signals", { ...this.signals(), ...d });
  }

  onPetState(d: PetStateData): void {
    const prev = this.kv.get<PetStateData | null>("pet_state", null);
    this.kv.set("pet_state", d);
    if (!prev || prev.phase !== d.phase) this.sql.exec("INSERT INTO pet_log (kind, name, ref, ts) VALUES ('phase', ?, NULL, ?)", d.phase, this.h.now());
  }

  onPetEvent(d: PetEventData): void {
    const now = this.h.now();
    let kind = d.kind;
    // The reply was "be quiet" (the instruction can reach us just before the Mac's bubble event).
    if (kind === "bubble_replied" && now - this.kv.get<number>("dismiss_obey_ts", -Infinity) <= DISMISS_WINDOW_MS) kind = "bubble_dismissed";
    this.sql.exec("INSERT INTO pet_log (kind, name, ref, ts) VALUES ('event', ?, ?, ?)", kind.slice(0, 40), d.thought_id ?? d.intent ?? null, now);
    const userTouched = ["petted", "poked", "fed", "carried", "bubble_replied", "made_up", "reunion"].includes(kind);
    const gain: Record<string, number> = { petted: 0.5, fed: 0.5, made_up: 1, bubble_replied: 0.5 };
    if (!userTouched && !gain[kind]) return;
    this.updateProfile((p) => {
      if (userTouched) noteContact(p, now, this.dayKey(now));
      if (gain[kind]) {
        const applied = addBond(p, gain[kind]!, this.dayKey(now));
        p.feel.warm += 1;
        if (kind === "bubble_replied") this.kv.set("bubble_reply", { ts: now, gain: applied, day: this.dayKey(now) });
      }
    });
  }

  /**
   * A quiet / not now / stop / less needy right after a bubble "reply": re-label that reply as a dismissal
   * (pet_log feeds the weekly chattiness check) and undo its bond / warmth gain. Runs inside updateProfile.
   */
  private undoBubbleReply(p: PetProfile, now: number): void {
    this.kv.set("dismiss_obey_ts", now);
    const r = this.kv.get<{ ts: number; gain: number; day: string } | null>("bubble_reply", null);
    if (!r || now - r.ts > DISMISS_WINDOW_MS || now < r.ts) return;
    this.kv.delete("bubble_reply");
    const row = this.sql
      .exec<{ id: number }>("SELECT id FROM pet_log WHERE kind = 'event' AND name = 'bubble_replied' AND ts >= ? ORDER BY id DESC LIMIT 1", r.ts)
      .toArray()[0];
    if (row) this.sql.exec("UPDATE pet_log SET name = 'bubble_dismissed' WHERE id = ?", row.id);
    p.bond = Math.max(0, p.bond - r.gain);
    if (p.bond_day === r.day) p.bond_today = Math.max(0, p.bond_today - r.gain);
    p.feel.warm = Math.max(0, p.feel.warm - 1);
  }

  /** Something the user did (chat, state change while present) counts as contact. */
  noteUserContact(): void {
    const now = this.h.now();
    this.updateProfile((p) => noteContact(p, now, this.dayKey(now)));
  }

  /** Record a user.say appraisal: bond, drift counters, and the wire event. */
  applyAppraisal(a: Appraisal | null): void {
    if (!a) return;
    const macs = this.h.macs();
    if (macs.length) this.h.send(macs, "pet.appraisal", a);
    this.updateProfile((p) => {
      addBond(p, bondGainFor(a), this.dayKey());
      if (a.event === "praise" || a.event === "affection" || a.event === "thanks" || a.event === "apology") p.feel.warm += 1;
      else if (a.event === "scold") p.feel.cold += 1;
      else if (a.event === "tease") p.feel.tease += 1;
    });
  }

  heuristicAppraisal(text: string): Appraisal | null {
    return appraise(text);
  }

  onActivity(activity: Activity, frontApp: string | null): void {
    this.sql.exec("INSERT INTO activity_log (activity, front_app, ts) VALUES (?, ?, ?)", activity, frontApp ? truncate(frontApp, 60) : null, this.h.now());
  }

  // ---- instructions ------------------------------------------------------------------------------------

  /**
   * Recognise and apply an instruction in user.say. Regex first; one model call only for ambiguous
   * phrasing. Returns true when handled (the caller skips normal chat).
   */
  async handleInstruction(text: string, via: "typed" | "voice", replyTo: string, origin: DeviceConn[]): Promise<boolean> {
    let parsed: ParsedInstruction | null = parseInstruction(text);
    if (!parsed && maybeInstruction(text) && this.h.userBudgetOk()) {
      try {
        this.h.noteModelCall();
        const res = await this.h.ai.chat(buildInstructionMessages(text), { maxTokens: 60, temperature: 0 });
        parsed = parseModelInstruction(parseJsonObject(res.text));
      } catch {
        parsed = null;
      }
    }
    if (!parsed) return false;
    this.applyInstruction(parsed, text, via, replyTo, origin);
    return true;
  }

  private applyInstruction(pi: ParsedInstruction, text: string, via: "typed" | "voice", replyTo: string, origin: DeviceConn[]): void {
    const now = this.h.now();
    const u = this.h.user();
    const inMeeting = this.inMeeting();
    const obeyKey = pi.subject ? `${pi.instruction}:${nameKey(pi.subject)}` : pi.busy ? "busy" : pi.instruction;
    let until: number | null = null;
    let repeat = false;
    const p = this.updateProfile((p) => {
      repeat = now - (p.obeyed[obeyKey] ?? -Infinity) < DAY;
      p.obeyed[obeyKey] = now;
      for (const [k, ts] of Object.entries(p.obeyed)) if (ts != null && now - ts > 30 * DAY) delete p.obeyed[k];
      noteContact(p, now, this.dayKey(now));
      if (DISMISSIVE.includes(pi.instruction)) this.undoBubbleReply(p, now);
      switch (pi.instruction) {
        case "quiet":
        case "not_now":
        case "stop": {
          const mins = pi.minutes ?? (pi.busy ? BUSY_MINUTES : DEFAULT_MINUTES[pi.instruction]!);
          until = mins === "today" ? nextLocalMidnight(now, this.offset()) : now + mins * 60_000;
          p.quiet_until = Math.max(p.quiet_until > now ? p.quiet_until : 0, until);
          if (u.activity === "coding") {
            p.quiet_coding = [...p.quiet_coding.filter((t) => now - t < QUIET_CODING_WINDOW_MS), now];
            const days = new Set(p.quiet_coding.map((t) => this.dayKey(t)));
            if (p.quiet_coding.length >= 3 && days.size >= 2 && !p.quiet_when.includes("coding")) p.quiet_when = [...p.quiet_when, "coding"];
          }
          break;
        }
        case "sleep":
          break;
        case "less_needy":
          p.less_needy = Math.min(1, Math.round((p.less_needy + 0.5) * 100) / 100);
          nudgeTrait(p, "chattiness", -0.02);
          break;
        case "more_chatty":
          p.less_needy = Math.max(0, Math.round((p.less_needy - 0.5) * 100) / 100);
          p.quiet_until = 0;
          p.quiet_when = [];
          p.quiet_coding = [];
          nudgeTrait(p, "chattiness", 0.02);
          break;
        case "no_gossip":
          if (pi.subject) {
            const key = nameKey(pi.subject);
            const label = this.contactLabel(key) ?? pi.subject;
            if (!p.gossip_block.some((b) => b.key === key)) p.gossip_block = [...p.gossip_block, { key, label }].slice(-50);
          } else p.gossip_enabled = false;
          break;
        case "gossip_ok":
          if (pi.subject) {
            const key = nameKey(pi.subject);
            p.gossip_block = p.gossip_block.filter((b) => b.key !== key);
          } else p.gossip_enabled = true;
          break;
      }
    });
    if (pi.instruction === "no_gossip" || pi.instruction === "gossip_ok") {
      this.refreshThoughts();
      // A per-person block is enforced by the filtered thought list alone, so always re-send it then.
      this.sendThoughts(!!pi.subject);
    }
    const pout = shouldPout({ instruction: pi.instruction, repeatWithin24h: repeat, aboutPerson: !!pi.subject, angry: isAngry(text), inMeeting });
    const macs = this.h.macs();
    const instruction: ObeyInstruction = pi.instruction;
    // A gossip instruction about one person must not reach the Mac as pet.obey (it would toggle gossip globally).
    const aboutPersonGossip = !!pi.subject && (instruction === "no_gossip" || instruction === "gossip_ok");
    if (macs.length && !aboutPersonGossip) this.h.send(macs, "pet.obey", { instruction, until, pout });
    const happy = instruction === "more_chatty" || instruction === "gossip_ok";
    const say = ackLine(pi, text, this.h.random);
    this.h.perform(
      perf({ say, emotion: happy ? "happy" : instruction === "sleep" ? "sleepy" : pout ? "shy" : "neutral", intensity: 0.4, gesture: happy ? "bounce" : "nod", gaze: "user", speak: via === "voice" }, replyTo),
      dedupe([...macs, ...origin]),
    );
    void p;
  }

  private contactLabel(key: string): string | null {
    const r = this.sql.exec<{ name: string }>("SELECT name FROM contacts WHERE name_key = ?", key).toArray()[0];
    return r?.name ?? null;
  }

  // ---- thoughts --------------------------------------------------------------------------------------

  private thoughtRows(): Array<Thought & { created_at: number; used_at: number | null }> {
    return this.sql
      .exec<{ id: string; kind: string; salience: number; expires_at: number; fact: string; subject_key: string | null; created_at: number; used_at: number | null }>("SELECT * FROM thoughts")
      .toArray()
      .map((r) => ({ id: r.id, kind: r.kind as ThoughtKind, salience: Number(r.salience), expires_at: Number(r.expires_at), fact: r.fact, subject_key: r.subject_key, created_at: Number(r.created_at), used_at: r.used_at == null ? null : Number(r.used_at) }));
  }

  /** Recompute gossip aggregates and callbacks for today; drop expired / now-disallowed thoughts. */
  refreshThoughts(): void {
    const now = this.h.now();
    const p = this.profile();
    const offset = this.offset();
    const dk = this.dayKey(now);
    const ds = this.dayStart(now);
    this.sql.exec("DELETE FROM thoughts WHERE expires_at <= ?", now);
    const messages = this.sql
      .exec<{ who_key: string; ts: number }>("SELECT who_key, ts FROM interactions WHERE type = 'message' AND ts > ?", ds - 15 * DAY)
      .toArray()
      .map((r) => ({ who_key: r.who_key, ts: Number(r.ts) }));
    const activity = this.sql
      .exec<{ activity: string; front_app: string | null; ts: number }>("SELECT activity, front_app, ts FROM activity_log WHERE ts > ? ORDER BY ts", ds - 9 * DAY)
      .toArray()
      .map((r) => ({ activity: r.activity, front_app: r.front_app, ts: Number(r.ts) }));
    const contacts = new Map(
      this.sql.exec<{ name_key: string; name: string; relation: string | null }>("SELECT name_key, name, relation FROM contacts").toArray().map((c) => [c.name_key, { name: c.name, relation: c.relation }] as const),
    );
    const gossip = gossipCandidates({ now, dayStart: ds, dayKey: dk, localHour: (ts) => localHour(ts, offset), messages, activity, contacts, profile: p });
    const keep = new Set(gossip.map((g) => g.id));
    for (const t of this.thoughtRows()) {
      if (t.kind === "gossip" && !keep.has(t.id) && t.used_at == null) this.sql.exec("DELETE FROM thoughts WHERE id = ?", t.id);
    }
    const callbacks = callbackCandidates(this.h.memories(), p.familiarity, now, ds, dk);
    for (const t of [...gossip, ...callbacks]) {
      this.sql.exec(
        "INSERT INTO thoughts (id, kind, salience, expires_at, fact, subject_key, created_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(id) DO UPDATE SET salience = excluded.salience, fact = excluded.fact, expires_at = excluded.expires_at",
        t.id, t.kind, t.salience, t.expires_at, t.fact, t.subject_key, now,
      );
    }
  }

  /** Thoughts the Mac may ask about now (unexpired, unused, still allowed). */
  liveThoughts(): Thought[] {
    const now = this.h.now();
    const p = this.profile();
    return this.thoughtRows().filter((t) => t.expires_at > now && t.used_at == null && (t.kind !== "gossip" || gossipAllowed(t, p)));
  }

  private sendThoughts(force: boolean, to?: DeviceConn[]): void {
    const items = thoughtsWire(this.liveThoughts(), this.h.now());
    const sig = JSON.stringify(items);
    if (!force && sig === this.kv.get<string>("thoughts_sent", "")) return;
    const targets = to ?? this.h.macs();
    if (!targets.length) return;
    this.kv.set("thoughts_sent", sig);
    this.h.send(targets, "pet.thoughts", { items });
  }

  /**
   * Cheap world-news detection on text reaching the user. Rate-limited per source; at most
   * WORLD_MAX_NEW_PER_DAY new notes a day; a recurring story extends the existing note.
   */
  noticeWorld(text: string, source: "window" | "ocr" | "transcript" | "chat", frontApp?: string | null): void {
    const now = this.h.now();
    const gate = this.kv.get<Record<string, number>>("world_check", {});
    if (now - (gate[source] ?? 0) < WORLD_CHECK_INTERVAL_MS) return;
    const hit = detectWorld(text, source, frontApp);
    if (!hit) return;
    gate[source] = now;
    this.kv.set("world_check", gate);
    const existing = this.thoughtRows().find((t) => t.kind === "world" && t.expires_at > now && sameStory((t.subject_key ?? "").split(" "), hit.words));
    if (existing) {
      const ext = extendWorld(existing, now);
      this.sql.exec("UPDATE thoughts SET salience = ?, expires_at = ? WHERE id = ?", ext.salience, ext.expires_at, existing.id);
    } else {
      const day = this.dayKey(now);
      const quota = this.kv.get<{ day: string; n: number }>("world_quota", { day, n: 0 });
      const used = quota.day === day ? quota.n : 0;
      if (used >= WORLD_MAX_NEW_PER_DAY) return;
      this.kv.set("world_quota", { day, n: used + 1 });
      const t = newWorldThought(hit, now);
      this.sql.exec("INSERT OR IGNORE INTO thoughts (id, kind, salience, expires_at, fact, subject_key, created_at, used_at) VALUES (?, 'world', ?, ?, ?, ?, ?, NULL)", t.id, t.salience, t.expires_at, t.fact, t.subject_key, now);
    }
    this.sendThoughts(false);
  }

  // ---- speaking ----------------------------------------------------------------------------------------

  lineBank(): LineBank {
    return { ...DEFAULT_LINE_BANK, ...this.kv.get<Partial<LineBank>>("pet_lines", {}) };
  }

  private speakCounts(): { lines: number; gossip: number; theatrical: number } {
    const rows = this.sql.exec<{ name: string; n: number }>("SELECT name, COUNT(*) AS n FROM pet_log WHERE kind = 'speak' AND ts >= ? GROUP BY name", this.dayStart()).toArray();
    let lines = 0;
    let gossip = 0;
    let theatrical = 0;
    for (const r of rows) {
      const n = Number(r.n);
      lines += n;
      if (r.name === "gossip") gossip += n;
      if ((THEATRICAL_INTENTS as readonly string[]).includes(r.name)) theatrical += n;
    }
    return { lines, gossip, theatrical };
  }

  /** Why a pet.speak would be declined right now (null = go ahead). Exposed for tests. */
  declineReason(intent: string): SpeakDecline {
    const c = this.speakCounts();
    return speakDecline({
      profile: this.profile(),
      now: this.h.now(),
      intent,
      activity: this.h.user().activity,
      inMeeting: this.inMeeting(),
      linesToday: c.lines,
      gossipToday: c.gossip,
      theatricalToday: c.theatrical,
      modelBudgetLeft: this.h.backgroundBudgetLeft(),
    });
  }

  private findThought(kind: ThoughtKind, id: string | undefined): Thought | null {
    const live = this.liveThoughts().filter((t) => t.kind === kind);
    if (id) return live.find((t) => t.id === id) ?? null;
    return live.sort((a, b) => b.salience - a.salience)[0] ?? null;
  }

  /** pet.speak → one short line in Pixie's voice (bot.perform, speak false), or say "" to decline. */
  async onSpeak(d: PetSpeakData, replyTo: string, to: DeviceConn[]): Promise<void> {
    const decline = (): void => this.h.perform(perf({ say: "", emotion: "neutral", intensity: 0.3, gesture: "none", gaze: "user", speak: false }, replyTo), to);
    if (this.declineReason(d.intent)) return decline();
    let thought: Thought | null = null;
    if (d.intent === "gossip" || d.intent === "world" || d.intent === "callback") {
      thought = this.findThought(d.intent, d.thought_id);
      if (!thought) return decline();
    }
    const p = this.profile();
    const st = this.kv.get<PetStateData | null>("pet_state", null);
    const env = this.envNow();
    const memQuery = thought?.fact ?? d.hint ?? d.intent.replace(/_/g, " ");
    const memories = thought?.kind === "gossip" ? [] : await this.h.relevantMemories(memQuery, 3);
    const diary = this.kv.get<{ text: string; day: string } | null>("pet_diary", null);
    const input = {
      intent: d.intent,
      personaName: this.h.personaName(),
      userName: this.h.userName(),
      traits: describeTraits(p.traits),
      bond: describeBond(p),
      petState: describePetState(st),
      dayMood: p.day_mood,
      env: describeEnv(env),
      fact: thought?.fact ?? null,
      hint: d.hint ?? null,
      memories,
      diary: diary?.text ?? null,
      timeText: istString(this.h.now()),
    };
    let line: { say: string; emotion: string; gesture: string; intensity: number } | null = null;
    let retryNote: string | undefined;
    for (let attempt = 0; attempt < 2 && !line; attempt++) {
      if (this.h.backgroundBudgetLeft() < 1) break;
      try {
        this.h.noteModelCall();
        const res = await this.h.ai.chat(buildSpeakMessages(input, retryNote), { maxTokens: 80, temperature: 0.9 });
        const j = parseJsonObject(res.text);
        const say = cleanLine(j?.say);
        const chk = checkLine(say);
        if (chk.ok) line = { say, emotion: String(j?.emotion ?? "happy"), gesture: String(j?.gesture ?? "none"), intensity: typeof j?.intensity === "number" ? j.intensity : 0.6 };
        else retryNote = chk.reason;
      } catch {
        retryNote = "no answer";
      }
    }
    if (!line) {
      const b = pickBankLine(this.lineBank(), d.intent, this.h.random);
      if (!b) return decline();
      line = { say: b.text, emotion: b.emotion, gesture: b.gesture, intensity: 0.6 };
    }
    const out = sanitizePerformance({ say: line.say, emotion: pickEnum(line.emotion, EMOTIONS, "happy"), gesture: pickEnum(line.gesture, GESTURES, "none"), intensity: line.intensity, gaze: "user", voice: { pace: "normal", pitch: 0 }, speak: false }, replyTo);
    out.speak = false;
    this.sql.exec("INSERT INTO pet_log (kind, name, ref, ts) VALUES ('speak', ?, ?, ?)", d.intent, thought?.id ?? null, this.h.now());
    if (thought) {
      this.sql.exec("UPDATE thoughts SET used_at = ? WHERE id = ?", this.h.now(), thought.id);
      this.sendThoughts(false);
    }
    this.h.perform(out, to);
  }

  // ---- nightly ------------------------------------------------------------------------------------------

  async learn(episodes: string[]): Promise<{ rhythm: boolean; lines: number; diary: boolean }> {
    const now = this.h.now();
    const offset = this.offset();
    const lh = (ts: number) => localHour(ts, offset);
    const ds = this.dayStart(now);
    const days = Array.from({ length: 14 }, (_, i) => ({ start: ds - (i + 1) * DAY, end: ds - i * DAY }));
    const rows = this.sql
      .exec<{ activity: string; ts: number }>("SELECT activity, ts FROM activity_log WHERE ts > ? ORDER BY ts", ds - 15 * DAY)
      .toArray()
      .map((r) => ({ activity: r.activity, ts: Number(r.ts) }));
    const wakes = this.sql
      .exec<{ ts: number }>("SELECT ts FROM pet_log WHERE ((kind = 'phase' AND name = 'waking') OR (kind = 'event' AND name = 'woke')) AND ts > ?", ds - 15 * DAY)
      .toArray()
      .map((r) => Number(r.ts));
    const outcomes = this.sql
      .exec<{ name: string; n: number }>("SELECT name, COUNT(*) AS n FROM pet_log WHERE kind = 'event' AND name IN ('bubble_replied','bubble_dismissed','bubble_ignored') AND ts > ? GROUP BY name", now - 7 * DAY)
      .toArray();
    const oc = { replied: 0, dismissed: 0, ignored: 0 };
    for (const o of outcomes) oc[o.name.replace("bubble_", "") as keyof typeof oc] = Number(o.n);
    let rhythmChanged = false;
    this.updateProfile((p) => {
      const r = learnRhythm(p.rhythm, rows, days, lh, wakes);
      rhythmChanged = JSON.stringify(r) !== JSON.stringify(p.rhythm);
      p.rhythm = r;
      updateFamiliarity(p, this.h.memories().length);
      driftTraits(p);
      fadeBond(p, now, this.dayKey(now));
      weeklyChattiness(p, oc, now);
    });

    // Line bank in Pixie's voice (keeps the previous / default bank for any intent the model fumbles).
    let replaced = 0;
    if (this.h.backgroundBudgetLeft() > 2) {
      try {
        this.h.noteModelCall();
        const p = this.profile();
        const res = await this.h.ai.chat(buildLineBankMessages({ personaName: this.h.personaName(), traits: describeTraits(p.traits), bond: describeBond(p), userName: this.h.userName() }), { maxTokens: 1500, temperature: 0.9 });
        const r = parseLineBank(parseJsonObject(res.text), this.lineBank());
        replaced = r.replaced;
        if (replaced) this.kv.set("pet_lines", r.bank);
      } catch {
        /* keep the current bank */
      }
    }
    const macs = this.h.macs();
    if (macs.length) this.h.send(macs, "pet.lines", { lines: this.lineBank() });

    // Reflection memory + diary entry for the morning greeting.
    let diaryOk = false;
    if (this.h.backgroundBudgetLeft() > 1) {
      try {
        this.h.noteModelCall();
        const res = await this.h.ai.chat(buildReflectionMessages({ personaName: this.h.personaName(), userName: this.h.userName(), dayNotes: [...episodes, ...this.dayNotes(ds - DAY, now)] }), { maxTokens: 200, temperature: 0.7 });
        const r = parseReflection(parseJsonObject(res.text));
        if (r.reflection) await this.h.remember([r.reflection], "episode", 0.55);
        if (r.diary) {
          this.kv.set("pet_diary", { text: r.diary, day: this.dayKey(now) });
          diaryOk = true;
        }
      } catch {
        /* tomorrow */
      }
    }

    this.sql.exec("DELETE FROM activity_log WHERE ts < ?", now - 30 * DAY);
    this.sql.exec("DELETE FROM pet_log WHERE ts < ?", now - 30 * DAY);
    this.sql.exec("DELETE FROM thoughts WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at < ?)", now, now - 7 * DAY);
    this.refreshThoughts();
    this.sendThoughts(false);
    return { rhythm: rhythmChanged, lines: replaced, diary: diaryOk };
  }

  /** Deterministic, content-free notes about the day for the reflection prompt. */
  private dayNotes(from: number, to: number): string[] {
    const notes: string[] = [];
    const chats = Number(this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM context WHERE role = 'user' AND ts BETWEEN ? AND ?", from, to).toArray()[0]?.n ?? 0);
    if (chats) notes.push(`Chatted with Pixie ${chats} time${chats === 1 ? "" : "s"}.`);
    for (const r of this.sql.exec<{ name: string; n: number }>("SELECT name, COUNT(*) AS n FROM pet_log WHERE kind = 'event' AND ts BETWEEN ? AND ? GROUP BY name", from, to).toArray()) {
      if (["petted", "fed", "poked", "made_up", "reunion"].includes(r.name)) notes.push(`Pixie was ${r.name.replace("_", " ")} ${Number(r.n)} time(s).`);
    }
    const coding = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM activity_log WHERE activity = 'coding' AND ts BETWEEN ? AND ?", from, to).toArray()[0]?.n;
    if (Number(coding)) notes.push("Spent part of the day coding.");
    return notes;
  }

  /** "Forget me": wipe the pet's history of the user; keep Pixie's own personality. */
  forget(): void {
    for (const t of ["activity_log", "pet_log", "thoughts"]) this.sql.exec(`DELETE FROM ${t}`);
    for (const k of ["pet_diary", "location", "weather", "signals", "pet_state", "world_check", "world_quota", "thoughts_sent", "env_sent", "phone_fix_ts", "bubble_reply", "dismiss_obey_ts"]) this.kv.delete(k);
    const old = this.profile();
    const fresh = normalizeProfile(null, this.h.now(), this.h.random);
    this.saveProfile({ ...fresh, traits: old.traits, seed: old.seed, born_ts: old.born_ts });
  }
}

function dedupe(conns: DeviceConn[]): DeviceConn[] {
  const seen = new Set<string>();
  return conns.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}
