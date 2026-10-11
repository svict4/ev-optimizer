/**
 * Car API abstraction. The controller talks to the car through exactly one
 * provider per install — Tessie, Teslascope or TeslaFi — chosen by which
 * token secret is set. All proxy Tesla's Fleet API (command signing included);
 * commands are still not confirmations (invariant 4).
 */
import type { Charge } from "../charges";
import { TeslaFiClient } from "./teslafi";
import { TeslascopeClient } from "./teslascope";
import { TessieClient } from "./tessie";

export interface CarState {
  pluggedIn: boolean;
  chargingState: string; // Tesla charging_state: "Charging" | "Stopped" | "Complete" | "Disconnected" | ...
  socPct: number;
  limitPct: number;
  chargeAmps: number | null; // null = not reported
  latLon: { lat: number; lon: number } | null; // null = unknown → NOT home (invariant 7)
}

export interface CarClient {
  readonly name: string;
  /** Cached car state (must not wake the car). Fails loud on missing fields. */
  getCarState(): Promise<CarState>;
  startCharging(): Promise<void>;
  stopCharging(): Promise<void>;
  setChargingAmps(amps: number): Promise<void>;
  /** Charge history overlapping [fromS, toS] (unix SECONDS). Absent when
   *  the provider has none (TeslaFi): the nightly pull then excludes
   *  car-sized load spikes instead (src/charges.ts spikeSlots). */
  getCharges?(fromS: number, toS: number): Promise<Charge[]>;
  /** Raw state payload, for /debug/car shape checks. */
  rawState(): Promise<unknown>;
}

export interface CarEnv {
  TESSIE_TOKEN?: string;
  TESSIE_VIN?: string;
  TESLASCOPE_TOKEN?: string;
  TESLASCOPE_VEHICLE_ID?: string;
  TESLAFI_TOKEN?: string; // per-vehicle token: no VIN needed
}

/** Exactly one provider's token must be set. Ambiguity is a config error,
 *  not a silent pick: the wrong account could command the wrong car. */
export function carFromEnv(env: CarEnv): CarClient {
  const set = (["TESSIE_TOKEN", "TESLASCOPE_TOKEN", "TESLAFI_TOKEN"] as const).filter((k) => !!env[k]);
  if (set.length > 1) throw new Error(`more than one car API token set (${set.join(", ")}); keep one`);
  if (env.TESSIE_TOKEN) {
    if (!env.TESSIE_VIN) throw new Error("TESSIE_VIN missing");
    return new TessieClient(env.TESSIE_TOKEN, env.TESSIE_VIN);
  }
  if (env.TESLASCOPE_TOKEN) {
    if (!env.TESLASCOPE_VEHICLE_ID) throw new Error("TESLASCOPE_VEHICLE_ID missing");
    return new TeslascopeClient(env.TESLASCOPE_TOKEN, env.TESLASCOPE_VEHICLE_ID);
  }
  if (env.TESLAFI_TOKEN) return new TeslaFiClient(env.TESLAFI_TOKEN);
  throw new Error("no car API configured: set TESSIE_TOKEN, TESLASCOPE_TOKEN or TESLAFI_TOKEN");
}
