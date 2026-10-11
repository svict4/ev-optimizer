import { describe, expect, it } from "vitest";
import { decide, parseGlideMode, type Action, type DecideInputs, type StoredState } from "./tick";
import { DEFAULT_SAFETY_FACTOR, DEFAULT_STRANDED_MIN_PCT } from "./constants";
import { TEST_SITE } from "./testing";
import { siteFromEnv } from "./site";

/** 06:00 local, car plugged in at home below limit, battery above reserve,
 *  no sun, fresh day (stored = null -> PLAN runs). */
function base(): DecideInputs {
  return {
    date: "2026-07-06",
    nowMins: 6 * 60,
    site: TEST_SITE,
    car: { pluggedIn: true, chargingState: "Stopped", socPct: 50, limitPct: 80, chargeAmps: 16, atHome: true },
    house: { socPct: 44, loadW: 400, gridImportW: 0, pvW: 0, feedinW: 0 },
    cfg: { safetyFactor: DEFAULT_SAFETY_FACTOR, strandedMinPct: DEFAULT_STRANDED_MIN_PCT, solarTrack: true, glideMode: "asap", solarSoak: true, soakExport: true, shadowMode: false },
    samples: [],
    floorPct: 10,
    stored: null,
  };
}

/** Stored state as a fresh PLAN would create it, with overrides. */
function stored(over: Partial<StoredState> = {}): StoredState {
  return {
    date: "2026-07-06",
    state: "IDLE",
    reservePct: 17,
    floorPct: 10,
    slotKwh: null, // legacy fixed reserve unless a test opts into decay
    sessionOwner: null,
    startPending: -1,
    startBlocked: false,
    lastAmps: null,
    surplusStreak: 0,
    solarResumes: 0,
    manualNoted: false,
    solarVarsAlerted: false,
    highImportTicks: 0,
    ampHold: 0,
    ampsPending: false,
    soakStarts: 0,
    soakHold: 0,
    soakLowTicks: 0,
    gridDown: null,
    ...over,
  };
}

const kinds = (a: Action[]) => a.map((x) => x.kind);

/** The TEST_SITE vars as strings, for per-test overrides. */
const wranglerVars = () => ({
  TIME_ZONE: "Australia/Brisbane",
  FREE_WINDOW_START: "11:00",
  FREE_WINDOW_END: "14:00",
  DAY_START: "05:30",
  SOLAR_SOAK_END: "17:30",
  BATTERY_KWH: "42",
  BATTERY_MIN_SOC: "10",
  CHARGER_VOLTS: "230",
  CHARGER_PHASES: "3",
  CHARGER_MIN_AMPS: "5",
  CHARGER_MAX_AMPS: "16",
  HOME_RADIUS_M: "150",
  INVERTER_MAX_W: "15000",
});

describe("PLAN (first tick of day)", () => {
  it("computes bootstrap reserve with no samples (06:00 -> 10 slots x 0.5 kWh x 1.3)", () => {
    const { next } = decide(base());
    // 5.0 kWh x 1.3 / 42 = 15.5% -> ceil 16 + 10 = 26
    expect(next.reservePct).toBe(26);
  });

  it("computes data-driven reserve from samples", () => {
    const i = base();
    for (let slot = 12; slot < 22; slot++) i.samples.push({ slot, loadKwh: 0.2 });
    const { next } = decide(i);
    // 2.0 x 1.3 / 42 = 6.2% -> ceil 7 + 10 = 17
    expect(next.reservePct).toBe(17);
  });

  it("re-plans when the stored state is from yesterday", () => {
    const i = base();
    i.stored = stored({ date: "2026-07-05", state: "DONE", solarResumes: 4 });
    const { next } = decide(i);
    expect(next.date).toBe("2026-07-06");
    expect(next.solarResumes).toBe(0);
  });

  it("reserves the house's energy ON TOP of an owner-raised minSocOnGrid", () => {
    const i = base();
    i.floorPct = 35; // owner raised it in the FoxESS app; house needs 16% until 11:00
    const { next } = decide(i);
    expect(next.reservePct).toBe(51); // 35 + 16: the house never runs on grid at the floor
  });

  it("keeps the forecast reserve when the floor is at the 10% BMS minimum", () => {
    const i = base();
    i.floorPct = 10; // manufacturer minimum, below the 26% forecast
    const { next } = decide(i);
    expect(next.reservePct).toBe(26);
  });

  it("assumes the 10% BMS minimum when the floor read failed (null)", () => {
    const i = base();
    i.floorPct = null;
    const { next } = decide(i);
    expect(next.reservePct).toBe(26);
  });
});

