import { describe, expect, it, vi } from "vitest";
import {
  GAS_CHANNELS,
  GAS_UNIT,
  GasCollectorError,
  fetchGasHistory,
  isAvailableState,
  normalizeGasHistory,
  parsePsi,
  parseRecordedAt,
  runGasCollector,
  type GasTarget,
  type HaHistoryResponse
} from "../src/gas.js";

const TARGET: GasTarget = {
  tenant_id: "9069c13d-f590-402e-a200-08fe26bde21c",
  branch_id: "5e9611c1-6380-4d58-8ec7-ba4fb8fe4369",
  branch_slug: "otterimju2"
};

const INGESTED = new Date("2026-09-30T05:00:00.000Z");

/**
 * State strings and shapes here are taken from the real Home Assistant MySQL
 * export (data/gas-export/, gitignored) covering 2026-09-22..30, not invented.
 */
function entry(state: string, lastUpdated = "2026-09-30T04:33:12.345+00:00") {
  return {
    entity_id: "sensor.otterimju2_gas_pressure_a",
    state,
    last_changed: lastUpdated,
    last_updated: lastUpdated
  };
}

describe("parsePsi", () => {
  it("parses the integer psi values Home Assistant actually reports", () => {
    // Real values from the export: these entities report whole numbers.
    expect(parsePsi("104")).toBe(104);
    expect(parsePsi("87")).toBe(87);
    expect(parsePsi("22")).toBe(22);
  });

  it("returns null for 'unavailable', never 0", () => {
    // The load-bearing case. The true numeric minimum on all three entities
    // over 2026-09-22..30 is 9 psi, so 0 is not a value this data uses.
    // Coercing the sentinel to 0 would fabricate an empty-tank reading.
    expect(parsePsi("unavailable")).toBeNull();
    expect(parsePsi("unavailable")).not.toBe(0);
  });

  it("returns null for other non-numeric states rather than guessing", () => {
    expect(parsePsi("unknown")).toBeNull();
    expect(parsePsi("")).toBeNull();
    expect(parsePsi("   ")).toBeNull();
    expect(parsePsi(undefined)).toBeNull();
    expect(parsePsi("NaN")).toBeNull();
    expect(parsePsi("n/a")).toBeNull();
  });

  it("keeps a genuine 0 if one ever appears, because 0 is a real pressure", () => {
    // psi is gauge pressure; 0 is a physically meaningful reading, so it must
    // not be conflated with the sentinel. Not observed in this data — the
    // export has no 0 — but the parser must not be the thing that forbids it.
    expect(parsePsi("0")).toBe(0);
    expect(isAvailableState("0")).toBe(true);
  });

  it("parses decimal pressure", () => {
    expect(parsePsi("104.5")).toBe(104.5);
  });
});

describe("parseRecordedAt", () => {
  it("reads the offset-aware timestamp Home Assistant returns as a UTC instant", () => {
    // +07:00 shop local must not be stored as if it were UTC.
    const d = parseRecordedAt({ last_updated: "2026-09-30T11:33:12.345+07:00" });
    expect(d?.toISOString()).toBe("2026-09-30T04:33:12.345Z");
  });

  it("falls back to last_changed when last_updated is absent", () => {
    const d = parseRecordedAt({ last_changed: "2026-09-30T04:33:12.345+00:00" });
    expect(d?.toISOString()).toBe("2026-09-30T04:33:12.345Z");
  });

  it("returns null for an unparseable or missing timestamp instead of defaulting to now", () => {
    // Defaulting to `now` would place a sample at a time it was never taken.
    expect(parseRecordedAt({ last_updated: "not-a-date" })).toBeNull();
    expect(parseRecordedAt({})).toBeNull();
  });
});

