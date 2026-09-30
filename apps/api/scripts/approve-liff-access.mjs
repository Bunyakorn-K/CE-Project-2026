// Approves a pending LIFF access request on the production VM.
//
// The API container ships only `dist/index.mjs`, where approveLiffAccessRequest
// is bundled but not exported, so the real function cannot be imported. This
// replicates `approveLiffAccessRequest` from apps/api/src/access-store.ts
// exactly -- same user creation, same grant insert, same request update, same
// audit_log row -- using the same standalone-script approach as
// apps/api/scripts/seed-ai-settings-standalone.mjs.
//
// If you change approveLiffAccessRequest, change this too.
//
// Env: DATABASE_PATH (default /data/laundrytwin.sqlite)
// Args: <requestId> <owner|manager|technician> <branchId|-> <actorUserId>
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";

const dbPath = process.env.DATABASE_PATH ?? "/data/laundrytwin.sqlite";
if (!existsSync(dbPath)) {
  console.error(`DB not found: ${dbPath}`);
  process.exit(1);
}

const [requestId, role, branchArg, actorUserId] = process.argv.slice(2);
if (!requestId || !role || !actorUserId) {
  console.error("usage: approve-liff-access.mjs <requestId> <role> <branchId|-> <actorUserId>");
  process.exit(2);
}
if (!["owner", "manager", "technician"].includes(role)) {
  console.error(`INVALID_ROLE: ${role}`);
  process.exit(2);
}
const branchId = branchArg && branchArg !== "-" ? branchArg : null;

// The same scope rule the admin route enforces: owner is tenant-wide, the other
// roles each need exactly one branch.
if (role === "owner" && branchId !== null) {
  console.error("INVALID_BRANCH_SCOPE: owner is tenant-wide; branchId must be -");
  process.exit(2);
}
if (role !== "owner" && branchId === null) {
  console.error(`INVALID_BRANCH_SCOPE: ${role} needs exactly one branchId`);
  process.exit(2);
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// The actor must be a real owner, or the audit trail records an approval that
// nobody was entitled to make.
const actor = db
  .prepare(
    "select g.user_id as userId from access_grant g where g.user_id = ? and g.role = 'owner' and g.revoked_at is null"
  )
  .get(actorUserId);
if (!actor) {
  console.error(`ACTOR_NOT_OWNER: ${actorUserId} has no active owner grant`);
  process.exit(2);
}

const request = db.prepare("select * from liff_access_request where id = ?").get(requestId);
if (!request || request.approved_at !== null) {
  console.error("ACCESS_REQUEST_NOT_FOUND: the request is no longer pending");
  process.exit(1);
}

// findLiffUser
const existing = db
  .prepare(
    "select u.id as id, u.name as name, u.email as email from liff_identity l join user u on u.id = l.user_id where l.line_user_id = ?"
  )
  .get(request.line_user_id);

const now = Date.now();
let approvedUser;
let created = false;
if (existing) {
  approvedUser = existing;
} else {
  // createLiffUser
  const id = randomUUID();
  const email = `line-${request.line_user_id}@liff.local`;
  db.prepare(
    "insert into user (id, name, email, email_verified, image, created_at, updated_at) values (?, ?, ?, 0, null, ?, ?)"
  ).run(id, request.display_name, email, now, now);
  db.prepare("insert into liff_identity (line_user_id, user_id, display_name, updated_at) values (?, ?, ?, ?)").run(
    request.line_user_id,
    id,
    request.display_name,
    now
  );
  approvedUser = { id, name: request.display_name, email };
  created = true;
}

db.prepare("insert into access_grant (id, user_id, role, branch_id, granted_by_user_id, granted_at, revoked_at) values (?, ?, ?, ?, ?, ?, null)").run(
  randomUUID(),
  approvedUser.id,
  role,
  branchId,
  actorUserId,
  now
);
db.prepare("update liff_access_request set approved_at = ?, approved_by_user_id = ? where id = ?").run(now, actorUserId, requestId);
db.prepare("insert into audit_log (id, actor_user_id, action, target, detail, created_at) values (?, ?, ?, ?, ?, ?)").run(
  randomUUID(),
  actorUserId,
  "access_request.approved",
  requestId,
  JSON.stringify({ role, branchId, userId: approvedUser.id }),
  Date.now()
);

// Read back what actually landed, rather than trusting the writes above.
const grant = db
  .prepare("select id, user_id as userId, role, branch_id as branchId, granted_by_user_id as grantedByUserId from access_grant where user_id = ? and revoked_at is null")
  .all(approvedUser.id);
const audit = db
  .prepare("select actor_user_id as actorUserId, action, target, detail from audit_log where target = ? order by created_at desc limit 1")
  .get(requestId);

console.log(JSON.stringify({ ok: true, user: approvedUser, userCreated: created, role, branchId, grants: grant, audit }, null, 2));
