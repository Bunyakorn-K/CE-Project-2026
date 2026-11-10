// Creates one throwaway account in a SCRATCH database so the sign-in path can be
// exercised against the deployed better-auth version — which is how the 1.6 -> 1.7
// upgrade was verified before anyone was told to try logging in.
//
// Refuses to run anywhere that looks like the real database: it inserts a user
// with a known password, and the one thing it must never do is that.
//
// The check runs BEFORE the modules are imported. `../src/db` opens the database
// when it is imported, so a static import would create the file — or crash on a
// path it cannot create — before the refusal could be reached. That is what the
// first version of this guard did.
const dbPath = process.env.DATABASE_PATH ?? "";
const looksLikeProduction = dbPath === "" || /(^|\/)data\/laundrytwin/.test(dbPath) || !/scratch|test|tmp|check/.test(dbPath);
if (looksLikeProduction) {
  console.error(
    `refusing to seed a password account into ${dbPath || "(default path)"} — set DATABASE_PATH to a scratch file first`
  );
  process.exit(1);
}

const { hashPassword } = await import("better-auth/crypto");
const { eq } = await import("drizzle-orm");
const { db, initializeDatabase } = await import("../src/db");
const { account, accessGrant, user } = await import("../src/schema");

const email = "signin-check@example.invalid";
// Random per run, printed once for the caller: a fixed literal in the repo is a
// credential in the repo, and the scanner is right to refuse it.
const password = (await import("node:crypto")).randomBytes(18).toString("base64url");

initializeDatabase();
db.delete(account).where(eq(account.providerId, "credential")).run();
db.delete(user).where(eq(user.email, email)).run();

const now = new Date();
const userId = "signin-check-user";
const hash = await hashPassword(password);

db.insert(user)
  .values({
    id: userId,
    name: "Sign-in check",
    email,
    emailVerified: true,
    createdAt: now,
    updatedAt: now
  })
  .run();

db.insert(account)
  .values({
    id: "signin-check-account",
    accountId: userId,
    providerId: "credential",
    userId,
    password: hash,
    createdAt: now,
    updatedAt: now
  })
  .run();

db.insert(accessGrant)
  .values({
    id: "signin-check-grant",
    userId,
    role: "owner",
    branchId: null,
    grantedByUserId: null,
    grantedAt: now
  })
  .run();

console.log(JSON.stringify({ email, password, hashPrefix: hash.slice(0, 12), userId }));
