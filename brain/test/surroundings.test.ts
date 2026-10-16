import { describe, expect, it } from "vitest";
import {
  HOLIDAYS, dayKey, envWire, fetchWeather, holidayOn, isWeekend, mapWeatherCode, nextLocalMidnight, openMeteoUrl, parseOpenMeteo,
} from "../src/brain/surroundings";

const IST = 5.5 * 3600_000;

describe("weather code mapping", () => {
  it.each([
    [0, 25, "clear"], [1, 25, "clear"], [2, 25, "cloudy"], [3, 25, "cloudy"], [45, 20, "fog"], [48, 20, "fog"],
    [51, 20, "rain"], [61, 22, "rain"], [65, 22, "rain"], [67, 0, "rain"], [80, 28, "rain"], [82, 28, "rain"],
    [71, -2, "snow"], [77, -2, "snow"], [85, -1, "snow"], [86, -1, "snow"], [95, 30, "storm"], [96, 30, "storm"], [99, 30, "storm"],
  ])("code %i at %i°C → %s", (code, t, want) => expect(mapWeatherCode(code, t)).toBe(want));
  it("hot at ≥ 35 °C replaces clear / cloudy, not rain or storms", () => {
    expect(mapWeatherCode(0, 35)).toBe("hot");
    expect(mapWeatherCode(3, 41)).toBe("hot");
    expect(mapWeatherCode(0, 34.9)).toBe("clear");
    expect(mapWeatherCode(95, 38)).toBe("storm");
    expect(mapWeatherCode(61, 36)).toBe("rain");
  });
});

describe("Open-Meteo request and parsing", () => {
  it("builds the documented forecast request with coordinates rounded to 2 decimals", () => {
    const u = new URL(openMeteoUrl(28.4567, 77.0312));
    expect(u.origin + u.pathname).toBe("https://api.open-meteo.com/v1/forecast");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      latitude: "28.46", longitude: "77.03", current: "temperature_2m,weather_code,is_day", daily: "sunrise,sunset", timezone: "auto", timeformat: "unixtime", forecast_days: "1",
    });
  });
  const body = {
    latitude: 28.46, longitude: 77.03, utc_offset_seconds: 19800, timezone: "Asia/Kolkata",
    current: { time: 1760600000, interval: 900, temperature_2m: 31.4, weather_code: 2, is_day: 1 },
    daily: { time: [1760553000], sunrise: [1760576400], sunset: [1760618100] },
  };
  it("parses unixtime responses", () => {
    expect(parseOpenMeteo(body)).toEqual({ weather: { temp_c: 31, condition: "cloudy", is_day: true }, sunrise: 1760576400000, sunset: 1760618100000, tz: "Asia/Kolkata", offset_ms: IST });
  });
  it("parses ISO-local times using utc_offset_seconds", () => {
    const r = parseOpenMeteo({ ...body, daily: { sunrise: ["2026-10-16T06:22"] } });
    expect(r!.sunrise).toBe(Date.UTC(2026, 9, 16, 6, 22) - IST);
  });
  it("rejects bodies without current data", () => {
    expect(parseOpenMeteo({})).toBeNull();
    expect(parseOpenMeteo({ current: { temperature_2m: "hot" } })).toBeNull();
    expect(parseOpenMeteo(null)).toBeNull();
  });
  it("fetchWeather with a mocked fetch: success, HTTP error, network error, bad JSON", async () => {
    const urls: string[] = [];
    const ok = async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(body), { status: 200 });
    };
    expect((await fetchWeather(ok, 28.46, 77.03))!.weather).toEqual({ temp_c: 31, condition: "cloudy", is_day: true });
    expect(urls[0]).toContain("api.open-meteo.com");
    expect(await fetchWeather(async () => new Response("nope", { status: 503 }), 1, 2)).toBeNull();
    expect(await fetchWeather(async () => { throw new Error("offline"); }, 1, 2)).toBeNull();
    expect(await fetchWeather(async () => new Response("{not json", { status: 200 }), 1, 2)).toBeNull();
  });
});

describe("festival lookup", () => {
  it("finds verified 2026 and 2027 dates", () => {
    expect(holidayOn("2026-11-08")).toEqual({ name: "Diwali" });
    expect(holidayOn("2026-03-04")).toEqual({ name: "Holi" });
    expect(holidayOn("2026-10-20")).toEqual({ name: "Dussehra" });
    expect(holidayOn("2026-08-28")).toEqual({ name: "Raksha Bandhan" });
    expect(holidayOn("2027-10-29")).toEqual({ name: "Diwali" });
    expect(holidayOn("2027-03-23")).toEqual({ name: "Holi" });
    expect(holidayOn("2027-01-26")).toEqual({ name: "Republic Day" });
    expect(holidayOn("2026-10-17")).toBeNull();
  });
  it("leaves out unverified and solemn days", () => {
    expect(holidayOn("2026-02-15")).toBeNull(); // Maha Shivratri 2026: sources disagree
    expect(holidayOn("2026-06-26")).toBeNull(); // Muharram
    expect(holidayOn("2026-04-03")).toBeNull(); // Good Friday
  });
  it("every key is a real date in 2026-2027", () => {
    for (const k of Object.keys(HOLIDAYS)) {
      expect(k).toMatch(/^202[67]-\d\d-\d\d$/);
      expect(new Date(`${k}T00:00:00Z`).toISOString().slice(0, 10)).toBe(k);
    }
  });
  it("env.update uses the local date (IST)", () => {
    // 2026-11-08 00:30 IST = 2026-11-07 19:00 UTC
    const ts = Date.UTC(2026, 10, 7, 19, 0);
    expect(envWire(null, ts).holiday).toEqual({ name: "Diwali" });
    expect(envWire(null, ts)).toMatchObject({ weather: null, sunrise: null, sunset: null, tz: "Asia/Kolkata", weekend: true });
  });
});

describe("local calendar", () => {
  it("weekend, day key with 04:00 boundary, next midnight", () => {
    const sat = Date.UTC(2026, 9, 17, 6, 0); // Sat 11:30 IST
    expect(isWeekend(sat, IST)).toBe(true);
    expect(isWeekend(Date.UTC(2026, 9, 16, 6, 0), IST)).toBe(false);
    expect(dayKey(Date.UTC(2026, 9, 16, 20, 0), IST)).toBe("2026-10-16"); // 01:30 IST on the 17th → still the 16th
    expect(dayKey(Date.UTC(2026, 9, 17, 0, 0), IST)).toBe("2026-10-17"); // 05:30 IST
    expect(nextLocalMidnight(Date.UTC(2026, 9, 16, 6, 30), IST)).toBe(Date.UTC(2026, 9, 17) - IST);
  });
});