describe("DUMPING", () => {
  it("enters from IDLE and starts at 16 A in the same tick", () => {
    const i = base();
    i.stored = stored();
    const { actions, next } = decide(i);
    expect(next.state).toBe("DUMPING");
    expect(actions).toContainEqual({ kind: "start_charging", amps: 16 });
    expect(next.sessionOwner).toBe("system");
    expect(next.startPending).toBe(0);
  });

  it("does not resend start while confirmation is pending", () => {
    const i = base();
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", startPending: 0, lastAmps: 16 });
    const { actions } = decide(i);
    expect(kinds(actions)).not.toContain("start_charging");
  });

  it("alerts and blocks after 2 unconfirmed ticks (invariant 4)", () => {
    const i = base();
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", startPending: 1, lastAmps: 16 });
    const { actions, next } = decide(i);
    expect(kinds(actions)).toContain("notify");
    expect(next.startBlocked).toBe(true);
    expect(next.sessionOwner).toBeNull();
    // and stays blocked: no new start attempt this tick or the next
    expect(kinds(actions)).not.toContain("start_charging");
    const again = decide({ ...i, stored: next });
    expect(kinds(again.actions)).not.toContain("start_charging");
  });

  it("confirms the start when the car reports Charging", () => {
    const i = base();
    i.car.chargingState = "Charging";
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", startPending: 0, lastAmps: 16 });
    const { next } = decide(i);
    expect(next.startPending).toBe(-1);
    expect(next.sessionOwner).toBe("system");
  });

  it("derates by the import (battery limiting), then holds before probing back up", () => {
    const i = base();
    i.car.chargingState = "Charging";
    i.house.gridImportW = 3400; // BMS limiting the battery to ~8 kW under an 11 kW car
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", lastAmps: 16 });
    const { actions, next } = decide(i);
    // floor((-3400 - 250) / 690) = -6 -> 10 A, biased past the import
    expect(actions).toContainEqual({ kind: "set_amps", amps: 10 });
    expect(next.lastAmps).toBe(10);
    expect(next.ampHold).toBe(3);
    // import gone: no probe for two more ticks (15 min from the derate), then 2 A per tick
    let st = next;
    for (const expectAmps of [null, null, 12, 14]) {
      const t = base();
      t.car.chargingState = "Charging";
      t.car.chargeAmps = st.lastAmps;
      t.stored = st;
      const r = decide(t);
      if (expectAmps === null) expect(kinds(r.actions)).not.toContain("set_amps");
      else expect(r.actions).toContainEqual({ kind: "set_amps", amps: expectAmps });
      st = r.next;
    }
  });

  it("a small import (noise) derates 2 A, as before", () => {
    const i = base();
    i.car.chargingState = "Charging";
    i.house.gridImportW = 600;
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", lastAmps: 16 });
    expect(decide(i).actions).toContainEqual({ kind: "set_amps", amps: 14 });
  });

  it("recovers 2 A when headroom returns, and never exceeds 16", () => {
    const i = base();
    i.car.chargingState = "Charging";
    i.house.gridImportW = 0;
    i.car.chargeAmps = 14;
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", lastAmps: 14 });
    expect(decide(i).actions).toContainEqual({ kind: "set_amps", amps: 16 });
    i.car.chargeAmps = 16;
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", lastAmps: 16 });
    expect(kinds(decide(i).actions)).not.toContain("set_amps"); // no-op dedupe
    // import between recover and tolerance: hold, neither direction
    i.house.gridImportW = 200;
    i.car.chargeAmps = 14;
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", lastAmps: 14 });
    expect(kinds(decide(i).actions)).not.toContain("set_amps");
  });

  it("opens at what the inverter can deliver after house load (INVERTER_MAX_W)", () => {
    // 6 kW single-stack inverter, 11 kW charger: floor((6000 - 400 - 250) / 690) = 7 A,
    // not 16 A and 7 kW of paid import until a 2 A/tick derate caught up.
    const small = siteFromEnv({ ...wranglerVars(), INVERTER_MAX_W: "6000" });
    const i = base();
    i.site = small;
    i.stored = stored();
    expect(decide(i).actions).toContainEqual({ kind: "start_charging", amps: 7 });
    // and holds there: 7 A x 690 + 400 house = 5230 W, 770 W under the cap
    const run = base();
    run.site = small;
    run.car.chargingState = "Charging";
    run.house.loadW = 5230;
    run.car.chargeAmps = 7;
    run.stored = stored({ state: "DUMPING", sessionOwner: "system", lastAmps: 7 });
    expect(kinds(decide(run).actions)).not.toContain("set_amps");
  });

  it("takes export on top of the inverter cap while dumping (PV already in the output)", () => {
    const i = base();
    i.car.chargingState = "Charging";
    i.house = { socPct: 44, loadW: 7300, gridImportW: 0, pvW: 3000, feedinW: 1500 }; // 10 A + house
    i.car.chargeAmps = 10;
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", lastAmps: 10 });
    expect(decide(i).actions).toContainEqual({ kind: "set_amps", amps: 12 }); // AMP_STEP-capped
  });

  it("runs without pv/feedin (meter only)", () => {
    const i = base();
    i.car.chargingState = "Charging";
    i.house = { socPct: 44, loadW: 11440, gridImportW: 0, pvW: null, feedinW: null };
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", lastAmps: 16 });
    expect(decide(i).actions).toHaveLength(0);
  });

  it("exits to GLIDE at the SoC floor and acts the same tick (spec example)", () => {
    // 16 A car + 400 W house on 6 kW PV: the floor-hit shortfall is paid
    // import, and at reserve PV doesn't cover the load -> reserve_hit now.
    const i = base();
    i.car.chargingState = "Charging";
    i.house = { socPct: 17, loadW: 11440, gridImportW: 5440, pvW: 6000, feedinW: 0 };
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", lastAmps: 16 });
    const { actions, next } = decide(i);
    expect(next.state).toBe("GLIDE");
    expect(actions).toContainEqual({ kind: "stop_charging", reason: "reserve_hit" });
  });

  it("8 kW floor hit above the planned reserve: learns the floor and stops the same tick", () => {
    const i = base();
    i.car.chargingState = "Charging";
    i.house = { socPct: 30, loadW: 11440, gridImportW: 11440, pvW: 0, feedinW: 0 };
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", lastAmps: 16, reservePct: 17 });
    const { actions, next } = decide(i);
    expect(next.reservePct).toBe(30);
    expect(actions).toContainEqual({ kind: "stop_charging", reason: "reserve_hit" });
  });

  it("exits to GLIDE on the 8 kW import backstop even above the SoC floor", () => {
    const i = base();
    i.car.chargingState = "Charging";
    i.house = { socPct: 30, loadW: 400, gridImportW: 9000, pvW: 0, feedinW: 0 };
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", lastAmps: 16 });
    expect(decide(i).next.state).toBe("GLIDE");
  });
});

