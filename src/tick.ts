import { morningSlotKwh, reserveAt } from "./reserve";
import {
  AMP_STEP,
  BANK_RUN_MINS,
  DERATE_HOLD_TICKS,
  EXPORT_MARGIN_W,
  FLOOR_IMPORT_FRACTION,
  GLIDE_BUFFER_MINS,
  IMPORT_TOLERANCE_W,
  MAX_SOLAR_RESUMES,
  OFF_GRID_RUNNING_STATE,
  RECOVER_IMPORT_W,
  RESERVE_BLEED_W,
  RESUME_STREAK_TICKS,
  RESUME_HEADROOM_W,
  SOAK_DISCHARGE_W,
  SOAK_LOW_TICKS,
  SOAK_MAX_STARTS,
  SOAK_MIN_SOC,
  SOAK_RESTART_HOLD_TICKS,
  SOAK_START_SOC,
  SOAK_STEP_HOLD_TICKS,
  START_CONFIRM_TICKS,
  STOP_IMPORT_W,
  SUSTAINED_IMPORT_TICKS,
  SUSTAINED_IMPORT_W,
  WINDOW_DRAIN_GRACE_MINS,
  WINDOW_DRAIN_W,
  SOAK_LAST_START_LEAD_MINS,
} from "./constants";
import type { Site } from "./site";

/**
 * Pure decision function of (inputs, stored state) -> (actions, new state).
 * No I/O, no clock, no randomness — see SPEC.md "State machine".
 * Orchestration (reads, command execution, persistence) lives in src/index.ts.
 */

export type StateName = "IDLE" | "DUMPING" | "GLIDE" | "FREE_WINDOW" | "SOLAR_SOAK" | "DONE";

/** Morning bank-restart policy (D1 config glide_mode, see SPEC "GLIDE").
 *  asap: restart as soon as the bank carries the car's minimum for
 *  BANK_RUN_MINS (more cycles, less stranded if the owner leaves early).
 *  continuous: restart only once it can carry the car to the free window
 *  without a stop (one contactor cycle, runs straight into FREE_WINDOW). */
export const GLIDE_MODES = ["asap", "continuous"] as const;
export type GlideMode = (typeof GLIDE_MODES)[number];

/** Unset = asap (the behaviour before the mode existed). A typo must not
 *  silently change the restart policy, so unknown values throw. */
export function parseGlideMode(v: string | undefined): GlideMode {
  if (v === undefined || v === "") return "asap";
  if ((GLIDE_MODES as readonly string[]).includes(v)) return v as GlideMode;
  throw new Error(`config glide_mode '${v}' invalid (one of ${GLIDE_MODES.join(", ")})`);
}

export interface StoredState {
  date: string; // YYYY-MM-DD local
  state: StateName;
  /** House reserve NOW: floorPct + forecast house need until 11:00. Re-derived
   *  every tick from slotKwh, so it decays through the morning. */
  reservePct: number;
  /** Effective hardware floor: max(10, minSocOnGrid at PLAN, learned from
   *  import stops). */
  floorPct: number;
  /** Forecast house kWh per half-hour slot until 11:00, fixed at PLAN.
   *  null = row persisted before the decaying reserve: reservePct stays fixed. */
  slotKwh: number[] | null;
  /** Who started the running charge session (invariant 6). */
  sessionOwner: "system" | "owner" | null;
  /** Ticks since start_charging was sent; -1 = no start pending (invariant 4). */
  startPending: number;
  /** Set after a failed start or an external stop: no more auto-starts until
   *  the free window (which resets it). */
  startBlocked: boolean;
  /** Last amps target we commanded; null when not charging. */
  lastAmps: number | null;
  surplusStreak: number; // consecutive ticks with pv-load >= resume threshold
  solarResumes: number; // GLIDE restarts today (wear cap)
  manualNoted: boolean; // one ntfy per owner session
  solarVarsAlerted: boolean; // one ntfy per day for missing pv/feedin
  highImportTicks: number; // GLIDE sustained-import failsafe
  /** DUMPING: ticks to wait after a derate before probing back up. */
  ampHold: number;
  /** An amps command (start or set_amps) went out last tick, so the car's
   *  reported amps may not reflect it yet: don't re-sync lastAmps from them. */
  ampsPending: boolean;
  soakStarts: number; // SOLAR_SOAK starts today (wear cap)
  soakHold: number; // SOLAR_SOAK ticks to wait before probing up / restarting
  soakLowTicks: number; // SOLAR_SOAK consecutive ticks at MIN_AMPS with battery discharging
  /** Grid-offline guard: "offgrid" = inverter reports off-grid (clears when it
   *  reports anything else); "drain" = battery feeding the car in the free
   *  window (latched for the day — the car being off hides the symptom). */
  gridDown: "offgrid" | "drain" | null;
}

