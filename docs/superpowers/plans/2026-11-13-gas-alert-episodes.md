# Gas Alert Episodes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop re-announcing a gas-pressure decline that has not changed, and slow the reminder cadence from 12 h to 48 h.

**Architecture:** A gas channel that is *still* declining is not news. A pure decision (`decideGasRenotify`) compares the current sweep's trend against the evidence of the last alert actually sent for that channel, and answers one of: first alert, worsened enough to escalate, reminder due, or unchanged. The sweep drops unchanged channels before they reach the alert engine, and marks escalations so the engine's cooldown does not swallow them. The reminder cadence stays a backoffice setting; this plan changes its value, not its mechanism.

**Tech Stack:** TypeScript 5, Vitest, better-sqlite3 + Drizzle, Hono (unchanged), Airflow DAG calling the API's existing sweep path.

**Spec:** `docs/04_traceability/ops-verification-2026-11-13-feedback-counting-and-stale-numbers.md` §2 for the measurement this follows on from, and the measurements below taken from production on 2026-11-13.

## Global Constraints

- Thai for anything a user reads; English for code and comments.
- Every new decision lives in a pure function with its own test file; the DB read is a separate function so the decision can be tested without a database.
- Numbers in this plan are measured, not chosen: 42 gas pushes in 5 days across 3 channels (`gas_run_a` 16, `gas_run_b` 22, `changeover_filter` 4), 38 distinct alert events, `alert_settings` empty so `renotifyHours` falls back to the environment default of 12.
- Do not change what an alert *says*, only whether it is sent.
- Do not add a schema migration: the previous episode is already stored in `alert_notification.evidence` and `alert_notification.attempted_at`.
- `RATE_WORSEN_FRACTION = 0.25` and `DROP_WORSEN_PSI = 5` are this plan's values; both live in `gas-episode.ts` as exported constants so a test can name them.
- Verification for every task: `pnpm --filter @laundrytwin/api exec vitest run <file>`, then `pnpm build && pnpm test && pnpm check` before any commit that ships.

## Review Focus

Inputs and conditions a reasonable person would expect to work, that no task's happy-path test covers. Each line names the task that must carry its test.

1. **An alert row whose `evidence` predates this feature** (or came from an IRIS rule): no `edgeRatePsiPerHour`. Expected: treated as "no previous alert", so the channel alerts rather than being silenced by an unparseable predecessor. → Task 2.
2. **A trend that recovers and declines again within the cooldown.** Expected: the reminder cadence still bounds it (one alert per `renotifyMs`), and that is a documented limit, not an accident — a re-entry cannot be distinguished from a continuation without new state. → Task 4 test asserts the sweep asks the decision, and Task 1 documents the reason the decision cannot say "new episode".
3. **A rate that is zero or positive** in a "previous" row (older formatting): abs-based comparison must not treat `-0.1` as a 90% improvement over `0`. Expected: finite-number guard, fall through to `unchanged_episode`/`reminder_due`, never a divide-by-zero or NaN comparison. → Task 1.
4. **Escalation while the monthly budget is spent.** Expected: still suppressed by budget and counted as `suppressedBudget`; the exemption only bypasses the cooldown. → Task 3/4.
5. **Two channels escalating in the same sweep.** Expected: both alerts sent, both exempt, budget decremented per recipient — a Set keyed by alert id must not collapse them. → Task 4.

---

### Task 1: The episode decision

**Files:**
- Create: `apps/api/src/gas-episode.ts`
- Test: `apps/api/src/gas-episode.test.ts`

**Interfaces:**
- Produces:
  - `export const RATE_WORSEN_FRACTION = 0.25`
  - `export const DROP_WORSEN_PSI = 5`
  - `export type GasEpisodePrevious = { edgeRatePsiPerHour: number; lastEdgePsi: number; sentAt: number }`
  - `export type GasEpisodeDecision = { notify: true; reason: "first_alert" | "rate_worsened" | "drop_worsened" | "reminder_due" } | { notify: false; reason: "unchanged_episode" }`
  - `export function decideGasRenotify(input: { previous: GasEpisodePrevious | null; current: { edgeRatePsiPerHour: number; lastEdgePsi: number }; now: number; renotifyMs: number }): GasEpisodeDecision`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/gas-episode.test.ts
import { describe, expect, it } from "vitest";
import { DROP_WORSEN_PSI, RATE_WORSEN_FRACTION, decideGasRenotify } from "./gas-episode";

const HOUR = 60 * 60 * 1000;
const previous = { edgeRatePsiPerHour: -1.4, lastEdgePsi: 39, sentAt: 0 };

