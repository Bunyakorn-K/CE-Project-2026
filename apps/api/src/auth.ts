import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { db } from "./db";
import { schema } from "./schema";

const TEST_ONLY_BETTER_AUTH_SECRET = "test-only-better-auth-secret-for-laundrytwin";
const DEFAULT_TRUSTED_ORIGIN = "http://localhost:5173";

type RuntimeEnvironment = Partial<Pick<NodeJS.ProcessEnv, "NODE_ENV" | "BETTER_AUTH_SECRET" | "CORS_ORIGIN">>;

export function resolveServerSecret(environment: RuntimeEnvironment = process.env): string {
  const configuredSecret = environment.BETTER_AUTH_SECRET?.trim();
  if (configuredSecret) return configuredSecret;
  if (environment.NODE_ENV === "test") return TEST_ONLY_BETTER_AUTH_SECRET;
  throw new Error("BETTER_AUTH_SECRET must be configured in every non-test runtime");
}

export function resolveTrustedOrigins(environment: RuntimeEnvironment = process.env): string[] {
  const configuredOrigins = environment.CORS_ORIGIN === undefined
    ? [DEFAULT_TRUSTED_ORIGIN]
    : environment.CORS_ORIGIN.split(",").map((origin) => origin.trim());
  if (configuredOrigins.length === 0 || configuredOrigins.some((origin) => !origin)) {
    throw new Error("CORS_ORIGIN must contain at least one explicit origin");
  }
  return configuredOrigins.map(normalizeTrustedOrigin);
}

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "sqlite",
    schema
  }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 12
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 60, max: 3 }
    }
  },
  secret: resolveServerSecret(),
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:8787",
  trustedOrigins: resolveTrustedOrigins()
});

function normalizeTrustedOrigin(value: string): string {
  if (value.includes("*")) {
    throw new Error("Wildcard trusted origins are not allowed");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("CORS_ORIGIN entries must be valid origins");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw new Error("CORS_ORIGIN entries must be valid HTTP(S) origins");
  }
  return parsed.origin;
}
