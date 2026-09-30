// Presentation helper for the alerts card on the Analytics page.
//
// The warehouse has no alert fact table, so this card has one job: say that
// plainly, and distinguish "this warehouse cannot raise alerts" from "the alert
// source is broken". The server already makes that distinction in its response
// contract -- an absent source answers 200 with availability "unavailable" and a
// reason, where a broken one answers 503 -- and this helper only carries the
// known case into Thai.
//
// It is keyed on contractVersion rather than on matching the server's English
// reason string. Matching prose would break silently the first time that string
// is reworded, and it would make a translation mistake look like a working
// check.

export type AlertEnvelopeView = {
  contractVersion: string;
  source: string;
  availability: string;
  reason?: string;
};

const ALERTS_ABSENT_CONTRACT = "clickhouse-alerts-unavailable";

/**
 * The message under the alerts card when the alert source is unavailable.
 *
 * An unrecognised contract falls through to the server's own reason, because
 * this build cannot claim to know why a response shape it does not model is
 * unavailable. Showing the source string is honest; guessing would fabricate an
 * absence.
 */
export function alertUnavailableReason(alerts: AlertEnvelopeView): string {
  if (alerts.contractVersion === ALERTS_ABSENT_CONTRACT) {
    return "คลังข้อมูล ClickHouse ยังไม่มีแหล่งข้อมูลการแจ้งเตือน";
  }
  return alerts.reason ?? "แหล่งข้อมูลการแจ้งเตือนยังไม่พร้อมใช้งาน";
}