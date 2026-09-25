import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccessGrant } from "./access-policy";

let database: typeof import("./db");
let accessStore: typeof import("./access-store");
let schema: typeof import("./schema");
let testDatabasePath: string;
let previousDatabasePath: string | undefined;

beforeAll(async () => {
  previousDatabasePath = process.env.DATABASE_PATH;
  testDatabasePath = join(tmpdir(), `laundrytwin-access-store-${process.pid}-${randomUUID()}.sqlite`);
  process.env.DATABASE_PATH = testDatabasePath;
  database = await import("./db");
  database.initializeDatabase();
  accessStore = await import("./access-store");
  schema = await import("./schema");
});

afterAll(() => {
  database.sqlite.close();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${testDatabasePath}${suffix}`, { force: true });
});

describe("access owner lifecycle", () => {
  it("does not count the synthetic demo owner as a real owner", () => {
    accessStore.ensureDemoOwner();
    const realOwner = insertOwner("real-owner@example.com");

    expect(accessStore.revokeAccessGrant(realOwner.grantId, realOwner.id)).toBe("last-owner");
  });

  it("allows revoking a real owner when another real owner remains", () => {
    accessStore.ensureDemoOwner();
    const firstOwner = insertOwner("first-owner@example.com");
    insertOwner("second-owner@example.com");

    expect(accessStore.revokeAccessGrant(firstOwner.grantId, firstOwner.id)).toBe("revoked");
  });
});

function insertOwner(email: string): { id: string; grantId: string; grant: AccessGrant } {
  const now = new Date();
  const userId = randomUUID();
  const grantId = randomUUID();
  database.db
    .insert(schema.user)
    .values({ id: userId, name: email, email, emailVerified: true, image: null, createdAt: now, updatedAt: now })
    .run();
  database.db
    .insert(schema.accessGrant)
    .values({
      id: grantId,
      userId,
      role: "owner",
      branchId: null,
      grantedByUserId: userId,
      grantedAt: now
    })
    .run();
  return { id: userId, grantId, grant: { id: grantId, role: "owner", branchId: null } };
}
