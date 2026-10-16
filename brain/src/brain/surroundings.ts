/**
 * Surroundings (PROTOCOL.md §4.2 env.update): weather and sun times from Open-Meteo (free, no key),
 * Indian festivals and holidays, weekend, time zone. Pure helpers plus one fetch wrapper that never throws.
 *
 * Location privacy: only the latest coordinates, re-rounded to 2 decimals (~1 km), are kept; no history.
 */
import { IST_OFFSET_MS } from "../util";

export const WEATHER_TTL_MS = 30 * 60_000;
export const WEATHER_RETRY_MS = 10 * 60_000;
export const FETCH_TIMEOUT_MS = 6_000;
export const HOT_C = 35;
export const DEFAULT_TZ = "Asia/Kolkata";

export type Condition = "clear" | "cloudy" | "rain" | "storm" | "fog" | "snow" | "hot";
export interface Weather { temp_c: number; condition: Condition; is_day: boolean }

export interface WeatherCache {
  lat: number;
  lon: number;
  /** when the data was fetched (0 = never) */
  ts: number;
  /** last failed attempt, for backoff */
  failed_ts: number;
  weather: Weather | null;
  sunrise: number | null;
  sunset: number | null;
  tz: string;
  offset_ms: number;
}

export interface EnvWire {
  weather: Weather | null;
  sunrise: number | null;
  sunset: number | null;
  holiday: { name: string } | null;
  weekend: boolean;
  tz: string;
}

export const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Open-Meteo forecast request. Parameters checked against the API's documented names
 * (current=, daily=, timezone=auto, timeformat=unixtime, forecast_days=); see the README of this change.
 */
export function openMeteoUrl(lat: number, lon: number): string {
  const q = new URLSearchParams({
    latitude: round2(lat).toFixed(2),
    longitude: round2(lon).toFixed(2),
    current: "temperature_2m,weather_code,is_day",
    daily: "sunrise,sunset",
    timezone: "auto",
    timeformat: "unixtime",
    forecast_days: "1",
  });
  return `https://api.open-meteo.com/v1/forecast?${q.toString()}`;
}

/**
 * WMO weather interpretation codes (as used by Open-Meteo) → §4 conditions.
 * 0-1 clear, 2-3 cloudy, 45/48 fog, 51-67 and 80-82 rain (drizzle, rain, freezing rain, showers),
 * 71-77 and 85-86 snow, 95-99 thunderstorm. "hot" replaces clear/cloudy at ≥ 35 °C (rain, storms,
 * fog and snow are more telling than heat, so they win).
 */
export function mapWeatherCode(code: number, tempC: number | null): Condition {
  let c: Condition;
  if (code <= 1) c = "clear";
  else if (code <= 3) c = "cloudy";
  else if (code === 45 || code === 48) c = "fog";
  else if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) c = "rain";
  else if ((code >= 71 && code <= 77) || code === 85 || code === 86) c = "snow";
  else if (code >= 95 && code <= 99) c = "storm";
  else c = "cloudy";
  if ((c === "clear" || c === "cloudy") && tempC != null && tempC >= HOT_C) c = "hot";
  return c;
}

