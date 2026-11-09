import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db, initializeDatabase } from "./db";
import { accessGrant, alertNotification, auditLog, liffIdentity, user } from "./schema";
import type { Principal } from "./access-store";
import type { ClickHouseExecutor } from "./analytics/clickhouse";
import type { Role } from "./access-policy";
import type { IrisAlert } from "./iris-read-client";

const testAuth = vi.hoisted(() => ({ principal: null as Principal | null }));

vi.mock("./auth", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () => (testAuth.principal ? { user: testAuth.principal.user } : null))
    },
    handler: vi.fn()
  },
  resolveServerSecret: vi.fn(() => "test-only-secret"),
  resolveTrustedOrigins: vi.fn(() => process.env.CORS_ORIGIN?.split(",").map((origin) => origin.trim()) ?? ["http://localhost:5173"])
}));

vi.mock("./access-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./access-store")>();
  return {
    ...actual,
    resolveBetterAuthPrincipal: vi.fn(() => testAuth.principal)
  };
});

const { createApp } = await import("./index");
const { isAlertSweepTokenValid, performAlertSweep } = await import("./alert-sweep");

const testAlertIds: string[] = [];
const testUserIds: string[] = [];
const testLineUserIds: string[] = [];

function seedRecipient(role: Role): string {
  const userId = randomUUID();
  const lineUserId = `U-sweep-${randomUUID().slice(0, 8)}`;
  const now = new Date();
  db.insert(user)
    .values({ id: userId, name: "Sweep Test", email: `sweep-${userId}@laundrytwin.test`, emailVerified: false, image: null, createdAt: now, updatedAt: now })
    .run();
  db.insert(accessGrant)
    .values({ id: randomUUID(), userId, role, branchId: null, grantedByUserId: null, grantedAt: now })
    .run();
  db.insert(liffIdentity).values({ lineUserId, userId, displayName: "Sweep Test", updatedAt: now }).run();
  testUserIds.push(userId);
  testLineUserIds.push(lineUserId);
  return lineUserId;
}

function makeAlert(over: Partial<IrisAlert> = {}): IrisAlert {
  const alert: IrisAlert = {
    id: randomUUID(),
    branchId: "B1",
    machineId: "M1",
    ruleId: "R1",
    ruleUpdatedAt: null,
    ruleVersion: "1",
    severity: "warning",
    title: "อุณหภูมิสูงผิดปกติ",
    detail: "เครื่อง M1 อุณหภูมิ 95C",
    tags: [],
    evidence: { temperatureC: 95 },
    detectedAt: "2026-11-09T05:00:00.000Z",
    acknowledgedAt: null,
    coverage: {},
    ...over
  };
  testAlertIds.push(alert.id);
  return alert;
}

function notificationRows() {
  return db.select().from(alertNotification).all();
}

function cleanupTestData() {
  if (testAlertIds.length > 0) {
    const placeholders = testAlertIds.map(() => "?").join(", ");
    db.$client.prepare(`DELETE FROM alert_notification WHERE iris_alert_id IN (${placeholders})`).run(...testAlertIds);
    db.$client.prepare(`DELETE FROM audit_log WHERE target IN (${placeholders})`).run(...testAlertIds);
  }
  if (testLineUserIds.length > 0) {
    const placeholders = testLineUserIds.map(() => "?").join(", ");
    db.$client.prepare(`DELETE FROM alert_notification WHERE line_user_id IN (${placeholders})`).run(...testLineUserIds);
    db.$client.prepare(`DELETE FROM liff_identity WHERE line_user_id IN (${placeholders})`).run(...testLineUserIds);
  }
  if (testUserIds.length > 0) {
    const placeholders = testUserIds.map(() => "?").join(", ");
    db.$client.prepare(`DELETE FROM access_grant WHERE user_id IN (${placeholders})`).run(...testUserIds);
    db.$client.prepare(`DELETE FROM liff_identity WHERE user_id IN (${placeholders})`).run(...testUserIds);
    db.$client.prepare(`DELETE FROM user WHERE id IN (${placeholders})`).run(...testUserIds);
  }
  // Gas-derived rows are not keyed by a tracked alert id, so clear by prefix.
  db.$client.prepare("DELETE FROM alert_notification WHERE iris_alert_id LIKE 'gas:%'").run();
  testAlertIds.length = 0;
  testUserIds.length = 0;
  testLineUserIds.length = 0;
}