/** Fields added after go-live; a state row persisted by an older build lacks
 *  them, so they are defaulted when the row is loaded mid-day. */
const lateFields = (
  site: Site,
): Pick<StoredState, "soakStarts" | "soakHold" | "soakLowTicks" | "gridDown" | "floorPct" | "slotKwh" | "ampHold" | "ampsPending"> => ({
  floorPct: site.batteryMinSocPct,
  slotKwh: null,
  ampHold: 0,
  ampsPending: false,
  soakStarts: 0,
  soakHold: 0,
  soakLowTicks: 0,
  gridDown: null,
});

/** A state row persisted by a build that still called GLIDE "SOLAR_TRACK"
 *  (renamed 2026-10-05) must keep acting as GLIDE when loaded mid-day. */
const migrateState = (state: string): StateName => (state === "SOLAR_TRACK" ? "GLIDE" : (state as StateName));

export interface DecideInputs {
  date: string;
  nowMins: number; // minutes since local midnight
  site: Site; // per-install facts (wrangler.jsonc vars)
  car: {
    pluggedIn: boolean;
    chargingState: string; // "Charging" | "Stopped" | "Complete" | "Disconnected" | ...
    socPct: number;
    limitPct: number; // car's own charge limit = the target (invariant 3)
    /** The car's requested amps (charge_amps / charge_current_request);
     *  null = the provider doesn't report them. */
    chargeAmps: number | null;
    atHome: boolean; // geofence, unknown location = false (invariant 7)
  };
  house: {
    socPct: number;
    loadW: number;
    gridImportW: number;
    pvW: number | null; // null = inverter doesn't report it
    feedinW: number | null;
    runningState?: number | null; // FoxESS mode code; absent = unknown
  };
  cfg: {
    safetyFactor: number;
    strandedMinPct: number;
    solarTrack: boolean;
    glideMode: GlideMode; // morning bank-restart policy (default asap)
    solarSoak: boolean; // afternoon PV -> car after the window (default on)
    /** Afternoon soak may take PV that would otherwise be exported (default
     *  on: export costs money on the reference plan). 'false' = only PV the
     *  inverter is curtailing, which needs the EXPORT_LIMIT_W site var. */
    soakExport: boolean;
    shadowMode: boolean;
  };
  /** Half-hour load history for PLAN; only read on the first tick of a day. */
  samples: { slot: number; loadKwh: number }[];
  /** FoxESS minSocOnGrid, read (read-only) at PLAN. 10% is the manufacturer
   *  BMS minimum; the owner may raise it in the FoxESS app. The house's
   *  forecast energy until 11:00 is reserved ON TOP of this floor — the
   *  inverter won't discharge below it, so energy at/below the floor can't
   *  run the house (it would be paid grid import). null = read failed or not
   *  the first tick of a day; assumes the 10% minimum (hardware still
   *  enforces the real floor, and an import stop learns it). */
  floorPct: number | null;
  stored: StoredState | null;
}

export type Action =
  | { kind: "start_charging"; amps: number }
  | { kind: "stop_charging"; reason: string }
  | { kind: "set_amps"; amps: number }
  | { kind: "notify"; message: string };

export function decide(i: DecideInputs): { actions: Action[]; next: StoredState } {
  const r = run(i);
  // Commands are not confirmations (invariant 4): give an amps command one
  // tick to show up in the car's cached state before trusting that state.
  r.next.ampsPending = r.actions.some((x) => x.kind === "set_amps" || x.kind === "start_charging");
  return r;
}

