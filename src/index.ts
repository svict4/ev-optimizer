import { decide, parseGlideMode, type Action, type DecideInputs, type StoredState } from "./tick";
import { FoxEssClient } from "./clients/foxess";
import { carFromEnv, type CarClient, type CarEnv, type CarState } from "./clients/car";
import { excludedSlots, spikeSlots } from "./charges";
import { bluetoothHome, gpsHome, isHome, parseHomeDetection, type PresenceReport } from "./presence";
import {
  DEFAULT_SAFETY_FACTOR,
  DEFAULT_STRANDED_MIN_PCT,
  LOAD_LOOKBACK_DAYS,
  NIGHTLY_PULL_MINS,
  TICK_TAIL_MINS,
} from "./constants";
import { addDays, localMidnightMs, localNow, siteFromEnv, type Site, type SiteVars } from "./site";

export interface Env extends SiteVars, CarEnv {
  DB: D1Database;
  // Car API: set exactly one of TESSIE_TOKEN (+ TESSIE_VIN) or
  // TESLASCOPE_TOKEN (+ TESLASCOPE_VEHICLE_ID); see src/clients/car.ts.
  FOXESS_API_KEY: string;
  FOXESS_DEVICE_SN: string;
  NTFY_TOPIC: string;
  NTFY_URL?: string; // ntfy server, default https://ntfy.sh (self-hosters override)
  ADMIN_KEY: string; // bearer for admin HTTP routes (/backfill, step-3 endpoints)
  PRESENCE_KEY?: string; // bearer for POST /presence (bluetooth scanner); unset = webhook off
}

// Local time is TIME_ZONE wall-clock time, DST included (invariant 5): the
// runtime's built-in Intl data, no timezone libraries.
const localMins = (local: Date) => local.getUTCHours() * 60 + local.getUTCMinutes();

function withinOperatingWindow(local: Date, site: Site): boolean {
  const mins = localMins(local);
  return mins >= site.dayStartMins && mins <= site.soakEndMins + TICK_TAIL_MINS;
}

