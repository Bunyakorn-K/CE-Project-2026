# Gas Alert Episodes and Reminder Cadence (C + A)

**Date:** 2026-11-14
**Commits:** `d997d28` (Task 1), `e82fb7d` (Task 2), `833b7a5` (Task 3), `0386240` (Task 4)
**Deployed Image:** `laundrytwin:deploy-0386240-20261114`
**Published Digest:** `ghcr.io/bunyakorn-k/ce-project-2026-app:deploy-0386240a8f6b437061dd45d95a401164f5e0e6f2-43560978186`

## The Problem

Measured in production on 2026-11-13: **42 push messages** were delivered over 5 days across 3 gas channels:
- `gas_run_b_pressure`: 22
- `gas_run_a_pressure`: 16
- `changeover_filter_pressure`: 4

The 12-hour renotify cooldown was working as designed, but the underlying condition ("pressure declining") persisted across all 5 days. Every 12 hours, each channel hit its reminder window and fired again, announcing an unchanged ongoing state rather than a new event.

## The Fix: C (Episodes & Escalation) + A (Cadence)

### 1. Approach C: Episode Tracking & Material Escalation
- `decideGasRenotify` compares current sweep evidence against the last actually sent alert from `alert_notification.evidence`:
  - `first_alert`: no prior alert sent for this channel → notify.
  - `rate_worsened`: decline rate is >= 25% steeper (`RATE_WORSEN_FRACTION = 0.25`) → notify & bypass cooldown (`cooldownExemptIds`).
  - `drop_worsened`: pressure dropped >= 5 psi further (`DROP_WORSEN_PSI = 5`) since previous alert → notify & bypass cooldown.
  - `reminder_due`: elapsed time >= `renotifyMs` → notify.
  - `unchanged_episode`: decline is essentially the same → **suppressed**.
- Suppressed sweeps do not enter the alert engine and are audited to `audit_log` with action `alert.suppressed_episode` and reason `unchanged_episode`.
- Material escalations bypass the reminder cooldown but **remain subject to the monthly budget cap**.

### 2. Approach A: Cadence Extended to 48 Hours
- Configured in production SQLite table `alert_settings`:
  `renotify_hours = 48`, `monthly_budget = 200`.
- The engine reads this dynamically per sweep, so reminders only fire once every 2 days instead of twice a day.

## Production Verification

### Baseline Before Deploy
- Prior sweeps at 05:05, 05:10, 05:15, 05:20 UTC recorded:
  `action: alert.skipped_cooldown` (engine cooldown check).

### Measured After Deploy
- Deployed `deploy-0386240-20261114` on `10.10.0.117:8787` (0 restarts, health 200).
- Automatic sweep at **05:25:02 UTC**:
  ```text
  action: alert.suppressed_episode
  target: gas:gas_run_a_pressure:declining:2026-11-14T05
  detail: {"cooldownKey":"5e9611c1-...:gas.gas_run_a_pressure.declining:warning","ruleId":"gas.gas_run_a_pressure.declining","reason":"unchanged_episode"}
  ```
- Triggered sweep at **05:29:49 UTC**:
  ```json
  {
    "gas": {
      "state": "evaluated",
      "evaluated": 3,
      "alertable": 0,
      "channels": [
        {
          "channel": "gas_run_a_pressure",
          "trend": "declining",
          "alertable": true,
          "suppression": null,
          "coveragePct": 100,
          "sampleCount": 170,
          "reason": "declining:edgeRate=-1.0135psi/h,drop=5psi,slope=-0.5406psi/h",
          "temperatureAgeHours": 24,
          "episode": "suppressed",
          "episodeReason": "unchanged_episode"
        },
        { "channel": "gas_run_b_pressure", "trend": "steady", "alertable": false, "episode": "not_declining" },
        { "channel": "changeover_filter_pressure", "trend": "steady", "alertable": false, "episode": "not_declining" }
      ],
      "summary": null
    }
  }
  ```
- `audit_log` recorded the second suppression at `2026-11-14T05:29:49.762Z`.
- `alert_notification` row count did not increase (0 notifications sent).

### Rollback Target
- `laundrytwin:deploy-908494e-20261113`
- If rolled back, renotify cooldown reverts to 12 hours if `alert_settings` is deleted.
