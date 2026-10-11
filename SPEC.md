# Design specification

Numbers and clock times in this document describe the **reference install**
the design was developed on (see "Reference install"). On your install they
come from the site vars in `wrangler.jsonc` (`TIME_ZONE`,
`FREE_WINDOW_START`/`END`, `DAY_START`, `SOLAR_SOAK_END`, `BATTERY_KWH`,
`BATTERY_MIN_SOC`, charger volts/phases/amps, `HOME_RADIUS_M`,
`INVERTER_MAX_W`, optional `EXPORT_LIMIT_W`) — read
"11:00" as "free-window start", "14:00" as "free-window end", "05:30" as
`DAY_START`, "42 kWh" as `BATTERY_KWH`, "10% BMS minimum" as
`BATTERY_MIN_SOC`, "16 A" as `CHARGER_MAX_AMPS`, "15 kW inverter" as
`INVERTER_MAX_W`, and so on. The 8 kW
floor-hit import trigger and 4.5 kW solar-resume surplus scale with the
charger (72.5% of max draw; minimum draw + 1.05 kW). "The owner" is
whoever runs the install. Dated notes are the design's decision log.

## Problem

The reference install has a 42 kWh FoxESS battery + 15 kW hybrid inverter
and a Tesla Model Y LR (11 kW three-phase AC charging). Grid power is free
11:00–14:00 local time every day, but the car is usually away during the
free window. Goal: each morning, transfer surplus home-battery energy into
the car before departure, while guaranteeing the house has enough battery to
reach 11:00, at which point the battery refills to 100% for free. If the car
is still home during the window it charges directly from free grid power.

## Why dumping is always correct

Energy moved battery→car costs nothing: the battery refills to 100% during
the free window regardless (owner-verified; 15 kW inverter easily refills
42 kWh in 3 h). The ~12–15% round-trip loss (battery DC→AC, car AC→DC) is a
loss of free energy. Therefore: always dump the maximum available above the
house reserve. There is no marginal-cost optimisation to do pre-window.

During the window there is no contention: the car's 11 kW comes from the
grid directly, the battery force-charges in parallel through the inverter.

The reference install's evening export (18:00–21:00, see "Reference install") does
not change this: it sells energy from the same free 11:00–14:00 refill, so a
morning dump never competes with export revenue.

## Control strategy

No attempt to predict "is the car leaving today". The system reacts:
charge whenever (plugged in at HOME ∧ car SoC < car's charge limit ∧ battery
above reserve). Unplugging ends the session naturally. Same logic works
weekends and holidays with zero calendar awareness.