function run(i: DecideInputs): { actions: Action[]; next: StoredState } {
  const a: Action[] = [];
  const carAmps = carAmpsOf(i);

  // PLAN: first tick of a new day.
  const s: StoredState =
    i.stored && i.stored.date === i.date
      ? { ...lateFields(i.site), ...i.stored, state: migrateState(i.stored.state) }
      : {
          date: i.date,
          state: "IDLE",
          // House energy until 11:00 on top of the hardware floor (see
          // DecideInputs.floorPct). Floor unknown -> the BMS minimum; the
          // learned-floor rule catches a higher one from import evidence.
          // reservePct is filled in by refreshReserve() below.
          reservePct: 0,
          sessionOwner: null,
          startPending: -1,
          startBlocked: false,
          lastAmps: null,
          surplusStreak: 0,
          solarResumes: 0,
          manualNoted: false,
          solarVarsAlerted: false,
          highImportTicks: 0,
          ...lateFields(i.site),
          floorPct: Math.max(i.site.batteryMinSocPct, i.floorPct ?? i.site.batteryMinSocPct),
          slotKwh: morningSlotKwh(i.samples, i.site.windowStartMins / 30),
        };

  const refreshReserve = () => {
    if (s.slotKwh === null) return; // legacy row: keep its fixed reserve
    s.reservePct = reserveAt({
      nowMins: i.nowMins,
      slotKwh: s.slotKwh,
      safetyFactor: i.cfg.safetyFactor,
      batteryKwh: i.site.batteryKwh,
      minSocPct: i.site.batteryMinSocPct,
      floorPct: s.floorPct,
    });
  };
  refreshReserve();

  const charging = i.car.chargingState === "Charging";
  const full = i.car.chargingState === "Complete" || i.car.socPct >= i.car.limitPct;

  const stop = (reason: string) => {
    a.push({ kind: "stop_charging", reason });
    s.sessionOwner = null;
    s.lastAmps = null;
  };
  const start = (amps: number) => {
    a.push({ kind: "start_charging", amps });
    s.sessionOwner = "system";
    s.startPending = 0;
    s.lastAmps = amps;
  };
  const canStart = () => !s.startBlocked && s.startPending < 0 && s.gridDown === null;
  // Grid import while the car runs above reserve means the battery would not
  // discharge at this SoC (hardware floor above the planned reserve — e.g. the
  // PLAN floor read failed — or a derated battery). Adopt that SoC as today's
  // effective floor so no path (bank restart, glide) starts
  // the car on paid grid again. Only ever raises: conservative, like the
  // owner-raised-floor rule at PLAN.
  const learnFloor = () => {
    s.floorPct = Math.min(100, Math.max(s.floorPct, i.house.socPct));
    if (s.slotKwh === null) s.reservePct = Math.min(100, Math.max(s.reservePct, i.house.socPct));
    else refreshReserve(); // the house's remaining need now sits on the learned floor
  };

  // --- Session bookkeeping (invariants 4 + 6) ---
  if (charging && s.sessionOwner === null) {
    if (i.nowMins >= i.site.windowStartMins && i.nowMins < i.site.windowEndMins && i.car.atHome) {
      // The car's native 11:00 Tesla schedule (kept as the dead-controller
      // backstop) or any fresh in-window start wants exactly what we want:
      // free charge until 14:00. Adopt it so the 14:00 stop applies.
      // Ownership is sticky, so a session the owner started BEFORE the
      // window stays theirs all the way through.
      s.sessionOwner = "system";
      if (s.lastAmps === null) s.lastAmps = carAmps;
    } else {
      s.sessionOwner = "owner"; // the deliberate manual override
      if (!s.manualNoted && i.car.atHome) {
        a.push({ kind: "notify", message: "manual charge detected — not interfering" });
        s.manualNoted = true;
      }
    }
  }
  if (s.startPending >= 0) {
    if (charging) {
      s.startPending = -1; // confirmed
    } else if (++s.startPending >= START_CONFIRM_TICKS) {
      s.startPending = -1;
      s.sessionOwner = null;
      s.lastAmps = null;
      a.push({
        kind: "notify",
        message: `start_charging sent but car not Charging after ${START_CONFIRM_TICKS} ticks`,
      });
      if (!i.cfg.shadowMode) s.startBlocked = true; // shadow never really starts
    }
  } else if (!charging && s.sessionOwner === "system") {
    // Our session ended without our stop command. Unplug and Complete are
    // natural ends; anything else (owner pressed stop in the Tesla app, car
    // fault) means stand down — restarting would fight the owner.
    s.sessionOwner = null;
    s.lastAmps = null;
    if (!full && i.car.pluggedIn && !i.cfg.shadowMode) {
      a.push({ kind: "notify", message: "charging stopped externally — standing down until the free window" });
      s.startBlocked = true;
    }
  }
  if (!charging && s.sessionOwner === "owner") {
    s.sessionOwner = null;
    s.manualNoted = false; // next manual session gets its own note
  }
  // Re-sync (2026-10-05): the loops reason from lastAmps, the value we last
  // commanded. If the car reports something else once that command has had
  // a tick to land — the owner changed amps in the Tesla app, or our
  // set_amps was accepted but not applied — reason from what the car says.
  if (charging && s.sessionOwner === "system" && s.lastAmps !== null && !s.ampsPending && i.car.chargeAmps !== null) {
    s.lastAmps = i.car.chargeAmps;
  }

  // --- Grid-offline guard (owner, 2026-09-27) ---
  // Without the grid there's no knowing when the house is reconnected, so the
  // house battery is for the house only: stop our charge at once and start
  // nothing until the grid is back.
  const rs = i.house.runningState;
  const wasDown = s.gridDown;
  if (rs === OFF_GRID_RUNNING_STATE) {
    if (s.gridDown === null) s.gridDown = "offgrid";
  } else if (s.gridDown === "offgrid" && rs !== null && rs !== undefined) {
    s.gridDown = null;
    a.push({ kind: "notify", message: `inverter back on-grid (runningState ${rs}) — car charging resumes normally` });
  }
  if (
    s.gridDown === null &&
    i.nowMins >= i.site.windowStartMins + WINDOW_DRAIN_GRACE_MINS &&
    i.nowMins < i.site.windowEndMins &&
    i.house.pvW !== null &&
    i.house.feedinW !== null &&
    i.house.feedinW - i.house.gridImportW - (i.house.pvW - i.house.loadW) > WINDOW_DRAIN_W
  ) {
    s.gridDown = "drain"; // fallback when runningState is missing or doesn't flip
  }
  if (s.gridDown !== null && wasDown === null) {
    const why =
      s.gridDown === "offgrid"
        ? `inverter reports off-grid (runningState ${rs})`
        : "house battery discharging in the free window (grid down or ForceCharge not running)";
    const owner = s.sessionOwner === "owner" && charging ? " An owner-started charge is still running — stop it in the Tesla app." : "";
    const until = s.gridDown === "offgrid" ? "until it's back on-grid" : "for the rest of today";
    a.push({ kind: "notify", message: `${why}: car charging stopped, no starts ${until}.${owner}` });
  }
  if (s.gridDown !== null && charging && s.sessionOwner === "system" && i.car.atHome) {
    stop("grid_offline");
  }

  // No command ever leaves while away/unknown (invariant 7) or during an
  // owner session (invariant 6).
  const canAct = i.car.atHome && s.sessionOwner !== "owner";

  if (!i.car.pluggedIn) {
    s.state = "IDLE"; // unplugging ends everything naturally
    s.lastAmps = null;
    s.surplusStreak = 0;
    return { actions: a, next: s };
  }

  const phase = i.nowMins >= i.site.windowEndMins ? "after" : i.nowMins >= i.site.windowStartMins ? "window" : "morning";

  if (phase === "after") {
    const soakOn = i.cfg.solarSoak && i.nowMins < i.site.soakEndMins;
    if (s.state !== "DONE" && s.state !== "SOLAR_SOAK") {
      // First after-window tick (or a re-plug after an unplug reset to IDLE).
      if (charging && s.sessionOwner === "system" && canAct) {
        if (i.car.socPct < i.cfg.strandedMinPct) {
          // never strand the owner: leave the (now paid) charge running
          a.push({
            kind: "notify",
            message: `free window ended with car at ${i.car.socPct}% (< stranded min ${i.cfg.strandedMinPct}%) — leaving paid charge running`,
          });
          s.state = "DONE";
          return { actions: a, next: s };
        }
        if (soakOn && !full && i.house.pvW !== null && i.house.feedinW !== null) {
          // Throttle to the PV the meter can see instead of stopping: no
          // contactor cycle, and the soak loop probes up from here. In
          // curtailed-only mode the export cap is kept out of reach first,
          // so a car that would only eat export stops here instead.
          const houseW = i.house.loadW - carAmps * i.site.wPerAmp;
          const keepW = i.cfg.soakExport ? 0 : i.site.exportLimitW;
          if (keepW !== null) {
            const raw = Math.floor((i.house.pvW - houseW - keepW - EXPORT_MARGIN_W) / i.site.wPerAmp);
            if (i.cfg.soakExport || raw >= i.site.minAmps) {
              const target = clampAmps(i.site, raw);
              if (target !== s.lastAmps) a.push({ kind: "set_amps", amps: target });
              s.lastAmps = target;
              s.state = "SOLAR_SOAK";
              return { actions: a, next: s };
            }
          }
        }
        stop("window_end");
      }
      s.state = soakOn ? "SOLAR_SOAK" : "DONE";
    }
    if (s.state === "SOLAR_SOAK") soak(i, s, a, { charging, full, canAct, stop, start, canStart, soakOn });
    return { actions: a, next: s };
  }

  if (phase === "window") {
    if (s.state !== "FREE_WINDOW") s.startBlocked = false; // free power: always worth one fresh attempt
    s.state = "FREE_WINDOW";
    if (!full && canAct) {
      if (!charging) {
        if (canStart()) start(i.site.maxAmps);
      } else if (s.sessionOwner === "system") {
        if (s.lastAmps === null) s.lastAmps = carAmps;
        if (s.lastAmps !== i.site.maxAmps) {
          a.push({ kind: "set_amps", amps: i.site.maxAmps });
          s.lastAmps = i.site.maxAmps;
        }
      }
    }
    return { actions: a, next: s };
  }

  // --- morning: IDLE / DUMPING / GLIDE ---
  // Transition first, then act as the resulting state in the same tick (so a
  // floor-hit at 16 A throttles immediately instead of a tick later).
  let st: StateName = s.state === "FREE_WINDOW" || s.state === "DONE" ? "IDLE" : s.state;
  if (full || s.sessionOwner === "owner" || !i.car.atHome) {
    st = "IDLE";
  } else if (st === "IDLE") {
    st = i.house.socPct > s.reservePct ? "DUMPING" : "GLIDE";
  } else if (st === "DUMPING") {
    if (i.house.gridImportW > floorImportW(i.site)) {
      learnFloor(); // floor hit before a SoC read caught it: reserve_hit stops the car this tick
      st = "GLIDE";
    } else if (i.house.socPct <= s.reservePct) {
      st = "GLIDE";
    }
  }
  // No GLIDE -> DUMPING re-entry (2026-09-29): energy that appears above the
  // reserve (PV, or the reserve decaying toward 11:00) is glided into the
  // car at a gentle rate instead of a 16 A burst.
  s.state = st;
  if (st !== "DUMPING") s.ampHold = 0;

  if (st === "DUMPING" && canAct) morningDump(i, s, a, { charging, start, canStart });
  if (st === "GLIDE" && canAct) morningGlide(i, s, a, { charging, stop, start, canStart, learnFloor });

  return { actions: a, next: s };
}

