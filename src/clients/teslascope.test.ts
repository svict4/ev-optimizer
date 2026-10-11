import { afterEach, describe, expect, it, vi } from "vitest";
import { carFromEnv } from "./car";
import { TeslaFiClient } from "./teslafi";
import { TeslascopeClient } from "./teslascope";
import { TessieClient } from "./tessie";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("carFromEnv", () => {
  it("picks Tessie when only its token is set", () => {
    expect(carFromEnv({ TESSIE_TOKEN: "t", TESSIE_VIN: "v" })).toBeInstanceOf(TessieClient);
  });
  it("picks Teslascope when only its token is set", () => {
    expect(carFromEnv({ TESLASCOPE_TOKEN: "t", TESLASCOPE_VEHICLE_ID: "abc" })).toBeInstanceOf(TeslascopeClient);
  });
  it("refuses both tokens rather than guessing", () => {
    expect(() =>
      carFromEnv({ TESSIE_TOKEN: "t", TESSIE_VIN: "v", TESLASCOPE_TOKEN: "t", TESLASCOPE_VEHICLE_ID: "a" }),
    ).toThrow(/more than one/);
    expect(() => carFromEnv({ TESSIE_TOKEN: "t", TESSIE_VIN: "v", TESLAFI_TOKEN: "f" })).toThrow(/more than one/);
  });
  it("picks TeslaFi when only its token is set (no vehicle id needed)", () => {
    expect(carFromEnv({ TESLAFI_TOKEN: "f" })).toBeInstanceOf(TeslaFiClient);
  });
  it("refuses no token", () => {
    expect(() => carFromEnv({})).toThrow(/no car API/);
  });
  it("refuses a token without its vehicle id", () => {
    expect(() => carFromEnv({ TESSIE_TOKEN: "t" })).toThrow(/TESSIE_VIN/);
    expect(() => carFromEnv({ TESLASCOPE_TOKEN: "t" })).toThrow(/TESLASCOPE_VEHICLE_ID/);
  });
});

describe("TeslascopeClient.getCarState", () => {
  const client = new TeslascopeClient("tok", "abc123");
  const detailed = {
    charge_state: { battery_level: 55, charge_limit_soc: 80, charging_state: "Charging", charge_amps: 12 },
    drive_state: { latitude: -27.5, longitude: 153.0 },
  };

  it("reads /detailed with a bearer token", async () => {
    const fetch = vi.fn().mockResolvedValue(json(detailed));
    vi.stubGlobal("fetch", fetch);
    await expect(client.getCarState()).resolves.toEqual({
      pluggedIn: true,
      chargingState: "Charging",
      socPct: 55,
      limitPct: 80,
      chargeAmps: 12,
      latLon: { lat: -27.5, lon: 153.0 },
    });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://teslascope.com/api/vehicle/abc123/detailed");
    expect(fetch.mock.calls[0]?.[1].headers.Authorization).toBe("Bearer tok");
  });

  it("unwraps a { response } envelope", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ response: detailed })));
    await expect(client.getCarState()).resolves.toMatchObject({ socPct: 55 });
  });

  it("falls back to detailed_charge_state", async () => {
    const body = {
      charge_state: { battery_level: 55, charge_limit_soc: 80, detailed_charge_state: "DetailedChargeStateDisconnected" },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(body)));
    await expect(client.getCarState()).resolves.toMatchObject({
      chargingState: "Disconnected",
      pluggedIn: false,
      chargeAmps: null,
      latLon: null, // unknown location = NOT home
    });
  });

  it("fails loud on missing charge fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ charge_state: { battery_level: 55 } })));
    await expect(client.getCarState()).rejects.toThrow(/missing charge_state/);
  });

  it("throws on a non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({}, 401)));
    await expect(client.getCarState()).rejects.toThrow(/401/);
  });
});

describe("TeslascopeClient commands", () => {
  const client = new TeslascopeClient("tok", "abc123");

  it("POSTs the camelCase command paths", async () => {
    const fetch = vi.fn().mockImplementation(async () => json({}));
    vi.stubGlobal("fetch", fetch);
    await client.startCharging();
    await client.stopCharging();
    await client.setChargingAmps(9);
    expect(fetch.mock.calls.map((c) => [c[1].method, c[0]])).toEqual([
      ["POST", "https://teslascope.com/api/vehicle/abc123/command/startCharging"],
      ["POST", "https://teslascope.com/api/vehicle/abc123/command/stopCharging"],
      ["POST", "https://teslascope.com/api/vehicle/abc123/command/setChargingAmps?amps=9&charging_amps=9"],
    ]);
  });

  it("a rejected command throws (commands are not confirmations, failures are loud)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({}, 400)));
    await expect(client.setChargingAmps(9)).rejects.toThrow(/400/);
  });
});

describe("TeslascopeClient.getCharges", () => {
  const client = new TeslascopeClient("tok", "abc123");
  const from = Date.UTC(2026, 9, 1) / 1000;
  const to = Date.UTC(2026, 9, 3) / 1000;

  it("parses seconds, ms and zoned ISO, and filters to the range", async () => {
    const body = {
      response: [
        { started_at: from + 3600, ended_at: from + 7200, latitude: -27.5, longitude: 153 },
        { start_date: "2026-10-02T01:00:00+10:00", end_date: null },
        { started_at: (from + 60) * 1000, ended_at: (from + 120) * 1000 },
        { started_at: to + 3600, ended_at: to + 7200 }, // after range
      ],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(body)));
    await expect(client.getCharges(from, to)).resolves.toEqual([
      { startedAtMs: (from + 3600) * 1000, endedAtMs: (from + 7200) * 1000, lat: -27.5, lon: 153 },
      { startedAtMs: Date.UTC(2026, 9, 1, 15), endedAtMs: null, lat: null, lon: null },
      { startedAtMs: (from + 60) * 1000, endedAtMs: (from + 120) * 1000, lat: null, lon: null },
    ]);
  });

  it("fails loud on a zoneless timestamp (would be read as UTC)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json([{ started_at: "2026-10-02 01:00:00" }])));
    await expect(client.getCharges(from, to)).rejects.toThrow(/start time/);
  });

  it("fails loud on an unknown shape", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ sessions: {} })));
    await expect(client.getCharges(from, to)).rejects.toThrow(/no list/);
  });
});
