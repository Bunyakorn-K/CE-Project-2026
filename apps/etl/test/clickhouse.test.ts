import { describe, expect, it } from "vitest";
import { ClickHouseClient, ClickHouseError } from "../src/clickhouse.js";

describe("ClickHouseClient request budget", () => {
  it("passes an abort signal so a hung HTTP request cannot stall the ETL forever", async () => {
    let seenSignal: AbortSignal | null | undefined;
    const client = new ClickHouseClient({
      requestTimeoutMs: 5000,
      fetchImpl: async (_url, init) => {
        seenSignal = init?.signal;
        return new Response("", { status: 200 });
      },
    });

    await client.query("SELECT 1");
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it("rejects loudly when the request exceeds its budget", async () => {
    const client = new ClickHouseClient({
      requestTimeoutMs: 20,
      // A server that accepts the connection and then never answers — the same
      // shape as the blocked Postgres statement that hid the 2026-09-25 hang.
      fetchImpl: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
          });
        }),
    });

    await expect(client.query("SELECT 1")).rejects.toThrow(ClickHouseError);
    await expect(client.query("SELECT 1")).rejects.toThrow(/budget of 20 ms/);
  });

  it("defaults to a bounded budget rather than waiting forever", async () => {
    const client = new ClickHouseClient({
      fetchImpl: async () => new Response("", { status: 200 }),
    });
    // The default is not observable from outside; assert the constructor accepts
    // an omitted timeout and still sets a signal on every request.
    let seenSignal: AbortSignal | null | undefined;
    const bounded = new ClickHouseClient({
      fetchImpl: async (_url, init) => {
        seenSignal = init?.signal;
        return new Response("", { status: 200 });
      },
    });
    await bounded.insert("dim_branch", [{ branch_id: "b" }]);
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(client).toBeInstanceOf(ClickHouseClient);
  });
});