Home gate (promoted from "optional" to hard gate 2026-07-05): NO car command
is ever sent unless the cached drive_state lat/lon is within 150 m
(haversine) of home_lat/home_lon (config). Without this, DUMPING would start
a PAID session at a work AC charger — invariant 6 only protects sessions
already running (a supercharger auto-starts, so it's covered by accident),
not an idle away plug. Location missing or malformed → treat as NOT home,
do nothing, log; alert once if that persists 3+ ticks while the car reports
plugged in. "Plugged in" everywhere in this spec means plugged in at home.

Bluetooth presence (added 2026-10-05, src/presence.ts): a device at home
(scripts/ble-presence.py on a Pi, or Home Assistant / any automation) POSTs
`/presence` (Bearer PRESENCE_KEY; `home=true|false` as query or JSON body,
optional `source`) whenever it does or doesn't see the car's BLE
advertisement. One row in the `presence` table, stamped with the Worker's
clock. D1 config `home_detection` picks the gate:
  gps (default)      — GPS geofence only (behaviour before bluetooth)
  bluetooth          — fresh "home" report only; for car APIs with no or
                       privacy-blurred location
  gps_or_bluetooth   — either; covers GPS drift in a garage
  gps_and_bluetooth  — both; strictest
A report counts only while ≤ PRESENCE_MAX_AGE_MINS (15) old, so a dead
scanner decays to NOT home — the same fail-safe as an unknown location. An
unknown home_detection value fails the tick (alert) rather than silently
switching signal. Every decision row logs {mode, gps, bluetooth, presence}.
home_lat/home_lon stay required in every mode: the nightly charge
exclusion still geofences charge-history locations.

The house reserve is enforced in HARDWARE: `minSocOnGrid` on the FoxESS
Self-Use scheduler group (statically set by the owner — see PLAN). A dead
controller cannot drain the house. The software detects "battery hit the
floor" by battery SoC ≤ reserve or grid import jumping to ~11 kW, then
throttles the car to the live PV surplus (GLIDE), stopping it only
when the surplus cannot sustain the car's 3.45 kW three-phase minimum.
Missed ticks cost a few minutes of paid grid power — bounded downside.

Manual override (owner-confirmed design, 2026-07-04): the system NEVER stops
a charging session it did not start. If a tick sees the car Charging without
the system having sent start_charging — e.g. the owner pressed start in the
Tesla app after a floor-stop to deliberately grid-charge before a long drive
(home grid ≈ half supercharger price) — the controller backs off for that
session and sends ONE ntfy note ("manual grid charge detected, not
interfering"). The Tesla app start button is the escape hatch; no pause
endpoint. Raising the car's charge limit is the "big drive tomorrow" knob.
Session ownership lives in days.state_json (sessionOwner); the audit trail
is the decisions table.

## State machine (ticks every 5 min, 05:30–17:45 local)

States: IDLE → DUMPING → GLIDE → FREE_WINDOW → SOLAR_SOAK → DONE. PLAN is the
first-tick-of-day event (creates the day's stored state), not a state.
(GLIDE was called SOLAR_TRACK until 2026-10-05; a state row persisted under
the old name is read as GLIDE.)

One morning controller (2026-10-05): DUMPING and GLIDE share a single amp
formula, src/tick.ts carRoomW. Watts the car may add (+) or must shed (−),
before the 250 W export margin:
    meterW     = feedin − import           (ground truth: + export, − import)
    pvSpareW   = pv − load                 (PV the battery is absorbing; loadsPower includes the car)
    allowanceW = battery power the car may draw: the inverter's whole
                 output in DUMPING (∞); in GLIDE the glide budget net of
                 what the battery already discharges (may be negative)
    import > 250 W → room = meterW + min(0, allowanceW)
                     (shed the import and any battery over-draw; a positive
                     allowance is IGNORED — a stale bank, or a battery that
                     cannot discharge at its hardware floor, must never
                     ratchet the car up on paid grid; the old GLIDE loop
                     could for a tick or two until the failsafes caught it)
    otherwise      → room = min(INVERTER_MAX_W − load, max(meterW, pvSpareW) + allowanceW)
The inverter term is new: DUMPING used to open at CHARGER_MAX_AMPS and
derate 2 A per tick on import, which on the 15 kW reference inverter never
fired but on a 5–10 kW FoxESS (most of them) meant several kW of paid
import for 15–20 min every morning. Starts now open at what fits under the
inverter after house load (a 6 kW inverter with the 11 kW charger starts at
7 A, not 16); the meter still closes the loop, because the real ceiling may
be a battery/BMS limit the var cannot know. feedin/pv missing degrade to
the meter alone, so DUMPING keeps working without them.

PLAN (first tick of day, ~05:30)
  reserve_kwh = forecast_house_load(now → 11:00) × safety_factor(1.3)
  reserve_pct = clamp(ceil(reserve_kwh / 42 × 100) + floor, 10, 100)
    where floor = max(10, minSocOnGrid read at PLAN; 10 if the read fails)
  Reserve ON TOP of the floor (owner, 2026-09-27 — supersedes the
  "effective reserve = max(forecast, floor)" rule and the floor-drift alert
  below): the owner never wants the house on grid because the battery hit
  its minimum. The inverter won't discharge below minSocOnGrid, so the
  house's energy until 11:00 must sit above it, whatever the floor is. Every
  floor ≥ 10% is therefore valid and there is no "floor too low" alert;
  only a failed floor read alerts. With the floor at 10% this is exactly the
  original formula. A floor read failure assumes 10%; if the real floor is
  higher, the first import stop learns it (see GLIDE "Learned floor").
  Decaying reserve (owner, 2026-09-29): PLAN stores the per-half-hour
  forecast until 11:00 (days.state_json slotKwh) and the effective floor;
  every tick re-derives reserve = floor + ceil(remaining need × 1.3 / 42 ×
  100), pro-rating the current half-hour. It equals the formula above at
  PLAN and falls to the floor at 11:00 (e.g. flat 0.4 kW house: 17% at
  06:00, 13% at 09:00, 11% at 10:45). Safe by construction: the house's
  own draw is what shrinks the need, and the 1.3 factor stays on what is
  left. State rows persisted before this change keep their fixed reserve.
  Original floor strategy, SUPERSEDED where it conflicts with the above (decided 2026-07-04, confirm with ~2 weeks of data): the
  house load is flat (~0.4 kW), so reserve_pct is expected to be near-constant
  (~17–20%). Plan of record: the owner sets minSocOnGrid ONCE, manually, in
  the FoxESS app at step-5 go-live; the controller stays READ-ONLY on the
  inverter — PLAN computes reserve_pct for the decision log, uses it for the
  software-side dump cutoff, and VERIFIES the configured hardware floor
  (alert on drift). Revert to daily writes only if the computed reserve
  varies by more than a few points day-to-day.
  Owner-raised floor (2026-07-10): 10% is the manufacturer BMS minimum; the
  owner may set minSocOnGrid HIGHER in the FoxESS app, and the software must
  respect that. PLAN reads minSocOnGrid (the same read the verify uses) and
  the day's effective reserve is max(forecast reserve_pct, minSocOnGrid) —
  so DUMPING stops AT an owner-raised floor instead of planning through it
  (the inverter would stop discharging there and the shortfall would be paid
  grid import until the derate/sustained-import failsafes caught it). An
  owner-raised floor is NOT drift; the drift alert fires only when the floor
  is below the forecast reserve. The floor is read once at PLAN — a mid-
  morning change is picked up next day, bounded meanwhile by the hardware
  floor and the import failsafes.
  Fallback: if FoxESS unreachable at PLAN, use the forecast-only reserve
  (hardware still enforces the floor); alert.

  forecast_house_load: rolling mean of same-half-hour load over last 5
  weekdays (or all days — configurable) from stored telemetry samples.
  Bootstrap with flat 1.0 kW until 7 days of history exist.

DUMPING (car plugged in, car_soc < car_limit, battery_soc > reserve_pct)
  Send start_charging at the amps the inverter can deliver after house load
  (16 A on the reference install; see "One morning controller" above).
  Each tick verify charging_state == "Charging"; if command sent but not
  charging after 2 ticks → alert.
  Grid import > 250 W while dumping (battery derated/limiting, or the
  inverter var optimistic): shed amps sized to the import in one step
  (floor((−import − 250) / 690): 3.4 kW of import at 16 A → 10 A), then
  hold 3 ticks and probe back up 2 A per tick while import stays < 100 W.
  Bounded hunting of ±2 A on a 20-min period at a hard battery limit,
  instead of the old fixed 2 A/tick in both directions (which hunted every
  tick). Export visible while dumping (sunny late morning) is taken the
  same way, capped by the inverter.
  Exit → GLIDE when battery_soc ≤ reserve_pct (predictive, the normal
  path) or grid import > 8 kW (floor hit before a SoC read caught it:
  inverter stopped discharging, car now on grid). GLIDE's first tick
  throttles or stops the car — no separate stop here.
  Quantised exit (noted 2026-10-05): the SoC check runs every 5 min at
  full draw, ~920 Wh ≈ 2.2% of the reference battery per tick, and the
  cloud read reports whole percent, so the dump routinely overshoots the
  reserve by a point or two before GLIDE stops it. The 1.3 safety factor
  absorbs it (≈ 0.65 kWh of margin on a 2.2 kWh need); don't read the
  exit as exact, and don't tighten the factor without shortening the tick.
  Exit → FREE_WINDOW at 11:00. Exit → IDLE if unplugged.

GLIDE (battery at reserve; car follows PV surplus plus the bank above the
decaying reserve — added 2026-07-05 as SOLAR_TRACK, renamed 2026-10-05)
  Renamed because on most mornings here it is not tracking the sun: the
  battery is the buffer that catches morning PV and the decaying reserve
  frees energy above it, and GLIDE spends that bank into the car. Direct
  PV tracking stays (the pv − load term) and matters on installs with
  enough roof to carry the car's minimum, but the state's job is "hold the
  reserve, glide the rest to the window".
  Replaces FLOOR_HOLD. Rationale: on stay-home mornings the dump reaches the
  reserve well before 11:00. Stopping outright wastes the morning PV — the
  battery it would otherwise charge refills for free at 11:00 anyway — and
  without this state a car left charging at the floor pulls the shortfall
  from the PAID grid until the owner notices. Load-follow the car instead:
  grid import stays ~0, house battery holds at reserve.
  Entered from DUMPING at the floor, or directly from PLAN if the battery
  is already ≤ reserve at 05:30. System-started sessions only — invariant 6
  applies to throttling exactly as to stopping.

  Constants (code, not config): 690 W per amp (three-phase 230 V),
  min 5 A ≈ 3.45 kW (the car refuses lower), max 16 A, export margin 250 W.

  While charging:
    Stop IMMEDIATELY (reserve_hit) when battery_soc ≤ reserve AND
    load_W − pv_W > 250: the meter reads ~0 while the battery covers the
    car in Self-Use, so the amp loop below is blind to battery drain above
    the hardware floor. Without this rule the 1 A/tick ramp-down bled the
    battery from reserve (16%) to the 10% floor in ~10 min and the car
    then ran on PAID grid until below_solar_min caught it (2026-07-08,
    ~1 kWh paid import). At/below reserve a charge may only run on PV
    that covers the whole load; otherwise:
    amps += floor((feedin_W − import_W − 250) / 690), clamped to [5, 16]
    (since 2026-10-05 via the shared carRoomW formula above, with the
    glide allowance and the inverter cap folded in).
    Closed loop on the METER, not pv−load arithmetic: mains-voltage error
    (~3%) and car-side taper make an open-loop estimate drift into
    sustained import; the meter is ground truth. floor() plus the 250 W
    margin bias rounding error toward export, never import. Converges in
    1–2 ticks after a floor-hit or a cloud edge (e.g. entry from DUMPING
    at 16 A with 6 kW PV: import ≈ 5.4 kW → step −9 → 7 A ≈ 4.8 kW ✓).
    Stop when clamped at 5 A AND import > 250 W (surplus can't sustain the
    car's minimum) → stop_charging. Worst case one tick ≈ 25 Wh of import.
    Morning PV into the battery (2026-09-27): below the battery's reserve
    Self-Use routes spare PV into the battery and feedin reads 0, so the
    meter term alone never steps up. The loop uses
    max(feedin_W − import_W, pv_W − load_W) — loadsPower includes the car,
    so pv − load is PV left after house + car, i.e. what the battery is
    absorbing. The larger of two non-import quantities cannot push the car
    onto the grid; the 250 W margin covers the ~3% DC-vs-AC PV reading bias.
    Glide (2026-09-29): the reserve DECAYS through the morning (see PLAN
    "Decaying reserve"), so energy appears above it as the house uses up
    its need — at 10:45 the house needs 15 min of load, not the 05:30
    figure (owner saw the car idle at 10:45 with the battery well above
    what the house needed). The bank above the current reserve is spread
    evenly until 11:00: spendW = bankWh / (minutes to 11:00 + 5) × 60, one
    tick of buffer so the last tick can't overshoot. The amp loop adds
    spendW − (battery discharge already happening, by energy balance) to
    its surplus; netting the discharge is essential — the meter can't see
    it, and a bare allowance ratchets the amps up every tick. Gentle when
    early (a 4 kWh bank at 08:00 ≈ 1.3 kW), faster close to 11:00, then
    the car carries straight on into FREE_WINDOW without a contactor
    cycle. SoC resolution (noted 2026-10-05): the bank is derived from the
    cloud's whole-percent SoC, so on the reference battery it moves in
    420 Wh steps and the glide rate with it (one point at 10:30 ≈ 720 W of
    allowance appearing at once). That is the floor on how smooth the
    glide can be from the cloud API; a local Modbus feed would lift it.
    Replaces the old SOLAR_TRACK → DUMPING re-entry at reserve + 5
    (a 16 A burst): energy above the reserve always glides now. The early
    DUMPING at 16 A is unchanged — the owner wants that before commuting.
  While stopped:
    Solar bank (2026-09-27): resume at 5 A as soon as the energy above
    reserve ((soc − reserve) × 420 Wh) covers max(0, 3.45 kW − (pv − load))
    for 20 min — i.e. banked PV plus current sun can carry the car's
    minimum for a full run. Previously banked PV reached the car only once
    it hit reserve + 5% (≈ 2.1 kWh) and DUMPING re-entered at 16 A; on a
    morning the owner leaves before 11:00, up to that much PV was left in
    a battery that refills free at 11:00 anyway. Now at most ~1–4% is left
    stranded, and the car runs gently at 5 A (amp loop above) until
    reserve_hit. Learned floor (review fix, 2026-09-27): a below_solar_min
    or sustained_import stop, or DUMPING's 8 kW import exit, raises the
    day's reserve to the current SoC — import above the planned reserve
    proves the battery won't discharge there (hardware floor above plan,
    e.g. PLAN's floor read failed, or a derated battery). Without it the
    bank restart saw "3% above reserve" and restarted onto paid grid every
    tick until the cap. Only ever raises (and with the decaying reserve,
    the house's remaining need is re-added on top of the learned floor).
    Counts against the same 4-resume daily wear cap; past the cap the car
    waits for FREE_WINDOW. Battery above reserve covers any shortfall, so
    no import. Gated on solar_track. The run only has to last
    min(20 min, time to 11:00): close to the window it continues into
    FREE_WINDOW without a stop. Starts at the amps sun + glide support
    (≥ 5 A), not always 5 A.
    glide_mode (D1 config, 2026-10-05; default asap = the rule above):
    the car's minimum draw (3.45 kW three-phase) is far above the glide
    rate for most of a sunless morning, so in practice the glide is
    bang-bang: restart at 5 A, drain the bank in ~20 min, reserve_hit,
    wait ~2 h for the decaying reserve to free another 3%, repeat — two
    or three contactor cycles on a stay-home morning, bounded only by the
    4-resume cap. (How far above depends on the roof: with enough PV to
    carry the minimum the pv − load term keeps the car running and the
    bank just tops it up.) 'continuous' instead restarts only once the
    bank plus the current surplus can carry the car's minimum ALL THE WAY
    to the window: needWh = max(0, 3.45 kW − (pv − load)) × minutes to
    11:00. One contactor cycle, no stop, straight into FREE_WINDOW; the
    energy sits in the battery longer, so on a morning the owner drives
    off at 09:30 a little more is stranded. With no sun that start lands
    minutes before the window; with 2 kW of surplus from 09:00, around
    09:50. The sustained-sun restart (next paragraph) is unaffected, and
    the run still ends at reserve via reserve_hit if the sun drops.
    Sun-only resume (unchanged): at 5 A only when the last 3 ticks (15 min) ALL showed
    pvPower − loadsPower ≥ 4.5 kW, capped at 4 solar resumes per day —
    past the cap stay stopped until FREE_WINDOW, log it. The 3-in-a-row
    rule gives dwell time and sustained-sun in one condition: flickering
    cloud never passes it, so worst-case cycling is ~3/hr and the daily
    cap bounds the pathological day. The meter can't see surplus here —
    at the floor Self-Use routes spare PV into the battery, so feedin
    reads 0 — hence PV arithmetic for resume only (loadsPower is
    house-only while the car is off).
  Practical note for THIS house (owner-confirmed 2026-07-08): the array is
  6.6 kW split east/west and rarely nears rated output, so pre-11:00 PV can
  almost never cover house + the car's 3.45 kW minimum. Expect reserve_hit
  to be the normal exit for a running charge at the reserve, the 4.5 kW
  resume threshold to essentially never fire, and GLIDE to behave as
  floor-hold: car stopped, battery holding at reserve, waiting for 11:00.
  The tracking/resume logic stays — it is the correct behaviour on the
  days the sun does deliver — but do not expect it to run often, and do
  not "fix" quiet mornings by lowering the resume threshold below what
  sustains the car's minimum draw.
  Wear asymmetry (owner-requested 2026-07-05): stops stay IMMEDIATE — at
  the floor a deficit is paid grid import, and an extra stop costs less
  than the import it prevents. Only restarts are throttled, because
  cycling, not stopping, wears the contactor. Amp changes are contactor-
  free (pilot-signal PWM) and need no throttle beyond no-op dedupe: never
  send set_charging_amps when target == current amps.
  Re-sync (2026-10-05): the loops reason from lastAmps, the value last
  commanded. Once a command has had a tick to land (state ampsPending
  clears on the next quiet tick), a system session whose car reports
  different amps — the owner changed them in the Tesla app, or set_amps
  was accepted but not applied — adopts the car's value, so the next step
  is relative to reality rather than to a number the car never reached.
  Never for owner sessions (nothing is commanded for them), and never
  when the provider reports no amps (the charger max is assumed only for
  a session we didn't start).
  Throttle counters (consecutive-surplus ticks, resumes today) live in
  stored state like everything else the pure tick reads.
  Battery absorption while charging is visible via pv − load (above) and
  anything the battery does bank above the reserve is glided back out.
  Exit → FREE_WINDOW at 11:00. Exit → IDLE if unplugged.
  Fallback: if feedinPower/pvPower are absent from the real-time response
  (the device's missing variables are silently omitted), degrade to the old
  FLOOR_HOLD behaviour — stop at floor, wait — and alert once. Confirm both
  variables exist for this inverter during the step-5 shadow week.
  Config: solar_track flag, default on; off = FLOOR_HOLD behaviour.

FREE_WINDOW (11:00–14:00)
  If car present: ensure charging at 16 A (free grid). FoxESS ForceCharge
  group (static config) refills battery in parallel.
  Adoption rule (2026-07-05): unclaimed charging observed in-window at home
  (typically the KEPT native 11:00 Tesla schedule firing) is adopted as a
  system session — same goal, and adoption restores the 14:00 stop. Sticky
  pre-window owner sessions are untouched.
  At 14:00: if car_soc < stranded_min (config, default 30%) → alert and
  leave charging (paid) — never strand the owner — and go DONE. Otherwise
  hand a system session to SOLAR_SOAK throttled to the visible PV
  (set_amps, no contactor cycle), or stop_charging when solar_soak is off.

SOLAR_SOAK (14:00–17:30; added 2026-09-27)
  Rationale (owner, 2026-09-27): the battery reaches 100% in the window, so
  from 14:00 Self-Use CURTAILS the PV it can't place (export limited /
  worth little — the paid 15 kWh/day is used by the 18:00 export). That PV
  is free energy the car can take, and on low-battery mornings the window
  alone doesn't fill the car.
  Curtailment hides headroom from the meter (pv == load, feedin at its
  cap), so the loop runs on the full battery as a buffer instead:
    battery_W = feedin − import − (pv − load)   (energy balance, + = discharge)
  using only variables already in the one real-time read (no new API
  calls; batChargePower/batDischargePower deliberately not relied on).
  While charging (system sessions only, invariant 6):
    SoC < 90% → stop (soak_battery_low). Hard guard: the car may borrow at
      most ~4 kWh, so the 18:00 export (no fdSoC floor) and the next
      morning's dump are untouched.
    battery_W > 300 → the car outran the sun: step down ceil(battery_W/690)
      A, then hold 3 ticks before probing up again. Already at 5 A → stop
      on the 2nd consecutive tick (soak_below_min; one tick rides out a
      cloud, worst case ≈ 2 ticks × 3.45 kW from a full battery).
    else take visible surplus max(feedin − import, pv − load) − 250 W in
      one step; if none and the battery is full (≥ 97%, i.e. curtailing)
      probe +1 A per tick — the inverter un-curtails to meet the load, or
      the battery shows the shortfall next tick. A failed probe costs
      ≈ 58 Wh from a full battery.
  While stopped: start at 5 A when SoC ≥ 97%, before 16:30, ≥ 30 min after
    the last soak stop, ≤ 3 starts per afternoon (wear), start not blocked
    (an owner stop of a soak session stands down for the day as usual).
  At 17:30 stop (soak_end) → DONE — well before the 18:00 export.
  pvPower/feedinPower missing → alert once, stop, DONE (old 14:00 stop).
  Config: solar_soak flag, default on; 'false' = the old 14:00 stop.
  soak_export (D1 config, 2026-10-05; default on): the loop above also
  takes PV that is being EXPORTED (the feedin − import term), not only
  curtailed PV. On the reference plan that is right — exporting costs
  money once the paid 15 kWh/day is done, so any PV the inverter would
  push out or clip may as well go into the car. On a plan that pays a
  feed-in tariff, export is worth keeping, and a car that eats it is
  displacing free window charge tomorrow. 'false' = curtailed PV only,
  which needs the EXPORT_LIMIT_W site var (0 for a zero-export site):
  curtailment is observable only as feed-in sitting at the cap with a
  full battery. Then: the export term is dropped (visible surplus = PV
  the battery is absorbing, −battery_W), starts and probes need feed-in
  ≥ cap − 250 W, and feed-in falling more than 250 W below the cap while
  charging means the car is eating export: step down by the shortfall
  (same hold as a discharge step), and at 5 A stop on the 2nd tick
  (soak_export_lost). The 14:00 hand-off throttles to PV beyond house +
  cap, or stops (window_end) when that is under the car's minimum. With
  no EXPORT_LIMIT_W the soak never starts in this mode. The battery-
  discharge rules are unchanged and take precedence.

DONE (post 17:30, or 14:00 with solar_soak off). An EVENING_DUMP (same as
DUMPING with the reserve horizon = house load until 11:00 TOMORROW) was
sketched here but never built; its evening_dump config row is removed by
the schema migration. On the reference install the morning dump already moves
more than the overnight surplus before departure, so it buys nothing.

## FoxESS integration

- Open API, key from foxesscloud.com (User Profile → API Management).
- Auth VERIFIED 2026-07-04 against the official doc (v1.1.18) and the
  TonyM1958 reference, and proven live: headers token / timestamp (ms, as
  string) / signature / lang=en, plus Content-Type: application/json and a
  browser-like User-Agent (the WAF blocks default library UAs).
  signature = lowercase-hex MD5 of path + "\r\n" + key + "\r\n" + timestamp
  where the separator is the LITERAL four characters backslash-r-backslash-n,
  NOT a real CRLF (both the doc's own example and the reference hash Python
  raw strings — do not "fix" this). Path only: no host, query string, or
  body. Envelope { errno, msg?, result }; errno 0 = success.
  Implementation: src/clients/foxess.ts.
- Verified endpoints: real-time = POST /op/v1/device/real/query with
  {sns: [sn], variables} (v0 is deprecated; SoC in %, loadsPower /
  gridConsumptionPower in kW; variables the device lacks are silently
  omitted from the response). Battery variables carry a bank-index suffix on
  our inverter — SoC_1 not SoC (live-verified 2026-07-06; cost the first
  shadow morning to "real-time missing SoC" every tick) — the client requests
  and accepts both. Raw dump for diagnosis: GET /debug/foxess (admin bearer).
  GLIDE adds pvPower + feedinPower to the SAME call — no extra
  API-budget cost; presence confirmed live 2026-07-06. History = POST /op/v0/device/history/query,
  begin/end in ms, span ≤ 24 h; sample times are inverter-LOCAL strings
  ("2026-07-03 00:02:33 AEST+1000" on a UTC+10 install) at ~5-min cadence, may over-run the
  requested day, values may be null. The client fails loud if timestamps
  don't carry TIME_ZONE's UTC offset for that instant (DST-aware) — a wrong cloud-side device timezone would otherwise silently
  phase-shift every slot. Slots are wall-clock half hours: on the 23-h day DST
  starts the skipped hour's slots are absent; on the 25-h day it ends the
  repeated hour's samples share their slots, and the 24-h query cap drops
  that day's last hour (those slots average over fewer days).
- Error codes: 40256 bad headers/signature, 40257 bad body, 40400 rate
  limit, 44096 "cannot update settings when schedule is active" — any future
  setting write must go through the scheduler endpoints while a schedule is
  enabled. Rate limit 1,440 calls/day (queries ≤ 1/s, writes ≤ 1 per 2 s).
  Budget: 1 read per tick (~147/day, 05:30–17:45) + nightly history pull.
  Ample headroom.
- ACTUAL scheduler config (owner-managed in the FoxESS app; the controller
  does not write it — verify-and-alert only):
    11:00–14:00 ForceCharge (free-window refill, as designed)
    18:00–21:00 ForceDischarge to grid, NO fdSoC floor — owner duration-tunes
                it to export ~15 kWh (feed-in tariff pays well only on the
                first 15 kWh/day); battery ends ~50% by 21:00
    otherwise   Self-Use, minSocOnGrid 10% (the old plan to raise it to the
                reserve is dropped: the reserve now sits on top of it)
  The owner may manually skip the evening export before a long drive; that
  stays a manual FoxESS-app action (no calendar awareness).
- Nightly job (LIVE since 2026-07-04; 01:00 local, run from the 5-min cron so
  no cron edit is needed for a different TIME_ZONE or a DST change):
  pull yesterday's loadsPower into half-hour `load_samples`.
  NOTE: loadsPower INCLUDES the EV charger (verified: the owner's manual
  midnight charge showed as ~10 kW in slot 0 on 2026-07-03). Charge
  exclusion happens AT INGEST (2026-07-05, src/charges.ts): both the
  nightly pull and the backfill fetch Tessie charge history and DROP any
  half-hour slot overlapping a home charge session before insert. Tessie
  history sees ALL charges — including manual off-hours charges, which
  happens outside the tick window and is therefore invisible to the
  sessions table; the earlier plan to filter via recorded sessions is
  superseded. Unknown charge location counts as home (wrongly excluding a
  slot only pushes that slot toward other days' mean or the conservative
  bootstrap; wrongly keeping one bakes ~10 kW of charger into the house
  forecast). Away charges are filtered by the same 150 m haversine as the
  command geofence. Ingest fails loud if the charges call fails — a day
  with unfilterable EV load must not enter the forecast.
- Backfill (added 2026-07-05): POST /backfill?from=YYYY-MM-DD&to=YYYY-MM-DD
  (Authorization: Bearer ADMIN_KEY) seeds load_samples from FoxESS history,
  ≤ 21 days per call (Workers 50-subrequest limit), 1.1 s between FoxESS
  calls (rate limit), one Tessie charges call for the whole range. Same
  charge exclusion as the nightly pull. After seeding, sanity-check morning
  slots with SQL for residual EV-shaped spikes (> ~1 kWh/slot).
- Reference implementation of endpoint quirks: TonyM1958/foxesscloud (PyPI) —
  Python, but documents API behaviour; port patterns, don't depend on it.

## Tessie integration

- Base https://api.tessie.com, bearer token, per-VIN paths.
- Reads: GET /{vin}/state — served from Tessie's cache; does NOT wake the car.
  GET /{vin}/charges?from=&to= (unix seconds) — charge session history, used
  for forecast charge-exclusion at ingest; response shape unverified until
  the first backfill run, client fails loud on surprises (timestamps are
  normalised sec/ms defensively — a wrong unit would silently exclude
  nothing).
  Needed fields: charge_state.battery_level, charging_state,
  charge_port_latch/conn status, charge_amps, drive_state lat/lon (home
  geofence — hard gate on every command, see Control strategy).
- Commands: POST /{vin}/command/start_charging | stop_charging |
  set_charging_amps (query param: amps). Tessie handles virtual-key signing
  and retries.
- Tessie does have saved locations (a separate /{vin}/location endpoint can
  resolve a named "Home"), and the Tesla app has its own Home — neither is
  used: the first costs an extra API call per tick and both depend on
  app-side config that can drift. The geofence is a haversine on the
  drive_state lat/lon already present in the one /state read.
- Poll only during operating window; nothing outside it.
- The owner's native 11:00–14:00 Tesla charge schedule is KEPT permanently
  (decided 2026-07-05, reversing the earlier disable-at-go-live plan): it is
  the dead-controller backstop — if the Worker never ticks again, the car
  still charges free every day at 11:00. The two-schedulers conflict is
  resolved by the ADOPTION RULE instead: charging that appears inside the
  free window, at home, with no existing session claim is adopted as a
  SYSTEM session (native schedule and controller want the same thing there),
  which restores the 14:00 stop. Ownership is sticky: a session the owner
  started before 11:00 stays an owner session through the window and is
  never stopped. The owner's app schedule has an END time too (owner-
  confirmed 2026-07-05: the Tesla app supports charge windows), so the
  dead-controller backstop is bounded at 14:00 — no paid overrun.
- A Tessie account may hold several vehicles; the TESSIE_VIN secret selects
  the one to control. Token + VIN verified live 2026-07-04: cached /{vin}/state returned
  battery_level, charge_limit_soc, charging_state, charge_port_latch and
  charge_amps without waking the car.

## Teslascope integration (alternative car provider, added 2026-10-05)

- Selected instead of Tessie by setting TESLASCOPE_TOKEN +
  TESLASCOPE_VEHICLE_ID (src/clients/car.ts `carFromEnv`). Both providers'
  tokens set, or neither, is a config error: the Worker idles and alerts
  hourly, it never picks one.
- Base https://teslascope.com/api, `Authorization: Bearer <personal access
  token>`. Per-vehicle paths use the Teslascope public ID, not the VIN.
- Reads: GET /vehicle/{id}/detailed — Teslascope's last-polled state
  (does not wake the car); Fleet-API-shaped charge_state / drive_state, so
  the same fields as Tessie. charging_state is preferred; if absent,
  detailed_charge_state ("DetailedChargeStateCharging") is mapped by
  stripping the prefix. An optional { response: … } envelope is unwrapped.
- Commands: POST /vehicle/{id}/command/startCharging | stopCharging
  (verified via the openHAB Teslascope binding) | setChargingAmps
  (UNVERIFIED name; sends both `amps` and `charging_amps` query params).
  A non-2xx throws, so a rejected amps command fails the tick loudly.
- Charge history: GET /vehicle/{id}/charging-history, filtered to the
  requested range client-side. Shape UNVERIFIED: the client accepts the
  plausible spellings (started_at/start_date/…; unix s/ms or a zoned ISO
  string) and fails loud otherwise; zoneless date strings are rejected
  (Workers would read them as UTC). RISK: Teslascope documents this as
  "supercharging (and related)" history. If it omits home AC sessions,
  home charges are NOT excluded from load_samples and inflate the
  forecast (a too-high reserve: suboptimal, never unsafe). After the first
  /backfill, run the residual-spike SQL check under "Backfill" above.
- GET /debug/car (ADMIN_KEY) returns the provider name and the raw state
  payload, for checking these shapes before leaving shadow mode.

## TeslaFi integration (alternative car provider, added 2026-10-05)

- Selected by setting TESLAFI_TOKEN (Settings → Tesla API → API Token).
  The token is per vehicle, so there is no VIN secret. Same one-provider
  rule as above.
- No public API document (teslafi.com/api.php is account-only). Ported
  from two open-source integrations: Sentry-USB run/awake_start (the
  "SentrySix" keep-awake code) and Home Assistant's jhansche/ha-teslafi.
  Not yet live-tested here.
- Single endpoint GET https://www.teslafi.com/feed.php?command=…, with
  `Authorization: Bearer <token>`.
- Reads: command=lastGood — TeslaFi's last logged data point with charge
  data (does not wake the car). Flat Fleet-API field names, values often
  strings: battery_level, charge_limit_soc, charging_state,
  charge_current_request (= the set amps), latitude, longitude.
- Commands: charge_start | charge_stop | set_charging_amps&charging_amps=N,
  each with wake=30 (TeslaFi wakes a sleeping car and waits up to 30 s).
  Each must be ticked under Settings → Tesla API → Commands.
- Failure shapes, all thrown: non-2xx; a 200 with plain text ("This
  command is not enabled…", "Vehicle is asleep or unavailable…"); a JSON
  {error, error_description}; response.result anything but true (false,
  "unauthorized").
- No charge-history call. The nightly pull and /backfill instead drop
  every half-hour slot averaging ≥ the car's minimum draw (CHARGER_MIN_AMPS
  × volts × phases; 3.45 kW = 1.725 kWh/slot on the reference install),
  plus its neighbours for the partial start/end slots (src/charges.ts
  spikeSlots). Same stance as "Nightly job": over-exclude rather than bake
  ~10 kW of charger into the forecast. Known errors: a genuine house load
  that big is dropped (its slot falls back to other days or the 1 kW
  bootstrap, so the reserve can run low there; the safety factor and the
  minSocOnGrid floor absorb it), and a charge shorter than a slot can slip
  through. Run the residual-spike SQL check after the first backfill.

## Reference install (confirmed 2026-07-04)

The facts the reference install's tuning was derived from. Yours will
differ: set the site vars in `wrangler.jsonc` and revisit src/constants.ts.

- The car usually leaves 07:00–08:00 → the dump must effectively finish by
  ~07:00 (it does: ~11 kWh surplus at 11 kW ≈ 1 h from a 05:30 start).
- House load is flat, ~0.4 kW baseline; 05:30→11:00 ≈ 2.2 kWh, so
  reserve_pct ≈ 17% with the 1.3 safety factor.
- Typical day: ~50% SoC at 21:00 (post-export), ~2.4 kWh overnight load,
  ~44% at 05:30, ~11 kWh dumpable → ~9–10 kWh (~60 km) into the car, free.
- The car is sometimes charged manually at odd hours (e.g. midnight) — both the manual-override rule and the ingest-time charge
  exclusion exist because of this.
- Feed-in pays well only on the first 15 kWh/day → the 18:00–21:00 export is
  deliberately ~15 kWh, duration-tuned by the owner, no fdSoC floor.
- Solar array: 6.6 kW rated, split across east and west roofs, so combined
  output is rarely near rated (owner-confirmed 2026-07-08). Consequence: PV
  alone can almost never cover house load + the car's 3.45 kW minimum,
  especially before 11:00 (east panels only) — see the GLIDE note.
- Home geofence centre: kept out of the repo — seed the D1 config keys
  home_lat/home_lon at go-live (README "Setup").

## Data model (D1)

Schema: migrations/0001_schema.sql, one idempotent file (collapsed on
2026-10-05 from four per-step migrations before the repo went public).
wrangler applies local migration names it has not recorded and ignores
recorded names no longer on disk, so a database built by the old files
simply applies the new one once: every CREATE is IF NOT EXISTS, config
defaults are INSERT OR IGNORE, and only the never-used leftovers (the
sessions table, three unread config rows) are removed.

- config(key TEXT PK, value TEXT) — reserve safety factor, stranded_min,
  solar_track flag (default on), glide_mode (asap |
  continuous, default asap), solar_soak flag (default on), soak_export
  flag (default on), shadow_mode flag
  (default ON — commands only sent when explicitly 'false'), home_lat/
  home_lon (geofence), home_detection (gps | bluetooth | gps_or_bluetooth
  | gps_and_bluetooth, default gps). The evening_dump and operating-window
  rows an early migration seeded were never read (the window comes from
  wrangler vars); the schema migration deletes them.
- presence(id = 1, home INT, reported_at TEXT, source TEXT) — latest
  bluetooth / webhook car-presence report
- days(date TEXT PK, reserve_pct INT, planned_at TEXT, state TEXT)
- decisions(id, ts, state_from, state_to, action, inputs_json) — every tick
  that does anything writes a row
- load_samples(date, slot_half_hour INT, load_kwh REAL) — forecast input
- (sessions — created by 0001 for per-session bookkeeping, never written:
  ownership lives in days.state_json, the audit trail in decisions, and
  forecast hygiene happens at ingest from the car API's charge history.
  Dropped by the schema migration.)

## Failure modes → behaviour

- Controller dead: inverter minSocOnGrid floor protects house; car charges
  until its own limit or until floor forces grid draw (owner alerted next
  successful tick). Bounded cost. The kept native Tesla 11:00 schedule
  still delivers the free-window charge with zero working software.
- FoxESS API down at PLAN: reuse yesterday's reserve; alert.
- Grid offline (owner, 2026-09-27): no knowing when the house is
  reconnected, so the battery is for the house only. The real-time read
  also requests runningState (163 on-grid / 164 off-grid per community
  docs — UNVERIFIED on this device, confirm via /debug/foxess; 164 is
  also reported when the datalogger drops offline, when stopping is
  still right). 164 → stop the system charge that tick, one alert, no
  starts in any state until runningState reports anything else (then one
  "back on-grid" note). Missing runningState never clears it. Fallback
  (variable missing or not flipping): from 11:10 to 14:00 ForceCharge
  should feed the car from the grid, so battery discharge (energy
  balance, as SOLAR_SOAK) > 2 kW → same stop + alert, latched for the
  day, since the stopped car hides the symptom. Owner sessions are never
  stopped (invariant 6); the alert tells the owner to stop it in the app.
- Tessie down: cannot start/stop car. House protected by floor. Alert.
- Command accepted but car not charging: alert after 2 ticks.
- Car plugged in away from home (work, supercharger, anywhere): geofence
  gate → no commands at all; away sessions are the owner's business.
- Location missing from cached state: treated as away (fail-safe, no
  commands); alert once if persistent.
- pvPower/feedinPower missing from real-time response: GLIDE degrades
  to stop-at-floor (old FLOOR_HOLD), SOLAR_SOAK to the old 14:00 stop;
  alert once.
- SOLAR_SOAK set_amps failing: the battery covers the car → soak_below_min
  or, at worst, the 90% SoC hard stop; the inverter floor still backstops.
- set_charging_amps fails mid-GLIDE: import persists → next tick steps
  down again (from the amps the car actually reports, once the failed
  command has had its tick — see "Re-sync" above); if import > 2 kW for 3
  consecutive ticks → stop_charging + alert (never sit on sustained paid
  import).
- Every alert via ntfy.sh POST (topic in secrets).

## Costs

- Cloudflare Workers free tier: 288 cron invocations/day, trivial CPU. $0.
- Tessie: already subscribed. FoxESS API: free. ntfy.sh: free.

## Build order

1. ✅ DONE 2026-07-04 — FoxESS client (auth verified against the official
   doc and live-tested), reserve calc + tests, nightly history pull DEPLOYED
   (the only cron registered; the */5 tick cron returns at step 5). Now
   soaking: validate forecast against reality (SQL over load_samples).
2. RESCOPED — no scheduler writes. Pick the static reserve floor from ~2
   weeks of load_samples; owner sets minSocOnGrid manually at go-live. The
   controller gets read-only daily schedule verification + drift alert.
3. ✅ DONE 2026-07-05 — typed Tessie state read (getCarState), manual
   start/stop via POST /car/start | /car/stop (Bearer ADMIN_KEY; an API
   start is an OWNER action — the next tick backs off per invariant 6),
   GET /status.
4. ✅ DONE 2026-07-05 — decide() in src/tick.ts, pure (inputs, stored) →
   (actions, next state); 50+ vitest cases. Session ownership, SOLAR_TRACK (now GLIDE)
   amp controller (clamp edges, stop/resume hysteresis, restart throttle +
   daily cap, no-op amp dedupe, missing-variable fallback, sustained-import
   failsafe), home geofence (unknown location = away), external-stop
   stand-down (owner stopping a SYSTEM session via the app blocks
   auto-starts until the free window, one alert; owner stopping their OWN
   session hands control back). Forecast charge-exclusion ships at ingest
   (src/charges.ts). Persisted state = days.state_json.
   PLAN forecast uses all days of the last 14 (spec offered 5-weekday or
   all-days; all-days chosen — owner's load is flat). Sessions-table
   bookkeeping dropped: ownership lives in state_json, audit in decisions;
   the empty table was dropped on 2026-10-05.
5. ✅ DONE 2026-07-05 — */5 cron live, gated 05:30–14:15 in code (extended
   to 17:45 on 2026-09-27 for SOLAR_SOAK). SHADOW
   MODE ON (config shadow_mode, default true — commands sent only when
   explicitly 'false'): decisions logged with "shadow:" prefix, no car
   commands, no ntfy from actions. Read-failure alerts throttled to one
   per 3 h (every failure still logged to decisions). PLAN verifies
   minSocOnGrid read-only via /op/v0/device/battery/soc/get (endpoint
   shape unverified — fails soft with an alert). GO-LIVE checklist after
   the shadow week: review decisions log → set config
   shadow_mode='false'. (The "owner raises minSocOnGrid to the static
   reserve" step was dropped 2026-09-27: the reserve sits on top of it.) The Tesla native
   11:00–14:00 schedule stays ON as the dead-controller backstop (adoption
   rule, see Tessie integration).
6. Dashboard last (TanStack Start reading D1 via the Worker, or just
   wrangler d1 execute queries until it hurts).