export default {
  // One 5-min cron drives everything; local-time gating lives here so the
  // cron never needs editing when the timezone or windows change.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    let site: Site;
    let car: CarClient;
    try {
      site = siteFromEnv(env);
      car = carFromEnv(env);
    } catch (err) {
      console.error("bad site config", err);
      // Alert once an hour, not every tick: the fix is a redeploy anyway.
      if (new Date().getUTCMinutes() < 5) {
        ctx.waitUntil(notify(env, `config error, controller idle: ${err instanceof Error ? err.message : String(err)}`));
      }
      return;
    }
    const local = localNow(site);
    const mins = localMins(local);
    const foxess = new FoxEssClient(env.FOXESS_API_KEY, env.FOXESS_DEVICE_SN);

    if (mins >= NIGHTLY_PULL_MINS && mins < NIGHTLY_PULL_MINS + 5) {
      ctx.waitUntil(
        pullYesterdayLoad(env, site, foxess, car, local).catch(async (err) => {
          console.error("nightly load pull failed", err); // survives even if ntfy is down
          await notify(env, `nightly load pull failed: ${err instanceof Error ? err.message : String(err)}`);
        }),
      );
      return;
    }

    if (!withinOperatingWindow(local, site)) return;

    ctx.waitUntil(
      runTick(env, site, foxess, car, local).catch(async (err) => {
        console.error("tick failed", err); // survives even if ntfy is down
        await notify(env, `tick failed: ${err instanceof Error ? err.message : String(err)}`);
      }),
    );
  },

  // Manual controls + status for the dashboard. TODO: implement rest at step 3.
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Seed load_samples from FoxESS history for a past date range.
    if (url.pathname === "/backfill" && req.method === "POST") {
      if (req.headers.get("authorization") !== `Bearer ${env.ADMIN_KEY}`) {
        return new Response("forbidden", { status: 403 });
      }
      const from = url.searchParams.get("from") ?? "";
      const to = url.searchParams.get("to") ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
        return new Response("need ?from=YYYY-MM-DD&to=YYYY-MM-DD", { status: 400 });
      }
      // ponytail: 21-day cap keeps one request under the 50-subrequest limit;
      // call again for older ranges.
      if ((Date.parse(to) - Date.parse(from)) / 86_400_000 >= 21) {
        return new Response("max 21 days per call", { status: 400 });
      }
      const site = siteFromEnv(env);
      const foxess = new FoxEssClient(env.FOXESS_API_KEY, env.FOXESS_DEVICE_SN);
      const car = carFromEnv(env);
      // One charges call for the whole range (padded a day each side for
      // midnight-spanning sessions) keeps the request under subrequest limits.
      const home = await homeCoords(env);
      const fromMs = localMidnightMs(site, from);
      const toMs = localMidnightMs(site, to);
      const charges = car.getCharges
        ? await car.getCharges((fromMs - 86_400_000) / 1000, (toMs + 2 * 86_400_000) / 1000)
        : null; // no charge history: pullDayLoad falls back to spikeSlots
      const ok: string[] = [];
      const failed: Record<string, string> = {};
      for (let d = from; d <= to; d = nextDay(d)) {
        try {
          await pullDayLoad(env, site, foxess, d, charges && excludedSlots(charges, home, d, Date.now(), site));
          ok.push(d);
        } catch (err) {
          failed[d] = err instanceof Error ? err.message : String(err);
        }
        await new Promise((r) => setTimeout(r, 1100)); // FoxESS queries <= 1/s
      }
      return Response.json({ ok, failed });
    }

    // Car presence webhook: a bluetooth scanner at home (or any automation)
    // reports whether it currently sees the car. Read by the tick when
    // config home_detection uses bluetooth (src/presence.ts). Its own key so
    // the device at home never holds ADMIN_KEY.
    if (url.pathname === "/presence" && req.method === "POST") {
      if (!env.PRESENCE_KEY) return new Response("presence webhook disabled (set PRESENCE_KEY)", { status: 404 });
      if (req.headers.get("authorization") !== `Bearer ${env.PRESENCE_KEY}`) {
        return new Response("forbidden", { status: 403 });
      }
      let body: Record<string, unknown> = {};
      if ((req.headers.get("content-type") ?? "").includes("application/json")) {
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return new Response("bad JSON", { status: 400 });
        }
      }
      const home = parsePresent(url.searchParams.get("home") ?? body.home);
      if (home === null) return new Response("need home=true|false (query or JSON body)", { status: 400 });
      const source = String(url.searchParams.get("source") ?? body.source ?? "").slice(0, 64) || null;
      const reportedAt = new Date().toISOString(); // Worker clock: reporter clock skew can't matter
      await d1Retry(() =>
        env.DB.prepare(
          "INSERT INTO presence (id, home, reported_at, source) VALUES (1, ?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET home = excluded.home, reported_at = excluded.reported_at, source = excluded.source",
        )
          .bind(home ? 1 : 0, reportedAt, source)
          .run(),
      );
      return Response.json({ ok: true, home, reportedAt });
    }

    // Manual car controls. A /car/start here is an OWNER action: the next
    // tick sees a charge the system didn't start and backs off (invariant 6).
    if ((url.pathname === "/car/start" || url.pathname === "/car/stop") && req.method === "POST") {
      if (req.headers.get("authorization") !== `Bearer ${env.ADMIN_KEY}`) {
        return new Response("forbidden", { status: 403 });
      }
      const car = carFromEnv(env);
      const action = url.pathname === "/car/start" ? "manual_api_start" : "manual_api_stop";
      if (url.pathname === "/car/start") await car.startCharging();
      else await car.stopCharging();
      await env.DB.prepare(
        "INSERT INTO decisions (ts, state_from, state_to, action, inputs_json) VALUES (?,?,?,?,?)",
      )
        .bind(new Date().toISOString(), "MANUAL", "MANUAL", action, "{}")
        .run();
      return Response.json({ ok: true, action });
    }

    // Raw FoxESS real/query dump (all variables, full envelope) for
    // diagnosing read failures like "real-time missing SoC".
    if (url.pathname === "/debug/foxess") {
      if (req.headers.get("authorization") !== `Bearer ${env.ADMIN_KEY}`) {
        return new Response("forbidden", { status: 403 });
      }
      const foxess = new FoxEssClient(env.FOXESS_API_KEY, env.FOXESS_DEVICE_SN);
      try {
        return Response.json(await foxess.rawRealTime());
      } catch (err) {
        return new Response(err instanceof Error ? err.message : String(err), { status: 502 });
      }
    }

    // Raw car-provider state payload, for checking response shapes
    // (Teslascope's are unverified live — see src/clients/teslascope.ts).
    if (url.pathname === "/debug/car") {
      if (req.headers.get("authorization") !== `Bearer ${env.ADMIN_KEY}`) {
        return new Response("forbidden", { status: 403 });
      }
      try {
        const car = carFromEnv(env);
        return Response.json({ provider: car.name, raw: await car.rawState() });
      } catch (err) {
        return new Response(err instanceof Error ? err.message : String(err), { status: 502 });
      }
    }

    if (url.pathname === "/status") {
      if (req.headers.get("authorization") !== `Bearer ${env.ADMIN_KEY}`) {
        return new Response("forbidden", { status: 403 });
      }
      const [day, decisions] = await Promise.all([
        env.DB.prepare("SELECT * FROM days ORDER BY date DESC LIMIT 1").first(),
        env.DB.prepare("SELECT ts, state_from, state_to, action FROM decisions ORDER BY id DESC LIMIT 20").all(),
      ]);
      return Response.json({ day, decisions: decisions.results });
    }

    return new Response("ev-optimiser", { status: 200 });
  },
} satisfies ExportedHandler<Env>;