const clampAmps = (site: Site, a: number) => Math.min(site.maxAmps, Math.max(site.minAmps, a));
/** Amps the car reports, or the charger max if the provider doesn't report them. */
const carAmpsOf = (i: DecideInputs) => i.car.chargeAmps ?? i.site.maxAmps;
const floorImportW = (site: Site) =>
  Math.round((site.maxAmps * site.wPerAmp * FLOOR_IMPORT_FRACTION) / 100) * 100;

/**
 * The one morning formula (DUMPING and GLIDE, 2026-10-05): watts the car may
 * add (+) or must shed (-) this tick, before the export margin.
 *   meterW    = feedin - import            (+ export, - import; ground truth)
 *   pvSpareW  = pv - load                  (PV the battery is absorbing — loadsPower includes the car)
 *   allowanceW = battery power the car may draw: the inverter's whole output
 *                in DUMPING (Infinity), the glide budget net of what the
 *                battery already gives in GLIDE (may be negative)
 * Importing beyond IMPORT_TOLERANCE_W: shed the import plus any battery
 * over-draw, and ignore a positive allowance — a stale bank or a battery
 * that can't discharge (hardware floor) must never ratchet the car up on
 * paid grid. Otherwise take the visible surplus plus the allowance, capped
 * by what the inverter can still deliver after everything it already
 * supplies (INVERTER_MAX_W - load): a small inverter never opens at max
 * amps and imports until the loop catches up. feedin/pv missing (DUMPING
 * runs without them) degrade to the meter alone.
 */