describe("normalizeGasHistory", () => {
  it("maps each inner array to its channel positionally, not by name", () => {
    // minimal_response strips entity_id from middle entries, so position is
    // the only reliable binding. The collector does not request it, but the
    // walk must survive it.
    const response: HaHistoryResponse = [
      [{ state: "104", last_updated: "2026-09-30T04:00:00.000+00:00" }],
      [{ state: "87", last_updated: "2026-09-30T04:00:00.000+00:00" }],
      [{ state: "22", last_updated: "2026-09-30T04:00:00.000+00:00" }]
    ];
    const { rows } = normalizeGasHistory({ response, target: TARGET, ingestedAt: INGESTED });
    expect(rows.map((r) => [r.channel, r.value_psi])).toEqual([
      ["gas_run_a_pressure", 104],
      ["gas_run_b_pressure", 87],
      ["changeover_filter_pressure", 22]
    ]);
    expect(rows.every((r) => r.entity_id.startsWith("sensor.otterimju2_"))).toBe(true);
  });

  it("stamps every row with the target branch and the otterimju2 slug", () => {
    const { rows } = normalizeGasHistory({
      response: [[entry("104")], [], []],
      target: TARGET,
      ingestedAt: INGESTED
    });
    expect(rows[0]).toMatchObject({
      tenant_id: TARGET.tenant_id,
      branch_id: TARGET.branch_id,
      branch_slug: "otterimju2",
      unit: GAS_UNIT
    });
  });

  it("keeps 'unavailable' as NULL with is_available=0 and the raw state preserved", () => {
    const { rows } = normalizeGasHistory({
      response: [[entry("unavailable")], [], []],
      target: TARGET,
      ingestedAt: INGESTED
    });
    expect(rows[0].value_psi).toBeNull();
    expect(rows[0].is_available).toBe(0);
    // The evidence for the NULL survives into the warehouse.
    expect(rows[0].state_raw).toBe("unavailable");
  });

  it("reports an empty inner array as an empty channel rather than a zero row", () => {
    const { rows, emptyChannels } = normalizeGasHistory({
      response: [[entry("104")], [], []],
      target: TARGET,
      ingestedAt: INGESTED
    });
    // "No data" and "a reading of 0" must never look the same downstream.
    expect(rows.some((r) => r.value_psi === 0)).toBe(false);
    expect(emptyChannels).toEqual(["gas_run_b_pressure", "changeover_filter_pressure"]);
  });

  it("drops a row whose entity_id contradicts its position", () => {
    // A shape change must surface as a dropped row, not a mislabelled one.
    const { rows } = normalizeGasHistory({
      response: [[{ ...entry("104"), entity_id: "sensor.someone_elses_sensor" }], [], []],
      target: TARGET,
      ingestedAt: INGESTED
    });
    expect(rows).toHaveLength(0);
  });

  it("drops rows with an unparseable timestamp rather than inventing one", () => {
    const { rows } = normalizeGasHistory({
      response: [[{ state: "104", last_updated: "garbage" }], [], []],
      target: TARGET,
      ingestedAt: INGESTED
    });
    expect(rows).toHaveLength(0);
  });

  it("rejects a non-array response", () => {
    expect(() =>
      normalizeGasHistory({
        response: null as unknown as HaHistoryResponse,
        target: TARGET,
        ingestedAt: INGESTED
      })
    ).toThrow(GasCollectorError);
  });

  it("writes recorded_at and ingested_at as UTC ClickHouse literals", () => {
    const { rows } = normalizeGasHistory({
      response: [[entry("104", "2026-09-30T11:33:12.345+07:00")], [], []],
      target: TARGET,
      ingestedAt: INGESTED
    });
    // 11:33:12.345+07:00 is 04:33:12.345 UTC — not 11:33 wall-clock.
    expect(rows[0].recorded_at).toBe("2026-09-30 04:33:12.345");
    expect(rows[0].ingested_at).toBe("2026-09-30 05:00:00.000");
  });
});

describe("channel allow-list", () => {
  it("collects exactly the three pressure entities and nothing else", () => {
    expect(GAS_CHANNELS.map((c) => c.entityId)).toEqual([
      "sensor.otterimju2_gas_pressure_a",
      "sensor.otterimju2_gas_pressure_b",
      "sensor.otterimju2_changeover_pressure"
    ]);
  });

  it("excludes the gas_detector heartbeat entities", () => {
    // Measured 2026-09-30: 50.00-50.03% daily on-ratio, fixed 5-25s toggle,
    // constant attributes. A liveness heartbeat, not a leak detector.
    // Ingesting it would manufacture a "leak half the time" reading.
    const ids = GAS_CHANNELS.map((c) => c.entityId);
    expect(ids.some((id) => id.includes("gas_detector"))).toBe(false);
  });

  it("labels the changeover entity as the FILTER, not a changeover pressure", () => {
    // The entity id is misleading; the channel is the semantic truth.
    const filter = GAS_CHANNELS.find((c) => c.entityId.includes("changeover"));
    expect(filter?.channel).toBe("changeover_filter_pressure");
  });
});