/** One 5-min tick: read car + house, run the pure decision, execute (unless
 *  shadow mode), persist state + decision log. */
export async function runTick(
  env: Env,
  site: Site,
  foxess: FoxEssClient,
  carApi: CarClient,
  local: Date,
): Promise<void> {
  const date = local.toISOString().slice(0, 10);
  const nowMins = localMins(local);

  const cfgRows = await d1Retry(() =>
    env.DB.prepare("SELECT key, value FROM config").all<{ key: string; value: string }>(),
  );
  const cfg = new Map(cfgRows.results.map((r) => [r.key, r.value]));
  const home = { lat: Number(cfg.get("home_lat")), lon: Number(cfg.get("home_lon")) };
  if (Number.isNaN(home.lat) || Number.isNaN(home.lon)) throw new Error("config home_lat/home_lon missing");
  const shadowMode = cfg.get("shadow_mode") !== "false"; // default ON: act only when explicitly enabled

  let car: CarState;
  let house: Awaited<ReturnType<FoxEssClient["getRealTime"]>>;
  try {
    [car, house] = await Promise.all([carApi.getCarState(), foxess.getRealTime()]);
  } catch (err) {
    await recordReadFailure(env, err);
    return; // state untouched; floor + car limit are the hardware backstops
  }

  const dayRow = await d1Retry(() =>
    env.DB.prepare("SELECT state_json FROM days WHERE date = ?")
      .bind(date)
      .first<{ state_json: string | null }>(),
  );
  const stored: StoredState | null = dayRow?.state_json ? (JSON.parse(dayRow.state_json) as StoredState) : null;
  const samples = stored
    ? []
    : (
        await d1Retry(() =>
          env.DB.prepare(
            "SELECT slot_half_hour AS slot, load_kwh AS loadKwh FROM load_samples WHERE date >= ? AND date < ?",
          )
            .bind(addDays(date, -LOAD_LOOKBACK_DAYS), date)
            .all<{ slot: number; loadKwh: number }>(),
        )
      ).results;

  // Invariant 7 gate. Unknown GPS, or a missing/stale/absent bluetooth
  // report, counts as NOT home.
  const homeDetection = parseHomeDetection(cfg.get("home_detection"));
  let presence: PresenceReport | null = null;
  if (homeDetection !== "gps") {
    const row = await d1Retry(() =>
      env.DB.prepare("SELECT home, reported_at FROM presence WHERE id = 1").first<{
        home: number;
        reported_at: string;
      }>(),
    );
    presence = row ? { home: row.home === 1, reportedAtMs: Date.parse(row.reported_at) } : null;
  }
  const atGps = gpsHome(car.latLon, home, site.homeRadiusM);
  const atBluetooth = bluetoothHome(presence, Date.now());
  const atHome = isHome(homeDetection, atGps, atBluetooth);

  // PLAN-time read-only hardware-floor read, BEFORE decide: the house's
  // forecast energy is reserved on top of minSocOnGrid. Only the FoxESS
  // *read* is guarded by this try: a throw here means we genuinely couldn't
  // read the floor — decide assumes the 10% minimum, the inverter still
  // enforces the real floor in hardware, and an import stop learns it. Keeping notify() calls outside the try stops a transient ntfy
  // failure being relabeled "reserve floor verify failed" (and stops the
  // catch doubling as an accidental resend).
  let floorPct: number | null = null;
  let floorReadErr: unknown;
  if (!stored) {
    try {
      floorPct = await foxess.getMinSocOnGrid();
    } catch (err) {
      floorReadErr = err;
    }
  }

  const inputs: DecideInputs = {
    date,
    nowMins,
    site,
    car: {
      pluggedIn: car.pluggedIn,
      chargingState: car.chargingState,
      socPct: car.socPct,
      limitPct: car.limitPct,
      chargeAmps: car.chargeAmps, // null = not reported; decide() falls back to the charger max
      atHome,
    },
    house,
    cfg: {
      safetyFactor: Number(cfg.get("safety_factor") ?? DEFAULT_SAFETY_FACTOR),
      strandedMinPct: Number(cfg.get("stranded_min_pct") ?? DEFAULT_STRANDED_MIN_PCT),
      solarTrack: cfg.get("solar_track") !== "false",
      glideMode: parseGlideMode(cfg.get("glide_mode")),
      solarSoak: cfg.get("solar_soak") !== "false",
      soakExport: cfg.get("soak_export") !== "false",
      shadowMode,
    },
    samples,
    floorPct,
    stored,
  };
  const { actions, next } = decide(inputs);

  if (!shadowMode) {
    for (const act of actions) {
      if (act.kind === "start_charging") {
        await carApi.startCharging();
        await carApi.setChargingAmps(act.amps);
      } else if (act.kind === "stop_charging") {
        await carApi.stopCharging();
      } else if (act.kind === "set_amps") {
        await carApi.setChargingAmps(act.amps);
      } else {
        await notify(env, act.message);
      }
    }
  }

  const stateChanged = !stored || stored.state !== next.state;
  if (actions.length || stateChanged) {
    const prefix = shadowMode && actions.length ? "shadow: " : "";
    await d1Retry(() =>
      env.DB.prepare("INSERT INTO decisions (ts, state_from, state_to, action, inputs_json) VALUES (?,?,?,?,?)")
        .bind(
          new Date().toISOString(),
          stored?.state ?? "PLAN",
          next.state,
          prefix + (actions.length ? actions.map(describeAction).join(" | ") : "none"),
          JSON.stringify({
            nowMins,
            car: inputs.car,
            home: { mode: homeDetection, gps: atGps, bluetooth: atBluetooth, presence },
            house,
            cfg: inputs.cfg,
            floorPct,
            before: stored,
            after: next,
          }),
        )
        .run(),
    );
  }
  await d1Retry(() =>
    env.DB.prepare(
      "INSERT INTO days (date, reserve_pct, planned_at, state, state_json) VALUES (?,?,?,?,?) " +
        "ON CONFLICT(date) DO UPDATE SET state = excluded.state, state_json = excluded.state_json",
    )
      .bind(date, next.reservePct, new Date().toISOString(), next.state, JSON.stringify(next))
      .run(),
  );

  // PLAN-time floor read failure alert. There is no "floor too low" drift
  // alert any more: the reserve sits ON TOP of whatever floor is set, so
  // every floor >= the 10% BMS minimum is valid (2026-09-27).
  if (!stored && floorReadErr !== undefined) {
    const msg = floorReadErr instanceof Error ? floorReadErr.message : String(floorReadErr);
    if (!shadowMode) {
      await notify(env, `reserve floor read failed (assuming ${site.batteryMinSocPct}%): ${msg}`);
    } else {
      console.error("floor read failed (shadow)", floorReadErr);
    }
  }
}

