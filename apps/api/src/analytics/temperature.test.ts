import { describe, expect, it } from "vitest";
import type { Principal } from "../access-store";
import { CURVE_SQL } from "./queries";
import { buildTestApp, fakeClickhouse } from "./routes.test";
import type { FakeRow } from "./routes.test";

const principalFor = (role: "owner" | "technician", branchId: string | null): Principal => ({
  source: "demo",
  user: { id: "u1", name: "T", email: "t@e.com" },
  grants: [{ id: "g", role, branchId }]
});

// `countIf(...) OVER ()` has no PARTITION BY, so ClickHouse returns the SAME
// window value on every row (verified against the local warehouse: 5 rows, all
// 8867/8867). A window that is entirely synthetic is 2 of 2 samples.
const curveRows: FakeRow[] = [
  { occurredAt: "2026-08-01 09:05:00", machineId: "m1", machineCode: "W-1", temperatureF: "140.5", temperatureC: "60.3", phase: "wash", synthCount: "2", totalCount: "2" },
  { occurredAt: "2026-08-01 09:20:00", machineId: "m1", machineCode: "W-1", temperatureF: null, temperatureC: null, phase: "spin", synthCount: "2", totalCount: "2" }
];

// A genuinely mixed window is 2 synthetic samples out of 4 in the range, and
// the window value is that same 2/4 on both rows. The previous fixture varied
// synthCount per row (2 then 0), which an unpartitioned OVER () cannot produce,
// and existed only to make the old per-row summing return the right tag.
const mixedRows: FakeRow[] = [
  { ...curveRows[0], synthCount: "2", totalCount: "4" },
  { ...curveRows[1], synthCount: "2", totalCount: "4" }
];

// The FULL branch and machine disjunctions are pinned so a tenant-wide or
// unfiltered request cannot silently drop either predicate from the template.
const SCOPED_CURVE_QUERY = /\{branchId:String\} = '' OR toString\(s\.branch_id\) = \{branchId:String\}[\s\S]*\{machineId:String\} = '' OR s\.machine_id = \{machineId:String\}/;

