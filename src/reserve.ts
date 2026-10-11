/**
 * House reserve calculation. See SPEC.md "PLAN".
 *
 * reserve_kwh = forecast house load from `nowSlot` until the free window x safetyFactor
 * reserve_pct = ceil(reserve_kwh / batteryKwh * 100) + floor, clamped minSocPct..100
 *
 * `floor` is the FoxESS minSocOnGrid (the battery's BMS minimum, minSocPct,
 * unless the owner raised it). The house's energy sits ON TOP of it: the inverter won't discharge
 * below the floor, so a reserve AT the floor would leave the house on paid
 * grid until the free window (owner, 2026-09-27: never pull from grid because the
 * battery hit its minimum).
 *
 * Forecast per half-hour slot = mean of `samples` rows for that slot; the
 * caller passes rows already filtered to the days it wants averaged (e.g.
 * last 5 weekdays). Slots with no samples fall back to a flat 1.0 kW
 * (0.5 kWh/slot), which also covers the no-history bootstrap.
 */

import { BOOTSTRAP_SLOT_KWH } from "./constants";

export function reservePct(opts: {
  nowSlot: number; // half-hour slot index 0..47, local time
  windowStartSlot: number; // half-hour slot of the free-window start
  samples: { slot: number; loadKwh: number }[];
  safetyFactor: number;
  batteryKwh: number;
  minSocPct: number; // battery BMS minimum
  floorPct?: number; // FoxESS minSocOnGrid; default / below-minimum -> minSocPct
}): number {
  const { nowSlot, windowStartSlot, samples, safetyFactor, batteryKwh, minSocPct } = opts;
  const floor = Math.max(minSocPct, opts.floorPct ?? minSocPct);

  const bySlot = new Map<number, { sum: number; n: number }>();
  for (const s of samples) {
    const agg = bySlot.get(s.slot) ?? { sum: 0, n: 0 };
    agg.sum += s.loadKwh;
    agg.n += 1;
    bySlot.set(s.slot, agg);
  }

  // Slots from nowSlot up to (not including) the window start, wrapping past
  // midnight so an evening dump's horizon of "until the window tomorrow" also
  // works. At exactly the window start the horizon is empty and the reserve is the floor.
  const nSlots = (windowStartSlot - nowSlot + 48) % 48;
  let forecastKwh = 0;
  for (let i = 0; i < nSlots; i++) {
    const agg = bySlot.get((nowSlot + i) % 48);
    forecastKwh += agg ? agg.sum / agg.n : BOOTSTRAP_SLOT_KWH;
  }

  const pct = Math.ceil(((forecastKwh * safetyFactor) / batteryKwh) * 100) + floor;
  return Math.min(100, Math.max(minSocPct, pct));
}

/** Forecast house kWh for each half-hour slot 0..windowStartSlot-1 (same
 *  mean / bootstrap rule as reservePct). Stored at PLAN so every later tick
 *  can re-derive the reserve without re-reading load history. */
export function morningSlotKwh(samples: { slot: number; loadKwh: number }[], windowStartSlot: number): number[] {
  const bySlot = new Map<number, { sum: number; n: number }>();
  for (const s of samples) {
    const agg = bySlot.get(s.slot) ?? { sum: 0, n: 0 };
    agg.sum += s.loadKwh;
    agg.n += 1;
    bySlot.set(s.slot, agg);
  }
  return Array.from({ length: windowStartSlot }, (_, k) => {
    const agg = bySlot.get(k);
    return agg ? agg.sum / agg.n : BOOTSTRAP_SLOT_KWH;
  });
}

/**
 * Reserve at `nowMins`: floor + what the house still needs until the window.
 * It DECAYS through the morning as that need is used up (owner, 2026-09-29:
 * at 10:45 the house needs 15 min of load, not the 05:30 figure), reaching
 * the floor at the window start. The current slot is pro-rated, so at a slot boundary
 * this equals reservePct().
 */
export function reserveAt(opts: {
  nowMins: number;
  slotKwh: number[]; // from morningSlotKwh
  safetyFactor: number;
  batteryKwh: number;
  minSocPct: number;
  floorPct: number;
}): number {
  const { nowMins, slotKwh, safetyFactor, batteryKwh, minSocPct } = opts;
  const floor = Math.max(minSocPct, opts.floorPct);
  const slot = Math.floor(nowMins / 30);
  let kwh = 0;
  for (let k = slot; k < slotKwh.length; k++) {
    kwh += (slotKwh[k] ?? BOOTSTRAP_SLOT_KWH) * (k === slot ? (30 - (nowMins % 30)) / 30 : 1);
  }
  const pct = Math.ceil(((kwh * safetyFactor) / batteryKwh) * 100) + floor;
  return Math.min(100, Math.max(minSocPct, pct));
}