function carRoomW(i: DecideInputs, allowanceW: number): number {
  const h = i.house;
  const meterW = (h.feedinW ?? 0) - h.gridImportW;
  const pvSpareW = h.pvW === null ? -Infinity : h.pvW - h.loadW;
  if (h.gridImportW > IMPORT_TOLERANCE_W) return meterW + Math.min(0, allowanceW);
  return Math.min(i.site.inverterMaxW - h.loadW, Math.max(meterW, pvSpareW) + allowanceW);
}

/** Amps to start at for a given allowance (the car is off, so loadsPower is
 *  house-only); clamped to the charger's range. */
const startAmps = (i: DecideInputs, allowanceW: number) =>
  clampAmps(i.site, Math.floor((carRoomW(i, allowanceW) - EXPORT_MARGIN_W) / i.site.wPerAmp));

/** Battery -> loads by energy balance (+ = discharging), W. */
const batteryDischargeW = (h: DecideInputs["house"]) =>
  Math.max(0, (h.feedinW ?? 0) - h.gridImportW - ((h.pvW ?? h.loadW) - h.loadW));

/**
 * DUMPING: the battery is above the house reserve, so the car takes the
 * inverter's whole output. Opens at what fits under INVERTER_MAX_W after
 * house load; the meter closes the loop from there — import beyond
 * tolerance (a battery/BMS limit the var can't know) sheds amps sized to
 * the import, then holds DERATE_HOLD_TICKS and probes back up AMP_STEP per
 * tick while import stays below RECOVER_IMPORT_W. Bounded hunting instead
 * of a 16 A restart every tick.
 */
