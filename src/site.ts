/**
 * Per-install site facts, read at runtime from Worker `vars` (wrangler.jsonc).
 *
 * Every value is REQUIRED: a controller that silently fell back to someone
 * else's timezone or free window would charge the car at the wrong time, so a
 * missing or malformed var throws (the tick fails loud via ntfy) instead.
 * Control-loop tuning that rarely differs between installs stays in
 * src/constants.ts.
 */

export interface Site {
  /** IANA time zone (e.g. "Australia/Sydney"). Daylight saving follows the
   *  zone's rules via the runtime's built-in Intl data; every window below is
   *  local WALL-CLOCK time, so the free window tracks a DST change. */
  timeZone: string;
  /** Free grid window, minutes since local midnight. Start is on a half hour
   *  (the reserve forecast works in half-hour slots). */
  windowStartMins: number;
  windowEndMins: number;
  /** First tick of the day (PLAN runs here). */
  dayStartMins: number;
  /** Afternoon solar soak hard stop; no fresh soak starts in its last hour,
   *  and ticks keep running 15 min past it so the stop lands. */
  soakEndMins: number;
  /** Home battery usable capacity. */
  batteryKwh: number;
  /** Battery's own minimum SoC (BMS floor), %. The reserve never sits below
   *  it, and it is assumed when the FoxESS minSocOnGrid read fails. */
  batteryMinSocPct: number;
  /** Charger watts per amp step (volts x phases, e.g. 230 V x 3 = 690). */
  wPerAmp: number;
  minAmps: number;
  maxAmps: number;
  /** Geofence radius around config home_lat/home_lon (invariant 7). */
  homeRadiusM: number;
  /** Most AC power the inverter can deliver to the house from the battery
   *  (plus PV), W. Sizes the morning dump: the car starts at what fits under
   *  it after house load, so a small inverter never opens at max amps and
   *  imports until the derate loop catches up. The grid meter stays the
   *  ground truth; this only sets the starting point and the ceiling. */
  inverterMaxW: number;
  /** Grid export limit, W (0 = zero-export site); null = unknown / none.
   *  Only read when D1 config soak_export is 'false': PV counts as curtailed
   *  (free to put in the car) while feed-in sits at this cap. */
  exportLimitW: number | null;
}

export interface SiteVars {
  TIME_ZONE?: unknown; // "Australia/Brisbane"
  FREE_WINDOW_START?: unknown; // "11:00"
  FREE_WINDOW_END?: unknown; // "14:00"
  DAY_START?: unknown; // "05:30"
  SOLAR_SOAK_END?: unknown; // "17:30"
  BATTERY_KWH?: unknown;
  BATTERY_MIN_SOC?: unknown; // %
  CHARGER_VOLTS?: unknown;
  CHARGER_PHASES?: unknown;
  CHARGER_MIN_AMPS?: unknown;
  CHARGER_MAX_AMPS?: unknown;
  HOME_RADIUS_M?: unknown;
  INVERTER_MAX_W?: unknown; // 15000
  EXPORT_LIMIT_W?: unknown; // optional: 5000, or 0 for a zero-export site
}

