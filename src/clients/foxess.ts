/**
 * FoxESS Open API client.
 * Docs: https://www.foxesscloud.com/public/i18n/en/OpenApiDocument.html
 * Rate limit: 1,440 calls/day, query endpoints max 1/second.
 *
 * Auth (verified against the official doc v1.1.18 and TonyM1958/FoxESS-Cloud,
 * 2026-07-04): headers token/timestamp(ms)/signature/lang, where signature is
 * lowercase-hex MD5 of `path + "\r\n" + token + "\r\n" + timestamp` — the
 * separator is the LITERAL four characters backslash-r-backslash-n, not CRLF
 * (both sources hash Python raw strings). Path only: no host, query, or body.
 * Envelope: { errno, msg?, result } with errno === 0 on success.
 */
import { addDays, localMidnightMs, offsetSuffix, utcOffsetMins, type Site } from "../site";

export class FoxEssClient {
  constructor(
    private apiKey: string,
    private deviceSn: string,
    private base = "https://www.foxesscloud.com",
  ) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request("POST", path, { body });
  }

  /** Signature covers the PATH ONLY — query strings are excluded, so GET
   *  endpoints sign identically to POST ones. */
  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Record<string, string>; raw?: boolean } = {},
  ): Promise<T> {
    const timestamp = Date.now().toString();
    const signature = await md5Hex(`${path}\\r\\n${this.apiKey}\\r\\n${timestamp}`);
    const qs = opts.query ? `?${new URLSearchParams(opts.query)}` : "";
    const res = await fetch(this.base + path + qs, {
      method,
      headers: {
        token: this.apiKey,
        timestamp,
        signature,
        lang: "en",
        "Content-Type": "application/json",
        // FoxESS WAF blocks default library user agents.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) throw new Error(`FoxESS HTTP ${res.status} on ${path}`);
    const json = (await res.json()) as { errno: number; msg?: string; result: T };
    if (opts.raw) return json as unknown as T; // full envelope, even errno != 0
    if (json.errno !== 0) {
      throw new Error(`FoxESS errno ${json.errno} (${json.msg ?? "no msg"}) on ${path}`);
    }
    return json.result;
  }

  async getRealTime(): Promise<{
    socPct: number;
    loadW: number;
    gridImportW: number;
    pvW: number | null;
    feedinW: number | null;
    runningState: number | null;
  }> {
    // v0 real/query is deprecated; v1 takes an sns array. Battery variables
    // carry a bank-index suffix on (at least) this inverter: SoC_1, not SoC
    // (live-verified 2026-07-06 via /debug/foxess) — request and accept both.
    const result = await this.post<
      { deviceSN: string; datas: { variable: string; value: number }[] }[]
    >("/op/v1/device/real/query", {
      sns: [this.deviceSn],
      variables: ["SoC", "SoC_1", "loadsPower", "gridConsumptionPower", "pvPower", "feedinPower", "runningState"],
    });
    const datas = result[0]?.datas ?? [];
    const get = (...names: string[]): number => {
      // variables the device lacks are silently omitted from datas
      for (const name of names) {
        const v = datas.find((d) => d.variable === name)?.value;
        if (typeof v === "number") return v;
      }
      throw new Error(`FoxESS real-time missing ${names.join("/")}`);
    };
    // pv/feedin are optional: GLIDE degrades to floor-hold without them
    // (SPEC), so their absence must not kill the whole tick.
    const opt = (variable: string): number | null => {
      const v = datas.find((d) => d.variable === variable)?.value;
      return typeof v === "number" ? Math.round(v * 1000) : null;
    };
    return {
      socPct: get("SoC_1", "SoC"), // %
      loadW: Math.round(get("loadsPower") * 1000), // kW -> W
      gridImportW: Math.round(get("gridConsumptionPower") * 1000), // kW -> W
      pvW: opt("pvPower"),
      feedinW: opt("feedinPower"),
      // Inverter mode code (163 on-grid, 164 off-grid per community docs —
      // UNVERIFIED on this device, confirm via /debug/foxess). Raw, no kW
      // scaling; optional like pv/feedin. Used by the grid-offline guard.
      runningState: (() => {
        const v = datas.find((d) => d.variable === "runningState")?.value;
        const n = typeof v === "number" ? v : Number(v);
        return Number.isFinite(n) ? n : null;
      })(),
    };
  }

  /** Full real/query envelope, unfiltered (no variables list = everything the
   *  device reports) and un-unwrapped — for the admin /debug/foxess route. */
  async rawRealTime(): Promise<unknown> {
    return this.request("POST", "/op/v1/device/real/query", {
      body: { sns: [this.deviceSn] },
      raw: true,
    });
  }

  /** Read-only hardware-floor verification (step 2, rescoped: the controller
   *  never writes inverter settings). Endpoint per TonyM1958 reference;
   *  field name matched loosely and fail-loud — PLAN alerts on any throw. */
  async getMinSocOnGrid(): Promise<number> {
    const r = await this.request<Record<string, unknown>>("GET", "/op/v0/device/battery/soc/get", {
      query: { sn: this.deviceSn },
    });
    const key = Object.keys(r).find((k) => /grid/i.test(k) && typeof r[k] === "number");
    if (!key) throw new Error(`FoxESS soc/get: no grid-floor field (keys: ${Object.keys(r).join(",")})`);
    return r[key] as number;
  }

  /** One local day (YYYY-MM-DD) of loadsPower samples as half-hour kWh. */
  async pullDailyLoadHistory(
    date: string,
    site: Pick<Site, "timeZone">,
  ): Promise<{ slot: number; loadKwh: number }[]> {
    const begin = localMidnightMs(site, date);
    const dayEnd = localMidnightMs(site, addDays(date, 1));
    const result = await this.post<
      { datas: { variable: string; data: { time: string; value: number }[] }[] }[]
    >("/op/v0/device/history/query", {
      sn: this.deviceSn,
      variables: ["loadsPower"],
      begin,
      // Query span must stay <= 24 h: the 25-h day DST ends on loses its
      // last hour of samples (those slots just average over fewer days).
      end: Math.min(dayEnd, begin + 24 * 60 * 60 * 1000) - 1,
    });
    const samples = result[0]?.datas.find((d) => d.variable === "loadsPower")?.data ?? [];

    const bySlot = new Map<number, { sum: number; n: number }>();
    for (const s of samples) {
      // time is inverter-local, e.g. "2025-11-25 17:58:16 CST+0800". Slot
      // arithmetic below assumes the device clock is TIME_ZONE wall time
      // (including its DST changes); a wrong cloud-side timezone would
      // silently phase-shift every slot, so fail loud instead (the nightly
      // caller alerts on any throw).
      const off = /([+-])(\d{2})(\d{2})$/.exec(s.time);
      const offMins = off ? (off[1] === "-" ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3])) : NaN;
      const wall = Date.parse(`${s.time.slice(0, 10)}T${s.time.slice(11, 19)}Z`);
      const want = utcOffsetMins(site, wall - offMins * 60_000);
      if (!Number.isFinite(wall) || offMins !== want) {
        throw new Error(
          `FoxESS sample time not UTC${offsetSuffix(want)} (${s.time}); fix the device timezone in FoxESS cloud or TIME_ZONE`,
        );
      }
      // the API can over-run into the next day; keep only the requested date
      if (s.time.slice(0, 10) !== date) continue;
      if (typeof s.value !== "number") continue; // API is known to return nulls
      const slot =
        Number(s.time.slice(11, 13)) * 2 + (Number(s.time.slice(14, 16)) >= 30 ? 1 : 0);
      const agg = bySlot.get(slot) ?? { sum: 0, n: 0 };
      agg.sum += s.value; // kW
      agg.n += 1;
      bySlot.set(slot, agg);
    }
    // ponytail: mean kW x 0.5 h assumes roughly uniform ~5-min samples;
    // switch to time-weighted integration if sample gaps ever matter.
    return [...bySlot].map(([slot, { sum, n }]) => ({ slot, loadKwh: (sum / n) * 0.5 }));
  }
}

/** Workers-only: MD5 is a documented non-standard crypto.subtle extension
 *  (absent from Node webcrypto, so tests never exercise this path). */
async function md5Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("MD5", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