function morningDump(
  i: DecideInputs,
  s: StoredState,
  a: Action[],
  h: { charging: boolean; start: (amps: number) => void; canStart: () => boolean },
): void {
  if (!h.charging) {
    if (h.canStart()) h.start(startAmps(i, Infinity));
    return;
  }
  if (s.sessionOwner !== "system") return;
  if (s.lastAmps === null) s.lastAmps = carAmpsOf(i);
  if (s.ampHold > 0) s.ampHold--;
  let delta = Math.floor((carRoomW(i, Infinity) - EXPORT_MARGIN_W) / i.site.wPerAmp);
  if (delta > 0) {
    delta = i.house.gridImportW < RECOVER_IMPORT_W && s.ampHold === 0 ? Math.min(delta, AMP_STEP) : 0;
  } else if (delta < 0) {
    s.ampHold = DERATE_HOLD_TICKS;
  }
  const target = clampAmps(i.site, s.lastAmps + delta);
  if (target !== s.lastAmps) {
    a.push({ kind: "set_amps", amps: target });
    s.lastAmps = target;
  }
}

/**
 * GLIDE (battery at the house reserve; was SOLAR_TRACK until 2026-10-05):
 * the car follows the PV surplus plus a glide allowance that spreads the
 * energy above the DECAYING reserve evenly until the free window. Below the
 * reserve nothing runs on the battery (reserve_hit). While stopped, restarts
 * on sustained sun or once the bank can carry the car's minimum — for
 * BANK_RUN_MINS (glide_mode asap) or all the way to the window (continuous).
 */
