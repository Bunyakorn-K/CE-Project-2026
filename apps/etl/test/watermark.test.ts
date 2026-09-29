import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WatermarkStore } from "../src/watermark.js";

describe("WatermarkStore", () => {
  const empty = {
    usageCreatedAt: null,
    temperatureIngestedAt: null,
    usage: null,
    temperature: null,
    temperatureIngestedCursor: null,
  };

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
      temperature: { key: "occurred_at", at: "2026-08-29T00:05:00.000Z", seq: "100", id: "evt9" },
      temperatureIngestedCursor: null,
    });
    expect(store.load()).toEqual({
      usageCreatedAt: "2026-08-29T00:00:00.000Z",
      temperatureIngestedAt: null,
      usage: { at: "2026-08-29T00:00:00.000Z", id: "u1" },
      temperature: { key: "occurred_at", at: "2026-08-29T00:05:00.000Z", seq: "100", id: "evt9" },
      temperatureIngestedCursor: null,
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

  it("round-trips the occurred_at temperature cursor with its format marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "etl-wm-"));
    const store = new WatermarkStore(join(dir, "wm.json"));
    store.save({
      usageCreatedAt: null,
      temperatureIngestedAt: null,
      usage: null,
      temperature: { key: "occurred_at", at: "2026-08-29T00:05:00.000Z", seq: "100", id: "evt9" },
      temperatureIngestedCursor: null,
    });
    expect(store.load().temperature).toEqual({
      key: "occurred_at",
      at: "2026-08-29T00:05:00.000Z",
      seq: "100",
      id: "evt9",
    });
  });

  it("never reinterprets a legacy ingested_at temperature cursor as occurred_at", () => {
    // A watermark written before 2026-09-29 tracked `ingested_at`. Its `at`
    // means a different column, so promoting it to the occurred_at keyset would
    // silently skip every row between the two positions.
    const io = {
      read: () =>
        JSON.stringify({
          temperature: { at: "2026-09-25T12:00:00.000Z", seq: "100", id: "evt9" },
        }),
      write: () => {},
    };
    const wm = new WatermarkStore("/virtual/wm.json", io).load();
    expect(wm.temperature).toBeNull();
    expect(wm.temperatureIngestedCursor).toEqual({
      at: "2026-09-25T12:00:00.000Z",
      seq: "100",
      id: "evt9",
    });
  });

  it("ignores a temperature cursor carrying an unknown key marker", () => {
    const io = {
      read: () =>
        JSON.stringify({
          temperature: { key: "ingested_at", at: "2026-09-25T12:00:00.000Z", seq: "1", id: "e" },
        }),
      write: () => {},
    };
    const wm = new WatermarkStore("/virtual/wm.json", io).load();
    expect(wm.temperature).toBeNull();
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