export function siteFromEnv(env: SiteVars): Site {
  const missing: string[] = [];
  const raw = (k: keyof SiteVars): string => {
    const v = env[k];
    if (v === undefined || v === null || String(v).trim() === "") {
      missing.push(k);
      return "";
    }
    return String(v).trim();
  };
  const hhmm = (k: keyof SiteVars): number => {
    const v = raw(k);
    if (!v) return NaN;
    const m = /^(\d{1,2}):(\d{2})$/.exec(v);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`var ${k}="${v}" must be HH:MM`);
    return Number(m[1]) * 60 + Number(m[2]);
  };
  const num = (k: keyof SiteVars): number => {
    const v = raw(k);
    if (!v) return NaN;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`var ${k}="${v}" must be a positive number`);
    return n;
  };
  const zone = (k: keyof SiteVars): string => {
    const v = raw(k);
    if (!v) return "";
    try {
      formatter(v);
    } catch {
      throw new Error(`var ${k}="${v}" must be an IANA time zone, e.g. Australia/Sydney`);
    }
    return v;
  };

  const site: Site = {
    timeZone: zone("TIME_ZONE"),
    windowStartMins: hhmm("FREE_WINDOW_START"),
    windowEndMins: hhmm("FREE_WINDOW_END"),
    dayStartMins: hhmm("DAY_START"),
    soakEndMins: hhmm("SOLAR_SOAK_END"),
    batteryKwh: num("BATTERY_KWH"),
    batteryMinSocPct: num("BATTERY_MIN_SOC"),
    wPerAmp: num("CHARGER_VOLTS") * num("CHARGER_PHASES"),
    minAmps: num("CHARGER_MIN_AMPS"),
    maxAmps: num("CHARGER_MAX_AMPS"),
    homeRadiusM: num("HOME_RADIUS_M"),
    inverterMaxW: num("INVERTER_MAX_W"),
    exportLimitW: optionalNonNegative(env, "EXPORT_LIMIT_W"),
  };
  if (missing.length) throw new Error(`missing site vars in wrangler.jsonc: ${missing.join(", ")}`);

  if (site.windowStartMins % 30 !== 0) throw new Error("FREE_WINDOW_START must be on the hour or half hour");
  if (!(site.dayStartMins < site.windowStartMins && site.windowStartMins < site.windowEndMins)) {
    throw new Error("need DAY_START < FREE_WINDOW_START < FREE_WINDOW_END");
  }
  if (site.soakEndMins < site.windowEndMins || site.soakEndMins > 23 * 60 + 30) {
    throw new Error("SOLAR_SOAK_END must be between FREE_WINDOW_END and 23:30");
  }
  if (!Number.isInteger(site.batteryMinSocPct) || site.batteryMinSocPct >= 100) {
    throw new Error("BATTERY_MIN_SOC must be a whole percentage below 100");
  }
  if (!Number.isInteger(site.minAmps) || !Number.isInteger(site.maxAmps) || site.minAmps > site.maxAmps) {
    throw new Error("CHARGER_MIN_AMPS / CHARGER_MAX_AMPS must be integers with min <= max");
  }
  return site;
}

/** An optional var: unset/blank = null; otherwise a number >= 0. */
function optionalNonNegative(env: SiteVars, k: keyof SiteVars): number | null {
  const v = env[k];
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const n = Number(String(v).trim());
  if (!Number.isFinite(n) || n < 0) throw new Error(`var ${k}="${String(v)}" must be a number >= 0 (or unset)`);
  return n;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The zone's offset from UTC, in minutes, at instant `ms` (DST-aware). */
export function utcOffsetMins(site: Pick<Site, "timeZone">, ms: number): number {
  const p: Record<string, number> = {};
  for (const part of formatter(site.timeZone).formatToParts(new Date(ms))) p[part.type] = Number(part.value);
  const wall = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60_000);
}

/** Local wall-clock time as a Date whose UTC fields read as local time. */
export function localNow(site: Pick<Site, "timeZone">, now = new Date()): Date {
  return new Date(now.getTime() + utcOffsetMins(site, now.getTime()) * 60_000);
}

/** Local half-hour slot (0..47, wall clock) containing instant `ms`. In the
 *  repeated hour after DST ends two instants share a slot; in the hour
 *  skipped when DST starts, those slots simply don't occur. */
export function localSlot(site: Pick<Site, "timeZone">, ms: number): number {
  const local = localNow(site, new Date(ms));
  return local.getUTCHours() * 2 + (local.getUTCMinutes() >= 30 ? 1 : 0);
}

/** UTC epoch ms of local midnight starting `date` (YYYY-MM-DD, local). A
 *  local day is 23 or 25 hours long when DST starts or ends: measure it as
 *  localMidnightMs(next day) - localMidnightMs(date), never as 24 h. */
export function localMidnightMs(site: Pick<Site, "timeZone">, date: string): number {
  const wall = Date.parse(`${date}T00:00:00Z`);
  // Offset at the guess, then once more at the corrected instant: converges
  // unless a transition sits within hours of midnight (not in Australia,
  // whose changes happen at 02:00/03:00).
  const guess = wall - utcOffsetMins(site, wall) * 60_000;
  return wall - utcOffsetMins(site, guess) * 60_000;
}

/** YYYY-MM-DD plus `n` calendar days. */
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** "+1000" / "-0330" — the offset suffix format FoxESS puts on sample times. */
export function offsetSuffix(offsetMins: number): string {
  const m = Math.abs(offsetMins);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${offsetMins < 0 ? "-" : "+"}${pad(Math.floor(m / 60))}${pad(m % 60)}`;
}
