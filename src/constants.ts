/**
 * Control-loop tuning, fixed at deploy.
 *
 * Three configuration layers, least to most dynamic:
 *  1. Deploy time: Worker `vars` in wrangler.jsonc — site facts (timezone,
 *     free window, battery size, charger, geofence radius), parsed by
 *     src/site.ts — plus this file's control-loop tuning, which rarely needs
 *     changing.
 *  2. D1 `config` table — runtime settings changed without a redeploy:
 *     home_lat/home_lon, shadow_mode, safety_factor, stranded_min_pct,
 *     solar_track, solar_soak, home_detection (see README "Configuration").
 *  3. Wrangler secrets — credentials (see .dev.vars.example).
 *
 * A fork should only need wrangler.jsonc, the D1 config rows and the
 * secrets — never the control logic in src/tick.ts.
 */

// --- Car / charger ---
/** DUMPING: most amps added per tick while probing back up after a derate
 *  (the real ceiling may be a battery/BMS limit the inverter var can't
 *  know, and only the meter shows it). Down steps are sized from the import. */
export const AMP_STEP = 2;
/** DUMPING: ticks to hold after a derate before probing up again. */
export const DERATE_HOLD_TICKS = 3;
/** A bluetooth "car present" report older than this counts as NOT home
 *  (src/presence.ts). The scanner should report every ~1-5 min. */
export const PRESENCE_MAX_AGE_MINS = 15;

// --- Operating window ---
/** Ticks keep running this long past the solar-soak end so its stop lands. */
export const TICK_TAIL_MINS = 15;
/** Local time of the nightly load-history pull (rides the 5-min cron). */
export const NIGHTLY_PULL_MINS = 60; // 01:00

// --- Reserve forecast (src/reserve.ts) ---
export const BOOTSTRAP_SLOT_KWH = 0.5; // flat 1.0 kW where a slot has no history
export const LOAD_LOOKBACK_DAYS = 14; // history window for the forecast
export const DEFAULT_SAFETY_FACTOR = 1.3; // fallback for config safety_factor
export const DEFAULT_STRANDED_MIN_PCT = 30; // fallback for config stranded_min_pct

// --- Control-loop tuning (src/tick.ts; _W values are watts at the grid meter) ---
export const EXPORT_MARGIN_W = 250; // bias tracking error toward export, never import
export const STOP_IMPORT_W = 250; // clamped at MIN_AMPS and still importing -> stop
/** Grid import beyond this is real (not CT noise): the morning loop sheds it
 *  and ignores any battery allowance that tick — the meter is ground truth. */
export const IMPORT_TOLERANCE_W = 250;
export const RECOVER_IMPORT_W = 100; // DUMPING: probes back up only below this import
/** DUMPING: grid import above this fraction of the charger's max draw means
 *  the battery hit its floor before a SoC read caught it (rounded to 100 W;
 *  8 kW for an 11 kW charger). */
export const FLOOR_IMPORT_FRACTION = 0.725;
/** pv - house load needed to resume: the car's minimum draw plus this
 *  (3.45 kW + 1.05 kW = 4.5 kW for a three-phase 5 A minimum). */
export const RESUME_HEADROOM_W = 1050;
export const RESUME_STREAK_TICKS = 3; // 15 min of sustained sun before a restart
export const MAX_SOLAR_RESUMES = 4; // contactor-wear cap per day
export const RESERVE_BLEED_W = 250; // at/below reserve: load beyond pv+this = battery/grid feeding the car
export const SUSTAINED_IMPORT_W = 2000; // GLIDE failsafe (amp commands failing)
export const SUSTAINED_IMPORT_TICKS = 3;
export const START_CONFIRM_TICKS = 2; // invariant 4: ticks to see "Charging" after a start

// --- Grid-offline guard (src/tick.ts) ---
/** FoxESS runningState meaning off-grid (community docs; 163 = on-grid).
 *  Also reported when the datalogger drops offline — stopping then is still
 *  right: the readings are stale and we're flying blind. */
export const OFF_GRID_RUNNING_STATE = 164;
/** Fallback detector: in the free window ForceCharge feeds the car from the
 *  grid, so a battery discharging this hard means the grid isn't there. */
export const WINDOW_DRAIN_W = 2000;
/** Skip the first ticks of the window: cloud readings can lag the window-start
 *  switch into ForceCharge by a few minutes. */
export const WINDOW_DRAIN_GRACE_MINS = 10;

// --- Morning solar bank (GLIDE, src/tick.ts) ---
/** glide_mode 'asap': resume at MIN_AMPS once the energy banked above
 *  reserve plus the current PV surplus can carry the car's minimum for this
 *  long. ('continuous' waits until it can carry it to the free window.) */
export const BANK_RUN_MINS = 20;
/** Glide: spend the bank above the reserve over (minutes to window + this),
 *  so the final tick before the window can't overshoot into the floor. */
export const GLIDE_BUFFER_MINS = 5;

// --- Afternoon solar soak (SOLAR_SOAK, src/tick.ts) ---
// After the free window the battery is full and Self-Use curtails the PV it can't
// place. The car soaks it up; the full battery is only a short-term buffer.
// The hard stop is the SOLAR_SOAK_END var (keep it before any scheduled
// evening battery export).
export const SOAK_LAST_START_LEAD_MINS = 60; // no fresh starts in the soak's last hour
export const SOAK_START_SOC = 97; // battery "full" (PV likely curtailed): start / probe up
export const SOAK_MIN_SOC = 90; // hard stop: never lend the car more than ~10% of the battery
export const SOAK_DISCHARGE_W = 300; // battery discharge beyond this = car outrunning PV
export const SOAK_LOW_TICKS = 2; // at MIN_AMPS and discharging this long -> stop (rides out a cloud)
export const SOAK_STEP_HOLD_TICKS = 3; // after a step down, wait before probing up again
export const SOAK_RESTART_HOLD_TICKS = 6; // 30 min between a soak stop and a restart
export const SOAK_MAX_STARTS = 3; // contactor-wear cap per afternoon
