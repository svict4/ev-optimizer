import { afterEach, describe, expect, it, vi } from "vitest";
import { d1Retry, notify } from "./index";

const overload = () => new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long");

describe("d1Retry", () => {
  it("returns the first success", async () => {
    let calls = 0;
    await expect(d1Retry(async () => ++calls, [0, 0, 0])).resolves.toBe(1);
    expect(calls).toBe(1);
  });

  it("rethrows non-transient errors immediately", async () => {
    let calls = 0;
    await expect(
      d1Retry(async () => {
        calls++;
        throw new Error("D1_ERROR: UNIQUE constraint failed");
      }, [0, 0, 0]),
    ).rejects.toThrow("UNIQUE constraint");
    expect(calls).toBe(1);
  });

  it("retries transient overload and succeeds", async () => {
    let calls = 0;
    const result = await d1Retry(async () => {
      if (++calls < 3) throw overload();
      return "ok";
    }, [0, 0, 0]);
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("gives up after the delay schedule is exhausted", async () => {
    let calls = 0;
    await expect(
      d1Retry(async () => {
        calls++;
        throw overload();
      }, [0, 0, 0]),
    ).rejects.toThrow("overloaded");
    expect(calls).toBe(3);
  });
});

describe("notify", () => {
  const env = { NTFY_TOPIC: "test-topic" } as unknown as Parameters<typeof notify>[0];
  const resp = (status: number) => new Response(null, { status });

  afterEach(() => vi.unstubAllGlobals());

  it("sends once on a 2xx", async () => {
    const fetch = vi.fn().mockResolvedValue(resp(200));
    vi.stubGlobal("fetch", fetch);
    await expect(notify(env, "hi", [0, 0, 0])).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://ntfy.sh/test-topic");
  });

  it("posts to a self-hosted server when NTFY_URL is set", async () => {
    const fetch = vi.fn().mockResolvedValue(resp(200));
    vi.stubGlobal("fetch", fetch);
    await notify({ ...env, NTFY_URL: "https://ntfy.example.org/" }, "hi", [0, 0, 0]);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://ntfy.example.org/test-topic");
  });

  it("retries a transient 5xx (ntfy 522 behind Cloudflare) and succeeds", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(resp(522))
      .mockResolvedValueOnce(resp(522))
      .mockResolvedValueOnce(resp(200));
    vi.stubGlobal("fetch", fetch);
    await expect(notify(env, "drift", [0, 0, 0])).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("retries a network-level failure and succeeds", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("connection reset")).mockResolvedValueOnce(resp(200));
    vi.stubGlobal("fetch", fetch);
    await expect(notify(env, "drift", [0, 0, 0])).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fails loud immediately on a 4xx without retrying", async () => {
    const fetch = vi.fn().mockResolvedValue(resp(404));
    vi.stubGlobal("fetch", fetch);
    await expect(notify(env, "hi", [0, 0, 0])).rejects.toThrow("ntfy 404");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("throws loud after the retry schedule is exhausted", async () => {
    const fetch = vi.fn().mockResolvedValue(resp(522));
    vi.stubGlobal("fetch", fetch);
    await expect(notify(env, "drift", [0, 0, 0])).rejects.toThrow("ntfy 522");
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
