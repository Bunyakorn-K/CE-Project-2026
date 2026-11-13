import { describe, expect, it, vi } from "vitest";
import { isPlaceholderName, lineProfileLookup, UNKNOWN_PERSON } from "./profile";

describe("lineProfileLookup", () => {
  it("returns the display name LINE reports", async () => {
    const client = { getProfile: vi.fn(async () => ({ userId: "U1", displayName: "  สมชาย ใจดี  ", statusMessage: "", pictureUrl: "" })) };
    const lookup = lineProfileLookup("token", { client });
    await expect(lookup("U1")).resolves.toBe("สมชาย ใจดี");
  });

  it("returns null instead of throwing when LINE refuses", async () => {
    const client = {
      getProfile: vi.fn(async () => {
        throw new Error("401");
      })
    };
    await expect(lineProfileLookup("token", { client })("U1")).resolves.toBeNull();
  });

  it("returns null when the profile carries no name", async () => {
    const client = { getProfile: vi.fn(async () => ({ userId: "U1", displayName: "   ", statusMessage: "", pictureUrl: "" })) };
    await expect(lineProfileLookup("token", { client })("U1")).resolves.toBeNull();
  });

  it("gives up rather than letting a slow lookup stall the webhook", async () => {
    const client = { getProfile: vi.fn(() => new Promise<never>(() => {})) };
    const started = Date.now();
    await expect(lineProfileLookup("token", { client, timeoutMs: 20 })("U1")).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("returns null with no token and no client, rather than constructing one", async () => {
    const lookup = lineProfileLookup(undefined);
    await expect(lookup("U1")).resolves.toBeNull();
  });

  it("uses an injected client even without a token — that is the test seam", async () => {
    const getProfile = vi.fn(async () => ({ userId: "U1", displayName: "สมหญิง", statusMessage: "", pictureUrl: "" }));
    await expect(lineProfileLookup(undefined, { client: { getProfile } })("U1")).resolves.toBe("สมหญิง");
  });
});

describe("isPlaceholderName", () => {
  it("recognises the names that describe the bot or nobody", () => {
    expect(isPlaceholderName("LINE bot user")).toBe(true);
    expect(isPlaceholderName(UNKNOWN_PERSON)).toBe(true);
    expect(isPlaceholderName("  ")).toBe(true);
    expect(isPlaceholderName(null)).toBe(true);
  });

  it("leaves a real name alone", () => {
    expect(isPlaceholderName("สมชาย ใจดี")).toBe(false);
  });
});
