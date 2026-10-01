import { describe, expect, it } from "vitest";
import { apiErrorCopy } from "./api-errors";

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
});
