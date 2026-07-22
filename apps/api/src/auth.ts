import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { db } from "./db";
import { schema } from "./schema";

const developmentSecret = "demo-only-secret-replace-before-production-2026";

if (process.env.NODE_ENV === "production" && !process.env.BETTER_AUTH_SECRET) {
  throw new Error("BETTER_AUTH_SECRET must be configured in production");
}

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "sqlite",
    schema
  }),
  emailAndPassword: {
    enabled: true
  },
  secret: process.env.BETTER_AUTH_SECRET ?? developmentSecret,
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:8787",
  trustedOrigins: [process.env.CORS_ORIGIN ?? "http://localhost:5173"]
});