describe("GLIDE", () => {
  // pvW default covers the load: at/below reserve a charge may only run on
  // PV surplus (reserve_hit stop otherwise), so the meter-loop tests need sun.
  const solar = (over: Partial<DecideInputs["house"]>, st: Partial<StoredState> = {}): DecideInputs => {
    const i = base();
    i.house = { socPct: 17, loadW: 400, gridImportW: 0, pvW: 6000, feedinW: 0, ...over };
    i.stored = stored({ state: "GLIDE", ...st });
    i.car.chargeAmps = st.lastAmps ?? 16; // the car reports what we last commanded
    return i;
  };

  it("steps amps up with export headroom", () => {
    // loadsPower includes the car: 400 W house + 7 A x 690 W
    const i = solar({ loadW: 5230, pvW: 6730, feedinW: 1500 }, { sessionOwner: "system", lastAmps: 7 });
    i.car.chargingState = "Charging";
    // 7 + floor((1500-0-250)/690) = 7 + 1 = 8
    expect(decide(i).actions).toContainEqual({ kind: "set_amps", amps: 8 });
  });

  it("holds amps inside the export margin (no-op dedupe)", () => {
    const i = solar({ loadW: 5920, pvW: 6220, feedinW: 300 }, { sessionOwner: "system", lastAmps: 8 });
    i.car.chargingState = "Charging";
    expect(kinds(decide(i).actions)).not.toContain("set_amps");
  });

  it("stops when clamped at 5 A and still importing", () => {
    // above reserve (so not reserve_hit): the battery can't be what's short
    const i = solar({ socPct: 18, loadW: 3850, pvW: 3450, gridImportW: 400 }, { sessionOwner: "system", lastAmps: 5 });
    i.car.chargingState = "Charging";
    const { actions, next } = decide(i);
    expect(actions).toContainEqual({ kind: "stop_charging", reason: "below_solar_min" });
    expect(next.sessionOwner).toBeNull();
  });

  it("steps down to 5 A first when arriving from higher amps", () => {
    const i = solar({ socPct: 18, loadW: 5920, pvW: 2920, gridImportW: 3000 }, { sessionOwner: "system", lastAmps: 8 });
    i.car.chargingState = "Charging";
    const { actions } = decide(i);
    expect(actions).toContainEqual({ kind: "set_amps", amps: 5 });
    expect(kinds(actions)).not.toContain("stop_charging");
  });

  it("stops immediately at reserve when PV doesn't cover the load (2026-07-08 floor-drain)", () => {
    // replay of the 06:20 tick: SoC 15 ≤ reserve, no sun, battery feeding the
    // car at ~11 kW while the meter reads ~0 — the amp loop can't see it.
    const i = solar(
      { socPct: 15, loadW: 11913, gridImportW: 19, pvW: 0 },
      { sessionOwner: "system", lastAmps: 16, reservePct: 16 },
    );
    i.car.chargingState = "Charging";
    const { actions, next } = decide(i);
    expect(actions).toContainEqual({ kind: "stop_charging", reason: "reserve_hit" });
    expect(kinds(actions)).not.toContain("set_amps");
    expect(next.sessionOwner).toBeNull();
  });

  it("DUMPING reserve-hit with no sun stops the same tick instead of amp-tracking", () => {
    const i = base();
    i.car.chargingState = "Charging";
    i.house = { socPct: 15, loadW: 11913, gridImportW: 19, pvW: 0, feedinW: 0 };
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", lastAmps: 16, reservePct: 16 });
    const { actions, next } = decide(i);
    expect(next.state).toBe("GLIDE");
    expect(actions).toContainEqual({ kind: "stop_charging", reason: "reserve_hit" });
  });

  it("keeps charging at reserve while PV covers the whole load", () => {
    const i = solar({ socPct: 17, loadW: 4000, pvW: 6000, feedinW: 300 }, { sessionOwner: "system", lastAmps: 5 });
    i.car.chargingState = "Charging";
    expect(kinds(decide(i).actions)).not.toContain("stop_charging");
  });

  it("resumes only after 3 consecutive surplus ticks, at the amps the sun supports", () => {
    let st = stored({ state: "GLIDE" });
    for (const expectStart of [false, false, true]) {
      const i = solar({ pvW: 5200 }, st);
      const { actions, next } = decide(i);
      expect(kinds(actions).includes("start_charging")).toBe(expectStart);
      st = next;
    }
    expect(st.solarResumes).toBe(1);
    expect(st.lastAmps).toBe(6); // floor((5200 - 400 - 250) / 690)
  });

  it("a cloudy tick resets the resume streak", () => {
    const i = solar({ pvW: 2000 }, { surplusStreak: 2 });
    expect(decide(i).next.surplusStreak).toBe(0);
  });

  it("enforces the daily resume cap", () => {
    const i = solar({ pvW: 8000 }, { surplusStreak: 2, solarResumes: 4 });
    expect(kinds(decide(i).actions)).not.toContain("start_charging");
  });

  it("solar_track=false never resumes (floor-hold behaviour)", () => {
    const i = solar({ pvW: 8000 }, { surplusStreak: 2 });
    i.cfg.solarTrack = false;
    const { actions, next } = decide(i);
    expect(actions).toHaveLength(0);
    expect(next.surplusStreak).toBe(0);
  });

  it("missing pv/feedin: alert once, stop the charge, degrade to floor-hold", () => {
    const i = solar({ pvW: null, feedinW: null }, { sessionOwner: "system", lastAmps: 7 });
    i.car.chargingState = "Charging";
    const first = decide(i);
    expect(kinds(first.actions)).toContain("notify");
    expect(kinds(first.actions)).toContain("stop_charging");
    const i2 = solar({ pvW: null, feedinW: null }, first.next);
    expect(decide(i2).actions).toHaveLength(0); // alert not repeated
  });

  it("sustained import (failed amp commands) stops after 3 ticks", () => {
    let st = stored({ state: "GLIDE", sessionOwner: "system", lastAmps: 5, highImportTicks: 0 });
    let stopped = false;
    for (let t = 0; t < 3; t++) {
      const i = solar({ gridImportW: 2500, feedinW: 0 }, st);
      i.car.chargingState = "Charging";
      const r = decide(i);
      stopped = kinds(r.actions).includes("stop_charging");
      st = r.next;
      if (stopped) break;
    }
    expect(stopped).toBe(true);
  });

  it("follows PV the battery is absorbing (meter reads 0 at the floor)", () => {
    // 5 A car + 400 W house = 3850 W load on 6 kW PV, no export: Self-Use
    // puts the spare ~2.1 kW into the battery, invisible to the meter.
    const i = solar({ loadW: 3850, pvW: 6000, feedinW: 0 }, { sessionOwner: "system", lastAmps: 5 });
    i.car.chargingState = "Charging";
    // 5 + floor((2150 - 250)/690) = 5 + 2 = 7
    expect(decide(i).actions).toContainEqual({ kind: "set_amps", amps: 7 });
  });

  it("battery discharging above reserve: no phantom surplus, stays at 5 A", () => {
    const i = solar({ socPct: 20, loadW: 3850, pvW: 1500, feedinW: 0 }, { sessionOwner: "system", lastAmps: 5 });
    i.car.chargingState = "Charging";
    expect(decide(i).actions).toHaveLength(0);
  });

  it("solar bank: resumes at 5 A once banked PV + surplus carry 20 min of the minimum", () => {
    // 2 kW surplus -> 1.45 kW deficit x 20 min = 483 Wh; 1% = 420 Wh, 2% = 840 Wh
    expect(kinds(decide(solar({ socPct: 18, pvW: 2400 })).actions)).not.toContain("start_charging");
    const { actions, next } = decide(solar({ socPct: 19, pvW: 2400 }));
    expect(actions).toContainEqual({ kind: "start_charging", amps: 5 });
    expect(next.solarResumes).toBe(1);
    expect(next.state).toBe("GLIDE"); // not a 16 A DUMPING burst
  });

  it("solar bank with no sun needs car min + house for 20 min (1.28 kWh -> 4%)", () => {
    expect(kinds(decide(solar({ socPct: 20, pvW: 0 })).actions)).not.toContain("start_charging");
    expect(kinds(decide(solar({ socPct: 21, pvW: 0 })).actions)).toContain("start_charging");
  });

  it("solar bank never fires at or below reserve, and respects the resume cap and solar_track", () => {
    expect(decide(solar({ socPct: 17, pvW: 3000 })).actions).toHaveLength(0);
    expect(decide(solar({ socPct: 20, pvW: 3000 }, { solarResumes: 4 })).actions).toHaveLength(0);
    const off = solar({ socPct: 20, pvW: 3000 });
    off.cfg.solarTrack = false;
    expect(decide(off).actions).toHaveLength(0);
  });

  it("hardware floor above the stored reserve: an import stop is not followed by a bank restart (review fix)", () => {
    // PLAN floor read failed -> forecast reserve 27, but the owner's floor is
    // 30: at 30% the inverter won't discharge and the 5 A car imports.
    const i = solar(
      { socPct: 30, loadW: 3850, pvW: 1000, gridImportW: 2850 },
      { sessionOwner: "system", lastAmps: 5, reservePct: 27 },
    );
    i.car.chargingState = "Charging";
    const stop = decide(i);
    expect(stop.actions).toContainEqual({ kind: "stop_charging", reason: "below_solar_min" });
    expect(stop.next.reservePct).toBe(30); // learned: the battery won't go lower today
    // next tick, car off, house covered: 3% "above reserve" no longer counts as a bank
    const after = solar({ socPct: 30, loadW: 400, pvW: 1000 }, stop.next);
    const r = decide(after);
    expect(kinds(r.actions)).not.toContain("start_charging");
    expect(r.next.solarResumes).toBe(0);
  });

  it("the learned reserve only ever rises", () => {
    const i = solar(
      { socPct: 18, loadW: 3850, pvW: 3450, gridImportW: 400 },
      { sessionOwner: "system", lastAmps: 5, reservePct: 25 },
    );
    i.car.chargingState = "Charging";
    expect(decide(i).next.reservePct).toBe(25);
  });

  it("importing with a positive glide budget never steps up (stale bank / battery at its floor)", () => {
    // SoC 25 says 8% banked (spend ~1.1 kW at 06:00), but the meter shows
    // 1 kW of import: the battery is not discharging here. The old formula
    // added the budget and stepped UP onto paid grid.
    const i = solar({ socPct: 25, loadW: 5920, pvW: 4920, gridImportW: 1000, feedinW: 0 }, { sessionOwner: "system", lastAmps: 8 });
    i.car.chargingState = "Charging";
    expect(decide(i).actions).toEqual([{ kind: "set_amps", amps: 6 }]); // floor((-1000-250)/690) = -2
  });

  it("the inverter cap bounds the glide too", () => {
    const small = siteFromEnv({ ...wranglerVars(), INVERTER_MAX_W: "6000" });
    // 10:30, SoC 25 vs reserve 17: 3360 Wh over 35 min = 5.8 kW budget, but
    // 5 A + house already loads the inverter to 3850 W: room 2150 -> +2 A
    const i = solar({ loadW: 3850, pvW: 0, socPct: 25 }, { sessionOwner: "system", lastAmps: 5 });
    i.site = small;
    i.nowMins = 10 * 60 + 30;
    i.car.chargingState = "Charging";
    expect(decide(i).actions).toEqual([{ kind: "set_amps", amps: 7 }]);
  });

  it("a state row persisted as SOLAR_TRACK (pre-rename) keeps acting as GLIDE", () => {
    const i = solar({ socPct: 19, pvW: 2400 }, { state: "SOLAR_TRACK" as unknown as StoredState["state"] });
    const { actions, next } = decide(i);
    expect(next.state).toBe("GLIDE");
    expect(actions).toContainEqual({ kind: "start_charging", amps: 5 });
  });

  it("PV refill well above reserve glides instead of a 16 A DUMPING burst", () => {
    const i = solar({ socPct: 23, pvW: 1000 }); // reserve 17
    const { actions, next } = decide(i);
    expect(next.state).toBe("GLIDE");
    // 06:00: bank 6% = 2520 Wh over (300 + 5) min = 496 W; 1000 - 400 + 496 - 250 = 846 W -> 5 A
    expect(actions).toEqual([{ kind: "start_charging", amps: 5 }]);
  });
});