const NOW = new Date("2026-11-09T06:00:00.000Z");

/** Gas rows shaped exactly as `queryGasSamples` parses them. */
function gasRows(values: Array<number | null>, channel = "gas_run_a_pressure", stepMinutes = 15) {
  return values.map((valuePsi, index) => ({
    channel,
    branch_id: "branch-01",
    recorded_at: new Date(NOW.getTime() - (values.length - 1 - index) * stepMinutes * 60000)
      .toISOString()
      .replace("T", " ")
      .replace("Z", ""),
    value_psi: valuePsi
  }));
}

function gasClickhouse(over: { gasRows?: unknown[]; gasThrows?: boolean; running?: string } = {}) {
  return vi.fn(async (sql: string) => {
    if (sql.includes("fact_gas_pressure_sample")) {
      if (over.gasThrows) throw new Error("Code: 497 Not enough privileges");
      return over.gasRows ?? [];
    }
    if (sql.includes("fact_machine_usage")) return [{ running: over.running ?? "1" }];
    if (sql.includes("fact_temperature_sample")) return [{ avg_c: "61.2" }];
    if (sql.includes("dim_branch_hours")) throw new Error("Code: 60 UNKNOWN_TABLE");
    return [];
  }) as unknown as ClickHouseExecutor;
}

function alertDeps(over: Record<string, unknown> = {}) {
  return {
    fetchAlerts: vi.fn(async () => [] as IrisAlert[]),
    adapter: { sendText: vi.fn().mockResolvedValue(undefined) },
    adapterAvailable: true,
    now: () => NOW,
    ...over
  };
}

beforeEach(() => {
  initializeDatabase();
});

afterEach(() => {
  cleanupTestData();
  testAuth.principal = null;
  delete process.env.ALERT_SWEEP_TOKEN;
});

describe("isAlertSweepTokenValid", () => {
  it("accepts an exact match", () => {
    expect(isAlertSweepTokenValid("s3cret-token", "s3cret-token")).toBe(true);
  });

  it("rejects a different token of the same length", () => {
    expect(isAlertSweepTokenValid("s3cret-tokeX", "s3cret-token")).toBe(false);
  });

  it("rejects a token of a different length without throwing", () => {
    expect(isAlertSweepTokenValid("short", "a-much-longer-token")).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(isAlertSweepTokenValid(undefined, "s3cret-token")).toBe(false);
    expect(isAlertSweepTokenValid(null, "s3cret-token")).toBe(false);
    expect(isAlertSweepTokenValid("", "s3cret-token")).toBe(false);
  });

  it("fails closed when the deployment has no token configured", () => {
    // The direction matters: an unconfigured token must never validate an
    // arbitrary request, including an empty one.
    expect(isAlertSweepTokenValid(undefined, undefined)).toBe(false);
    expect(isAlertSweepTokenValid("", "")).toBe(false);
    expect(isAlertSweepTokenValid("anything", "")).toBe(false);
  });
});

