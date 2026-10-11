# ev-optimiser

A Cloudflare Worker that charges a Tesla from a FoxESS home battery before a
daily free (or cheap) grid window. Each morning it moves the battery's surplus
into the car, keeping back what the house needs to reach the window. During
the window it charges the car straight from the grid if the car is still home.
After the window it soaks up spare afternoon solar.

Full design, control logic and failure-mode analysis are in **SPEC.md**.
Project rules for AI coding agents are in **CLAUDE.md**.

> **Use at your own risk.** This software sends commands to your car and
> reads your inverter, unattended. It never writes inverter settings, and it
> starts in shadow mode, which logs decisions but sends no car commands. Read
> SPEC.md, watch the decision log for a few days, and only then turn shadow
> mode off.

## Does it fit your setup?

You need:

- **A FoxESS hybrid inverter and battery** with Open API access (an API key
  from foxesscloud.com → User Profile → API Management). The inverter should
  run Self-Use outside the free window and ForceCharge during it. You set that
  schedule yourself in the FoxESS app. The inverter must feed the same
  phases the charger draws from: a single-phase inverter cannot cover a
  three-phase charger, whatever the amps.
- **A Tesla on a [Tessie](https://tessie.com),
  [Teslascope](https://teslascope.com) or [TeslaFi](https://www.teslafi.com)
  account.** Any of them signs the commands and serves cached state without
  waking the car. Teslascope and TeslaFi support is newer: run in shadow
  mode and check `GET /debug/car` and your first `/backfill` before
  trusting it (see SPEC.md "Teslascope integration" / "TeslaFi
  integration").
- **A daily free or cheap grid window** at the same local (wall-clock) time
  each day. Daylight saving is handled: set `TIME_ZONE` to your IANA zone and
  the window follows the clock change.
- A Cloudflare account (the free tier is enough) and an
  [ntfy](https://ntfy.sh) topic for push alerts.

## How it works

A cron runs every 5 minutes. Each tick reads the car (Tessie, Teslascope or TeslaFi) and the
inverter (FoxESS Open API) and runs a pure state machine (`src/tick.ts`). It
then sends the resulting car commands: start, stop and set amps. The
inverter is never written to. The FoxESS `minSocOnGrid` floor and the car's
own charge limit are the hardware backstops, so a failure leaves charging
slightly suboptimal but never leaves the house battery flat. Every decision
is logged to D1 with the inputs it acted on.

## Configuration

There are three layers:

1. **Site vars in `wrangler.jsonc`** (needs a redeploy). These describe your
   install: `TIME_ZONE`, `FREE_WINDOW_START`/`FREE_WINDOW_END`, `DAY_START`,
   `SOLAR_SOAK_END`, `BATTERY_KWH`, `BATTERY_MIN_SOC`, `CHARGER_VOLTS`, `CHARGER_PHASES`,
   `CHARGER_MIN_AMPS`, `CHARGER_MAX_AMPS`, `HOME_RADIUS_M`, `INVERTER_MAX_W`
   (the most AC power the inverter can put out from the battery; the
   morning dump opens at what fits under it after house load, so a small
   inverter is not asked for 11 kW), and optionally `EXPORT_LIMIT_W` (your
   grid export limit, `0` for a zero-export site; only read when
   `soak_export` is off) and `NTFY_URL` for a self-hosted ntfy server. Each
   one is commented in the file. **All but the optional two are required.**
   If one is missing or malformed, the Worker does nothing and sends an
   alert. It never falls back to someone else's values. The committed
   values are an example install, so change them.
2. **The D1 `config` table** (no redeploy needed):

   | key                | default  | meaning                                                         |
   | ------------------ | -------- | --------------------------------------------------------------- |
   | `home_lat`/`home_lon` | —     | **Required.** Geofence centre. No car command is sent away from home. |
   | `shadow_mode`      | on       | Logs decisions without sending commands until set to `'false'`. |
   | `safety_factor`    | `1.3`    | Multiplier on the forecast house load for the morning reserve.  |
   | `stranded_min_pct` | `30`     | Below this car SoC, a paid charge is left running after the window. |
   | `solar_track`      | on       | Morning PV tracking below the reserve (`'false'` to disable).   |
   | `glide_mode`       | `asap`   | Morning restarts once the battery has banked energy above the reserve: `asap` restarts as soon as it covers 20 minutes of the car's minimum draw (more stop/start cycles, less stranded if you leave early); `continuous` waits until it can carry the car to the free window in one run. |
   | `solar_soak`       | on       | Afternoon solar soak after the window (`'false'` to disable).   |
   | `soak_export`      | on       | The afternoon soak may also take PV that would be exported (right when exporting costs you, or pays nothing). `'false'` = only PV the inverter is curtailing; needs `EXPORT_LIMIT_W`. |
   | `home_detection`   | `gps`    | How "car is home" is decided: `gps`, `bluetooth`, `gps_or_bluetooth` or `gps_and_bluetooth`. See "Bluetooth presence". |

3. **Secrets** (`wrangler secret put …`, with local copies in `.dev.vars`):
   `TESSIE_TOKEN` + `TESSIE_VIN` **or** `TESLASCOPE_TOKEN` +
   `TESLASCOPE_VEHICLE_ID` **or** `TESLAFI_TOKEN` (exactly one car
   provider). The Teslascope token is a personal access token from
   Developers → Applications, and the vehicle ID is the public ID in your
   vehicle's Teslascope URL. The TeslaFi token is under Settings → Tesla
   API → API Token; on the Commands tab also tick Charge Start, Charge
   Stop and Set Charging Amps, or TeslaFi refuses them.
   `FOXESS_API_KEY`, `FOXESS_DEVICE_SN`,
   `NTFY_TOPIC`, `ADMIN_KEY` (the bearer token for the admin HTTP
   routes), and optionally `PRESENCE_KEY` (see "Bluetooth presence"). Pick an unguessable ntfy topic, because anyone who knows it can
   read your alerts.

Control-loop tuning, such as import/export thresholds, the wear caps on
restarts and the solar-soak SoC limits, lives in `src/constants.ts`. The
defaults are tuned for an 11 kW charger with a 40-odd kWh battery. Read the
relevant SPEC.md section before changing them.

Set the FoxESS device timezone in FoxESS Cloud to match `TIME_ZONE`
(including its daylight saving). The nightly load pull checks every sample's
UTC offset against `TIME_ZONE` and fails loudly on a mismatch.

## Bluetooth presence (optional)

The car only gets commands when it is home. By default that's the car API's
GPS location. You can also (or instead) use Bluetooth: a device near where
the car parks watches for the car's Bluetooth signal and tells the Worker.
That helps when the GPS drifts in a garage or the car API hides the location.

1. `pnpm exec wrangler secret put PRESENCE_KEY` (any long random string).
2. On a Raspberry Pi or other Linux box with Bluetooth, run
   `scripts/ble-presence.py` with `WORKER_URL`, `PRESENCE_KEY` and
   `TESLA_VIN` set (instructions at the top of the file). Anything else
   can feed the same webhook instead, e.g. Home Assistant:
   `POST /presence` with `Authorization: Bearer <PRESENCE_KEY>` and
   `{"home": true}` or `{"home": false}`.
3. Set `home_detection` in the D1 `config` table, for example
   `INSERT OR REPLACE INTO config (key, value) VALUES ('home_detection','gps_or_bluetooth')`.

A "home" report counts for 15 minutes, so the reporter should post every
few minutes. If it stops, the car counts as away and nothing is sent.

## Setup

The repo is pnpm-managed, so don't use `npm install`.

```bash
pnpm install
pnpm exec wrangler d1 create ev_optimiser   # put the printed id in wrangler.jsonc
# edit the "vars" block in wrangler.jsonc for your site
pnpm run migrate -- --remote                # pnpm run migrate alone targets the local dev DB
cp .dev.vars.example .dev.vars              # fill in local secrets
pnpm exec wrangler secret put TESSIE_TOKEN  # repeat for every secret (or TESLASCOPE_* / TESLAFI_TOKEN)
pnpm exec wrangler d1 execute ev_optimiser --remote \
  --command "INSERT INTO config (key, value) VALUES ('home_lat','<lat>'), ('home_lon','<lon>')"
pnpm test
pnpm run deploy
```

Optionally, seed the load forecast from up to 21 days of history per call:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_KEY" \
  "https://<your-worker>.workers.dev/backfill?from=2026-01-01&to=2026-01-21"
```

Leave `shadow_mode` on and watch the `decisions` table (or `GET /status` with
the admin bearer) for a few days. When you trust it, run:

```bash
pnpm exec wrangler d1 execute ev_optimiser --remote \
  --command "INSERT OR REPLACE INTO config (key, value) VALUES ('shadow_mode','false')"
```

Keep your car's own charge schedule set to the free window. If the Worker
ever stops ticking, the car still charges for free.

### Local development

```bash
pnpm run dev
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"   # one tick, at the real local time
```

### Continuous deployment (optional)

`.github/workflows/ci-deploy.yml` runs the typecheck and tests on every PR.
On a push to `main` it also applies the D1 migrations and deploys. Deploying
needs three repo secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and
`D1_DATABASE_ID`. CI substitutes `D1_DATABASE_ID` for the placeholder in
`wrangler.jsonc`, so your database id never has to be committed. Without the
token, the deploy job is skipped.

## License

MIT. See LICENSE.
