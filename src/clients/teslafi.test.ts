import { afterEach, describe, expect, it, vi } from "vitest";
import { TeslaFiClient } from "./teslafi";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const text = (body: string) => new Response(body, { status: 200 });

afterEach(() => vi.unstubAllGlobals());

const client = new TeslaFiClient("tok");

describe("TeslaFiClient.getCarState", () => {
  // lastGood is flat, and TeslaFi sends most numbers as strings.
  const lastGood = {
    battery_level: "55",
    charge_limit_soc: "80",
    charging_state: "Charging",
    charge_current_request: "12",
    charger_actual_current: "11",
    latitude: "-27.5",
    longitude: "153.0",
  };

  it("reads lastGood with a bearer token and parses string numbers", async () => {
    const fetch = vi.fn().mockResolvedValue(json(lastGood));
    vi.stubGlobal("fetch", fetch);
    await expect(client.getCarState()).resolves.toEqual({
      pluggedIn: true,
      chargingState: "Charging",
      socPct: 55,
      limitPct: 80,
      chargeAmps: 12,
      latLon: { lat: -27.5, lon: 153.0 },
    });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://www.teslafi.com/feed.php?command=lastGood");
    expect(fetch.mock.calls[0]?.[1].headers.Authorization).toBe("Bearer tok");
  });

  it("empty location = unknown = NOT home; Disconnected = unplugged", async () => {
    const body = { ...lastGood, charging_state: "Disconnected", latitude: "", longitude: null, charge_current_request: "" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(body)));
    await expect(client.getCarState()).resolves.toMatchObject({ pluggedIn: false, latLon: null, chargeAmps: null });
  });

  it("fails loud on missing charge fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ battery_level: "55" })));
    await expect(client.getCarState()).rejects.toThrow(/missing charge fields/);
  });
});

describe("TeslaFiClient commands", () => {
  it("sends charge_start / charge_stop / set_charging_amps with wake", async () => {
    const fetch = vi.fn().mockImplementation(async () => json({ response: { result: true } }));
    vi.stubGlobal("fetch", fetch);
    await client.startCharging();
    await client.stopCharging();
    await client.setChargingAmps(9);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      "https://www.teslafi.com/feed.php?command=charge_start&wake=30",
      "https://www.teslafi.com/feed.php?command=charge_stop&wake=30",
      "https://www.teslafi.com/feed.php?command=set_charging_amps&charging_amps=9&wake=30",
    ]);
  });

  it("a 200 with result=false throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ response: { result: false, reason: "not_charging" } })));
    await expect(client.startCharging()).rejects.toThrow(/not_charging/);
  });

  it("a 200 with result='unauthorized' throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ response: { result: "unauthorized" } })));
    await expect(client.stopCharging()).rejects.toThrow(/unauthorized/);
  });

  it("a disabled command (plain-text 200) throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(text("This command is not enabled. Enable it in Settings")));
    await expect(client.setChargingAmps(9)).rejects.toThrow(/not enabled/);
  });

  it("an error envelope throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "invalid_token", error_description: "bad" })));
    await expect(client.startCharging()).rejects.toThrow(/invalid_token/);
  });

  it("a non-2xx throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({}, 500)));
    await expect(client.startCharging()).rejects.toThrow(/500/);
  });

  it("has no charge history (nightly pull uses the spike fallback)", () => {
    expect((client as { getCharges?: unknown }).getCharges).toBeUndefined();
  });
});
