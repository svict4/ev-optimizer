import { describe, expect, it } from "vitest";
import { localMidnightMs, localNow, localSlot, offsetSuffix, siteFromEnv, utcOffsetMins, type SiteVars } from "./site";
import { TEST_SITE } from "./testing";
import { decide, type DecideInputs } from "./tick";
import wranglerJsonc from "../wrangler.jsonc?raw";

const vars: SiteVars = {
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
};

describe("siteFromEnv", () => {
  it("accepts the vars committed in wrangler.jsonc (CI catches a broken edit before deploy)", () => {
    const json = wranglerJsonc.replace(/^\s*\/\/.*$/gm, ""); // full-line comments only
    const cfg = JSON.parse(json) as { vars: SiteVars };
    expect(() => siteFromEnv(cfg.vars)).not.toThrow();
  });

  it("parses wrangler vars (strings or numbers)", () => {
    expect(siteFromEnv(vars)).toEqual({
      timeZone: "Australia/Brisbane",
      windowStartMins: 660,
      windowEndMins: 840,
      dayStartMins: 330,
      soakEndMins: 1050,
      batteryKwh: 42,
      batteryMinSocPct: 10,
      wPerAmp: 690,
      minAmps: 5,
      maxAmps: 16,
      homeRadiusM: 150,
      inverterMaxW: 15000,
      exportLimitW: null,
    });
    expect(siteFromEnv({ ...vars, BATTERY_KWH: 13.5, CHARGER_PHASES: 1 }).wPerAmp).toBe(230);
  });

  it("EXPORT_LIMIT_W is optional: unset/blank = null, 0 = zero-export site, negative rejected", () => {
    expect(siteFromEnv({ ...vars, EXPORT_LIMIT_W: "" }).exportLimitW).toBeNull();
    expect(siteFromEnv({ ...vars, EXPORT_LIMIT_W: 0 }).exportLimitW).toBe(0);
    expect(siteFromEnv({ ...vars, EXPORT_LIMIT_W: "5000" }).exportLimitW).toBe(5000);
    expect(() => siteFromEnv({ ...vars, EXPORT_LIMIT_W: "-1" })).toThrow("EXPORT_LIMIT_W");
    expect(() => siteFromEnv({ ...vars, EXPORT_LIMIT_W: "lots" })).toThrow("EXPORT_LIMIT_W");
  });

  it("lists every missing var instead of defaulting to someone else's site", () => {
    const { TIME_ZONE: _a, BATTERY_KWH: _b, INVERTER_MAX_W: _c, ...rest } = vars;
    expect(() => siteFromEnv(rest)).toThrow("missing site vars in wrangler.jsonc: TIME_ZONE, BATTERY_KWH, INVERTER_MAX_W");
  });

  it("rejects malformed values", () => {
    expect(() => siteFromEnv({ ...vars, TIME_ZONE: "Australia/Nowhere" })).toThrow("IANA time zone");
    expect(() => siteFromEnv({ ...vars, FREE_WINDOW_START: "11am" })).toThrow("HH:MM");
    expect(() => siteFromEnv({ ...vars, BATTERY_KWH: "-1" })).toThrow("positive");
    expect(() => siteFromEnv({ ...vars, FREE_WINDOW_START: "11:15" })).toThrow("half hour");
    expect(() => siteFromEnv({ ...vars, FREE_WINDOW_END: "10:00" })).toThrow("DAY_START <");
    expect(() => siteFromEnv({ ...vars, SOLAR_SOAK_END: "13:00" })).toThrow("SOLAR_SOAK_END");
    expect(() => siteFromEnv({ ...vars, CHARGER_MIN_AMPS: "20" })).toThrow("min <= max");
  });
});

describe("local time helpers", () => {
  const BNE = { timeZone: "Australia/Brisbane" };
  const SYD = { timeZone: "Australia/Sydney" };

  it("handles positive, negative and half-hour offsets", () => {
    const at = new Date("2026-07-01T20:00:00Z");
    expect(localNow(BNE, at).toISOString()).toBe("2026-07-02T06:00:00.000Z");
    expect(localMidnightMs(BNE, "2026-07-02")).toBe(Date.parse("2026-07-01T14:00:00Z"));
    expect(localMidnightMs({ timeZone: "America/Chicago" }, "2026-07-02")).toBe(Date.parse("2026-07-02T05:00:00Z"));
    expect(utcOffsetMins({ timeZone: "Australia/Darwin" }, at.getTime())).toBe(570);
    expect(utcOffsetMins({ timeZone: "America/St_Johns" }, Date.parse("2026-01-15T12:00:00Z"))).toBe(-210);
    expect(offsetSuffix(600)).toBe("+1000");
    expect(offsetSuffix(570)).toBe("+0930");
    expect(offsetSuffix(-210)).toBe("-0330");
  });

  it("a no-DST zone keeps one offset all year", () => {
    expect(utcOffsetMins(BNE, Date.parse("2026-01-15T00:00:00Z"))).toBe(600);
    expect(utcOffsetMins(BNE, Date.parse("2026-07-15T00:00:00Z"))).toBe(600);
  });

  it("free window 11:00 local tracks DST: AEST +10 in winter, AEDT +11 in summer", () => {
    // NSW 2026: DST starts Sun 4 Oct 02:00 AEST (-> 03:00 AEDT).
    expect(localNow(SYD, new Date("2026-10-03T01:00:00Z")).toISOString()).toBe("2026-10-03T11:00:00.000Z");
    expect(localNow(SYD, new Date("2026-10-05T00:00:00Z")).toISOString()).toBe("2026-10-05T11:00:00.000Z");
    // the instant just before / at the switch
    expect(localNow(SYD, new Date("2026-10-03T15:59:00Z")).toISOString()).toBe("2026-10-04T01:59:00.000Z");
    expect(localNow(SYD, new Date("2026-10-03T16:00:00Z")).toISOString()).toBe("2026-10-04T03:00:00.000Z");
  });

  it("local midnight and day length across DST changes", () => {
    expect(localMidnightMs(SYD, "2026-10-04")).toBe(Date.parse("2026-10-03T14:00:00Z")); // AEST
    expect(localMidnightMs(SYD, "2026-10-05")).toBe(Date.parse("2026-10-04T13:00:00Z")); // AEDT: 23-h day
    // DST ends Sun 5 Apr 2026 03:00 AEDT (-> 02:00 AEST): 25-h day
    expect(localMidnightMs(SYD, "2026-04-05")).toBe(Date.parse("2026-04-04T13:00:00Z"));
    expect(localMidnightMs(SYD, "2026-04-06")).toBe(Date.parse("2026-04-05T14:00:00Z"));
  });

  it("localSlot labels instants by wall-clock half hour", () => {
    expect(localSlot(SYD, Date.parse("2026-10-03T15:30:00Z"))).toBe(3); // 01:30 AEST
    expect(localSlot(SYD, Date.parse("2026-10-03T16:00:00Z"))).toBe(6); // 03:00 AEDT (02:xx skipped)
    expect(localSlot(SYD, Date.parse("2026-10-05T00:00:00Z"))).toBe(22); // 11:00 AEDT
    // repeated hour on DST end: 02:30 AEDT and 02:30 AEST share slot 5
    expect(localSlot(SYD, Date.parse("2026-04-04T15:30:00Z"))).toBe(5);
    expect(localSlot(SYD, Date.parse("2026-04-04T16:30:00Z"))).toBe(5);
  });
});

