/**
 * Teslascope API client. https://teslascope.com/developers/documentation
 * Personal access token (Developers → Applications) as a bearer; per-vehicle
 * paths keyed by the vehicle's Teslascope public ID (not the VIN).
 *
 * Verified against the openHAB Teslascope binding (2026-10): base URL,
 * bearer auth, GET /vehicle/{id}/detailed carrying Fleet-API-shaped
 * charge_state / drive_state, and the camelCase command names
 * startCharging / stopCharging. NOT yet verified live: the amps command
 * name and the charging-history shape — both fail loud (non-2xx throws,
 * unknown shapes throw) rather than act on a guess. Check with
 * GET /debug/car and the first /backfill run before leaving shadow mode.
 */
import type { Charge } from "../charges";
import type { CarClient, CarState } from "./car";

export class TeslascopeClient implements CarClient {
  readonly name = "teslascope";
  constructor(
    private token: string,
    private vehicleId: string,
    private base = "https://teslascope.com/api",
  ) {}

  /** Teslascope's last-known state (served from its own polling — does not
   *  wake the car). Fails loud on missing fields. */
  async getCarState(): Promise<CarState> {
    const raw = unwrap(await this.rawState()) as {
      charge_state?: Record<string, unknown>;
      drive_state?: Record<string, unknown>;
    };
    const cs = raw.charge_state ?? {};
    const num = (k: string) => (typeof cs[k] === "number" ? (cs[k] as number) : null);
    const socPct = num("battery_level");
    const limitPct = num("charge_limit_soc");
    // charging_state is the Fleet API field the state machine speaks; fall
    // back to detailed_charge_state ("DetailedChargeStateCharging" →
    // "Charging"), whose suffixes are the same vocabulary.
    const chargingState =
      typeof cs.charging_state === "string" && cs.charging_state !== ""
        ? cs.charging_state
        : typeof cs.detailed_charge_state === "string" && cs.detailed_charge_state.startsWith("DetailedChargeState")
          ? cs.detailed_charge_state.slice("DetailedChargeState".length)
          : null;
    if (socPct === null || limitPct === null || !chargingState) {
      throw new Error("teslascope /detailed: missing charge_state fields");
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
      chargeAmps: num("charge_amps"),
      latLon,
    };
  }
  async rawState(): Promise<unknown> {
    return this.req("GET", `/vehicle/${this.vehicleId}/detailed`);
  }
  async startCharging(): Promise<void> {
    await this.command("startCharging");
  }
  async stopCharging(): Promise<void> {
    await this.command("stopCharging");
  }
  async setChargingAmps(amps: number): Promise<void> {
    // Unverified name/param: both the Teslascope-style `amps` and the Fleet
    // API's `charging_amps` are sent. A rejected command throws, so the tick
    // alerts instead of silently charging at the wrong rate.
    await this.command("setChargingAmps", `amps=${amps}&charging_amps=${amps}`);
  }

  /** Charge history overlapping [fromS, toS] (unix SECONDS), filtered
   *  client-side. Shape unverified: accepts the plausible field spellings
   *  and fails loud on anything else, so a day with unfilterable EV load
   *  never enters the forecast. */
  async getCharges(fromS: number, toS: number): Promise<Charge[]> {
    const raw = unwrap(await this.req("GET", `/vehicle/${this.vehicleId}/charging-history`));
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { data?: unknown }).data)
        ? (raw as { data: unknown[] }).data
        : Array.isArray((raw as { results?: unknown }).results)
          ? (raw as { results: unknown[] }).results
          : null;
    if (!list) throw new Error("teslascope /charging-history: no list in response");
    const out: Charge[] = [];
    for (const r of list) {
      const c = r as Record<string, unknown>;
      const startedAtMs = toMs(c.started_at ?? c.start_date ?? c.start_time ?? c.startedAt);
      if (startedAtMs === null) throw new Error("teslascope /charging-history: no parsable start time");
      const endRaw = c.ended_at ?? c.end_date ?? c.end_time ?? c.endedAt;
      const endedAtMs = endRaw === null || endRaw === undefined ? null : toMs(endRaw);
      if (endRaw !== null && endRaw !== undefined && endedAtMs === null) {
        throw new Error("teslascope /charging-history: unparsable end time");
      }
      if (startedAtMs > toS * 1000 || (endedAtMs !== null && endedAtMs < fromS * 1000)) continue;
      out.push({
        startedAtMs,
        endedAtMs,
        lat: typeof c.latitude === "number" ? c.latitude : null,
        lon: typeof c.longitude === "number" ? c.longitude : null,
      });
    }
    return out;
  }

  private async command(cmd: string, params = ""): Promise<void> {
    await this.req("POST", `/vehicle/${this.vehicleId}/command/${cmd}${params ? `?${params}` : ""}`);
  }

  private async req(method: string, path: string): Promise<unknown> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`teslascope ${method} ${path}: ${res.status}`);
    return res.json();
  }
}

/** Some Teslascope endpoints wrap the payload in { response: … }. */
function unwrap(raw: unknown): unknown {
  if (raw && typeof raw === "object" && "response" in raw) {
    const inner = (raw as { response: unknown }).response;
    if (inner && typeof inner === "object") return inner;
  }
  return raw;
}

/** Unix seconds, unix ms, or a zoned ISO string → epoch ms; null if none.
 *  A zoneless date string is rejected: Workers would read it as UTC, and a
 *  silent offset error would exclude the wrong slots. */
function toMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === "string" && v !== "") {
    if (/^\d+$/.test(v)) return toMs(Number(v));
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(v)) return null;
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}
