import { afterEach, describe, expect, it, vi } from "vitest";
import { ClickHouseUnavailableError, createClickHouseClient } from "./clickhouse";

const okResponse = (rows: unknown[]) =>
  new Response(rows.map((row) => JSON.stringify(row)).join("\n"), { status: 200 });

describe("clickhouse client", () => {
  afterEach(() => vi.restoreAllMocks());

  it("posts the query body with bound params and parses JSONEachRow", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse([{ date: "2026-08-01", revenueSatang: 1200 }, { date: "2026-08-02", revenueSatang: 900 }])
    );
    const query = createClickHouseClient({ url: "http://ch:8123", user: "u", password: "p", database: "laundrytwin_analytics", fetchImpl });

    const rows = await query<{ date: string; revenueSatang: number }>(
      "SELECT toDate(started_at) AS date FROM fact_machine_usage WHERE started_at >= {from:String}",
      { from: "2026-08-01" }
    );

    expect(rows).toHaveLength(2);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://ch:8123/?database=laundrytwin_analytics&default_format=JSONEachRow&param_from=2026-08-01");
    expect(init.headers).toMatchObject({ Authorization: "Basic " + Buffer.from("u:p").toString("base64") });
    expect(String(init.body)).toContain("fact_machine_usage");
  });

  it("maps network failures to ClickHouseUnavailableError", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const query = createClickHouseClient({ fetchImpl });
    await expect(query("SELECT 1")).rejects.toBeInstanceOf(ClickHouseUnavailableError);
  });

  it("maps non-2xx responses to ClickHouseUnavailableError without leaking the SQL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("secret-secret FROM users", { status: 403 }));
    const query = createClickHouseClient({ fetchImpl });
    await expect(query("SELECT secret_col FROM users")).rejects.toThrow(/ClickHouse request failed with status 403/);
    await expect(query("SELECT secret_col FROM users")).rejects.not.toThrow(/secret_col/);
  });

  it("maps a malformed JSONEachRow body to ClickHouseUnavailableError without leaking the body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("ok-line\n{not json", { status: 200 }));
    const query = createClickHouseClient({ fetchImpl });
    await expect(query("SELECT 1")).rejects.toBeInstanceOf(ClickHouseUnavailableError);
    await expect(query("SELECT 1")).rejects.not.toThrow(/\{not json/);
  });
});
