import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WatermarkStore } from "../src/watermark.js";

describe("WatermarkStore", () => {
  const empty = { usageCreatedAt: null, temperatureIngestedAt: null, usage: null, temperature: null };

  it("returns empty watermarks for a missing file", () => {
    const store = new WatermarkStore("/nonexistent/watermark.json");
    expect(store.load()).toEqual(empty);
  });

  it("round-trips watermarks through a real file with atomic rename", () => {
    const dir = mkdtempSync(join(tmpdir(), "etl-wm-"));
    const path = join(dir, "wm.json");
    const store = new WatermarkStore(path);
    store.save({
      usageCreatedAt: "2026-08-29T00:00:00.000Z",
      temperatureIngestedAt: null,
      usage: { at: "2026-08-29T00:00:00.000Z", id: "u1" },
      temperature: { at: "2026-08-29T00:05:00.000Z", seq: "100", id: "evt9" },
    });
    expect(store.load()).toEqual({
      usageCreatedAt: "2026-08-29T00:00:00.000Z",
      temperatureIngestedAt: null,
      usage: { at: "2026-08-29T00:00:00.000Z", id: "u1" },
      temperature: { at: "2026-08-29T00:05:00.000Z", seq: "100", id: "evt9" },
    });
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw).toMatchObject({ usageCreatedAt: "2026-08-29T00:00:00.000Z" });
  });

  it("survives corrupt JSON by returning empty watermarks", () => {
    const io = { read: () => "{ not json", write: () => {} };
    const store = new WatermarkStore("/virtual/wm.json", io);
    expect(store.load()).toEqual(empty);
  });

  it("ignores missing fields in a partial file", () => {
    const io = { read: () => "{}", write: () => {} };
    const store = new WatermarkStore("/virtual/wm.json", io);
    expect(store.load()).toEqual(empty);
  });

  it("does not promote a deprecated single-column timestamp into a strict cursor", () => {
    const io = { read: () => '{"usageCreatedAt":"2026-08-29T00:00:00.000Z","temperatureIngestedAt":"2026-08-28T00:00:00.000Z"}', write: () => {} };
    const store = new WatermarkStore("/virtual/wm.json", io);
    const wm = store.load();
    // Deprecated fields are retained for audit, but never promoted to strict
    // cursors — so the strict forms stay null and the ETL re-reads that window.
    expect(wm.usageCreatedAt).toBe("2026-08-29T00:00:00.000Z");
    expect(wm.temperatureIngestedAt).toBe("2026-08-28T00:00:00.000Z");
    expect(wm.usage).toBeNull();
    expect(wm.temperature).toBeNull();
  });
});