describe("POST /api/internal/alerts/sweep", () => {
  function app(options: { clickhouse?: ClickHouseExecutor; alerts?: IrisAlert[] } = {}) {
    const getAlerts = vi.fn(async () => ({ alerts: options.alerts ?? [] }));
    const instance = createApp({
      irisClient: {
        getBranches: vi.fn(),
        getDashboard: vi.fn(),
        getLiveSnapshot: vi.fn(),
        getAlerts,
        getEvents: vi.fn()
      } as never,
      analyticsDeps: { clickhouse: options.clickhouse ?? gasClickhouse() }
    });
    return { app: instance, getAlerts };
  }

  function sweep(instance: ReturnType<typeof createApp>, token?: string) {
    return instance.request("/api/internal/alerts/sweep", {
      method: "POST",
      headers: token === undefined ? {} : { "x-alert-sweep-token": token }
    });
  }

  it("answers 401 with no token", async () => {
    process.env.ALERT_SWEEP_TOKEN = "s3cret-token";
    const { app: instance, getAlerts } = app();
    const response = await sweep(instance);
    expect(response.status).toBe(401);
    expect(getAlerts).not.toHaveBeenCalled();
  });

  it("answers 401 with the wrong token", async () => {
    process.env.ALERT_SWEEP_TOKEN = "s3cret-token";
    const { app: instance, getAlerts } = app();
    const response = await sweep(instance, "not-the-token");
    expect(response.status).toBe(401);
    expect(getAlerts).not.toHaveBeenCalled();
  });

  it("answers 401 when the deployment has no token at all", async () => {
    delete process.env.ALERT_SWEEP_TOKEN;
    const { app: instance, getAlerts } = app();
    const response = await sweep(instance, "anything");
    expect(response.status).toBe(401);
    expect(getAlerts).not.toHaveBeenCalled();
  });

  it("answers 200 with the right token and reports scanned, its window and gas", async () => {
    process.env.ALERT_SWEEP_TOKEN = "s3cret-token";
    const { app: instance, getAlerts } = app({ alerts: [makeAlert()] });
    const response = await sweep(instance, "s3cret-token");
    expect(response.status).toBe(200);
    expect(getAlerts).toHaveBeenCalledTimes(1);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.scanned).toBe(1);
    expect(body.window).toMatchObject({ from: expect.any(String), to: expect.any(String) });
    expect(body.summary).toMatchObject({ scanned: 1 });
    expect(body.gas).toMatchObject({ state: "unavailable", evaluated: 0 });
  });

  it("reports gas unavailable with a reason rather than failing the IRIS sweep", async () => {
    process.env.ALERT_SWEEP_TOKEN = "s3cret-token";
    const { app: instance } = app();
    const response = await sweep(instance, "s3cret-token");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { gas: { state: string; reason: string }; summary: unknown };
    expect(body.gas.state).toBe("unavailable");
    expect(body.gas.reason).toBe("gas_source_not_configured");
    expect(body.summary).toBeTruthy();
  });

  it("returns the same body shape as the owner button, so one summary means one thing", async () => {
    process.env.ALERT_SWEEP_TOKEN = "s3cret-token";
    testAuth.principal = {
      user: { id: "user-owner", name: "Owner", email: "owner@example.com" },
      source: "better-auth",
      grants: [{ id: "g1", role: "owner", branchId: null }]
    } as Principal;
    const { app: instance } = app();
    const internal = (await (await sweep(instance, "s3cret-token")).json()) as Record<string, unknown>;
    const manual = (await (
      await instance.request("/api/admin/alerts/notify", { method: "POST" })
    ).json()) as Record<string, unknown>;
    expect(Object.keys(manual).sort()).toEqual(Object.keys(internal).sort());
    expect(manual.gas).toMatchObject({ state: "unavailable" });
  });
});

describe("performAlertSweep", () => {
  it("sends once and then reports the cooldown on a second sweep inside the window", async () => {
    const lineUserId = seedRecipient("owner");
    const alert = makeAlert();
    const deps = alertDeps({ fetchAlerts: vi.fn(async () => [alert]) });

    const first = await performAlertSweep(deps);
    expect(first.summary.sent).toBe(1);
    expect(first.summary.cooldown).toBe(0);

    const second = await performAlertSweep(deps);
    expect(second.summary.sent).toBe(0);
    expect(second.summary.cooldown).toBeGreaterThan(0);
    expect(notificationRows().filter((row) => row.lineUserId === lineUserId)).toHaveLength(1);
  });





  it("reports gas as not configured when the sweep has no gas source", async () => {
    const result = await performAlertSweep(alertDeps());
    expect(result.gas.state).toBe("unavailable");
    expect(result.gas.reason).toBe("gas_source_not_configured");
    expect(result.gas.evaluated).toBe(0);
  });


  it("audits a cooldown skip so a silent non-send is still recorded", async () => {
    seedRecipient("owner");
    const alert = makeAlert();
    const deps = alertDeps({ fetchAlerts: vi.fn(async () => [alert]) });
    await performAlertSweep(deps);
    await performAlertSweep(deps);
    const skips = db.select().from(auditLog).all().filter((row) => row.action === "alert.skipped_cooldown" && row.target === alert.id);
    expect(skips.length).toBeGreaterThan(0);
  });
});