describe("decide honours the site", () => {
  const inputs = (nowMins: number, site = TEST_SITE): DecideInputs => ({
    date: "2026-07-06",
    nowMins,
    site,
    car: { pluggedIn: true, chargingState: "Stopped", socPct: 50, limitPct: 80, chargeAmps: 16, atHome: true },
    house: { socPct: 15, loadW: 400, gridImportW: 0, pvW: 0, feedinW: 0 },
    cfg: { safetyFactor: 1.3, strandedMinPct: 30, solarTrack: true, glideMode: "asap", solarSoak: true, soakExport: true, shadowMode: false },
    samples: [],
    floorPct: 10,
    stored: null,
  });

  it("uses the configured free window and charger max", () => {
    const site = siteFromEnv({ ...vars, FREE_WINDOW_START: "09:00", FREE_WINDOW_END: "15:00", CHARGER_MAX_AMPS: "32" });
    // 10:00 is outside the reference window but inside this one
    expect(decide(inputs(600)).next.state).not.toBe("FREE_WINDOW");
    const { actions, next } = decide(inputs(600, site));
    expect(next.state).toBe("FREE_WINDOW");
    expect(actions).toEqual([{ kind: "start_charging", amps: 32 }]);
  });

  it("forecasts the reserve up to the configured window start", () => {
    const early = siteFromEnv({ ...vars, FREE_WINDOW_START: "08:00" });
    // 06:00 -> 4 bootstrap slots x 0.5 kWh x 1.3 / 42 = 6.2% -> 7 + 10
    expect(decide(inputs(360, early)).next.reservePct).toBe(17);
    expect(decide(inputs(360)).next.reservePct).toBe(26);
  });

  it("uses BATTERY_MIN_SOC as the floor when the minSocOnGrid read fails", () => {
    const site = siteFromEnv({ ...vars, BATTERY_MIN_SOC: "20" });
    const i = { ...inputs(360, site), floorPct: null };
    expect(decide(i).next.floorPct).toBe(20);
    expect(decide(i).next.reservePct).toBe(36); // 16% house need on top of 20
  });

  it("scales the floor-hit import trigger with the charger (7.4 kW single-phase)", () => {
    const site = siteFromEnv({ ...vars, CHARGER_PHASES: "1", CHARGER_MIN_AMPS: "6", CHARGER_MAX_AMPS: "32" });
    const dumping = (gridImportW: number) => {
      const i = inputs(400, site);
      i.car.chargingState = "Charging";
      i.house = { ...i.house, socPct: 60, loadW: 7800, gridImportW };
      i.car.chargeAmps = 32;
      i.stored = { ...decide(inputs(395, site)).next, state: "DUMPING", sessionOwner: "system", lastAmps: 32 };
      return decide(i).next.state;
    };
    // 32 A x 230 V = 7.36 kW; trigger = 72.5% rounded to 100 W = 5.3 kW. A
    // fixed 8 kW (the 11 kW reference) would never fire on this charger.
    expect(dumping(5400)).toBe("GLIDE");
    expect(dumping(5200)).toBe("DUMPING");
  });

  it("resumes on surplus sized to the car's minimum draw", () => {
    const site = siteFromEnv({ ...vars, CHARGER_PHASES: "1", CHARGER_MIN_AMPS: "6", CHARGER_MAX_AMPS: "32" });
    // 6 A x 230 V = 1.38 kW minimum + 1.05 kW headroom = 2.43 kW surplus
    const streak = (pvW: number) => {
      const i = inputs(420, site);
      i.house = { ...i.house, socPct: 15, loadW: 400, pvW };
      i.stored = { ...decide(inputs(415, site)).next, state: "GLIDE" };
      return decide(i).next.surplusStreak;
    };
    expect(streak(400 + 2430)).toBe(1);
    expect(streak(400 + 2420)).toBe(0);
  });
});