describe("decideGasRenotify", () => {
  it("alerts when nothing was ever sent for this channel", () => {
    expect(
      decideGasRenotify({ previous: null, current: { edgeRatePsiPerHour: -1.4, lastEdgePsi: 39 }, now: 0, renotifyMs: 48 * HOUR })
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
      decideGasRenotify({ previous, current: { edgeRatePsiPerHour: steeper, lastEdgePsi: 30 }, now: HOUR, renotifyMs: 48 * HOUR })
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
      decideGasRenotify({ previous, current: { edgeRatePsiPerHour: -1.4, lastEdgePsi: 39 }, now: 48 * HOUR, renotifyMs: 48 * HOUR })
    ).toEqual({ notify: true, reason: "reminder_due" });
  });

  it("does not divide by zero or compare NaN when the previous rate is zero", () => {
    const zero = { edgeRatePsiPerHour: 0, lastEdgePsi: 40, sentAt: 0 };
    expect(
      decideGasRenotify({ previous: zero, current: { edgeRatePsiPerHour: -0.1, lastEdgePsi: 39.9 }, now: HOUR, renotifyMs: 48 * HOUR })
    ).toEqual({ notify: false, reason: "unchanged_episode" });
  });

  it("treats a non-finite previous rate as no previous episode", () => {
    const broken = { edgeRatePsiPerHour: Number.NaN, lastEdgePsi: 40, sentAt: 0 };
    expect(
      decideGasRenotify({ previous: broken, current: { edgeRatePsiPerHour: -1.4, lastEdgePsi: 39 }, now: HOUR, renotifyMs: 48 * HOUR })
    ).toEqual({ notify: true, reason: "first_alert" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @laundrytwin/api exec vitest run src/gas-episode.test.ts`
Expected: FAIL — `Failed to resolve import "./gas-episode"`.

- [ ] **Step 3: Implement `decideGasRenotify` in `apps/api/src/gas-episode.ts`**

Order of checks: no usable previous → `first_alert`; rate steeper by RATE_WORSEN_FRACTION (compare magnitudes, so a negative rate is "steeper" when its absolute value grows) → `rate_worsened`; pressure fallen by DROP_WORSEN_PSI or more since the last alert → `drop_worsened`; `now - previous.sentAt >= renotifyMs` → `reminder_due`; otherwise `unchanged_episode`. Document in the file header why a "new episode after a recovery" is not detectable here (no stored steady observations) and that the cadence is what bounds it.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @laundrytwin/api exec vitest run src/gas-episode.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/gas-episode.ts apps/api/src/gas-episode.test.ts
git commit -m "feat(alerts): decide whether a gas decline is still news"
```

---

### Task 2: Read the previous episode out of the transcript

**Files:**
- Modify: `apps/api/src/gas-episode.ts`
- Test: `apps/api/src/gas-episode.test.ts` (new `describe` block, real SQLite like `access-store.test.ts`)

**Interfaces:**
- Consumes: `GasEpisodePrevious` from Task 1.
- Produces: `export function lastSentGasAlert(cooldownKey: string): GasEpisodePrevious | null` — the newest `alert_notification` row with that `cooldown_key`, `status = 'sent'`, with its `evidence` parsed into `{ edgeRatePsiPerHour, lastEdgePsi, sentAt }`; `null` when there is no such row or the evidence does not carry finite numbers.

- [ ] **Step 1: Write the failing test**

```ts
// appended to apps/api/src/gas-episode.test.ts, in its own describe with the
// DATABASE_PATH/tmpdir setup copied from apps/api/src/access-store.test.ts
it("reads back the rate and pressure the last alert reported", () => { /* insert a sent row with evidence JSON; expect { edgeRatePsiPerHour: -1.4, lastEdgePsi: 39, sentAt: <ms> } */ });

it("returns null for a row whose evidence predates this feature", () => {
  // Production already holds rows shaped like this: `{"channel":"gas_run_a_pressure"}`
  // with no numbers. A channel must alert, not be silenced by its predecessor.
  expect(lastSentGasAlert("branch-01:gas.gas_run_a_pressure.declining:warning")).toBeNull();
});

it("ignores failed attempts and other keys", () => { /* status 'failed' row and a different cooldown_key both return null */ });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @laundrytwin/api exec vitest run src/gas-episode.test.ts`
Expected: FAIL — `lastSentGasAlert is not a function`.

- [ ] **Step 3: Implement `lastSentGasAlert`**

Query `alertNotification` with `and(eq(cooldownKey, key), eq(status, "sent"))`, `orderBy(desc(attemptedAt))`, `limit(1)`. Parse `evidence` in a `try/catch`; return `null` unless both `edgeRatePsiPerHour` and `lastEdgePsi` are finite numbers. `sentAt` is `row.attemptedAt.getTime()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @laundrytwin/api exec vitest run src/gas-episode.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/gas-episode.ts apps/api/src/gas-episode.test.ts
git commit -m "feat(alerts): the previous gas episode is already in the transcript"
```

---

### Task 3: Let an escalation past the cooldown

**Files:**
- Modify: `apps/api/src/alert-engine.ts` (`AlertEngineDeps`, `AlertSweepSummary`, the cooldown check in `runAlertSweep`)
- Test: `apps/api/src/alert-engine.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `AlertEngineDeps.cooldownExemptIds?: Set<string>` (alert ids that skip the cooldown check) and `AlertSweepSummary.cooldownExempt: number`.

- [ ] **Step 1: Write the failing test**

```ts
it("sends an exempt alert inside the cooldown window, and still counts the rest as cooldown", async () => {
  // seed a sent row 1 hour ago for the rule, so a normal alert is in cooldown
  // run the sweep with cooldownExemptIds: new Set([escalatedAlert.id])
  // expect summary.sent to be escalatedAlert recipients' count, summary.cooldown >= 1,
  //        summary.cooldownExempt === 1
});

it("an exemption does not bypass the monthly budget", async () => {
  // budget spent (set alert_settings.monthly_budget to 0)
  // expect summary.suppressedBudget === 1 and no send
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @laundrytwin/api exec vitest run src/alert-engine.test.ts`
Expected: FAIL — the exempt alert is skipped by the cooldown, so `summary.sent` is 0.

- [ ] **Step 3: Implement**

In `runAlertSweep`, compute `const exempt = deps.cooldownExemptIds?.has(alert.id) ?? false;` and change the guard to `if (!exempt && lastSent && now.getTime() - lastSent.getTime() < cooldownMs)`. Increment `summary.cooldownExempt` when exempt and the cooldown would otherwise have applied. Add the field to the summary object literal with `0` so every caller sees a total.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @laundrytwin/api exec vitest run src/alert-engine.test.ts`
Expected: PASS. If any existing test asserts the whole summary object with `toEqual`, add `cooldownExempt: 0` to it — that is a fixture update, not a behaviour change.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/alert-engine.ts apps/api/src/alert-engine.test.ts
git commit -m "feat(alerts): an escalation is not subject to the reminder cooldown"
```

---

### Task 4: Wire the episode into the gas sweep

**Files:**
- Modify: `apps/api/src/alert-sweep.ts` (`evaluateGasSweep`, the `alerts` construction and the `runAlertSweep` call)
- Test: `apps/api/src/alert-sweep.test.ts`

**Interfaces:**
- Consumes: `decideGasRenotify`, `lastSentGasAlert`, `RATE_WORSEN_FRACTION`, `DROP_WORSEN_PSI` (Tasks 1–2); `cooldownKeyFor` from `alert-engine.ts`; `effectiveRenotifyMs` from `alert-settings.ts`; `cooldownExemptIds` (Task 3).
- Produces: `AlertSweepResult.channels[i].episode: "notify" | "suppressed"` and `AlertSweepResult.channels[i].episodeReason` so an operator can see why a declining channel produced no message.

- [ ] **Step 1: Write the failing test**

```ts
it("does not re-announce a declining channel whose evidence has not changed", async () => {
  // seed alert_notification: sent gas alert for gas_run_a, evidence -1.4 psi/h, 39 psi, 1 hour ago
  // clickhouse fixture returns a declining series with the same rate
  // expect result.alertable === 0, and the channel's episode === "suppressed"
  // expect an audit row with action "alert.suppressed_episode"
});

it("escalates a channel that got steeper, even inside the cooldown", async () => {
  // same seed, but the series is twice as steep
  // expect result.alertable === 1 and dispatch called
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @laundrytwin/api exec vitest run src/alert-sweep.test.ts`
Expected: FAIL — `alertable` is 1 for the unchanged case.

- [ ] **Step 3: Implement**

Replace the `decisions.map(gasAlertFromDecision).filter(...)` chain with a loop that, for each non-null alert: computes `key = cooldownKeyFor(alert as unknown as IrisAlert)`; calls `lastSentGasAlert(key)`; calls `decideGasRenotify({ previous, current: { edgeRatePsiPerHour: decision.evidence.edgeRatePsiPerHour, lastEdgePsi: decision.evidence.lastEdgePsi }, now: now.getTime(), renotifyMs: effectiveRenotifyMs() })`; on `notify: false` writes an audit row `alert.suppressed_episode` (target `alert.id`, detail `{ cooldownKey, reason }`) and records the channel as suppressed; on an escalation reason adds `alert.id` to a `cooldownExemptIds` set; both kept alerts go into the array passed to `runAlertSweep(alerts, { ...engine, cooldownExemptIds })`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @laundrytwin/api exec vitest run src/alert-sweep.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole API suite, then commit**

Run: `pnpm build && pnpm test && pnpm check`
Expected: all green; API count rises by the new tests.

```bash
git add apps/api/src/alert-sweep.ts apps/api/src/alert-sweep.test.ts
git commit -m "feat(alerts): one message per gas decline, not one per sweep"
```

---

### Task 5: The cadence (A)

**Files:**
- No code. Production `alert_settings` row, and the evidence record from Task 6.

**Interfaces:**
- Consumes: `effectiveRenotifyMs()` (`alert-settings.ts`) — the engine and the episode decision both read it per sweep, so a change takes effect on the next run with no deploy.

- [ ] **Step 1: Set `renotifyHours` to 48 for the owner account**

Owner opens `/admin/alerts` and saves 48. (Fallback for a deployment with no session: `insert into alert_settings (id, renotify_hours, monthly_budget, updated_at, created_at) values ('default', 48, 200, <ms>, <ms>) on conflict(id) do update set renotify_hours = 48`. Either way the change is a stored fact, not an env edit, because the owner asked for adjustable values to live in `/admin`.)

- [ ] **Step 2: Verify it is the value the sweep will use**

```bash
ssh -J notnotik-pve uunw@10.10.0.117 "sudo -n docker exec -e NODE_PATH=/app/node_modules laundrytwin-app-1 node -e \"
const D=require('better-sqlite3');const db=new D('/data/laundrytwin.sqlite',{readonly:true});
console.log(db.prepare('select renotify_hours, monthly_budget, updated_at from alert_settings').all());
\""
```
Expected: one row, `renotify_hours: 48`.

- [ ] **Step 3: Record it in the evidence file**

One line: value, who changed it, when, and that it is read per sweep.

### Task 6: Evidence and production verification

**Files:**
- Create: `docs/04_traceability/ops-verification-YYYY-MM-DD-gas-alert-episodes.md`
- Modify: `docs/02_architecture/deploy-runbook.md` (rollback ref only)

- [ ] **Step 1: Deploy the image and record the digest**

Same sequence as the other deploys: `gh run list --workflow=release.yml`, resolve the tag `deploy-<sha>-<CI run id>`, `docker pull` → **verify** → `docker rm -f` + `compose up -d app` → health 200. Record image id and digest.

- [ ] **Step 2: Verify the suppression on production**

Read `alert_notification` before and after two consecutive sweeps (`*/5 * * * *`) with an unchanged declining channel: the count must not grow, and `audit_log` must gain `alert.suppressed_episode` rows naming the channel and `unchanged_episode`.

- [ ] **Step 3: Write the evidence record**

State: measured before/after counts, the two sweeps' audit rows, what is **not** verified (an escalation triggered by a real worsening — it needs the sensor to actually get worse, so it is covered by tests only), and the rollback image.

- [ ] **Step 4: Commit**

```bash
git add docs/04_traceability/ops-verification-*-gas-alert-episodes.md docs/02_architecture/deploy-runbook.md
git commit -m "docs(ops): gas alerts announce a change, not a state"
```

---

---

## Self-Review

**1. Spec coverage.** C is Tasks 1–4 (pure decision, previous-episode read, cooldown exemption, sweep wiring); A is Task 5; the record is Task 6. The option B (merging three channels into one message) is deliberately out of scope: the measurement showed 38 events over 31 sweeps, so aggregation saves ~18% while C removes the repetition.

**2. Step scan.** Each step names one action and its check. No step says "handle edge cases"; the five Review Focus lines each have a named test in a named task.

**3. Type consistency.** `GasEpisodePrevious` ({edgeRatePsiPerHour, lastEdgePsi, sentAt}) is produced by Task 2 and consumed by Task 1's input in Task 4 — the same field names as `evidence.edgeRatePsiPerHour`/`evidence.lastEdgePsi` in `gas-trend.ts`, which is where the values come from. `cooldownExemptIds` is spelled the same in Tasks 3 and 4. `AlertSweepResult.channels[i].episode` is added in Task 4 only.

**4. Review Focus.** Five lines, each with its test: Tasks 1 (3 lines), 2 (1 line), 3/4 (2 lines, with Task 3 owning the budget interaction and Task 4 the two-channel Set).

**5. Proportion.** The plan is shorter than the code it describes: two new functions (~120 lines with comments), two small edits, one settings change.

**Known limit, stated in Task 1's header:** a trend that recovers and declines again inside the cadence is not distinguished from a continuation, because nothing stores the steady observation that would separate them. The cadence bounds it; adding episode state would be a schema change and is not in this plan.
