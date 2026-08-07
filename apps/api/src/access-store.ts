import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { type AccessGrant, type Role } from "./access-policy";
import { db } from "./db";
import {
  accessGrant,
  alertAcknowledgement,
  auditLog,
  liffAccessRequest,
  liffIdentity,
  liffSession,
  user
} from "./schema";

type UserIdentity = { id: string; name: string; email: string };

export type Principal = {
  user: UserIdentity;
  source: "better-auth" | "liff" | "demo";
  grants: AccessGrant[];
};

export type PendingAccessRequest = {
  id: string;
  lineUserId: string;
  displayName: string;
  requestedAt: Date;
};

export type ActiveAccessGrant = {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  role: Role;
  branchId: string | null;
  grantedAt: Date;
};

export function resolveBetterAuthPrincipal(currentUser: UserIdentity): Principal {
  ensureBootstrapOwner(currentUser);
  return resolveUserPrincipal(currentUser, "better-auth");
}

export function resolveLiffPrincipal(token: string | undefined): Principal | null {
  return resolveSessionPrincipal(token, "liff");
}

export function resolveDemoPrincipal(token: string | undefined): Principal | null {
  return resolveSessionPrincipal(token, "demo");
}

function resolveSessionPrincipal(token: string | undefined, source: "liff" | "demo"): Principal | null {
  if (!token) return null;
  const row = db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(liffSession)
    .innerJoin(user, eq(liffSession.userId, user.id))
    .where(and(eq(liffSession.token, token), gt(liffSession.expiresAt, new Date())))
    .get();

  return row ? resolveUserPrincipal(row, source) : null;
}

export function findLiffUser(lineUserId: string): UserIdentity | null {
  const row = db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(liffIdentity)
    .innerJoin(user, eq(liffIdentity.userId, user.id))
    .where(eq(liffIdentity.lineUserId, lineUserId))
    .get();

  return row ?? null;
}

export function createLiffSession(userId: string) {
  return createLocalSession(userId);
}

export function createDemoSession(userId: string) {
  return createLocalSession(userId);
}

function createLocalSession(userId: string) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const token = randomUUID();
  db.insert(liffSession)
    .values({ id: randomUUID(), userId, token, expiresAt, createdAt: now })
    .run();
  return { token, expiresAt };
}

export function ensureDemoOwner(): UserIdentity {
  const email = "demo.owner@laundrytwin.local";
  const now = new Date();
  const existing = db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(eq(user.email, email)).get();
  const demoUser = existing ?? createDemoUser(email, now);
  const ownerGrant = db
    .select({ id: accessGrant.id })
    .from(accessGrant)
    .where(and(eq(accessGrant.userId, demoUser.id), eq(accessGrant.role, "owner"), isNull(accessGrant.revokedAt)))
    .get();
  if (!ownerGrant) {
    db.insert(accessGrant)
      .values({
        id: randomUUID(),
        userId: demoUser.id,
        role: "owner",
        branchId: null,
        grantedByUserId: demoUser.id,
        grantedAt: now
      })
      .run();
  }
  return demoUser;
}

export function revokeLiffSession(token: string | undefined) {
  if (!token) return;
  db.delete(liffSession).where(eq(liffSession.token, token)).run();
}

export function recordPendingLiffAccessRequest(input: { lineUserId: string; displayName: string }) {
  const now = new Date();
  db.insert(liffAccessRequest)
    .values({ id: randomUUID(), lineUserId: input.lineUserId, displayName: input.displayName, requestedAt: now })
    .onConflictDoUpdate({
      target: liffAccessRequest.lineUserId,
      set: { displayName: input.displayName, requestedAt: now }
    })
    .run();
}

export function listPendingAccessRequests(): PendingAccessRequest[] {
  return db
    .select({
      id: liffAccessRequest.id,
      lineUserId: liffAccessRequest.lineUserId,
      displayName: liffAccessRequest.displayName,
      requestedAt: liffAccessRequest.requestedAt
    })
    .from(liffAccessRequest)
    .where(isNull(liffAccessRequest.approvedAt))
    .orderBy(liffAccessRequest.requestedAt)
    .all();
}

export function listActiveAccessGrants(): ActiveAccessGrant[] {
  return db
    .select({
      id: accessGrant.id,
      userId: accessGrant.userId,
      userName: user.name,
      userEmail: user.email,
      role: accessGrant.role,
      branchId: accessGrant.branchId,
      grantedAt: accessGrant.grantedAt
    })
    .from(accessGrant)
    .innerJoin(user, eq(accessGrant.userId, user.id))
    .where(isNull(accessGrant.revokedAt))
    .orderBy(accessGrant.grantedAt)
    .all();
}

