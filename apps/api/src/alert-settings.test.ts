import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, like } from "drizzle-orm";
import { db, initializeDatabase } from "./db";
import { alertSettings, auditLog } from "./schema";
import type { Principal } from "./access-store";
import type { Role } from "./access-policy";

const testAuth = vi.hoisted(() => ({ principal: null as Principal | null }));

vi.mock("./auth", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () => (testAuth.principal ? { user: testAuth.principal.user } : null))
    },
    handler: vi.fn()
  },
  resolveServerSecret: vi.fn(() => "test-only-secret"),
  resolveTrustedOrigins: vi.fn(() => ["http://localhost:5173"])
}));

vi.mock("./access-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./access-store")>();
  return {
    ...actual,
    resolveBetterAuthPrincipal: vi.fn(() => testAuth.principal)
  };
});

const { createApp } = await import("./index");
const { effectiveMonthlyBudget, effectiveRenotifyMs, readAlertSettings, saveAlertSettings } =
  await import("./alert-settings");

function principal(role: Role): Principal {
  return {
    user: { id: `user-${role}`, name: role, email: `${role}@example.com` },
    source: "better-auth",
    grants: [{ id: `g-${role}`, role, branchId: null }]
  } as Principal;
}

beforeEach(() => {
  initializeDatabase();
  db.delete(alertSettings).run();
  db.delete(auditLog).where(like(auditLog.action, "alert.settings_updated")).run();
});

afterEach(() => {
  testAuth.principal = null;
  db.delete(alertSettings).run();
  db.delete(auditLog).where(like(auditLog.action, "alert.settings_updated")).run();
});

describe("readAlertSettings", () => {
  it("falls back to the environment's defaults before anything is saved", () => {
    const settings = readAlertSettings();
    expect(settings.source).toBe("environment");
    expect(settings.renotifyHours).toBe(12);
    expect(settings.monthlyBudget).toBe(200);
    expect(settings.updatedAt).toBeNull();
  });
});

describe("saveAlertSettings", () => {
  it("stores the values and reports where they came from afterwards", () => {
    const saved = saveAlertSettings({ renotifyHours: 6, monthlyBudget: 120 }, null);
    expect(saved).toMatchObject({ renotifyHours: 6, monthlyBudget: 120, source: "stored" });
    expect(readAlertSettings()).toMatchObject({ renotifyHours: 6, monthlyBudget: 120, source: "stored" });
  });

  it("clamps to the ranges the API promises, rather than trusting the caller", () => {
    // A floor of 0 would notify on every sweep; a budget of 5,000 would spend a
    // plan that does not exist.
    expect(saveAlertSettings({ renotifyHours: 0, monthlyBudget: 5000 }, null)).toMatchObject({
      renotifyHours: 1,
      monthlyBudget: 1000
    });
    expect(saveAlertSettings({ renotifyHours: 900, monthlyBudget: -5 }, null)).toMatchObject({
      renotifyHours: 168,
      monthlyBudget: 0
    });
  });

  it("keeps the field that was not sent", () => {
    saveAlertSettings({ renotifyHours: 8, monthlyBudget: 150 }, null);
    const saved = saveAlertSettings({ monthlyBudget: 90 }, null);
    expect(saved.renotifyHours).toBe(8);
    expect(saved.monthlyBudget).toBe(90);
  });

  it("audits the change with the previous values, so 'who turned this down' is answerable", () => {
    saveAlertSettings({ renotifyHours: 12, monthlyBudget: 200 }, null);
    saveAlertSettings({ renotifyHours: 48, monthlyBudget: 200 }, null);
    const rows = db.select().from(auditLog).where(eq(auditLog.action, "alert.settings_updated")).all();
    expect(rows.length).toBe(2);
    const detail = JSON.parse(rows[1].detail ?? "{}") as { from: { renotifyHours: number }; to: { renotifyHours: number } };
    expect(detail.from.renotifyHours).toBe(12);
    expect(detail.to.renotifyHours).toBe(48);
    // No user row exists for the id passed in, so the actor is recorded as null
    // rather than failing the save on a foreign key.
    expect(rows[1].actorUserId).toBeNull();
  });
});

describe("effective values", () => {
  it("are what the engine reads, and follow the stored row", () => {
    saveAlertSettings({ renotifyHours: 6, monthlyBudget: 120 }, null);
    expect(effectiveRenotifyMs()).toBe(6 * 60 * 60 * 1000);
    expect(effectiveMonthlyBudget()).toBe(120);
  });
});

describe("GET/PUT /api/admin/alert-settings", () => {
  function app() {
    return createApp();
  }

  it("is owner-only", async () => {
    testAuth.principal = principal("manager");
    const response = await app().request("/api/admin/alert-settings");
    expect(response.status).toBe(403);
  });

  it("returns the settings with the month's usage beside them", async () => {
    testAuth.principal = principal("owner");
    const response = await app().request("/api/admin/alert-settings");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      settings: { renotifyHours: number; monthlyBudget: number };
      usage: { month: string; cap: number };
    };
    expect(body.settings.renotifyHours).toBe(12);
    expect(body.usage.month).toMatch(/^\d{4}-\d{2}$/);
    expect(body.usage.cap).toBe(body.settings.monthlyBudget);
  });

  it("saves what an owner sends and clamps what they should not be able to", async () => {
    testAuth.principal = principal("owner");
    const response = await app().request("/api/admin/alert-settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ renotifyHours: 0, monthlyBudget: 60 })
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { settings: { renotifyHours: number; monthlyBudget: number } };
    expect(body.settings.renotifyHours).toBe(1);
    expect(body.settings.monthlyBudget).toBe(60);
  });

  it("rejects a body with neither field instead of silently doing nothing", async () => {
    testAuth.principal = principal("owner");
    const response = await app().request("/api/admin/alert-settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(response.status).toBe(400);
  });
});
