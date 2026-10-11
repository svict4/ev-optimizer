/**
 * Tessie API client. https://developer.tessie.com
 * Bearer token auth, per-VIN paths. State reads are served from Tessie's
 * cache and do not wake the car. Tessie handles command signing + retries,
 * but commands are still not confirmations: the state machine verifies
 * charging_state on the following tick.
 */
import type { Charge } from "../charges";
import type { CarClient, CarState } from "./car";

export class TessieClient implements CarClient {
  readonly name = "tessie";
  constructor(
    private token: string,
    private vin: string,
    private base = "https://api.tessie.com",
  ) {}

  /** Cached car state (does not wake the car). Fails loud on missing fields —
   *  the tick skips and alerts rather than acting on partial data. */
  async getCarState(): Promise<CarState> {
    const raw = (await this.req("GET", `/${this.vin}/state`)) as {
      charge_state?: Record<string, unknown>;
      drive_state?: Record<string, unknown>;
    };
    const cs = raw.charge_state ?? {};
    const num = (k: string) => (typeof cs[k] === "number" ? (cs[k] as number) : null);
    const socPct = num("battery_level");
    const limitPct = num("charge_limit_soc");
    const chargingState = typeof cs.charging_state === "string" ? cs.charging_state : null;
    if (socPct === null || limitPct === null || chargingState === null) {
      throw new Error("tessie /state: missing charge_state fields");
    }
    const ds = raw.drive_state ?? {};
    const latLon =
      typeof ds.latitude === "number" && typeof ds.longitude === "number"
        ? { lat: ds.latitude, lon: ds.longitude }
        : null; // executor treats unknown location as NOT home (invariant 7)
    return {
      pluggedIn: chargingState !== "Disconnected",
      chargingState,
      socPct,
      limitPct,
      chargeAmps: num("charge_amps"), // null = not reported
      latLon,
    };
  }
  async rawState(): Promise<unknown> {
    return this.req("GET", `/${this.vin}/state`);
  }
  async startCharging(): Promise<void> {
    await this.req("POST", `/${this.vin}/command/start_charging`);
  }
  async stopCharging(): Promise<void> {
    await this.req("POST", `/${this.vin}/command/stop_charging`);
  }
  async setChargingAmps(amps: number): Promise<void> {
    await this.req("POST", `/${this.vin}/command/set_charging_amps?amps=${amps}`);
  }

  /** Charge history overlapping [fromS, toS] (unix SECONDS). Shape is
   *  unverified against live data until the first backfill run — fail loud
   *  on surprises rather than silently mis-excluding forecast slots. */
  async getCharges(fromS: number, toS: number): Promise<Charge[]> {
    const raw = await this.req(
      "GET",
      `/${this.vin}/charges?from=${Math.floor(fromS)}&to=${Math.floor(toS)}`,
    );
    const results = (raw as { results?: unknown[] }).results;
    if (!Array.isArray(results)) throw new Error("tessie /charges: no results array");
    // Tessie timestamps are unix seconds; normalise defensively in case any
    // field arrives in ms — a wrong unit here would silently exclude nothing.
    const ms = (n: number) => (n > 1e12 ? n : n * 1000);
    return results.map((r) => {
      const c = r as Record<string, unknown>;
      if (typeof c.started_at !== "number") throw new Error("tessie /charges: started_at not a number");
      return {
        startedAtMs: ms(c.started_at),
        endedAtMs: typeof c.ended_at === "number" ? ms(c.ended_at) : null,
        lat: typeof c.latitude === "number" ? c.latitude : null,
        lon: typeof c.longitude === "number" ? c.longitude : null,
      };
    });
  }

  private async req(method: string, path: string): Promise<unknown> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`tessie ${method} ${path}: ${res.status}`);
    return res.json();
  }
}