describe("temperature curve endpoint", () => {
  it("returns samples with numeric temps, null passthrough, and synthetic meta for owners", async () => {
    const clickhouse = fakeClickhouse([{ match: /fact_temperature_sample/, rows: curveRows }]);
    const app = buildTestApp(principalFor("owner", null), { clickhouse });

    const response = await app.request("/api/v1/analytics/temperature/curve?from=2026-08-01&to=2026-08-31");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual([
      { occurredAt: "2026-08-01 09:05:00", machineId: "m1", machineCode: "W-1", temperatureF: 140.5, temperatureC: 60.3, phase: "wash" },
      { occurredAt: "2026-08-01 09:20:00", machineId: "m1", machineCode: "W-1", temperatureF: null, temperatureC: null, phase: "spin" }
    ]);
    expect(body.meta.dataSource).toBe("synthetic");
    expect(body.meta.range).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    // Owner without filters is tenant-wide and unfiltered by machine: empty-string sentinels.
    expect(clickhouse).toHaveBeenCalledWith(
      expect.stringMatching(SCOPED_CURVE_QUERY),
      expect.objectContaining({ branchId: "", machineId: "", from: "2026-08-01", to: "2026-08-31" })
    );
  });

  it("tags mixed when synthetic and real samples share the window", async () => {
    const app = buildTestApp(principalFor("owner", null), {
      clickhouse: fakeClickhouse([{ match: /fact_temperature_sample/, rows: mixedRows }])
    });

    const response = await app.request("/api/v1/analytics/temperature/curve");

    expect(response.status).toBe(200);
    const body = await response.json();
    // 4 total samples in the window, 2 synthetic → neither pure tag applies.
    expect(body.meta.dataSource).toBe("mixed");
  });

  // The window value is constant across rows, so it must be READ, not summed.
  // Summing an 8,208-row window across 5,000 returned rows reported 41,040,000
  // rows in range for a table that holds 8,867.
  it("reads the range total instead of summing the constant window value", async () => {
    const repeated: FakeRow[] = Array.from({ length: 3 }, (_, index) => ({
      ...curveRows[0],
      occurredAt: `2026-08-01 09:0${index}:00`,
      synthCount: "2",
      totalCount: "4"
    }));
    const app = buildTestApp(principalFor("owner", null), {
      clickhouse: fakeClickhouse([{ match: /fact_temperature_sample/, rows: repeated }])
    });

    const response = await app.request("/api/v1/analytics/temperature/curve");
    const body = await response.json();

    // 3 rows x a window of 4 would sum to 12. The honest figure is 4, which is
    // also what makes 3 < 4 readable as "the cap dropped one row".
    expect(body.meta.dataSource).toBe("mixed");
    expect(body.meta.truncation).toEqual({ returnedRows: 3, totalRowsInRange: 4, limit: 5000, kept: "newest" });
  });

  it("forwards the optional machineId filter as a bound param", async () => {
    const clickhouse = fakeClickhouse([{ match: /fact_temperature_sample/, rows: [] }]);
    const app = buildTestApp(principalFor("owner", null), { clickhouse });

    const response = await app.request("/api/v1/analytics/temperature/curve?from=2026-08-01&to=2026-08-02&machineId=m9");

    expect(response.status).toBe(200);
    expect(clickhouse).toHaveBeenCalledWith(
      // LIMIT stays inside the fixed template; the machine filter rides the bind, not the text.
      expect.stringMatching(/LIMIT 5000/),
      expect.objectContaining({ machineId: "m9" })
    );
    const body = await response.json();
    expect(body.data).toEqual([]);
  });

  // `ORDER BY occurred_at ASC LIMIT 5000` kept the OLDEST 5,000 rows in the
  // range and silently dropped everything newer. For 2026-07-01..2026-08-25 the
  // endpoint returned 5,000 rows whose newest was 2026-08-04 13:06 — 21 days
  // before the end of the requested range — while meta.range still said the
  // panel described 07-01..08-25.
  it("keeps the NEWEST rows under the 5000 cap, not the oldest", () => {
    const sql = CURVE_SQL;

    // The cap must be applied while ordering newest-first. An ascending
    // ORDER BY immediately above the LIMIT is the defect.
    expect(sql).toMatch(/ORDER BY occurredAt DESC\s+LIMIT 5000/);
    expect(sql).not.toMatch(/ORDER BY occurred_at ASC\s+LIMIT 5000/);
    // The window counts must be evaluated inside the subquery, i.e. before the
    // LIMIT, or they would describe the capped result instead of the range.
    expect(sql.indexOf("count() OVER ()")).toBeLessThan(sql.indexOf("LIMIT 5000"));
  });

  // ClickHouse can push a LIMIT beneath window-function evaluation when both
  // sit in one query block (github.com/ClickHouse/ClickHouse/issues/23125,
  // fixed in #36075 — it shipped a wrong answer). If the pushdown reappeared,
  // `count() OVER ()` would report the CAPPED count and the endpoint would
  // claim nothing was dropped for a window that dropped thousands. The
  // structural guard is that the window functions live in a query block with no
  // ORDER BY and no LIMIT, so there is nothing for a pushdown to move beneath
  // them.
  //
  // The block is found by paren matching rather than by slicing to a string
  // offset: slicing to `count() OVER ()` would stop BEFORE a same-block
  // ORDER BY and pass vacuously, which is exactly the regression this guards.
  it("computes the window counts in a query block that has no ORDER BY and no LIMIT", () => {
    const sql = CURVE_SQL;

    // The innermost `FROM (` is the one opening the window block.
    const open = sql.lastIndexOf("FROM (");
    expect(open).toBeGreaterThan(-1);

    let depth = 0;
    let close = -1;
    for (let i = open + "FROM ".length; i < sql.length; i += 1) {
      if (sql[i] === "(") depth += 1;
      else if (sql[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    expect(close).toBeGreaterThan(open);

    const windowBlock = sql.slice(open, close);
    expect(windowBlock).toContain("countIf(event_id LIKE 'synthetic:%') OVER ()");
    expect(windowBlock).toContain("count() OVER ()");
    expect(windowBlock).not.toMatch(/ORDER BY/);
    expect(windowBlock).not.toMatch(/LIMIT/);

    // The DESC cap still has to exist, in a block OUTSIDE the window block, so
    // the only clause that can truncate is applied after the window is computed.
    const afterWindowBlock = sql.slice(close);
    expect(afterWindowBlock).toMatch(/ORDER BY occurredAt DESC\s+LIMIT 5000/);
  });

  it("returns the kept rows in ascending time order for the consumer", () => {
    // The web panel takes the LAST 8 rows and reverses them, so the response
    // has to stay oldest-first or it would show the oldest of the newest 5,000.
    expect(CURVE_SQL.trimEnd().endsWith("ORDER BY occurredAt ASC")).toBe(true);
  });

  // The window counts are evaluated over the whole range BEFORE the cap, so
  // they are the honest denominator. Measured on the local warehouse for
  // 2026-07-01..2026-08-25: 8,208 rows in range, 5,000 returned.
  it("reports how many rows in range the cap dropped", async () => {
    const capped: FakeRow[] = Array.from({ length: 5000 }, (_, index) => ({
      ...curveRows[0],
      occurredAt: `2026-08-01 09:${String(index % 60).padStart(2, "0")}:00`
    }));
    // Every row carries the pre-cap range total, not the returned count.
    for (const row of capped) {
      row.synthCount = "0";
      row.totalCount = "8208";
    }
    const app = buildTestApp(principalFor("owner", null), {
      clickhouse: fakeClickhouse([{ match: /fact_temperature_sample/, rows: capped }])
    });

    const response = await app.request("/api/v1/analytics/temperature/curve?from=2026-07-01&to=2026-08-25");
    const body = await response.json();

    expect(body.meta.truncation).toEqual({ returnedRows: 5000, totalRowsInRange: 8208, limit: 5000, kept: "newest" });
  });

  it("omits the truncation marker when nothing was dropped", async () => {
    const app = buildTestApp(principalFor("owner", null), {
      clickhouse: fakeClickhouse([{ match: /fact_temperature_sample/, rows: curveRows }])
    });

    const response = await app.request("/api/v1/analytics/temperature/curve?from=2026-08-01&to=2026-08-31");
    const body = await response.json();

    expect(body.meta.truncation).toBeUndefined();
  });

  it("does not claim truncation for an empty range", async () => {
    const app = buildTestApp(principalFor("owner", null), { clickhouse: fakeClickhouse([{ match: /fact_temperature_sample/, rows: [] }]) });

    const response = await app.request("/api/v1/analytics/temperature/curve?from=2026-08-01&to=2026-08-31");
    const body = await response.json();

    expect(body.meta.truncation).toBeUndefined();
    expect(body.meta.dataSource).toBe("empty");
  });

  it("serves technicians within their own branch scope", async () => {
    const clickhouse = fakeClickhouse([{ match: /fact_temperature_sample/, rows: curveRows.map((row) => ({ ...row, synthCount: "0" })) }]);
    const app = buildTestApp(principalFor("technician", "b1"), { clickhouse });

    const response = await app.request("/api/v1/analytics/temperature/curve?branchId=b1&machineId=m1");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.meta.branchId).toBe("b1");
    expect(body.meta.dataSource).toBe("real");
    expect(clickhouse).toHaveBeenCalledWith(
      expect.stringMatching(SCOPED_CURVE_QUERY),
      expect.objectContaining({ branchId: "b1", machineId: "m1" })
    );
  });

  it("rejects cross-branch requests before querying", async () => {
    const clickhouse = fakeClickhouse([{ match: /./, rows: [] }]);
    const app = buildTestApp(principalFor("technician", "b1"), { clickhouse });

    const response = await app.request("/api/v1/analytics/temperature/curve?branchId=b2");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: { code: "BRANCH_FORBIDDEN", message: "You cannot view this branch" } });
    expect(clickhouse).not.toHaveBeenCalled();
  });
});

