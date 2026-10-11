/**
 * "Is the car at home?" — the hard gate on every car command (invariant 7).
 * Two signals:
 *  - gps: the car API's drive_state lat/lon within HOME_RADIUS_M of
 *    home_lat/home_lon (src/charges.ts haversine).
 *  - bluetooth: a device at home (Pi, ESP32, Home Assistant…) that sees the
 *    car's BLE advertisement and reports it to POST /presence. Any other
 *    automation can feed the same webhook.
 * D1 config home_detection picks how they combine. Pure — keep it
 * exhaustively testable. Unknown / stale always counts as NOT home.
 */
import { haversineM } from "./charges";
import { PRESENCE_MAX_AGE_MINS } from "./constants";

export const HOME_DETECTION_MODES = ["gps", "bluetooth", "gps_or_bluetooth", "gps_and_bluetooth"] as const;
export type HomeDetection = (typeof HOME_DETECTION_MODES)[number];

export interface PresenceReport {
  home: boolean;
  reportedAtMs: number;
}

/** Unset = gps (the pre-bluetooth behaviour). A typo must not silently
 *  change which signal gates commands, so unknown values throw. */
export function parseHomeDetection(v: string | undefined): HomeDetection {
  if (v === undefined || v === "") return "gps";
  if ((HOME_DETECTION_MODES as readonly string[]).includes(v)) return v as HomeDetection;
  throw new Error(`config home_detection '${v}' invalid (one of ${HOME_DETECTION_MODES.join(", ")})`);
}

export function gpsHome(
  latLon: { lat: number; lon: number } | null,
  home: { lat: number; lon: number },
  radiusM: number,
): boolean {
  return latLon !== null && haversineM(latLon.lat, latLon.lon, home.lat, home.lon) <= radiusM;
}

/** A "present" report only counts while fresh: a scanner that died (or a
 *  car that left while it was down) must decay to NOT home. */
export function bluetoothHome(report: PresenceReport | null, nowMs: number): boolean {
  if (!report || !report.home) return false;
  const ageMs = nowMs - report.reportedAtMs;
  return ageMs >= -60_000 && ageMs <= PRESENCE_MAX_AGE_MINS * 60_000; // small skew allowance
}

export function isHome(mode: HomeDetection, gps: boolean, bluetooth: boolean): boolean {
  switch (mode) {
    case "gps":
      return gps;
    case "bluetooth":
      return bluetooth;
    case "gps_or_bluetooth":
      return gps || bluetooth;
    case "gps_and_bluetooth":
      return gps && bluetooth;
  }
}