describe("decaying reserve + glide to 11:00 (2026-09-29)", () => {
  // flat 0.2 kWh/half-hour house (0.4 kW), 10% floor
  const FLAT = Array.from({ length: 22 }, () => 0.2);
  const glide = (nowMins: number, house: Partial<DecideInputs["house"]>, st: Partial<StoredState> = {}) => {
    const i = base();
    i.nowMins = nowMins;
    i.house = { socPct: 14, loadW: 400, gridImportW: 0, pvW: 1000, feedinW: 0, ...house };
    i.stored = stored({ state: "GLIDE", slotKwh: FLAT, ...st });
    i.car.chargeAmps = st.lastAmps ?? 16;
    return i;
  };

  it("PLAN stores the forecast and floor; reserve equals the old formula at a slot boundary", () => {
    const i = base(); // 06:00
    for (let slot = 12; slot < 22; slot++) i.samples.push({ slot, loadKwh: 0.2 });
    i.floorPct = 12;
    const { next } = decide(i);
    expect(next.floorPct).toBe(12);
    expect(next.slotKwh).toHaveLength(22);
    expect(next.reservePct).toBe(19); // 2.0 kWh x 1.3 / 42 -> ceil 7 + 12
  });

  it("the reserve decays through the morning to the floor at 11:00", () => {
    const at = (m: number) => decide(glide(m, { socPct: 50 })).next.reservePct;
    expect(at(6 * 60)).toBe(17); // 2.0 kWh left
    expect(at(9 * 60)).toBe(13); // 0.8 kWh left
    expect(at(10 * 60 + 45)).toBe(11); // 0.1 kWh left
  });

  it("owner's case: 10:45, battery above the decayed reserve, starts charging", () => {
    // SoC 14 vs 17 at PLAN (old: stuck) vs 11 now: 3% = 1260 Wh banked.
    // Needs (3450 - 600) x 15 min = 712 Wh to run until 11:00 -> starts.
    const { actions, next } = decide(glide(10 * 60 + 45, {}));
    expect(kinds(actions)).toEqual(["start_charging"]);
    expect(next.reservePct).toBe(11);
  });

  it("the same battery at 07:00 stays put (the house still needs it)", () => {
    const { actions, next } = decide(glide(7 * 60, {}));
    expect(next.reservePct).toBe(15); // 1.6 kWh left x 1.3 -> 5% + 10
    expect(actions).toHaveLength(0);
  });

  it("glide rate spreads the bank to 11:00: gentle early, faster late", () => {
    // charging at 5 A, battery covering the gap (meter 0, pv < load)
    const run = (m: number, soc: number) => {
      const i = glide(m, { socPct: soc, loadW: 3850, pvW: 1500 }, { sessionOwner: "system", lastAmps: 5 });
      i.car.chargingState = "Charging";
      return decide(i).actions;
    };
    // 08:00, SoC 25, reserve 14: 4620 Wh over 185 min = 1498 W allowance, but the
    // battery already covers 2350 W -> 1498 - 2350 - 250 < 0 -> stays 5 A (no ratchet)
    expect(run(8 * 60, 25)).toHaveLength(0);
    // 10:30, SoC 25, reserve 11: 5880 Wh over 35 min = 10080 W -> 10080 - 2350 - 250 = 7480 -> +10 A = 15 A
    expect(run(10 * 60 + 30, 25)).toEqual([{ kind: "set_amps", amps: 15 }]);
  });

  it("keeps the morning dump at 16 A (unchanged)", () => {
    const i = glide(6 * 60, { socPct: 44 }, { state: "IDLE" });
    const { actions, next } = decide(i);
    expect(next.state).toBe("DUMPING");
    expect(actions).toEqual([{ kind: "start_charging", amps: 16 }]);
  });

  it("learned floor lifts the whole decaying curve", () => {
    const i = glide(
      9 * 60,
      { socPct: 30, loadW: 3850, pvW: 1000, gridImportW: 2850 },
      { sessionOwner: "system", lastAmps: 5, reservePct: 13 },
    );
    i.car.chargingState = "Charging";
    const { actions, next } = decide(i);
    expect(actions).toContainEqual({ kind: "stop_charging", reason: "below_solar_min" });
    expect(next.floorPct).toBe(30);
    expect(next.reservePct).toBe(33); // 30 + house need until 11:00
  });

  it("simulated 09:00 -> 11:00: spends the bank into the car without breaching the reserve", () => {
    // Plant: house 400 W, PV 1.2 kW, battery covers the rest (Self-Use, no import
    // while SoC > 10% floor). SoC tracked in Wh; the controller sees whole %.
    let wh = 22 * 420; // 22% at 09:00
    let st = stored({ state: "GLIDE", slotKwh: FLAT });
    let carOn = false;
    let amps = 0;
    let carWh = 0;
    let minMargin = Infinity;
    for (let m = 9 * 60; m < 11 * 60; m += 5) {
      const carW = carOn ? amps * 690 : 0;
      const i = glide(m, { socPct: Math.floor(wh / 420), loadW: 400 + carW, pvW: 1200 }, st);
      i.car.chargingState = carOn ? "Charging" : "Stopped";
      i.car.chargeAmps = amps;
      const r = decide(i);
      for (const act of r.actions) {
        if (act.kind === "start_charging") [carOn, amps] = [true, act.amps];
        if (act.kind === "set_amps") amps = act.amps;
        if (act.kind === "stop_charging") carOn = false;
      }
      st = r.next;
      minMargin = Math.min(minMargin, wh / 420 - (st.reservePct - 1)); // ceil() slack: 1 point
      const drawW = 400 + (carOn ? amps * 690 : 0) - 1200;
      wh -= (drawW * 5) / 60;
      carWh += ((carOn ? amps * 690 : 0) * 5) / 60;
      expect(wh / 420).toBeGreaterThan(10); // never reaches the hardware floor -> no import
    }
    expect(minMargin).toBeGreaterThan(-1); // never meaningfully below the reserve line
    expect(wh / 420).toBeLessThan(14); // bank actually spent, not stranded at 11:00
    expect(carWh).toBeGreaterThan(4000); // ~4.6 kWh into the car over two hours
  });

  it("glide_mode continuous waits until the bank carries the car to the window", () => {
    // 10:00, reserve 12, SoC 15: 3% = 1260 Wh banked; 1 kW PV leaves a 2.85 kW
    // deficit. asap needs 20 min (950 Wh) -> starts; continuous needs 60 min
    // (2850 Wh) -> waits. At 10:45 both modes need the same 15 min run.
    const asap = glide(10 * 60, { socPct: 15 });
    expect(kinds(decide(asap).actions)).toEqual(["start_charging"]);
    const cont = glide(10 * 60, { socPct: 15 });
    cont.cfg.glideMode = "continuous";
    expect(decide(cont).actions).toHaveLength(0);
    const late = glide(10 * 60 + 45, {});
    late.cfg.glideMode = "continuous";
    expect(kinds(decide(late).actions)).toEqual(["start_charging"]);
  });

  it("glide_mode continuous: a sustained-sun restart is unaffected", () => {
    const i = glide(9 * 60, { socPct: 13, pvW: 5200 }, { surplusStreak: 2 });
    i.cfg.glideMode = "continuous";
    expect(kinds(decide(i).actions)).toEqual(["start_charging"]);
  });

  it("a legacy stored row (no forecast) keeps its fixed reserve", () => {
    const { next } = decide(glide(10 * 60 + 45, {}, { slotKwh: null, reservePct: 17 }));
    expect(next.reservePct).toBe(17);
  });
});