describe("fetchGasHistory", () => {
  it("puts the window start in the path and the end in end_time", () => {
    // Getting these backwards silently widens the read to HA's 1-day default.
    let seen = "";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      seen = String(input);
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const end = new Date("2026-09-30T05:00:00.000Z");
    return fetchGasHistory({
      baseUrl: "http://ha.example:8123",
      token: "t",
      end,
      lookbackHours: 3,
      fetchImpl: fetchImpl as unknown as typeof fetch
    }).then(() => {
      const url = new URL(seen);
      expect(decodeURIComponent(url.pathname)).toBe("/api/history/period/2026-09-30T02:00:00.000Z");
      expect(url.searchParams.get("end_time")).toBe("2026-09-30T05:00:00.000Z");
      expect(url.searchParams.get("filter_entity_id")).toBe(
        "sensor.otterimju2_gas_pressure_a,sensor.otterimju2_gas_pressure_b,sensor.otterimju2_changeover_pressure"
      );
    });
  });

  it("does not request minimal_response", () => {
    // It strips entity_id from all but the first and last entry per entity,
    // leaving position as the only channel binding.
    let seen = "";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      seen = String(input);
      return new Response("[]", { status: 200 });
    });
    return fetchGasHistory({
      baseUrl: "http://ha.example:8123",
      token: "t",
      end: new Date("2026-09-30T05:00:00.000Z"),
      lookbackHours: 3,
      fetchImpl: fetchImpl as unknown as typeof fetch
    }).then(() => {
      expect(new URL(seen).searchParams.has("minimal_response")).toBe(false);
    });
  });

  it("names a 401 as a token problem rather than a generic failure", () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    return expect(
      fetchGasHistory({
        baseUrl: "http://ha.example:8123",
        token: "bad",
        end: new Date(),
        lookbackHours: 3,
        fetchImpl: fetchImpl as unknown as typeof fetch
      })
    ).rejects.toThrow(/token is invalid or revoked/);
  });

  it("names a 404 as a possible entity rename", () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }));
    return expect(
      fetchGasHistory({
        baseUrl: "http://ha.example:8123",
        token: "t",
        end: new Date(),
        lookbackHours: 3,
        fetchImpl: fetchImpl as unknown as typeof fetch
      })
    ).rejects.toThrow(/renamed/);
  });

  it("wraps a connection failure as a collector error", () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    return expect(
      fetchGasHistory({
        baseUrl: "http://ha.example:8123",
        token: "t",
        end: new Date(),
        lookbackHours: 3,
        fetchImpl: fetchImpl as unknown as typeof fetch
      })
    ).rejects.toThrow(GasCollectorError);
  });
});

describe("runGasCollector", () => {
  function harness(inserted: unknown[][] = []) {
    const insert = vi.fn(async () => {
      inserted.push([1]);
    });
    return {
      inserted,
      warehouse: { insert } as unknown as Parameters<typeof runGasCollector>[0]["warehouse"],
      insert
    };
  }

  it("inserts normalized rows and reports the window", async () => {
    const h = harness();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify([
          [{ state: "104", last_updated: "2026-09-30T04:33:12.345+00:00" }],
          [{ state: "unavailable", last_updated: "2026-09-30T04:33:12.345+00:00" }],
          [{ state: "22", last_updated: "2026-09-30T04:33:12.345+00:00" }]
        ]),
        { status: 200 }
      )
    );

    const result = await runGasCollector({
      baseUrl: "http://ha.example:8123",
      token: "t",
      target: TARGET,
      warehouse: h.warehouse,
      lookbackHours: 3,
      now: () => INGESTED,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(h.insert).toHaveBeenCalledTimes(1);
    expect(result.inserted).toBe(3);
    expect(result.unavailable).toBe(1);
    expect(result.emptyChannels).toEqual([]);
    expect(result.windowStart).toBe("2026-09-30 02:00:00.000");
    expect(result.windowEnd).toBe("2026-09-30 05:00:00.000");
  });

  it("does not call insert when every channel came back empty", () => {
    // A quiet window is not an error, but it is also not rows of zeros.
    const h = harness();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([[], [], []]), { status: 200 }));
    return runGasCollector({
      baseUrl: "http://ha.example:8123",
      token: "t",
      target: TARGET,
      warehouse: h.warehouse,
      now: () => INGESTED,
      fetchImpl: fetchImpl as unknown as typeof fetch
    }).then((result) => {
      expect(h.insert).not.toHaveBeenCalled();
      expect(result.inserted).toBe(0);
      expect(result.emptyChannels).toHaveLength(3);
    });
  });
});