/** Parse an Open-Meteo JSON body (unixtime or ISO-local times). Null if unusable. */
export function parseOpenMeteo(j: unknown): Omit<WeatherCache, "lat" | "lon" | "ts" | "failed_ts"> | null {
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  const cur = (o.current ?? null) as Record<string, unknown> | null;
  if (!cur || typeof cur !== "object") return null;
  const temp = typeof cur.temperature_2m === "number" ? cur.temperature_2m : null;
  const code = typeof cur.weather_code === "number" ? cur.weather_code : null;
  if (temp == null || code == null) return null;
  const offsetSec = typeof o.utc_offset_seconds === "number" ? o.utc_offset_seconds : IST_OFFSET_MS / 1000;
  const toMs = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v * 1000;
    if (typeof v === "string") {
      const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`);
      return Number.isFinite(t) ? t - (/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? 0 : offsetSec * 1000) : null;
    }
    return null;
  };
  const daily = (o.daily ?? {}) as Record<string, unknown>;
  const first = (x: unknown) => (Array.isArray(x) ? x[0] : undefined);
  return {
    weather: { temp_c: Math.round(temp), condition: mapWeatherCode(code, temp), is_day: cur.is_day === 1 || cur.is_day === true },
    sunrise: toMs(first(daily.sunrise)),
    sunset: toMs(first(daily.sunset)),
    tz: typeof o.timezone === "string" && o.timezone ? o.timezone : DEFAULT_TZ,
    offset_ms: offsetSec * 1000,
  };
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Fetch current weather; returns null on any failure (network, HTTP status, bad JSON, timeout). */
export async function fetchWeather(fetchFn: FetchLike, lat: number, lon: number): Promise<ReturnType<typeof parseOpenMeteo>> {
  try {
    const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined;
    const res = await fetchFn(openMeteoUrl(lat, lon), { headers: { accept: "application/json" }, ...(signal ? { signal } : {}) });
    if (!res.ok) return null;
    return parseOpenMeteo(await res.json());
  } catch {
    return null;
  }
}

export function weatherFresh(c: WeatherCache | null, lat: number, lon: number, now: number): boolean {
  return !!c && c.lat === lat && c.lon === lon && c.ts > 0 && now - c.ts < WEATHER_TTL_MS;
}

/** Back off after a failure so a dead API isn't hit on every event. */
export function weatherRetryAllowed(c: WeatherCache | null, lat: number, lon: number, now: number): boolean {
  if (!c || c.lat !== lat || c.lon !== lon) return true;
  return now - c.failed_ts >= WEATHER_RETRY_MS;
}

// ---- local calendar -----------------------------------------------------------------------------

/** Local date key YYYY-MM-DD for a UTC offset. */
export function localDate(ts: number, offsetMs: number): string {
  return new Date(ts + offsetMs).toISOString().slice(0, 10);
}

/** Local decimal hour 0..24. */
export function localHour(ts: number, offsetMs: number): number {
  const d = new Date(ts + offsetMs);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

/** Day key whose day starts at 04:00 local (so a 1 am night still counts as the previous day). */
export function dayKey(ts: number, offsetMs: number): string {
  return localDate(ts - 4 * 3600_000, offsetMs);
}

/** UTC ms of the 04:00-local start of the day that contains `ts` (see dayKey). */
export function dayStartOf(ts: number, offsetMs: number): number {
  const [y, m, d] = dayKey(ts, offsetMs).split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d, 4) - offsetMs;
}

export function isWeekend(ts: number, offsetMs: number): boolean {
  const dow = new Date(ts + offsetMs).getUTCDay();
  return dow === 0 || dow === 6;
}

/** Start of the next local calendar day (UTC ms). */
export function nextLocalMidnight(ts: number, offsetMs: number): number {
  const d = new Date(ts + offsetMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - offsetMs;
}

/**
 * Indian festivals and national holidays, 2026–2027 (local dates).
 *
 * Sources (all dates verified; anything not confirmed by an official list was left out):
 * - 2026: DoPT O.M. F.No. 12/2/2023-JCA dated 03.07.2025, "Holidays to be observed in Central Government
 *   offices during the year 2026" — Annexure I (gazetted) and Annexure II (restricted), as published at
 *   https://www.gconnect.in/news/holidays-to-be-observed-in-central-government-offices-during-the-year-2026.html
 *   and cross-checked against the gazetted list at https://dfe.gov.in/uploads/documents/list-of-gazetted-holidays-2026.pdf
 * - 2027: DoPT O.M. F.No. 12/2/2023-JCA dated 16.07.2026, gazetted list
 *   https://www.staffnews.in/2026/07/list-of-holidays-for-the-year-2027-gazetted.html and restricted list
 *   https://www.staffnews.in/2026/07/list-of-restricted-holidays-for-the-year-2027.html, cross-checked against the
 *   O.M. scan https://www.gconnect.in/gc22/wp-content/uploads/2026/07/Holiday-list-2027.pdf
 *
 * Deliberately omitted: Maha Shivratri 2026 (sources disagree: 12 vs 15 Feb); solemn observances that a
 * playful pet should not greet (Muharram, Good Friday, Guru Teg Bahadur's Martyrdom Day); where two
 * holidays share a day, the more widely celebrated one is kept.
 */
export const HOLIDAYS: Readonly<Record<string, string>> = {
  // 2026
  "2026-01-01": "New Year's Day",
  "2026-01-14": "Makar Sankranti / Pongal",
  "2026-01-23": "Basant Panchami",
  "2026-01-26": "Republic Day",
  "2026-03-03": "Holika Dahan",
  "2026-03-04": "Holi",
  "2026-03-19": "Ugadi / Gudi Padwa",
  "2026-03-21": "Eid-ul-Fitr",
  "2026-03-26": "Ram Navami",
  "2026-03-31": "Mahavir Jayanti",
  "2026-04-05": "Easter",
  "2026-04-14": "Vaisakhi / Vishu / Tamil New Year",
  "2026-05-01": "Buddha Purnima",
  "2026-05-27": "Bakrid",
  "2026-07-16": "Rath Yatra",
  "2026-08-15": "Independence Day",
  "2026-08-26": "Onam",
  "2026-08-28": "Raksha Bandhan",
  "2026-09-04": "Janmashtami",
  "2026-09-14": "Ganesh Chaturthi",
  "2026-10-02": "Gandhi Jayanti",
  "2026-10-20": "Dussehra",
  "2026-10-29": "Karwa Chauth",
  "2026-11-08": "Diwali",
  "2026-11-09": "Govardhan Puja",
  "2026-11-11": "Bhai Dooj",
  "2026-11-15": "Chhath Puja",
  "2026-11-24": "Guru Nanak Jayanti",
  "2026-12-24": "Christmas Eve",
  "2026-12-25": "Christmas",
  // 2027
  "2027-01-01": "New Year's Day",
  "2027-01-14": "Makar Sankranti",
  "2027-01-15": "Pongal",
  "2027-01-26": "Republic Day",
  "2027-02-11": "Basant Panchami",
  "2027-03-06": "Maha Shivratri",
  "2027-03-10": "Eid-ul-Fitr",
  "2027-03-22": "Holika Dahan",
  "2027-03-23": "Holi",
  "2027-03-28": "Easter",
  "2027-04-07": "Ugadi / Gudi Padwa",
  "2027-04-14": "Vaisakhi / Vishu / Tamil New Year",
  "2027-04-15": "Ram Navami",
  "2027-04-19": "Mahavir Jayanti",
  "2027-05-17": "Bakrid",
  "2027-05-20": "Buddha Purnima",
  "2027-07-05": "Rath Yatra",
  "2027-08-15": "Independence Day",
  "2027-08-17": "Raksha Bandhan",
  "2027-08-25": "Janmashtami",
  "2027-09-04": "Ganesh Chaturthi",
  "2027-09-12": "Onam",
  "2027-10-02": "Gandhi Jayanti",
  "2027-10-09": "Dussehra",
  "2027-10-18": "Karwa Chauth",
  "2027-10-29": "Diwali",
  "2027-10-30": "Govardhan Puja",
  "2027-10-31": "Bhai Dooj",
  "2027-11-04": "Chhath Puja",
  "2027-11-14": "Guru Nanak Jayanti",
  "2027-12-24": "Christmas Eve",
  "2027-12-25": "Christmas",
};

export function holidayOn(dateKey: string): { name: string } | null {
  const n = HOLIDAYS[dateKey];
  return n ? { name: n } : null;
}

export function envWire(c: WeatherCache | null, now: number): EnvWire {
  const offset = c?.offset_ms ?? IST_OFFSET_MS;
  // Sun times are only meaningful for today's fetch; weather goes stale after 3 h without a refresh.
  const fresh = !!c && c.ts > 0 && now - c.ts < 3 * 3600_000;
  return {
    weather: fresh ? c!.weather : null,
    sunrise: fresh ? c!.sunrise : null,
    sunset: fresh ? c!.sunset : null,
    holiday: holidayOn(localDate(now, offset)),
    weekend: isWeekend(now, offset),
    tz: c?.tz ?? DEFAULT_TZ,
  };
}

export function describeEnv(e: EnvWire): string {
  const bits: string[] = [];
  if (e.weather) bits.push(`${e.weather.condition === "hot" ? "very hot" : e.weather.condition}, ${e.weather.temp_c}°C, ${e.weather.is_day ? "daytime" : "night"}`);
  if (e.holiday) bits.push(`today is ${e.holiday.name}`);
  if (e.weekend) bits.push("it's the weekend");
  return bits.join("; ");
}