describe("manual override (invariant 6)", () => {
  it("marks an unexpected charge as owner, notes once, sends no commands", () => {
    const i = base();
    i.car.chargingState = "Charging";
    i.stored = stored();
    const first = decide(i);
    expect(first.next.sessionOwner).toBe("owner");
    expect(first.actions).toEqual([{ kind: "notify", message: "manual charge detected — not interfering" }]);
    expect(first.next.state).toBe("IDLE");
    const second = decide({ ...i, stored: first.next });
    expect(second.actions).toHaveLength(0); // one note per session
  });

  it("away sessions (supercharger) are owner sessions with no note", () => {
    const i = base();
    i.car.chargingState = "Charging";
    i.car.atHome = false;
    i.stored = stored();
    const { actions, next } = decide(i);
    expect(actions).toHaveLength(0);
    expect(next.sessionOwner).toBe("owner");
  });

  it("owner session ending clears ownership for the next detection", () => {
    const i = base();
    i.house.socPct = 17; // at reserve: no dump starts, isolating the clearing
    i.stored = stored({ sessionOwner: "owner", manualNoted: true });
    const { next } = decide(i);
    expect(next.sessionOwner).toBeNull();
    expect(next.manualNoted).toBe(false);
  });

  it("owner stopping their own session hands control back to the system", () => {
    const i = base(); // battery above reserve -> the system dumps again
    i.stored = stored({ sessionOwner: "owner", manualNoted: true });
    const { actions, next } = decide(i);
    expect(actions).toContainEqual({ kind: "start_charging", amps: 16 });
    expect(next.sessionOwner).toBe("system");
  });

  it("external stop of a system session stands down with one alert", () => {
    const i = base();
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", lastAmps: 16 });
    const { actions, next } = decide(i);
    expect(kinds(actions)).toContain("notify");
    expect(next.startBlocked).toBe(true);
    expect(kinds(actions)).not.toContain("start_charging");
  });

  it("Complete is a natural end: no alert, no stand-down", () => {
    const i = base();
    i.car.chargingState = "Complete";
    i.car.socPct = 80;
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", lastAmps: 16 });
    const { actions, next } = decide(i);
    expect(actions).toHaveLength(0);
    expect(next.startBlocked).toBe(false);
    expect(next.state).toBe("IDLE");
  });
});

describe("geofence (invariant 7)", () => {
  it("no commands when the car is plugged in away from home", () => {
    const i = base();
    i.car.atHome = false;
    i.stored = stored();
    const { actions, next } = decide(i);
    expect(actions).toHaveLength(0);
    expect(next.state).toBe("IDLE");
  });

  it("no commands in the free window either", () => {
    const i = base();
    i.nowMins = 12 * 60;
    i.car.atHome = false;
    i.stored = stored();
    expect(decide(i).actions).toHaveLength(0);
  });
});

describe("unplugged", () => {
  it("resets to IDLE with no actions", () => {
    const i = base();
    i.car.pluggedIn = false;
    i.car.chargingState = "Disconnected";
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", lastAmps: 16 });
    const { actions, next } = decide(i);
    expect(actions).toHaveLength(0);
    expect(next.state).toBe("IDLE");
    expect(next.sessionOwner).toBeNull();
  });
});

describe("FREE_WINDOW", () => {
  it("starts at 16 A when the car is idle at 11:00", () => {
    const i = base();
    i.nowMins = 11 * 60;
    i.stored = stored({ state: "DUMPING" });
    const { actions, next } = decide(i);
    expect(next.state).toBe("FREE_WINDOW");
    expect(actions).toContainEqual({ kind: "start_charging", amps: 16 });
  });

  it("window entry resets a morning stand-down (free power is free)", () => {
    const i = base();
    i.nowMins = 11 * 60;
    i.stored = stored({ state: "GLIDE", startBlocked: true });
    const { actions } = decide(i);
    expect(actions).toContainEqual({ kind: "start_charging", amps: 16 });
  });

  it("bumps a system session back to 16 A", () => {
    const i = base();
    i.nowMins = 12 * 60;
    i.car.chargingState = "Charging";
    i.car.chargeAmps = 7;
    i.stored = stored({ state: "FREE_WINDOW", sessionOwner: "system", lastAmps: 7 });
    expect(decide(i).actions).toContainEqual({ kind: "set_amps", amps: 16 });
  });

  it("leaves pre-window owner sessions alone (ownership is sticky)", () => {
    const i = base();
    i.nowMins = 12 * 60;
    i.car.chargingState = "Charging";
    i.car.chargeAmps = 10;
    i.stored = stored({ state: "FREE_WINDOW", sessionOwner: "owner", manualNoted: true });
    expect(decide(i).actions).toHaveLength(0);
  });

  it("adopts a native-schedule start inside the window (no owner branding, 16 A, 14:00 stop applies)", () => {
    const i = base();
    i.nowMins = 11 * 60 + 5; // native Tesla schedule fired at 11:00
    i.car.chargingState = "Charging";
    i.car.chargeAmps = 10;
    i.stored = stored({ state: "DUMPING" }); // no session claim
    const { actions, next } = decide(i);
    expect(next.sessionOwner).toBe("system");
    expect(kinds(actions)).not.toContain("notify");
    expect(actions).toContainEqual({ kind: "set_amps", amps: 16 });
    // ...and at 14:00 the adopted session is stopped like any system session
    const end = { ...i, nowMins: 14 * 60, stored: next, cfg: { ...i.cfg, solarSoak: false } };
    expect(decide(end).actions).toContainEqual({ kind: "stop_charging", reason: "window_end" });
  });

  it("does not adopt in-window charging away from home", () => {
    const i = base();
    i.nowMins = 12 * 60;
    i.car.chargingState = "Charging";
    i.car.atHome = false;
    i.stored = stored({ state: "FREE_WINDOW" });
    const { actions, next } = decide(i);
    expect(next.sessionOwner).toBe("owner");
    expect(actions).toHaveLength(0);
  });

  it("does nothing when the car is full", () => {
    const i = base();
    i.nowMins = 12 * 60;
    i.car.socPct = 80;
    i.stored = stored({ state: "FREE_WINDOW" });
    expect(decide(i).actions).toHaveLength(0);
  });
});

describe("window end (14:00)", () => {
  it("solar_soak=false: stops a system session and goes DONE", () => {
    const i = base();
    i.cfg.solarSoak = false;
    i.nowMins = 14 * 60;
    i.car.chargingState = "Charging";
    i.stored = stored({ state: "FREE_WINDOW", sessionOwner: "system", lastAmps: 16 });
    const { actions, next } = decide(i);
    expect(actions).toContainEqual({ kind: "stop_charging", reason: "window_end" });
    expect(next.state).toBe("DONE");
  });

  it("below stranded min: alerts and leaves the paid charge running", () => {
    const i = base();
    i.nowMins = 14 * 60;
    i.car.chargingState = "Charging";
    i.car.socPct = 25;
    i.stored = stored({ state: "FREE_WINDOW", sessionOwner: "system", lastAmps: 16 });
    const { actions, next } = decide(i);
    expect(kinds(actions)).toContain("notify");
    expect(kinds(actions)).not.toContain("stop_charging");
    expect(next.state).toBe("DONE");
  });

  it("never stops an owner session at window end", () => {
    const i = base();
    i.nowMins = 14 * 60;
    i.car.chargingState = "Charging";
    i.stored = stored({ state: "FREE_WINDOW", sessionOwner: "owner", manualNoted: true });
    expect(kinds(decide(i).actions)).not.toContain("stop_charging");
  });

  it("DONE stays quiet", () => {
    const i = base();
    i.nowMins = 14 * 60 + 10;
    i.stored = stored({ state: "DONE" });
    expect(decide(i).actions).toHaveLength(0);
  });
});

