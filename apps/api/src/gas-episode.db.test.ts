import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// A separate file from the pure decision, and it has to be: `../db` binds DATABASE_PATH
// when it is imported, so the path must be set before the import — which is why the
// modules below are loaded inside `beforeAll` rather than at the top.

let database: typeof import("./db");
let schema: typeof import("./schema");
let gasEpisode: typeof import("./gas-episode");
let databasePath: string;
let previousDatabasePath: string | undefined;

const KEY = "branch-01:gas.gas_run_a_pressure.declining:warning";

beforeAll(async () => {
  previousDatabasePath = process.env.DATABASE_PATH;
  databasePath = join(tmpdir(), `laundrytwin-gas-episode-${process.pid}-${randomUUID()}.sqlite`);
  process.env.DATABASE_PATH = databasePath;
  database = await import("./db");
  database.initializeDatabase();
  schema = await import("./schema");
  gasEpisode = await import("./gas-episode");
});

afterAll(() => {
  database.sqlite.close();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${databasePath}${suffix}`, { force: true });
});

function insertAlert(input: {
  cooldownKey?: string;
  status?: "sent" | "failed";
  evidence: unknown;
  lineUserId?: string;
  attemptedAt?: Date;
}) {
  const now = input.attemptedAt ?? new Date();
  database.db
    .insert(schema.alertNotification)
    .values({
      id: randomUUID(),
      irisAlertId: `gas:gas_run_a_pressure:declining:${now.toISOString().slice(0, 13)}`,
      lineUserId: input.lineUserId ?? randomUUID(),
      branchId: "branch-01",
      machineId: null,
      severity: "warning",
      title: "แนวโน้มแรงดันแก๊สลดลงต่อเนื่อง",
      message: "…",
      evidence: JSON.stringify(input.evidence),
      status: input.status ?? "sent",
      cooldownKey: input.cooldownKey ?? KEY,
      attemptedAt: now,
      deliveredAt: input.status === "sent" ? now : null,
      error: input.status === "sent" ? null : "boom"
    })
    .run();
}

describe("lastSentGasAlert", () => {
  it("returns null when that channel has never been alerted", () => {
    expect(gasEpisode.lastSentGasAlert("branch-99:gas.gas_run_z.declining:warning")).toBeNull();
  });

  it("reads back the rate and pressure the last alert reported", () => {
    const at = new Date("2026-11-13T04:30:00.000Z");
    insertAlert({ evidence: { channel: "gas_run_a_pressure", edgeRatePsiPerHour: -1.41, lastEdgePsi: 39 }, attemptedAt: at });

    expect(gasEpisode.lastSentGasAlert(KEY)).toEqual({
      edgeRatePsiPerHour: -1.41,
      lastEdgePsi: 39,
      sentAt: at.getTime()
    });
  });

  it("returns null for a row whose evidence predates this feature", () => {
    // Production already holds rows shaped like this: `{"channel":"…"}` with no numbers.
    // A channel must alert, not be silenced by a predecessor that cannot be read.
    const key = "branch-01:gas.gas_run_b_pressure.declining:warning";
    insertAlert({ cooldownKey: key, evidence: { channel: "gas_run_b_pressure" } });
    expect(gasEpisode.lastSentGasAlert(key)).toBeNull();
  });

  it("ignores failed attempts, because nobody received them", () => {
    const key = "branch-01:gas.changeover_filter_pressure.declining:warning";
    insertAlert({ cooldownKey: key, status: "failed", evidence: { edgeRatePsiPerHour: -2.2, lastEdgePsi: 20 } });
    expect(gasEpisode.lastSentGasAlert(key)).toBeNull();
  });

  it("ignores a malformed evidence string instead of throwing", () => {
    const key = "branch-01:gas.gas_run_a_pressure.declining:critical";
    database.db
      .insert(schema.alertNotification)
      .values({
        id: randomUUID(),
        irisAlertId: "gas:malformed",
        lineUserId: randomUUID(),
        branchId: "branch-01",
        machineId: null,
        severity: "critical",
        title: "t",
        message: "m",
        evidence: "{not json",
        status: "sent",
        cooldownKey: key,
        attemptedAt: new Date(),
        deliveredAt: new Date(),
        error: null
      })
      .run();
    expect(gasEpisode.lastSentGasAlert(key)).toBeNull();
  });
});
