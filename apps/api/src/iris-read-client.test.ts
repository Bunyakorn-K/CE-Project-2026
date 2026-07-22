import { describe, expect, it, vi } from "vitest";
import { IrisReadUnavailableError, createIrisReadClient } from "./iris-read-client";

describe("IRIS read client", () => {
  it("does not fall back to demo data when the IRIS read API is unconfigured", async () => {
    const fetcher = vi.fn();
    const client = createIrisReadClient({ fetcher });

    await expect(client.getDashboard({ branchId: "branch-01" })).rejects.toBeInstanceOf(IrisReadUnavailableError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("forwards the scoped API key and preserves the reporting response", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          contractVersion: "2026-07-17",
          source: "postgres",
          fetchedAt: "2026-07-17T00:00:00.000Z",
          range: { from: "2026-07-17T00:00:00.000Z", to: "2026-07-18T00:00:00.000Z" },
          branches: [],
          totals: { revenueSatang: 184000, cycles: 5, machineCount: 5 }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const client = createIrisReadClient({
      baseUrl: "https://iris.example/v1/laundrygo",
      apiKey: "read-key",
      fetcher
    });

    const response = await client.getDashboard({ branchId: "branch-01", from: "2026-07-17", to: "2026-07-17" });

    expect(response.totals.revenueSatang).toBe(184000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "https://iris.example/v1/laundrygo/dashboard?branchId=branch-01&from=2026-07-17&to=2026-07-17"
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      headers: { "x-laundrygo-read-key": "read-key" }
    });
  });
});