describe("SOLAR_SOAK (after the window)", () => {
  /** 15:00, battery full, car on a system session at `amps`; loadsPower
   *  includes the car. Inverter curtailing: pv == load, no export. */
  const soakIn = (
    amps: number,
    over: Partial<DecideInputs["house"]> = {},
    st: Partial<StoredState> = {},
  ): DecideInputs => {
    const i = base();
    i.nowMins = 15 * 60;
    i.car.chargingState = "Charging";
    i.car.chargeAmps = amps;
    const load = 400 + amps * 690;
    i.house = { socPct: 100, loadW: load, gridImportW: 0, pvW: load, feedinW: 0, ...over };
    i.stored = stored({ state: "SOLAR_SOAK", sessionOwner: "system", lastAmps: amps, ...st });
    return i;
  };

  it("14:00: throttles the free-window session to visible PV instead of stopping", () => {
    const i = base();
    i.nowMins = 14 * 60;
    i.car.chargingState = "Charging";
    // 16 A car (11040 W) + 400 W house; PV 5 kW visible -> floor((5000-400-250)/690) = 6
    i.house = { socPct: 100, loadW: 11440, gridImportW: 6440, pvW: 5000, feedinW: 0 };
    i.stored = stored({ state: "FREE_WINDOW", sessionOwner: "system", lastAmps: 16 });
    const { actions, next } = decide(i);
    expect(actions).toEqual([{ kind: "set_amps", amps: 6 }]);
    expect(next.state).toBe("SOLAR_SOAK");
    expect(next.sessionOwner).toBe("system");
  });

  it("14:00 with no visible PV throttles to 5 A (the probe climbs from there)", () => {
    const i = base();
    i.nowMins = 14 * 60;
    i.car.chargingState = "Charging";
    i.house = { socPct: 100, loadW: 11440, gridImportW: 11440, pvW: 0, feedinW: 0 };
    i.stored = stored({ state: "FREE_WINDOW", sessionOwner: "system", lastAmps: 16 });
    expect(decide(i).actions).toEqual([{ kind: "set_amps", amps: 5 }]);
  });

  it("14:00 stranded-min rule still wins: leave the charge running, DONE", () => {
    const i = base();
    i.nowMins = 14 * 60;
    i.car.chargingState = "Charging";
    i.car.socPct = 25;
    i.stored = stored({ state: "FREE_WINDOW", sessionOwner: "system", lastAmps: 16 });
    const { actions, next } = decide(i);
    expect(kinds(actions)).toEqual(["notify"]);
    expect(next.state).toBe("DONE");
  });

  it("battery full and balanced (curtailing): probes up 1 A", () => {
    expect(decide(soakIn(8)).actions).toEqual([{ kind: "set_amps", amps: 9 }]);
  });

  it("does not probe while the battery is below full, or during a hold", () => {
    expect(decide(soakIn(8, { socPct: 96 })).actions).toHaveLength(0);
    expect(decide(soakIn(8, {}, { soakHold: 2 })).actions).toHaveLength(0);
  });

  it("takes visible export in one step", () => {
    const i = soakIn(6, { pvW: 400 + 6 * 690 + 2000, feedinW: 2000 });
    // 6 + floor((2000-250)/690) = 8
    expect(decide(i).actions).toEqual([{ kind: "set_amps", amps: 8 }]);
  });

  it("battery discharging: steps down by the deficit and holds before re-probing", () => {
    const i = soakIn(10, { pvW: 400 + 10 * 690 - 1000 }); // battery covering 1 kW
    const { actions, next } = decide(i);
    expect(actions).toEqual([{ kind: "set_amps", amps: 8 }]); // ceil(1000/690) = 2
    expect(next.soakHold).toBe(3);
  });

  it("at 5 A and discharging: rides out one tick (cloud), stops on the second", () => {
    const i = soakIn(5, { pvW: 1500 });
    const first = decide(i);
    expect(first.actions).toHaveLength(0);
    expect(first.next.soakLowTicks).toBe(1);
    const second = decide({ ...i, stored: first.next });
    expect(second.actions).toEqual([{ kind: "stop_charging", reason: "soak_below_min" }]);
    expect(second.next.sessionOwner).toBeNull();
    expect(second.next.soakHold).toBe(6);
  });

  it("hard stop below the battery floor (evening export + tomorrow's dump untouched)", () => {
    const { actions } = decide(soakIn(8, { socPct: 89 }));
    expect(actions).toEqual([{ kind: "stop_charging", reason: "soak_battery_low" }]);
  });

  it("amps stay within [5,16]", () => {
    expect(decide(soakIn(16)).actions).toHaveLength(0); // probe clamped at max
    const big = soakIn(6, { pvW: 400 + 6 * 690 + 20000, feedinW: 20000 });
    expect(decide(big).actions).toEqual([{ kind: "set_amps", amps: 16 }]);
  });

  it("starts at 5 A when the battery is full and the car is idle", () => {
    const i = soakIn(0, { loadW: 400, pvW: 400 }, { sessionOwner: null, lastAmps: null });
    i.car.chargingState = "Stopped";
    const { actions, next } = decide(i);
    expect(actions).toEqual([{ kind: "start_charging", amps: 5 }]);
    expect(next.soakStarts).toBe(1);
    expect(next.sessionOwner).toBe("system");
  });

  it("no start: battery not full, restart hold, daily cap, after 16:30, start blocked", () => {
    const idle = (over: Partial<DecideInputs["house"]>, st: Partial<StoredState> = {}) => {
      const i = soakIn(0, { loadW: 400, pvW: 400, ...over }, { sessionOwner: null, lastAmps: null, ...st });
      i.car.chargingState = "Stopped";
      return i;
    };
    expect(decide(idle({ socPct: 95 })).actions).toHaveLength(0);
    expect(decide(idle({}, { soakHold: 3 })).actions).toHaveLength(0);
    expect(decide(idle({}, { soakStarts: 3 })).actions).toHaveLength(0);
    expect(decide(idle({}, { startBlocked: true })).actions).toHaveLength(0);
    const late = idle({});
    late.nowMins = 16 * 60 + 30;
    expect(decide(late).actions).toHaveLength(0);
  });

  it("re-plug after 14:00 (IDLE) enters SOLAR_SOAK and can start", () => {
    const i = soakIn(0, { loadW: 400, pvW: 400 }, { state: "IDLE", sessionOwner: null, lastAmps: null });
    i.car.chargingState = "Stopped";
    const { actions, next } = decide(i);
    expect(next.state).toBe("SOLAR_SOAK");
    expect(kinds(actions)).toContain("start_charging");
  });

  it("17:30: stops the soak session and goes DONE", () => {
    const i = soakIn(8);
    i.nowMins = 17 * 60 + 30;
    const { actions, next } = decide(i);
    expect(actions).toEqual([{ kind: "stop_charging", reason: "soak_end" }]);
    expect(next.state).toBe("DONE");
  });

  it("never touches an owner session (invariant 6) or acts away from home (invariant 7)", () => {
    const owner = soakIn(16, {}, { sessionOwner: "owner", manualNoted: true });
    expect(decide(owner).actions).toHaveLength(0);
    const away = soakIn(8);
    away.car.atHome = false;
    expect(decide(away).actions).toHaveLength(0);
  });

  it("car full: nothing to do", () => {
    const i = soakIn(8);
    i.car.socPct = 80;
    expect(decide(i).actions).toHaveLength(0);
  });

  it("missing pv/feedin: alert once, stop, DONE", () => {
    const { actions, next } = decide(soakIn(8, { pvW: null, feedinW: null }));
    expect(kinds(actions)).toEqual(["notify", "stop_charging"]);
    expect(next.state).toBe("DONE");
  });

  it("loads a state row persisted before soak fields existed", () => {
    const i = soakIn(8);
    const legacy = { ...i.stored! } as Partial<StoredState>;
    delete legacy.soakHold;
    delete legacy.soakStarts;
    delete legacy.soakLowTicks;
    i.stored = legacy as StoredState;
    const { actions, next } = decide(i);
    expect(actions).toEqual([{ kind: "set_amps", amps: 9 }]);
    expect(next.soakHold).toBe(0);
  });
});