function describeAction(a: Action): string {
  if (a.kind === "start_charging" || a.kind === "set_amps") return `${a.kind}:${a.amps}`;
  if (a.kind === "stop_charging") return `stop_charging:${a.reason}`;
  return `notify:${a.message}`;
}

/** Read failures must not spam: log every one, ntfy at most every 3 h.
 *  Throttle on the last ALERTED failure ('read_failure_alert' rows), not the
 *  last failure — during a continuous outage a row lands every 5 min, which
 *  must never reset the 3 h window (that silenced the 2026-07-06 outage). */
async function recordReadFailure(env: Env, err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  const last = await d1Retry(() =>
    env.DB.prepare(
      "SELECT ts FROM decisions WHERE action = 'read_failure_alert' ORDER BY id DESC LIMIT 1",
    ).first<{ ts: string }>(),
  );
  const alert = !last || Date.now() - Date.parse(last.ts) > 3 * 3600 * 1000;
  await d1Retry(() =>
    env.DB.prepare("INSERT INTO decisions (ts, state_from, state_to, action, inputs_json) VALUES (?,?,?,?,?)")
      .bind(
        new Date().toISOString(),
        "-",
        "-",
        alert ? "read_failure_alert" : "read_failure",
        JSON.stringify({ error: msg }),
      )
      .run(),
  );
  if (alert) {
    await notify(env, `tick read failure (alerts throttled to one / 3 h): ${msg}`);
  }
}

/** Pull yesterday's (local) load history into load_samples, dropping
 *  slots that overlap a home charging session (the car API's charge history sees
 *  ALL charges, including outside the tick window, which the decisions log
 *  cannot). Fails loud: a day with unfilterable EV load must not enter the
 *  forecast. */