export function approveLiffAccessRequest(input: {
  requestId: string;
  role: Role;
  branchId: string | null;
  actorUserId: string;
}) {
  const request = db.select().from(liffAccessRequest).where(eq(liffAccessRequest.id, input.requestId)).get();
  if (!request || request.approvedAt) return null;

  const now = new Date();
  const existingUser = findLiffUser(request.lineUserId);
  const approvedUser = existingUser ?? createLiffUser(request.lineUserId, request.displayName, now);

  db.insert(accessGrant)
    .values({
      id: randomUUID(),
      userId: approvedUser.id,
      role: input.role,
      branchId: input.branchId,
      grantedByUserId: input.actorUserId,
      grantedAt: now
    })
    .run();
  db.update(liffAccessRequest)
    .set({ approvedAt: now, approvedByUserId: input.actorUserId })
    .where(eq(liffAccessRequest.id, request.id))
    .run();
  writeAudit(input.actorUserId, "access_request.approved", request.id, {
    role: input.role,
    branchId: input.branchId,
    userId: approvedUser.id
  });
  return approvedUser;
}

export function revokeAccessGrant(grantId: string, actorUserId: string): "revoked" | "not-found" | "last-owner" {
  const grant = db.select().from(accessGrant).where(eq(accessGrant.id, grantId)).get();
  if (!grant || grant.revokedAt) return "not-found";

  if (grant.role === "owner") {
    const activeOwnerCount = db
      .select({ id: accessGrant.id })
      .from(accessGrant)
      .where(and(eq(accessGrant.role, "owner"), isNull(accessGrant.revokedAt)))
      .all().length;
    if (activeOwnerCount <= 1) return "last-owner";
  }

  db.update(accessGrant).set({ revokedAt: new Date() }).where(eq(accessGrant.id, grantId)).run();
  writeAudit(actorUserId, "access_grant.revoked", grantId, { userId: grant.userId });
  return "revoked";
}

export function acknowledgeAlert(input: { irisAlertId: string; userId: string; note: string | null }) {
  const now = new Date();
  db.insert(alertAcknowledgement)
    .values({ id: randomUUID(), irisAlertId: input.irisAlertId, userId: input.userId, note: input.note, createdAt: now })
    .onConflictDoUpdate({
      target: alertAcknowledgement.irisAlertId,
      set: { userId: input.userId, note: input.note, createdAt: now }
    })
    .run();
  writeAudit(input.userId, "alert.acknowledged", input.irisAlertId, { note: input.note });
}

export function getAcknowledgedAlertIds(alertIds: string[]) {
  if (alertIds.length === 0) return new Set<string>();
  const placeholders = alertIds.map(() => "?").join(", ");
  const rows = db.$client.prepare(`SELECT iris_alert_id FROM alert_acknowledgement WHERE iris_alert_id IN (${placeholders})`).all(...alertIds) as Array<{
    iris_alert_id: string;
  }>;
  return new Set(rows.map((row) => row.iris_alert_id));
}

export function resolveUserPrincipal(currentUser: UserIdentity, source: Principal["source"]): Principal {
  const grants = db
    .select({ id: accessGrant.id, role: accessGrant.role, branchId: accessGrant.branchId })
    .from(accessGrant)
    .where(and(eq(accessGrant.userId, currentUser.id), isNull(accessGrant.revokedAt)))
    .all();
  return { user: currentUser, source, grants };
}

function ensureBootstrapOwner(currentUser: UserIdentity) {
  const bootstrapEmail = process.env.LAUNDRYTWIN_BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  if (!bootstrapEmail || currentUser.email.toLowerCase() !== bootstrapEmail) return;

  const existing = db
    .select({ id: accessGrant.id })
    .from(accessGrant)
    .where(and(eq(accessGrant.userId, currentUser.id), eq(accessGrant.role, "owner"), isNull(accessGrant.revokedAt)))
    .get();
  if (existing) return;

  db.insert(accessGrant)
    .values({
      id: randomUUID(),
      userId: currentUser.id,
      role: "owner",
      branchId: null,
      grantedByUserId: currentUser.id,
      grantedAt: new Date()
    })
    .run();
}

function createLiffUser(lineUserId: string, displayName: string, now: Date): UserIdentity {
  const id = randomUUID();
  const email = `line-${lineUserId}@liff.local`;
  db.insert(user)
    .values({ id, name: displayName, email, emailVerified: false, image: null, createdAt: now, updatedAt: now })
    .run();
  db.insert(liffIdentity).values({ lineUserId, userId: id, displayName, updatedAt: now }).run();
  return { id, name: displayName, email };
}

function createDemoUser(email: string, now: Date): UserIdentity {
  const id = randomUUID();
  const name = "Demo Owner";
  db.insert(user)
    .values({ id, name, email, emailVerified: false, image: null, createdAt: now, updatedAt: now })
    .run();
  return { id, name, email };
}

function writeAudit(actorUserId: string | null, action: string, target: string, detail: Record<string, unknown>) {
  db.insert(auditLog)
    .values({
      id: randomUUID(),
      actorUserId,
      action,
      target,
      detail: JSON.stringify(detail),
      createdAt: new Date()
    })
    .run();
}
