import { describe, expect, it } from "vitest";
import { PRESENCE_MAX_AGE_MINS } from "./constants";
import { bluetoothHome, gpsHome, HOME_DETECTION_MODES, isHome, parseHomeDetection } from "./presence";

const HOME = { lat: -27.47, lon: 153.02 };
const NOW = Date.UTC(2026, 9, 5, 0, 0);
const MIN = 60_000;

describe("parseHomeDetection", () => {
  it("defaults to gps when unset", () => {
    expect(parseHomeDetection(undefined)).toBe("gps");
    expect(parseHomeDetection("")).toBe("gps");
  });
  it("accepts every mode", () => {
    for (const m of HOME_DETECTION_MODES) expect(parseHomeDetection(m)).toBe(m);
  });
  it("throws on a typo rather than silently switching signal", () => {
    expect(() => parseHomeDetection("bluetoooth")).toThrow(/home_detection/);
  });
});

describe("gpsHome", () => {
  it("inside the radius", () => expect(gpsHome({ lat: -27.4705, lon: 153.0205 }, HOME, 150)).toBe(true));
  it("outside the radius", () => expect(gpsHome({ lat: -27.48, lon: 153.02 }, HOME, 150)).toBe(false));
  it("unknown location is NOT home", () => expect(gpsHome(null, HOME, 150)).toBe(false));
});

describe("bluetoothHome", () => {
  it("fresh present report", () => {
    expect(bluetoothHome({ home: true, reportedAtMs: NOW - 2 * MIN }, NOW)).toBe(true);
  });
  it("present report right at the age limit still counts", () => {
    expect(bluetoothHome({ home: true, reportedAtMs: NOW - PRESENCE_MAX_AGE_MINS * MIN }, NOW)).toBe(true);
  });
  it("stale present report decays to NOT home (dead scanner)", () => {
    expect(bluetoothHome({ home: true, reportedAtMs: NOW - (PRESENCE_MAX_AGE_MINS + 1) * MIN }, NOW)).toBe(false);
  });
  it("absent report is NOT home, however fresh", () => {
    expect(bluetoothHome({ home: false, reportedAtMs: NOW }, NOW)).toBe(false);
  });
  it("no report ever is NOT home", () => expect(bluetoothHome(null, NOW)).toBe(false));
  it("unparsable timestamp is NOT home", () => {
    expect(bluetoothHome({ home: true, reportedAtMs: Number.NaN }, NOW)).toBe(false);
  });
  it("report far in the future is NOT home", () => {
    expect(bluetoothHome({ home: true, reportedAtMs: NOW + 10 * MIN }, NOW)).toBe(false);
  });
});

describe("isHome", () => {
  const table: [Parameters<typeof isHome>[0], boolean, boolean, boolean][] = [
    ["gps", true, false, true],
    ["gps", false, true, false],
    ["bluetooth", false, true, true],
    ["bluetooth", true, false, false],
    ["gps_or_bluetooth", true, false, true],
    ["gps_or_bluetooth", false, true, true],
    ["gps_or_bluetooth", false, false, false],
    ["gps_and_bluetooth", true, true, true],
    ["gps_and_bluetooth", true, false, false],
    ["gps_and_bluetooth", false, true, false],
  ];
  it.each(table)("%s gps=%s bt=%s -> %s", (mode, gps, bt, want) => {
    expect(isHome(mode, gps, bt)).toBe(want);
  });
});
