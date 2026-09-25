import { describe, expect, it } from "vitest";
import { auth, resolveServerSecret, resolveTrustedOrigins } from "./auth";
import { encryptApiKey } from "./ai-settings";

describe("auth configuration", () => {
  it("requires a secret outside test and returns configured values", () => {
    expect(resolveServerSecret({ NODE_ENV: "development", BETTER_AUTH_SECRET: "configured-secret" })).toBe("configured-secret");
    expect(() => resolveServerSecret({ NODE_ENV: "production" })).toThrow(
      "BETTER_AUTH_SECRET must be configured in every non-test runtime"
    );
    expect(() => resolveServerSecret({})).toThrow(
      "BETTER_AUTH_SECRET must be configured in every non-test runtime"
    );
  });

  it("uses a private deterministic fallback only in test", () => {
    const first = resolveServerSecret({ NODE_ENV: "test" });
    const second = resolveServerSecret({ NODE_ENV: "test" });

    expect(first).toBe(second);
    expect(first).not.toBe("configured-secret");
    expect(first.length).toBeGreaterThan(0);
  });

  it("parses explicit trusted origins and rejects wildcard or malformed values", () => {
    expect(resolveTrustedOrigins({ CORS_ORIGIN: "http://localhost:5173, https://app.example.com/" })).toEqual([
      "http://localhost:5173",
      "https://app.example.com"
    ]);
    expect(() => resolveTrustedOrigins({ NODE_ENV: "production", CORS_ORIGIN: "*" })).toThrow(
      "Wildcard trusted origins are not allowed"
    );
    expect(() => resolveTrustedOrigins({ CORS_ORIGIN: "not-an-origin" })).toThrow(
      "CORS_ORIGIN entries must be valid origins"
    );
  });

  it("does not use a public secret fallback for AI settings outside test", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousSecret = process.env.BETTER_AUTH_SECRET;
    process.env.NODE_ENV = "production";
    delete process.env.BETTER_AUTH_SECRET;

    try {
      expect(() => encryptApiKey("not-persisted")).toThrow(
        "BETTER_AUTH_SECRET must be configured in every non-test runtime"
      );
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = previousSecret;
    }
  });

  it("disables public signup and configures bounded auth rate limits", () => {
    expect(auth.options.emailAndPassword).toMatchObject({
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12
    });
    expect(auth.options.rateLimit).toMatchObject({
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60, max: 3 }
      }
    });
  });
});
