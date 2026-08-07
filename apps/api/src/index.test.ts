import { describe, expect, it, vi } from "vitest";

vi.mock("./auth", () => ({
  auth: {
    api: { getSession: vi.fn().mockResolvedValue(null) },
    handler: vi.fn()
  }
}));

import { createApp } from "./index";

describe("LaundryTwin API", () => {
  it("does not call the IRIS source before a local session is established", async () => {
    const getDashboard = vi.fn();
    const app = createApp({
      irisClient: {
        getBranches: vi.fn(),
        getDashboard,
        getLiveSnapshot: vi.fn(),
        getAlerts: vi.fn(),
        getEvents: vi.fn()
      }
    });

    const response = await app.request("/api/report/dashboard");

    expect(response.status).toBe(401);
    expect(getDashboard).not.toHaveBeenCalled();
  });

  it("does not issue a demo session unless demo mode is enabled", async () => {
    const app = createApp();

    const response = await app.request("/api/demo/session", { method: "POST" });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "DEMO_DISABLED", message: "Demo mode is disabled" }
    });
  });
});
