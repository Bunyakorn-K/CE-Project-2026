import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { apiErrorCopy, MAPPED_API_ERROR_CODES } from "./api-errors";

/**
 * A server-supplied reason must never reach a Thai-first page untranslated.
 * `PRODUCT.md` records this as a real defect that was fixed once and has since
 * regressed: `Analytics range is capped at 90 days` rendered verbatim inside a
 * Thai sentence on the Dashboard's failure path.
 *
 * These key on the machine-readable `code`, never on the English prose. A
 * reworded server string must not silently produce an untranslated banner with
 * no test failing — that is the failure mode this mapping exists to prevent.
 */
describe("apiErrorCopy", () => {
  it("translates a range error instead of passing the server's English through", () => {
    const copy = apiErrorCopy("RANGE_TOO_LONG", "Analytics range is capped at 90 days");

    expect(copy).toBe("ช่วงวันที่ยาวเกินไป ระบบรองรับได้สูงสุด 90 วัน");
    expect(copy).not.toContain("Analytics range");
  });

  it("translates an invalid range", () => {
    expect(apiErrorCopy("INVALID_RANGE", "from and to must be YYYY-MM-DD dates")).toBe(
      "รูปแบบวันที่ไม่ถูกต้อง กรุณาเลือกช่วงวันที่ใหม่"
    );
  });

  it("never interpolates an unrecognised availability or status value into Thai copy", () => {
    const copy = apiErrorCopy("SOMETHING_NEW_FROM_A_LATER_RELEASE", "a totally unexpected english string");

    // A fallback sentence, not a sentence containing the raw server prose.
    expect(copy).toBe("ไม่สามารถโหลดข้อมูลได้");
    expect(copy).not.toContain("SOMETHING_NEW");
    expect(copy).not.toContain("unexpected english");
  });

  it("falls back rather than rendering an English message from a code-free response", () => {
    expect(apiErrorCopy(null, "IRIS reporting is not configured for LaundryTwin")).toBe("ไม่สามารถโหลดข้อมูลได้");
  });

  it("translates the access errors a branch manager can actually trigger", () => {
    expect(apiErrorCopy("BRANCH_FORBIDDEN", "You cannot view this branch")).toBe("คุณไม่มีสิทธิ์ดูข้อมูลสาขานี้");
    expect(apiErrorCopy("BRANCH_REQUIRED", "Choose a branch before loading this report")).toBe(
      "กรุณาเลือกสาขาก่อนดูรายงาน"
    );
    expect(apiErrorCopy("AUTHENTICATION_REQUIRED", "Sign in with an approved LaundryTwin account")).toBe(
      "กรุณาเข้าสู่ระบบเพื่อใช้งาน"
    );
  });

  it("distinguishes a source that is unconfigured from one that failed", () => {
    // These are different operational problems for a technician: one is a
    // deployment gap, the other is an outage. Collapsing them loses the fact
    // that decides who gets paged.
    expect(apiErrorCopy("REPORTING_SOURCE_UNAVAILABLE", "IRIS reporting is not configured")).not.toBe(
      apiErrorCopy("REPORTING_SOURCE_FAILED", "IRIS reporting could not return a usable response")
    );
  });

  it("keeps every mapped code free of Latin prose", () => {
    const codes = [
      "RANGE_TOO_LONG",
      "INVALID_RANGE",
      "BRANCH_FORBIDDEN",
      "BRANCH_REQUIRED",
      "BRANCH_NOT_FOUND",
      "AUTHENTICATION_REQUIRED",
      "ACCESS_NOT_GRANTED",
      "RATE_LIMITED",
      "REPORTING_SOURCE_UNAVAILABLE",
      "REPORTING_SOURCE_FAILED"
    ];

    for (const code of codes) {
      const copy = apiErrorCopy(code, "some english fallback");
      // Thai copy legitimately keeps established technical terms (API, LINE),
      // so this asserts no long English run rather than banning all Latin.
      expect(copy).not.toMatch(/[A-Za-z]{4,}\s+[A-Za-z]{4,}/);
    }
  });

  it("distinguishes an unreachable analytics warehouse from an unconfigured reporting source", () => {
    // Both are "the data did not load", but only one is an operator problem.
    expect(apiErrorCopy("ANALYTICS_SOURCE_UNAVAILABLE", "Analytics warehouse is unavailable")).not.toBe(
      apiErrorCopy("REPORTING_SOURCE_UNAVAILABLE", "IRIS reporting is not configured")
    );
  });
});

/**
 * The mapping above is only as complete as the API's own vocabulary, and nothing
 * in the build connects the two: a code added to `apps/api` and forgotten here
 * compiles fine, ships fine, and renders as the neutral generic sentence.
 *
 * Two codes are exempt, both deliberately. `INVALID_SCOPE` and `SCOPE_MISMATCH`
 * are the MCP service-token path — no browser in the request, so there is no
 * Thai page for them to reach. `REPORTING_SOURCE_FAILED` is listed explicitly
 * rather than exempted so that its presence stays deliberate.
 */
describe("every code the API can answer a browser with has Thai copy", () => {
  // Codes the browser can never receive, with the reason each is exempt.
  const BROWSER_INACCESSIBLE = new Set(["INVALID_SCOPE", "SCOPE_MISMATCH"]);

  function apiErrorCodes(): string[] {
    const apiDir = new URL("../../../api/src/", import.meta.url);
    const files = [
      "index.ts",
      "analytics/routes.ts",
      "analytics/scope.ts",
      "analytics/revenue.ts",
      "analytics/utilization.ts",
      "analytics/temperature.ts",
      "analytics/weather-routes.ts",
      "analytics/offpeak-routes.ts",
      "analytics/clickhouse.ts"
    ];
    const codes = new Set<string>();
    for (const file of files) {
      const source = readFileSync(new URL(file, apiDir), "utf8");
      // Two shapes reach the browser. Most routes call `apiError(c, 400, "CODE", …)`
      // or `analyticsError(c, …)`. `analytics/scope.ts` instead returns a typed
      // result whose fields the route forwards, so `code: "CODE"` has to be read
      // too — missing that form is how RANGE_TOO_LONG would have gone uncovered.
      for (const match of source.matchAll(/(?:apiError|analyticsError)\(\s*c\s*,\s*\d+\s*,\s*"([A-Z_]+)"/g)) {
        codes.add(match[1]!);
      }
      for (const match of source.matchAll(/\bcode:\s*"([A-Z_]{4,})"/g)) {
        codes.add(match[1]!);
      }
    }
    return [...codes].sort();
  }

  it("maps every emitted code, or exempts it with a stated reason", () => {
    const unmapped = apiErrorCodes().filter(
      (code) =>
        !BROWSER_INACCESSIBLE.has(code) &&
        code !== "REPORTING_SOURCE_FAILED" &&
        !MAPPED_API_ERROR_CODES.includes(code)
    );

    // Asserting the shape rather than the count: a new API code should fail
    // here, and the fix is one line of Thai copy, not a reworded English string.
    expect(unmapped).toEqual([]);
  });

  it("finds the API's own codes at all, so the guard cannot pass by matching nothing", () => {
    // A regex that silently matches zero sources would make the test above
    // vacuously true forever.
    const codes = apiErrorCodes();
    expect(codes.length).toBeGreaterThan(15);
    expect(codes).toContain("RANGE_TOO_LONG");
    expect(codes).toContain("INVALID_CURSOR");
  });
});
