/**
 * Thai-first presentation of API error codes.
 *
 * The API answers with English prose (`apps/api/src/index.ts` `apiError`, and
 * `apps/api/src/analytics/scope.ts` `parseAnalyticsRange`). Rendering that
 * string inside a Thai sentence produced banners like
 * "ไม่สามารถโหลดแดชบอร์ดได้: Analytics range is capped at 90 days".
 *
 * Two rules make this durable:
 *
 * 1. Key on the machine-readable `code`, never on the English text. Matching
 *    prose breaks silently the first time the server rewords a string, with no
 *    test failing. `apps/web/src/lib/alerts-view.ts` established the same rule
 *    for `contractVersion`.
 * 2. An unmapped code gets a neutral Thai sentence, never an interpolation of
 *    the raw value. "Something we did not anticipate" must not render as a
 *    confident claim carrying the server's own words.
 */

const API_ERROR_COPY: Record<string, string> = {
  INVALID_RANGE: "รูปแบบวันที่ไม่ถูกต้อง กรุณาเลือกช่วงวันที่ใหม่",
  RANGE_TOO_LONG: "ช่วงวันที่ยาวเกินไป ระบบรองรับได้สูงสุด 90 วัน",
  INVALID_REPORT_QUERY: "คำขอรายงานไม่ถูกต้อง กรุณาลองใหม่",
  INVALID_LIMIT: "จำนวนรายการที่ขอไม่ถูกต้อง กรุณาลองใหม่",
  INVALID_BRANCH_SCOPE: "ขอบเขตสาขาที่เลือกไม่ถูกต้อง",
  UNKNOWN_BRANCH: "ไม่พบสาขาที่เลือก",
  BRANCH_NOT_FOUND: "ไม่พบสาขาที่เลือกในระบบ",
  BRANCH_FORBIDDEN: "คุณไม่มีสิทธิ์ดูข้อมูลสาขานี้",
  BRANCH_REQUIRED: "กรุณาเลือกสาขาก่อนดูรายงาน",
  AUTHENTICATION_REQUIRED: "กรุณาเข้าสู่ระบบเพื่อใช้งาน",
  UNAUTHORIZED: "กรุณาเข้าสู่ระบบเพื่อใช้งาน",
  ACCESS_NOT_GRANTED: "บัญชีนี้ยังไม่ได้รับสิทธิ์เข้าใช้งาน",
  ACCESS_PENDING: "คำขอสิทธิ์ยังอยู่ระหว่างการอนุมัติ",
  OWNER_ROLE_REQUIRED: "หน้านี้ใช้ได้เฉพาะเจ้าของระบบ",
  INVALID_ROLE: "บทบาทการใช้งานไม่ถูกต้อง",
  RATE_LIMITED: "คำขอถี่เกินไป กรุณารอสักครู่แล้วลองใหม่",
  // Kept distinct on purpose: one is a deployment gap, the other an outage.
  // Collapsing them loses the fact that decides who gets paged.
  REPORTING_SOURCE_UNAVAILABLE: "ยังไม่ได้เชื่อมต่อแหล่งข้อมูลรายงาน กรุณาติดต่อผู้ดูแลระบบ",
  REPORTING_SOURCE_FAILED: "แหล่งข้อมูลรายงานไม่ตอบสนอง กรุณาลองใหม่",
  GRANT_NOT_FOUND: "ไม่พบสิทธิ์ที่เลือก",
  ACCESS_REQUEST_NOT_FOUND: "ไม่พบคำขอสิทธิ์ที่เลือก",
  DEMO_DISABLED: "โหมด Demo ถูกปิดใช้งาน",
  INVALID_LIFF_TOKEN: "ข้อมูลการเข้าสู่ระบบจาก LINE ไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่",
  LIFF_TOKEN_REJECTED: "เซสชัน LINE หมดอายุ กรุณาเข้าสู่ระบบใหม่",
  LIFF_VERIFICATION_FAILED: "ยืนยันตัวตนจาก LINE ไม่สำเร็จ กรุณาเข้าสู่ระบบใหม่",
  UNTRUSTED_ORIGIN: "คำขอมาจากแหล่งที่ไม่ได้รับความเชื่อถือ"
};

export const API_ERROR_FALLBACK = "ไม่สามารถโหลดข้อมูลได้";

/**
 * Thai copy for an API error, or the neutral fallback.
 *
 * `code` may be absent (a proxy error, an HTML error page, an older API
 * build), and the server's `message` is deliberately NOT used as a fallback:
 * it is English, and appending it to Thai copy is the defect this replaces.
 */
export function apiErrorCopy(code: string | null | undefined, _serverMessage?: string): string {
  if (!code) return API_ERROR_FALLBACK;
  return API_ERROR_COPY[code] ?? API_ERROR_FALLBACK;
}