export async function pullYesterdayLoad(
  env: Env,
  site: Site,
  foxess: FoxEssClient,
  car: CarClient,
  local: Date,
): Promise<void> {
  const date = addDays(local.toISOString().slice(0, 10), -1);
  const home = await homeCoords(env);
  const dayMs = localMidnightMs(site, date);
  const charges = car.getCharges
    ? await car.getCharges((dayMs - 86_400_000) / 1000, (dayMs + 2 * 86_400_000) / 1000)
    : null;
  await pullDayLoad(env, site, foxess, date, charges && excludedSlots(charges, home, date, Date.now(), site));
}

/** Pull one local day (YYYY-MM-DD) of load history into load_samples.
 *  exclude null = the car API has no charge history (TeslaFi): drop
 *  car-sized load spikes instead (spikeSlots). */
export async function pullDayLoad(
  env: Env,
  site: Site,
  foxess: FoxEssClient,
  date: string,
  exclude: Set<number> | null,
): Promise<void> {
  const rows = await foxess.pullDailyLoadHistory(date, site);
  if (rows.length === 0) throw new Error(`no load samples returned for ${date}`);
  const drop = exclude ?? spikeSlots(rows, site);
  const kept = rows.filter((r) => !drop.has(r.slot));
  const stmt = env.DB.prepare(
    "INSERT INTO load_samples (date, slot_half_hour, load_kwh) VALUES (?, ?, ?)",
  );
  // Delete-then-insert in one atomic batch so a re-pull also REMOVES slots
  // now excluded (INSERT OR REPLACE alone would leave stale contaminated rows).
  await d1Retry(() =>
    env.DB.batch([
      env.DB.prepare("DELETE FROM load_samples WHERE date = ?").bind(date),
      ...kept.map((r) => stmt.bind(date, r.slot, r.loadKwh)),
    ]),
  );
}

async function homeCoords(env: Env): Promise<{ lat: number; lon: number }> {
  const { results } = await d1Retry(() =>
    env.DB.prepare(
      "SELECT key, value FROM config WHERE key IN ('home_lat','home_lon')",
    ).all<{ key: string; value: string }>(),
  );
  const map = new Map(results.map((r) => [r.key, Number(r.value)]));
  const lat = map.get("home_lat");
  const lon = map.get("home_lon");
  if (lat === undefined || lon === undefined || Number.isNaN(lat) || Number.isNaN(lon)) {
    throw new Error("config home_lat/home_lon missing (seed them per README 'Setup')");
  }
  return { lat, lon };
}

/** home=true|false|1|0 (string from a query, or a JSON boolean/number). */
function parsePresent(v: unknown): boolean | null {
  if (v === true || v === 1 || v === "true" || v === "1") return true;
  if (v === false || v === 0 || v === "false" || v === "0") return false;
  return null;
}

function nextDay(date: string): string {
  return addDays(date, 1);
}

/** D1 throws transient "overloaded"/reset errors under Cloudflare-side load
 *  (worst at :00/:30, when the world's crons fire — the DB itself is tiny).
 *  Retry before letting the tick fail: a lost tick is benign (the next one
 *  redoes everything) but its "tick failed" alert is pure noise.
 *  ponytail: a SUSTAINED D1 outage still alerts once per 5-min tick; add
 *  KV-backed alert throttling only if that ever actually happens. */
export async function d1Retry<T>(fn: () => Promise<T>, delaysMs = [0, 500, 1500]): Promise<T> {
  let lastErr: unknown;
  for (const wait of delaysMs) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      return await fn();
    } catch (err) {
      if (!/overloaded|queued for too long|network connection lost|internal error|reset/i.test(String(err))) {
        throw err;
      }
      lastErr = err;
    }
  }
  throw lastErr;
}

export async function notify(env: Env, message: string, delaysMs = [0, 500, 1500]): Promise<void> {
  let lastErr: unknown;
  for (const wait of delaysMs) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    let res: Response;
    try {
      const server = (env.NTFY_URL || "https://ntfy.sh").replace(/\/+$/, "");
      res = await fetch(`${server}/${env.NTFY_TOPIC}`, { method: "POST", body: message });
    } catch (err) {
      lastErr = err; // network-level failure (DNS/TLS/reset) — transient, retry
      continue;
    }
    if (res.ok) return;
    // Fail loud: a swallowed non-2xx here would make every failure path in the
    // worker look successful with zero trace (invariant 2 in CLAUDE.md). A 5xx
    // (e.g. ntfy behind Cloudflare returning 522) is transient, so retry; a 4xx
    // is a real client error (bad topic) and surfaces immediately.
    lastErr = new Error(`ntfy ${res.status}: ${message}`);
    if (res.status < 500) throw lastErr;
  }
  throw lastErr;
}
