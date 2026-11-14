import { describe, expect, it } from "vitest";
import { DROP_WORSEN_PSI, RATE_WORSEN_FRACTION, decideGasRenotify } from "./gas-episode";

const HOUR = 60 * 60 * 1000;
const previous = { edgeRatePsiPerHour: -1.4, lastEdgePsi: 39, sentAt: 0 };

describe("decideGasRenotify", () => {
  it("alerts when nothing was ever sent for this channel", () => {
    expect(
      decideGasRenotify({
        previous: null,
        current: { edgeRatePsiPerHour: -1.4, lastEdgePsi: 39 },
        now: 0,
        renotifyMs: 48 * HOUR
      })
    ).toEqual({ notify: true, reason: "first_alert" });
  });

  it("stays quiet when the decline is the same one, measured again", () => {
    // The production case: 42 messages in 5 days announcing one unchanged fact.
    expect(
      decideGasRenotify({
        previous,
        current: { edgeRatePsiPerHour: -1.45, lastEdgePsi: 38.4 },
        now: 6 * HOUR,
        renotifyMs: 48 * HOUR
      })
    ).toEqual({ notify: false, reason: "unchanged_episode" });
  });

  it("escalates when the rate gets materially steeper", () => {
    const steeper = previous.edgeRatePsiPerHour * (1 + RATE_WORSEN_FRACTION + 0.01);
    expect(
      decideGasRenotify({
        previous,
        current: { edgeRatePsiPerHour: steeper, lastEdgePsi: 30 },
        now: HOUR,
        renotifyMs: 48 * HOUR
      })
    ).toEqual({ notify: true, reason: "rate_worsened" });
  });

  it("escalates when the pressure has dropped further, even at the same rate", () => {
    expect(
      decideGasRenotify({
        previous,
        current: { edgeRatePsiPerHour: -1.4, lastEdgePsi: 39 - DROP_WORSEN_PSI },
        now: HOUR,
        renotifyMs: 48 * HOUR
      })
    ).toEqual({ notify: true, reason: "drop_worsened" });
  });

  it("reminds once the cadence has elapsed", () => {
    expect(
      decideGasRenotify({
        previous,
        current: { edgeRatePsiPerHour: -1.4, lastEdgePsi: 39 },
        now: 48 * HOUR,
        renotifyMs: 48 * HOUR
      })
    ).toEqual({ notify: true, reason: "reminder_due" });
  });

  it("does not divide by zero or compare NaN when the previous rate is zero", () => {
    const zero = { edgeRatePsiPerHour: 0, lastEdgePsi: 40, sentAt: 0 };
    expect(
      decideGasRenotify({
        previous: zero,
        current: { edgeRatePsiPerHour: -0.1, lastEdgePsi: 39.9 },
        now: HOUR,
        renotifyMs: 48 * HOUR
      })
    ).toEqual({ notify: false, reason: "unchanged_episode" });
  });

  it("treats a non-finite previous rate as no previous episode", () => {
    const broken = { edgeRatePsiPerHour: Number.NaN, lastEdgePsi: 40, sentAt: 0 };
    expect(
      decideGasRenotify({
        previous: broken,
        current: { edgeRatePsiPerHour: -1.4, lastEdgePsi: 39 },
        now: HOUR,
        renotifyMs: 48 * HOUR
      })
    ).toEqual({ notify: true, reason: "first_alert" });
  });
});