describe("SOLAR_SOAK with soak_export=false (curtailed PV only)", () => {
  const capped = siteFromEnv({ ...wranglerVars(), EXPORT_LIMIT_W: "5000" });
  const zero = siteFromEnv({ ...wranglerVars(), EXPORT_LIMIT_W: "0" });
  /** 15:00, battery full, car on a system session at `amps` (0 = idle). */
  const at = (site: typeof capped | null, amps: number, over: Partial<DecideInputs["house"]>, st: Partial<StoredState> = {}) => {
    const i = base();
    if (site) i.site = site;
    i.cfg.soakExport = false;
    i.nowMins = 15 * 60;
    i.car.chargingState = amps ? "Charging" : "Stopped";
    i.car.chargeAmps = amps;
    const load = 400 + amps * 690;
    i.house = { socPct: 100, loadW: load, gridImportW: 0, pvW: load, feedinW: 0, ...over };
    i.stored = stored({ state: "SOLAR_SOAK", sessionOwner: amps ? "system" : null, lastAmps: amps || null, ...st });
    return i;
  };

  it("never starts without EXPORT_LIMIT_W (curtailment is invisible)", () => {
    expect(decide(at(null, 0, { feedinW: 0 })).actions).toHaveLength(0);
    expect(decide(at(null, 0, { feedinW: 3000, pvW: 3400 })).actions).toHaveLength(0);
  });

  it("starts at 5 A only while feed-in sits at the cap with a full battery", () => {
    expect(decide(at(capped, 0, { feedinW: 4800, pvW: 5200 })).actions).toEqual([{ kind: "start_charging", amps: 5 }]);
    expect(decide(at(capped, 0, { feedinW: 3000, pvW: 3400 })).actions).toHaveLength(0);
    expect(decide(at(capped, 0, { feedinW: 4800, pvW: 5200, socPct: 96 })).actions).toHaveLength(0);
    // zero-export site: feed-in is always "at the cap"
    expect(decide(at(zero, 0, {})).actions).toEqual([{ kind: "start_charging", amps: 5 }]);
  });

  it("probes up while at the cap (the inverter un-curtails), ignores the export term", () => {
    expect(decide(at(capped, 8, { feedinW: 5000, pvW: 400 + 8 * 690 + 5000 })).actions).toEqual([{ kind: "set_amps", amps: 9 }]);
    expect(decide(at(zero, 8, {})).actions).toEqual([{ kind: "set_amps", amps: 9 }]);
    // 2 kW of export below the cap is not "visible surplus" to take in one step
    const i = at(capped, 6, { feedinW: 2000, pvW: 400 + 6 * 690 + 2000 });
    expect(decide(i).actions).not.toContainEqual({ kind: "set_amps", amps: 8 });
  });

  it("feed-in below the cap: the car is eating export, step down by the shortfall and hold", () => {
    const i = at(capped, 10, { feedinW: 3000, pvW: 400 + 10 * 690 + 3000 });
    const { actions, next } = decide(i);
    expect(actions).toEqual([{ kind: "set_amps", amps: 7 }]); // ceil((5000-250-3000)/690) = 3
    expect(next.soakHold).toBe(3);
  });

  it("at 5 A and still below the cap: rides out one tick, stops on the second", () => {
    const i = at(capped, 5, { feedinW: 3000, pvW: 400 + 5 * 690 + 3000 });
    const first = decide(i);
    expect(first.actions).toHaveLength(0);
    const second = decide({ ...i, stored: first.next });
    expect(second.actions).toEqual([{ kind: "stop_charging", reason: "soak_export_lost" }]);
  });

  it("still takes PV the battery is absorbing, and still sheds battery discharge first", () => {
    // feed-in at the cap AND 1.5 kW going into the (99%) battery: +1 A
    expect(decide(at(capped, 6, { socPct: 99, feedinW: 5000, pvW: 400 + 6 * 690 + 5000 + 1500 })).actions).toEqual([{ kind: "set_amps", amps: 7 }]);
    // battery discharging 1 kW (feed-in below the cap too): the discharge step wins
    expect(decide(at(capped, 10, { feedinW: 0, pvW: 400 + 10 * 690 - 1000 })).actions).toEqual([{ kind: "set_amps", amps: 8 }]);
  });

  it("14:00 hand-off keeps the cap: throttles to PV beyond house + cap, or stops", () => {
    const handoff = (site: typeof capped | null, pvW: number) => {
      const i = base();
      if (site) i.site = site;
      i.cfg.soakExport = false;
      i.nowMins = 14 * 60;
      i.car.chargingState = "Charging";
      i.house = { socPct: 100, loadW: 11440, gridImportW: 11440 - pvW, pvW, feedinW: 0 };
      i.stored = stored({ state: "FREE_WINDOW", sessionOwner: "system", lastAmps: 16 });
      return decide(i);
    };
    // 5 kW PV against a 5 kW cap: nothing left for the car -> stop
    expect(handoff(capped, 5000).actions).toEqual([{ kind: "stop_charging", reason: "window_end" }]);
    // 9 kW PV: floor((9000 - 400 - 5000 - 250) / 690) = 4 -> below min -> stop
    expect(handoff(capped, 9000).actions).toEqual([{ kind: "stop_charging", reason: "window_end" }]);
    // 10 kW PV: 6 A
    expect(handoff(capped, 10000).actions).toEqual([{ kind: "set_amps", amps: 6 }]);
    // zero-export: as the default hand-off
    expect(handoff(zero, 5000).actions).toEqual([{ kind: "set_amps", amps: 6 }]);
    // cap unknown: stop
    expect(handoff(null, 10000).actions).toEqual([{ kind: "stop_charging", reason: "window_end" }]);
  });
});

