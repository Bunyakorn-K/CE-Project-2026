import { describe, expect, it } from "vitest";
import { alertUnavailableReason } from "./alerts-view";

const ABSENT = {
  contractVersion: "clickhouse-alerts-unavailable",
  source: "clickhouse",
  availability: "unavailable",
  reason: "ClickHouse analytics warehouse has no alert fact source"
};

describe("alertUnavailableReason", () => {
  // The server's reason is English, and this card renders on a Thai-first page
  // directly under a Thai heading. Rendering it verbatim put
  // "ClickHouse analytics warehouse has no alert fact source" on screen.
  it("states the absent alert source in Thai, not the server's English", () => {
    const message = alertUnavailableReason(ABSENT);

    expect(message).toMatch(/[฀-๿]/);
    expect(message).not.toBe(ABSENT.reason);
    // "ClickHouse" is a proper noun and stays; what must not survive is the
    // English prose around it.
    expect(message).not.toContain("warehouse");
    expect(message).not.toContain("alert fact source");
  });

  // The card's entire purpose is separating "this warehouse cannot raise alerts"
  // from "the alert source is broken". A generic message would collapse them.
  it("names the warehouse as the reason rather than reporting a failure", () => {
    const message = alertUnavailableReason(ABSENT);

    expect(message).toContain("ClickHouse");
    expect(message).toContain("ยังไม่มี");
    expect(message).not.toMatch(/error|failed|unavailable/i);
  });

  it("keeps the server's own reason for a contract this build does not model", () => {
    // Inventing a cause for an unknown response shape would fabricate an
    // absence, so an unrecognised contract defers to the source.
    const unknown = {
      contractVersion: "some-future-alert-contract",
      source: "clickhouse",
      availability: "unavailable",
      reason: "Something this build has never seen"
    };

    expect(alertUnavailableReason(unknown)).toBe("Something this build has never seen");
  });

  it("falls back to a Thai default when an unknown contract carries no reason", () => {
    const noReason = { contractVersion: "some-future-alert-contract", source: "clickhouse", availability: "unavailable" };

    expect(alertUnavailableReason(noReason)).toMatch(/[฀-๿]/);
  });

  it("does not depend on the English reason string staying as written", () => {
    // Keyed on contractVersion on purpose: rewording the server string must not
    // silently change which message appears.
    const reworded = { ...ABSENT, reason: "Reworded upstream but still absent" };

    expect(alertUnavailableReason(reworded)).toBe(alertUnavailableReason(ABSENT));
  });
});