function morningGlide(
  i: DecideInputs,
  s: StoredState,
  a: Action[],
  h: {
    charging: boolean;
    stop: (reason: string) => void;
    start: (amps: number) => void;
    canStart: () => boolean;
    learnFloor: () => void;
  },
): void {
  const varsOk = i.house.pvW !== null && i.house.feedinW !== null;
  // Glide (2026-09-29): spread the battery's energy above the reserve
  // evenly until 11:00, on top of the PV, instead of leaving it idle for
  // the free refill. One tick of buffer so the last tick doesn't overshoot.
  const minsLeft = i.site.windowStartMins - i.nowMins;
  const bankWh = (i.house.socPct - s.reservePct) * i.site.batteryKwh * 10;
  const spendW = Math.max(0, bankWh) / ((minsLeft + GLIDE_BUFFER_MINS) / 60);
  // The battery may cover up to spendW, net of what it is ALREADY discharging
  // (energy balance, as SOLAR_SOAK) — the meter can't see that drain, so
  // without subtracting it the allowance would ratchet the amps up every tick.
  const allowanceW = spendW - batteryDischargeW(i.house);

  if (!varsOk) {
    // degrade to floor-hold: stop, wait for the free window (SPEC fallback)
    if (!s.solarVarsAlerted) {
      a.push({ kind: "notify", message: "pvPower/feedinPower missing — solar tracking disabled, floor-hold" });
      s.solarVarsAlerted = true;
    }
    if (h.charging && s.sessionOwner === "system") h.stop("solar_vars_missing");
    return;
  }

  if (h.charging) {
    if (s.sessionOwner !== "system") return;
    if (s.lastAmps === null) s.lastAmps = carAmpsOf(i);
    if (i.house.socPct <= s.reservePct && i.house.loadW - i.house.pvW! > RESERVE_BLEED_W) {
      // Self-Use keeps the meter at ~0 while the battery covers the car, so
      // the amp loop below is blind to battery drain until the hardware
      // floor. At/below reserve anything PV doesn't cover comes from the
      // battery or paid grid — stop now (2026-07-08: the 1 A/tick ramp
      // bled the battery from reserve to the 10% floor, then imported).
      h.stop("reserve_hit");
      return;
    }
    // failsafe: if amp commands are failing and import persists, stop
    if (i.house.gridImportW > SUSTAINED_IMPORT_W) {
      if (++s.highImportTicks >= SUSTAINED_IMPORT_TICKS) {
        h.stop("sustained_import");
        h.learnFloor();
        a.push({ kind: "notify", message: "GLIDE: sustained grid import — stopped charge" });
        s.highImportTicks = 0;
        return;
      }
    } else {
      s.highImportTicks = 0;
    }
    // Closed loop on the meter; floor() + margin bias errors toward export.
    const delta = Math.floor((carRoomW(i, allowanceW) - EXPORT_MARGIN_W) / i.site.wPerAmp);
    const target = clampAmps(i.site, s.lastAmps + delta);
    if (target === i.site.minAmps && s.lastAmps === i.site.minAmps && i.house.gridImportW > STOP_IMPORT_W) {
      h.stop("below_solar_min"); // surplus can't sustain the car's minimum draw
      h.learnFloor();
    } else if (target !== s.lastAmps) {
      a.push({ kind: "set_amps", amps: target });
      s.lastAmps = target;
    }
    return;
  }

  // Stopped. Resume throttle: 15 min of sustained surplus, capped per day (wear).
  const surplus = i.cfg.solarTrack ? i.house.pvW! - i.house.loadW : 0;
  s.surplusStreak = surplus >= i.site.minAmps * i.site.wPerAmp + RESUME_HEADROOM_W ? s.surplusStreak + 1 : 0;
  // Solar bank: PV the battery absorbed above reserve (loadsPower is
  // house-only while the car is off). Resume once that bank plus today's
  // surplus carries the car's minimum for the run length the mode wants:
  //   asap        — BANK_RUN_MINS (or to the window if that is sooner): less
  //                 morning PV is stranded if the owner drives off early,
  //                 at the cost of a stop/restart cycle every time the
  //                 decaying reserve frees another few percent.
  //   continuous  — all the way to the window: one contactor cycle, and the
  //                 car carries straight on into FREE_WINDOW.
  // Either way the run ends at reserve via reserve_hit (battery above
  // reserve covers any shortfall, so no import).
  const runMins = i.cfg.glideMode === "continuous" ? minsLeft : Math.min(BANK_RUN_MINS, minsLeft);
  const needWh = (Math.max(0, i.site.minAmps * i.site.wPerAmp - surplus) * runMins) / 60;
  const banked = i.cfg.solarTrack && bankWh > 0 && bankWh >= needWh;
  if ((s.surplusStreak >= RESUME_STREAK_TICKS || banked) && s.solarResumes < MAX_SOLAR_RESUMES && h.canStart()) {
    s.surplusStreak = 0;
    s.solarResumes++;
    h.start(startAmps(i, allowanceW));
  }
}

/**
 * SOLAR_SOAK (after the free window, see SPEC): the battery is full and
 * Self-Use curtails the PV it can't place, so the car soaks it up. The meter
 * can't see curtailed headroom, so the loop runs on the battery instead:
 *   batteryW = feedin - import - (pv - load)   (energy balance, + = discharging)
 * Discharging -> the car outran the sun: step down. Otherwise take visible
 * surplus (export, or PV into the battery), and while the battery is full
 * probe up 1 A per tick — the inverter un-curtails to meet the new load, or
 * the battery shows it next tick. The full battery is only a buffer:
 * SOAK_MIN_SOC is the hard stop, so the evening export and next morning's
 * dump are untouched.
 * soak_export 'false' (2026-10-05): export is worth keeping, so the car may
 * only eat PV the inverter is curtailing — observable as feed-in sitting at
 * the EXPORT_LIMIT_W cap with a full battery. The export term is dropped,
 * starts and probes need the cap reached, and feed-in falling below the cap
 * while charging means the car is eating export: step down, stop at the
 * minimum. Without the cap var curtailment is invisible, so no soak starts.
 */