describe("amps re-sync from the car (2026-10-05)", () => {
  // GLIDE at reserve, balanced meter with 300 W export: a no-op at the
  // commanded amps, so any action comes from the re-synced value.
  const at = (lastAmps: number, chargeAmps: number | null, st: Partial<StoredState> = {}) => {
    const i = base();
    i.car.chargingState = "Charging";
    i.car.chargeAmps = chargeAmps;
    i.house = { socPct: 17, loadW: 400 + lastAmps * 690, gridImportW: 0, pvW: 700 + lastAmps * 690, feedinW: 300 };
    i.stored = stored({ state: "GLIDE", sessionOwner: "system", lastAmps, ...st });
    return i;
  };

  it("adopts amps the owner changed in the app once our last command has settled", () => {
    // we think 7 A, the car says 10 A (owner), meter balanced for 7 A: the
    // loop now reasons from 10 and the 300 W export is a no-op there too
    const { actions, next } = decide(at(7, 10));
    expect(actions).toHaveLength(0);
    expect(next.lastAmps).toBe(10);
  });

  it("a stale report right after our own set_amps does not override it", () => {
    const { next } = decide(at(7, 16, { ampsPending: true }));
    expect(next.lastAmps).toBe(7);
    expect(next.ampsPending).toBe(false); // settled now: next tick may re-sync
  });

  it("a provider that reports no amps never re-syncs, and falls back to the charger max for a new session", () => {
    expect(decide(at(7, null)).next.lastAmps).toBe(7);
    const i = at(7, null, { lastAmps: null });
    i.nowMins = 12 * 60; // adopted in-window session
    expect(decide(i).next.lastAmps).toBe(16);
  });

  it("ampsPending follows the actions: set after a command, cleared after a quiet tick", () => {
    const i = at(7, 7, { ampsPending: false });
    i.house.feedinW = 1500; // 1.5 kW of export headroom -> set_amps
    i.house.pvW = i.house.loadW + 1500;
    const { actions, next } = decide(i);
    expect(kinds(actions)).toContain("set_amps");
    expect(next.ampsPending).toBe(true);
    expect(decide(at(7, 7, { ampsPending: true })).next.ampsPending).toBe(false);
  });

  it("owner sessions are never re-synced (nothing is commanded for them)", () => {
    const { next } = decide(at(7, 10, { sessionOwner: "owner" }));
    expect(next.lastAmps).toBe(7);
  });
});

describe("glide_mode parsing", () => {
  it("defaults to asap, accepts both modes, rejects typos", () => {
    expect(parseGlideMode(undefined)).toBe("asap");
    expect(parseGlideMode("")).toBe("asap");
    expect(parseGlideMode("continuous")).toBe("continuous");
    expect(() => parseGlideMode("Continuous")).toThrow("glide_mode");
  });
});

describe("grid-offline guard", () => {
  it("off-grid: stops a system charge immediately, alerts once, blocks starts", () => {
    const i = base();
    i.car.chargingState = "Charging";
    i.house.runningState = 164;
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", lastAmps: 16 });
    const first = decide(i);
    expect(first.actions).toContainEqual({ kind: "stop_charging", reason: "grid_offline" });
    expect(kinds(first.actions).filter((k) => k === "notify")).toHaveLength(1);
    expect(first.next.gridDown).toBe("offgrid");
    // next tick: car stopped, still off-grid, battery well above reserve -> no restart, no repeat alert
    const second = decide({ ...i, car: { ...i.car, chargingState: "Stopped" }, stored: first.next });
    expect(second.actions).toHaveLength(0);
  });

  it("applies in every phase: free window and afternoon soak", () => {
    for (const [nowMins, state] of [
      [12 * 60, "FREE_WINDOW"],
      [15 * 60, "SOLAR_SOAK"],
    ] as const) {
      const i = base();
      i.nowMins = nowMins;
      i.car.chargingState = "Charging";
      i.house = { socPct: 100, loadW: 11440, gridImportW: 0, pvW: 0, feedinW: 0, runningState: 164 };
      i.stored = stored({ state, sessionOwner: "system", lastAmps: 16 });
      const { actions } = decide(i);
      expect(actions).toContainEqual({ kind: "stop_charging", reason: "grid_offline" });
      expect(kinds(actions)).not.toContain("set_amps");
      expect(kinds(actions)).not.toContain("start_charging");
    }
  });

  it("back on-grid: clears, notes it, and normal charging resumes", () => {
    const i = base();
    i.house.runningState = 163;
    i.stored = stored({ state: "DUMPING", gridDown: "offgrid" });
    const { actions, next } = decide(i);
    expect(next.gridDown).toBeNull();
    expect(kinds(actions)).toEqual(["notify", "start_charging"]);
  });

  it("runningState missing: stays latched rather than guessing the grid is back", () => {
    const i = base();
    i.stored = stored({ state: "DUMPING", gridDown: "offgrid" });
    expect(decide(i).actions).toHaveLength(0);
  });

  it("never stops an owner session (invariant 6), but the alert says so", () => {
    const i = base();
    i.car.chargingState = "Charging";
    i.house.runningState = 164;
    i.stored = stored({ state: "IDLE", sessionOwner: "owner", manualNoted: true });
    const { actions } = decide(i);
    expect(kinds(actions)).toEqual(["notify"]);
    expect((actions[0] as { message: string }).message).toContain("owner-started");
  });

  it("fallback: battery feeding the car in the window latches for the day", () => {
    const i = base();
    i.nowMins = 11 * 60 + 15;
    i.car.chargingState = "Charging";
    // no runningState; 11 kW load, no grid import, no PV -> battery covering it
    i.house = { socPct: 60, loadW: 11440, gridImportW: 0, pvW: 0, feedinW: 0 };
    i.stored = stored({ state: "FREE_WINDOW", sessionOwner: "system", lastAmps: 16 });
    const first = decide(i);
    expect(first.actions).toContainEqual({ kind: "stop_charging", reason: "grid_offline" });
    expect(first.next.gridDown).toBe("drain");
    // car off -> symptom gone, but still no restart
    const later = { ...i, car: { ...i.car, chargingState: "Stopped" }, stored: first.next };
    later.house = { socPct: 59, loadW: 400, gridImportW: 0, pvW: 0, feedinW: 0 };
    expect(decide(later).actions).toHaveLength(0);
  });

  it("fallback ignores the first 10 min of the window (lagging readings) and normal grid charging", () => {
    const early = base();
    early.nowMins = 11 * 60 + 5;
    early.car.chargingState = "Charging";
    early.house = { socPct: 60, loadW: 11440, gridImportW: 0, pvW: 0, feedinW: 0 };
    early.stored = stored({ state: "FREE_WINDOW", sessionOwner: "system", lastAmps: 16 });
    expect(decide(early).next.gridDown).toBeNull();
    const normal = { ...early, nowMins: 12 * 60 };
    normal.house = { socPct: 60, loadW: 11440, gridImportW: 20000, pvW: 1000, feedinW: 0 }; // grid feeds car + battery
    expect(decide(normal).actions).toHaveLength(0);
  });
});

describe("shadow mode", () => {
  it("failed start verification does not block retries", () => {
    const i = base();
    i.cfg.shadowMode = true;
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", startPending: 1, lastAmps: 16 });
    const { next } = decide(i);
    expect(next.startBlocked).toBe(false);
  });

  it("never-charging car does not trigger the external-stop stand-down", () => {
    const i = base();
    i.cfg.shadowMode = true;
    i.stored = stored({ state: "DUMPING", sessionOwner: "system", startPending: -1, lastAmps: 16 });
    const { next } = decide(i);
    expect(next.startBlocked).toBe(false);
  });
});

describe("amp maths sanity", () => {
  it("full sweep: amps always within [5,16] whatever the meter says", () => {
    for (const feedin of [0, 500, 3000, 12000]) {
      for (const imp of [0, 300, 2000, 11000]) {
        for (const last of [5, 8, 16]) {
          const i = base();
          i.car.chargingState = "Charging";
          i.house = { socPct: 17, loadW: 400, gridImportW: imp, pvW: 5000, feedinW: feedin };
          i.car.chargeAmps = last;
          i.stored = stored({ state: "GLIDE", sessionOwner: "system", lastAmps: last });
          for (const act of decide(i).actions) {
            if (act.kind === "set_amps") {
              expect(act.amps).toBeGreaterThanOrEqual(5);
              expect(act.amps).toBeLessThanOrEqual(16);
            }
          }
        }
      }
    }
  });
});
