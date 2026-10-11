import { describe, expect, it } from "vitest";
import { excludedSlots, haversineM, spikeSlots } from "./charges";
import { TEST_SITE } from "./testing";

// Arbitrary test coordinates (a city centre) — the real geofence lives in D1 config.
const HOME = { lat: -27.47, lon: 153.03 };
const bris = (s: string) => Date.parse(`${s}+10:00`);

describe("excludedSlots", () => {
  it("marks the slots a home charge overlaps", () => {
    const charges = [
      { startedAtMs: bris("2026-07-01T09:00:00"), endedAtMs: bris("2026-07-01T10:00:00"), ...HOME_XY },
    ];
    expect([...excludedSlots(charges, HOME, "2026-07-01", 0, TEST_SITE)].sort()).toEqual([18, 19]);
  });

  it("partial-slot overlap still excludes the slot", () => {
    const charges = [
      { startedAtMs: bris("2026-07-01T09:15:00"), endedAtMs: bris("2026-07-01T09:20:00"), ...HOME_XY },
    ];
    expect([...excludedSlots(charges, HOME, "2026-07-01", 0, TEST_SITE)]).toEqual([18]);
  });

  it("handles a charge spanning midnight from the previous day", () => {
    const charges = [
      { startedAtMs: bris("2026-06-30T23:30:00"), endedAtMs: bris("2026-07-01T00:45:00"), ...HOME_XY },
    ];
    expect([...excludedSlots(charges, HOME, "2026-07-01", 0, TEST_SITE)].sort()).toEqual([0, 1]);
  });

  it("ignores charges away from home", () => {
    const supercharger = { lat: -27.57, lon: 153.03 }; // ~11 km away
    const charges = [
      {
        startedAtMs: bris("2026-07-01T09:00:00"),
        endedAtMs: bris("2026-07-01T10:00:00"),
        lat: supercharger.lat,
        lon: supercharger.lon,
      },
    ];
    expect(excludedSlots(charges, HOME, "2026-07-01", 0, TEST_SITE).size).toBe(0);
  });

  it("treats unknown location as home (conservative)", () => {
    const charges = [
      { startedAtMs: bris("2026-07-01T09:00:00"), endedAtMs: bris("2026-07-01T09:31:00"), lat: null, lon: null },
    ];
    expect([...excludedSlots(charges, HOME, "2026-07-01", 0, TEST_SITE)].sort()).toEqual([18, 19]);
  });

  it("clamps a still-running charge (null end) to now", () => {
    const charges = [{ startedAtMs: bris("2026-07-01T08:00:00"), endedAtMs: null, ...HOME_XY }];
    const now = bris("2026-07-01T09:10:00");
    expect([...excludedSlots(charges, HOME, "2026-07-01", now, TEST_SITE)].sort()).toEqual([16, 17, 18]);
  });

  it("charge entirely on another day excludes nothing", () => {
    const charges = [
      { startedAtMs: bris("2026-06-30T09:00:00"), endedAtMs: bris("2026-06-30T10:00:00"), ...HOME_XY },
    ];
    expect(excludedSlots(charges, HOME, "2026-07-01", 0, TEST_SITE).size).toBe(0);
  });
});

const HOME_XY = { lat: HOME.lat, lon: HOME.lon };

describe("excludedSlots across DST (Australia/Sydney)", () => {
  const SYD_SITE = { ...TEST_SITE, timeZone: "Australia/Sydney" };

  it("uses wall-clock slots after DST starts (11:00 AEDT = slot 22)", () => {
    // 2026-10-04 is the 23-h day: 02:00 AEST jumps to 03:00 AEDT.
    const charges = [
      {
        startedAtMs: Date.parse("2026-10-04T11:00:00+11:00"),
        endedAtMs: Date.parse("2026-10-04T12:00:00+11:00"),
        ...HOME_XY,
      },
    ];
    expect([...excludedSlots(charges, HOME, "2026-10-04", 0, SYD_SITE)].sort()).toEqual([22, 23]);
  });

  it("covers the late-evening slots of the 25-h day DST ends on", () => {
    const charges = [
      {
        startedAtMs: Date.parse("2026-04-05T23:00:00+10:00"),
        endedAtMs: Date.parse("2026-04-06T01:00:00+10:00"),
        ...HOME_XY,
      },
    ];
    expect([...excludedSlots(charges, HOME, "2026-04-05", 0, SYD_SITE)].sort()).toEqual([46, 47]);
  });
});

describe("haversineM", () => {
  it("zero distance to itself, ~111 km per degree of latitude", () => {
    expect(haversineM(HOME.lat, HOME.lon, HOME.lat, HOME.lon)).toBe(0);
    expect(haversineM(0, 0, 1, 0)).toBeGreaterThan(110_000);
    expect(haversineM(0, 0, 1, 0)).toBeLessThan(112_000);
  });
});

describe("spikeSlots", () => {
  // TEST_SITE: 5 A x 690 W = 3.45 kW minimum draw -> 1.725 kWh per half hour.
  it("excludes car-sized slots and their neighbours", () => {
    const rows = [
      { slot: 10, loadKwh: 0.4 },
      { slot: 11, loadKwh: 0.9 }, // partial slot as a charge starts
      { slot: 12, loadKwh: 5.8 },
      { slot: 13, loadKwh: 5.8 },
      { slot: 14, loadKwh: 1.2 }, // partial slot as it ends
      { slot: 15, loadKwh: 0.4 },
    ];
    expect([...spikeSlots(rows, TEST_SITE)].sort((a, b) => a - b)).toEqual([11, 12, 13, 14]);
  });

  it("keeps ordinary house load", () => {
    const rows = Array.from({ length: 48 }, (_, slot) => ({ slot, loadKwh: 1.7 }));
    expect(spikeSlots(rows, TEST_SITE).size).toBe(0);
  });

  it("threshold is inclusive and slot 0 has no negative neighbour", () => {
    expect([...spikeSlots([{ slot: 0, loadKwh: 1.725 }], TEST_SITE)].sort()).toEqual([0, 1]);
  });
});
