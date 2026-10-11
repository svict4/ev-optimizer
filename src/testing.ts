import { siteFromEnv } from "./site";

/** The site the test suite's numbers were worked out against (the example
 *  vars in wrangler.jsonc): Australia/Brisbane (UTC+10, no DST), free window 11:00–14:00, 42 kWh battery,
 *  three-phase 230 V charger at 5–16 A, 15 kW inverter, no export limit set. Test-only. */
export const TEST_SITE = siteFromEnv({
  TIME_ZONE: "Australia/Brisbane",
  FREE_WINDOW_START: "11:00",
  FREE_WINDOW_END: "14:00",
  DAY_START: "05:30",
  SOLAR_SOAK_END: "17:30",
  BATTERY_KWH: 42,
  BATTERY_MIN_SOC: 10,
  CHARGER_VOLTS: 230,
  CHARGER_PHASES: 3,
  CHARGER_MIN_AMPS: 5,
  CHARGER_MAX_AMPS: 16,
  HOME_RADIUS_M: 150,
  INVERTER_MAX_W: 15000,
});