function soak(
  i: DecideInputs,
  s: StoredState,
  a: Action[],
  h: {
    charging: boolean;
    full: boolean;
    canAct: boolean;
    soakOn: boolean;
    stop: (reason: string) => void;
    start: (amps: number) => void;
    canStart: () => boolean;
  },
): void {
  const own = h.charging && s.sessionOwner === "system";
  if (!h.soakOn) {
    if (own && h.canAct) h.stop("soak_end");
    s.state = "DONE";
    return;
  }
  if (!h.canAct || h.full) return;
  if (i.house.pvW === null || i.house.feedinW === null) {
    if (!s.solarVarsAlerted) {
      a.push({ kind: "notify", message: "pvPower/feedinPower missing — afternoon solar soak disabled" });
      s.solarVarsAlerted = true;
    }
    if (own) h.stop("solar_vars_missing");
    s.state = "DONE";
    return;
  }
  if (s.soakHold > 0) s.soakHold--;
  const spareW = i.house.pvW - i.house.loadW; // PV beyond house + car
  const batteryW = i.house.feedinW - i.house.gridImportW - spareW;
  // Curtailed-only mode: the export cap we must leave untouched (null = the
  // cap is unknown, so curtailment can't be seen and nothing starts).
  const capW = i.cfg.soakExport ? null : i.site.exportLimitW;
  const atCap = capW === null ? i.cfg.soakExport : i.house.feedinW >= capW - EXPORT_MARGIN_W;
  const exportLostW = capW === null ? 0 : Math.max(0, capW - EXPORT_MARGIN_W - i.house.feedinW);

  if (own) {
    if (s.lastAmps === null) s.lastAmps = carAmpsOf(i);
    const stopSoak = (reason: string) => {
      h.stop(reason);
      s.soakHold = SOAK_RESTART_HOLD_TICKS;
      s.soakLowTicks = 0;
    };
    const shed = (w: number, reason: string) => {
      if (s.lastAmps! <= i.site.minAmps) {
        if (++s.soakLowTicks >= SOAK_LOW_TICKS) stopSoak(reason);
      } else {
        s.soakLowTicks = 0;
        const target = clampAmps(i.site, s.lastAmps! - Math.ceil(w / i.site.wPerAmp));
        a.push({ kind: "set_amps", amps: target });
        s.lastAmps = target;
        s.soakHold = SOAK_STEP_HOLD_TICKS;
      }
    };
    if (i.house.socPct < SOAK_MIN_SOC) {
      stopSoak("soak_battery_low");
    } else if (batteryW > SOAK_DISCHARGE_W) {
      shed(batteryW, "soak_below_min");
    } else if (exportLostW > 0) {
      shed(exportLostW, "soak_export_lost"); // the car is eating export we want to keep
    } else {
      s.soakLowTicks = 0;
      // Visible surplus: export or PV into the battery (default), or only
      // the PV the battery is absorbing (curtailed-only: spare minus export).
      const visibleW = capW === null ? Math.max(i.house.feedinW - i.house.gridImportW, spareW) : -batteryW;
      let target = s.lastAmps + Math.max(0, Math.floor((visibleW - EXPORT_MARGIN_W) / i.site.wPerAmp));
      if (target === s.lastAmps && s.soakHold === 0 && i.house.socPct >= SOAK_START_SOC && atCap) target++; // probe
      target = clampAmps(i.site, target);
      if (target !== s.lastAmps) {
        a.push({ kind: "set_amps", amps: target });
        s.lastAmps = target;
      }
    }
  } else if (
    !h.charging &&
    i.house.socPct >= SOAK_START_SOC &&
    atCap &&
    i.nowMins < i.site.soakEndMins - SOAK_LAST_START_LEAD_MINS &&
    s.soakHold === 0 &&
    s.soakStarts < SOAK_MAX_STARTS &&
    h.canStart()
  ) {
    // Full battery = PV is (probably) being curtailed. A failed probe costs
    // at most SOAK_LOW_TICKS of the car's minimum from a full battery.
    s.soakStarts++;
    s.soakLowTicks = 0;
    h.start(i.site.minAmps);
  }
}
