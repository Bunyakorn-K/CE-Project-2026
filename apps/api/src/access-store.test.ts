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

describe("granting a role to an existing account", () => {
  // `granted_by_user_id` is a real foreign key, so the actor must be a real
  // account — a bare UUID fails the insert rather than being ignored. It is
  // created inside each test because `database` is only assigned in `beforeAll`.
  const grantingActor = () => insertOwner(`actor-${randomUUID()}@example.com`).id;

  it("adds a branch-scoped grant to an account that already has one", () => {
    const actor = grantingActor();
    const owner = insertOwner("scoped-owner@example.com");

    const result = accessStore.createAccessGrant({
      email: "scoped-owner@example.com",
      role: "manager",
      branchId: "branch-lampang",
      actorUserId: actor
    });

    // The reason this exists: an owner who signed in on their own could never
    // be narrowed to one branch, because the only way to create a grant was to
    // approve a pending request from a stranger.
    expect(result.ok).toBe(true);
    const grants = accessStore.listActiveAccessGrants().filter((grant) => grant.userId === owner.id);
    expect(grants.map((grant) => [grant.role, grant.branchId])).toEqual([
      ["owner", null],
      ["manager", "branch-lampang"]
    ]);
  });

  it("reads the grant back with the account's own identity, not just an id", () => {
    const actor = grantingActor();
    insertOwner("readback@example.com");
    const result = accessStore.createAccessGrant({
      email: "readback@example.com",
      role: "technician",
      branchId: "branch-sandbox",
      actorUserId: actor
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.userEmail).toBe("readback@example.com");
    expect(result.grant.role).toBe("technician");
    expect(result.grant.branchId).toBe("branch-sandbox");
  });

  it("refuses a second identical grant instead of stacking a duplicate row", () => {
    const actor = grantingActor();
    insertOwner("duplicate@example.com");
    const first = accessStore.createAccessGrant({ email: "duplicate@example.com", role: "manager", branchId: "b1", actorUserId: actor });
    const second = accessStore.createAccessGrant({ email: "duplicate@example.com", role: "manager", branchId: "b1", actorUserId: actor });

    expect(first.ok).toBe(true);
    // The admin table lists grants one per row, so a repeated row would read as
    // two scopes where there is one.
    expect(second).toEqual({ ok: false, reason: "duplicate" });
    // Counted by role, because `insertOwner` already gave this account an owner
    // grant and the assertion is about the manager scope not doubling.
    expect(
      accessStore
        .listActiveAccessGrants()
        .filter((grant) => grant.userEmail === "duplicate@example.com" && grant.role === "manager")
    ).toHaveLength(1);
  });

  it("allows the same role on a different branch", () => {
    const actor = grantingActor();
    insertOwner("two-branches@example.com");
    accessStore.createAccessGrant({ email: "two-branches@example.com", role: "manager", branchId: "b1", actorUserId: actor });
    const second = accessStore.createAccessGrant({ email: "two-branches@example.com", role: "manager", branchId: "b2", actorUserId: actor });

    expect(second.ok).toBe(true);
  });

  it("reports an unknown address rather than creating a grant for nobody", () => {
    const actor = grantingActor();
    const result = accessStore.createAccessGrant({
      email: "nobody@example.com",
      role: "manager",
      branchId: "b1",
      actorUserId: actor
    });

    expect(result).toEqual({ ok: false, reason: "user-not-found" });
  });

  it("re-grants a scope that was revoked, because revocation is not deletion", () => {
    const actor = grantingActor();
    const owner = insertOwner("revoked-then-restored@example.com");
    accessStore.createAccessGrant({ email: "revoked-then-restored@example.com", role: "manager", branchId: "b1", actorUserId: actor });
    const grantId = accessStore
      .listActiveAccessGrants()
      .find((grant) => grant.userEmail === "revoked-then-restored@example.com" && grant.role === "manager")!.id;

    expect(accessStore.revokeAccessGrant(grantId, owner.id)).toBe("revoked");
    // The duplicate check looks only at unrevoked grants, so restoring access
    // after a revoke is possible instead of permanently locking the account out
    // of that branch.
    const restored = accessStore.createAccessGrant({
      email: "revoked-then-restored@example.com",
      role: "manager",
      branchId: "b1",
      actorUserId: actor
    });

    expect(restored.ok).toBe(true);
  });

  it("writes an audit entry naming who granted what", () => {
    const actor = grantingActor();
    insertOwner("audited@example.com");
    const result = accessStore.createAccessGrant({
      email: "audited@example.com",
      role: "technician",
      branchId: "branch-lampang",
      actorUserId: actor
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const entry = database.db
      .select()
      .from(schema.auditLog)
      .all()
      .find((row) => row.action === "access_grant.created" && row.target === result.grant.id);

    expect(entry?.actorUserId).toBe(actor);
    expect(JSON.parse(entry!.detail)).toMatchObject({ role: "technician", branchId: "branch-lampang" });
  });
});
