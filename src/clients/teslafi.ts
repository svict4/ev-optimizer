/**
 * TeslaFi API client. https://www.teslafi.com/api.php (account-only docs).
 * One endpoint, GET https://www.teslafi.com/feed.php?command=…, with the
 * API token (Settings → Tesla API → API Token) as a bearer. The token is
 * per vehicle, so there is no VIN. Each command must also be ticked in
 * Settings → Tesla API → Commands, or TeslaFi answers 200 with a
 * plain-text "This command is not enabled".
 *
 * Ported from two open-source TeslaFi integrations (2026-10): Sentry-USB
 * run/awake_start (bearer auth; a 200 can still carry
 * response.result=false) and the Home Assistant integration
 * jhansche/ha-teslafi (lastGood; charge_start / charge_stop /
 * set_charging_amps?charging_amps=; wake=<s> to wake a sleeping car;
 * flat Fleet-API field names, values often strings). Not yet live-tested
 * here: check GET /debug/car before leaving shadow mode.
 *
 * TeslaFi has no charge-history call, so getCharges is absent and the
 * nightly pull falls back to spikeSlots (src/charges.ts).
 */
import type { CarClient, CarState } from "./car";

/** Seconds TeslaFi waits for a sleeping car to wake before a command
 *  (ha-teslafi's DELAY_CMD_WAKE). Ignored when the car is awake. */
const WAKE_S = 30;

export class TeslaFiClient implements CarClient {
  readonly name = "teslafi";
  constructor(
    private token: string,
    private base = "https://www.teslafi.com/feed.php",
  ) {}

  /** lastGood: TeslaFi's last data point with charge data, from its own
   *  logging (does not wake the car). Fails loud on missing fields. */
  async getCarState(): Promise<CarState> {
    const raw = (await this.rawState()) as Record<string, unknown>;
    const socPct = num(raw.battery_level);
    const limitPct = num(raw.charge_limit_soc);
    const chargingState = typeof raw.charging_state === "string" && raw.charging_state !== "" ? raw.charging_state : null;
    if (socPct === null || limitPct === null || chargingState === null) {
      throw new Error("teslafi lastGood: missing charge fields");
    }
    const lat = num(raw.latitude);
    const lon = num(raw.longitude);
    return {
      pluggedIn: chargingState !== "Disconnected",
      chargingState,
      socPct,
      limitPct,
      // charge_current_request is the set amps (Tessie's charge_amps).
      chargeAmps: num(raw.charge_current_request) ?? num(raw.charge_amps),
      latLon: lat !== null && lon !== null ? { lat, lon } : null, // unknown = NOT home
    };
  }
  async rawState(): Promise<unknown> {
    return this.req("lastGood");
  }
  async startCharging(): Promise<void> {
    await this.req("charge_start", { wake: String(WAKE_S) });
  }
  async stopCharging(): Promise<void> {
    await this.req("charge_stop", { wake: String(WAKE_S) });
  }
  async setChargingAmps(amps: number): Promise<void> {
    await this.req("set_charging_amps", { charging_amps: String(amps), wake: String(WAKE_S) });
  }

  private async req(command: string, params: Record<string, string> = {}): Promise<unknown> {
    const qs = new URLSearchParams({ command, ...params });
    const res = await fetch(`${this.base}?${qs}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`teslafi ${command}: ${res.status}`);
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      // "This command is not enabled…", "Vehicle is asleep or unavailable…"
      throw new Error(`teslafi ${command}: ${text.slice(0, 120)}`);
    }
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const d = data as Record<string, unknown>;
      if (d.error) throw new Error(`teslafi ${command}: ${String(d.error)} ${String(d.error_description ?? "")}`.trim());
      const r = d.response as Record<string, unknown> | undefined;
      if (r && typeof r === "object" && "result" in r && r.result !== true && r.result !== "true") {
        // Commands are not confirmations, but a refusal must be loud.
        throw new Error(`teslafi ${command}: ${String(r.reason ?? r.string ?? r.result)}`);
      }
    }
    return data;
  }
}

/** TeslaFi sends most numbers as strings ("80"); "" / null = not reported. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
