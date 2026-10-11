/**
 * Tessie charge history → local half-hour slots to exclude from
 * load_samples (loadsPower includes the EV charger; see SPEC "Nightly job").
 * Pure functions — keep them exhaustively testable.
 */

import { addDays, localMidnightMs, localSlot, type Site } from "./site";

const SLOT_MS = 30 * 60 * 1000;

export interface Charge {
  startedAtMs: number;
  endedAtMs: number | null; // null = still charging
  lat: number | null; // null = location unknown
  lon: number | null;
}

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const a =
    Math.sin(r(lat2 - lat1) / 2) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

/**
 * Slots of `date` (YYYY-MM-DD local) that overlap a home charging session.
 * A charge with unknown location counts as home: wrongly excluding a slot
 * only pushes the forecast toward its conservative 1.0 kW bootstrap, while
 * wrongly keeping one bakes ~10 kW of charger into the house forecast.
 */
export function excludedSlots(
  charges: Charge[],
  home: { lat: number; lon: number },
  date: string,
  nowMs: number,
  site: Pick<Site, "timeZone" | "homeRadiusM">,
): Set<number> {
  const dayStart = localMidnightMs(site, date);
  const dayEnd = localMidnightMs(site, addDays(date, 1)); // 23/24/25 h (DST)
  const out = new Set<number>();
  for (const c of charges) {
    if (
      c.lat !== null &&
      c.lon !== null &&
      haversineM(c.lat, c.lon, home.lat, home.lon) > site.homeRadiusM
    ) {
      continue; // away charge: no effect on house loadsPower
    }
    const end = c.endedAtMs ?? nowMs;
    // Step real half hours and label each by its wall-clock slot, matching
    // how FoxESS samples are bucketed (by their local time string).
    for (let t = dayStart; t < dayEnd; t += SLOT_MS) {
      if (c.startedAtMs < t + SLOT_MS && end > t) out.add(localSlot(site, t));
    }
  }
  return out;
}

/**
 * Fallback for car APIs with no charge history (TeslaFi): exclude every
 * slot whose load averages at least the car's minimum draw
 * (minAmps x wPerAmp), plus its neighbours, which catch the partial slots
 * where a charge started or ended. A house alone rarely sustains that for
 * half an hour. Same stance as excludedSlots (over-exclude rather than bake
 * the charger into the forecast); a charge shorter than a slot, or a real
 * house load this big, is the accepted error.
 */
export function spikeSlots(
  rows: { slot: number; loadKwh: number }[],
  site: Pick<Site, "minAmps" | "wPerAmp">,
): Set<number> {
  const thresholdKwh = (site.minAmps * site.wPerAmp) / 1000 / 2; // per half hour
  const out = new Set<number>();
  for (const r of rows) {
    if (r.loadKwh >= thresholdKwh) {
      out.add(r.slot - 1).add(r.slot).add(r.slot + 1);
    }
  }
  out.delete(-1);
  return out; // a slot past the day's end is harmless: no row carries it
}