// The curve query is the only reader of fact_temperature_sample in the app, and
// it renders raw samples straight onto the chart. Until 2026-09-30 the table was
// a plain MergeTree carrying 1,503,920 duplicate sort keys, and this query had
// no FINAL on it. Measured on 2026-09-30 over 2026-09-22..26: it returned 35,486
// rows for 34,169 distinct readings, so 1,317 readings were drawn twice and the
// rows-in-range figure in `meta.truncation` was inflated by the same amount.
//
// The engine change is what makes the query fix possible, not a nicety: run
// against the old plain-MergeTree table, `... AS s FINAL` is refused outright
// with `Code: 181 DB::Exception: Storage MergeTree doesn't support FINAL
// (ILLEGAL_FINAL)`. FINAL alone could never have deduplicated that table.
describe("CURVE_SQL deduplication", () => {
  it("reads fact_temperature_sample with FINAL", () => {
    expect(CURVE_SQL).toMatch(/FROM\s+fact_temperature_sample\s+AS\s+s\s+FINAL/);
  });

  it("puts FINAL after the alias, which is the only order ClickHouse accepts", () => {
    // `FROM t FINAL AS s` parses as a table named `t` with a stray FINAL and an
    // alias in the wrong slot: the server answers
    //   Syntax error ... Expected alias cannot be here. (SYNTAX_ERROR)
    // The first version of this test only regex-matched the token and passed
    // against SQL the server would not run. Assert the whole clause instead.
    expect(CURVE_SQL).not.toMatch(/fact_temperature_sample\s+FINAL\s+AS\s+s/);
  });

  it("does not re-introduce an unversioned read of the temperature table", () => {
    // Guards the specific regression: tidying the SQL back to a bare
    // `FROM fact_temperature_sample AS s` would silently restore the double
    // drawing, and every test above would still pass, because they feed the
    // handler pre-deduplicated fixtures.
    const reads = CURVE_SQL.match(/FROM\s+fact_temperature_sample[^)\n]*/g) ?? [];
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read).toMatch(/\bFINAL\b/);
    }
  });

  it("keeps FINAL on dim_machine too", () => {
    expect(CURVE_SQL).toMatch(/dim_machine\s+AS\s+m\s+FINAL/);
  });
});
