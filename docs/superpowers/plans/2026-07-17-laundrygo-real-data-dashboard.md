# LaundryGo Real-Data Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the LaundryGo fixed-data demo with a mobile-first, LINE LIFF stakeholder dashboard that uses its own authentication and RBAC while displaying real data solely through the IRIS read API.

**Architecture:** LaundryGo keeps Better Auth for local administrator accounts and uses a verified LIFF token exchange for stakeholder sessions. The Hono API is the only component that holds the IRIS read credential; it validates the IRIS response contract, applies local branch scope, fans out bounded SSE updates, records local access and acknowledgement audit events, and never stores a production telemetry mirror.

**Tech Stack:** React 19, Vite, HeroUI, Hono on Node.js, Drizzle ORM, SQLite, Better Auth, LINE LIFF, JOSE, Zod, Vitest, Playwright.

## Global Constraints

- This workspace has no Git repository. Do not run `git add`, `git commit`, `git push`, or a destructive Git command here; record verification output instead.
- Keep code, comments, docs, environment variable names, and persisted audit values in English.
- Keep the UI mobile-first and truthful: no hard-coded revenue, machine state, alerts, simulated freshness, or `Live` label without a successful live response.
- Browser code only calls LaundryGo same-origin routes. It never receives `IRIS_LAUNDRYGO_READ_API_KEY` or calls IRIS directly.
- The server reads only the versioned IRIS contract. It never uses MQTT, a Durable Object binding, or a production database connection.
- LIFF stakeholder sessions can only read data. Local writes are access requests, local approval/revocation, local alert acknowledgement, and local audit records.
- Better Auth is retained for local administrator accounts; do not use a fake email or pretend a LIFF token is a Better Auth OAuth callback.
- Do not deploy the VM, configure LINE/IRIS/Cloudflare secrets, or call a production API until the user explicitly requests deployment and provides the scoped integration configuration.

---

### Task 1: Establish test tooling and remove the demo-data contract

**Files:**
- Modify: `package.json`
- Modify: `apps/api/package.json`
- Modify: `apps/web/package.json`
- Create: `apps/api/vitest.config.ts`
- Create: `apps/web/vitest.config.ts`
- Create: `apps/api/src/dashboard-source.test.ts`
- Modify: `README.md`

**Interfaces:**
- Produces `pnpm test` and package-scoped Vitest commands used by all following tasks.
- Removes the documented claim that seeded data is a valid dashboard source.

- [ ] **Step 1: Write a failing regression test against demo fallbacks**

```ts
// apps/api/src/dashboard-source.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('dashboard source boundary', () => {
  it('does not retain fixed revenue or demo data seeding in the dashboard path', () => {
    const api = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const database = readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
    expect(api).not.toContain('dailyRevenueEstimate: 1840');
    expect(database).not.toContain('seedDemoData');
  });
});
```

- [ ] **Step 2: Add Vitest scripts and run the test to verify it fails**

Add `vitest` to the API and web dev dependencies, add `test` scripts, and add a root `test` script that runs both workspaces. Use the Node test environment for API tests and `jsdom` for web tests.

Run: `pnpm --filter @laundrygo/api test -- src/dashboard-source.test.ts`

Expected: FAIL because the fixed revenue and demo seeding still exist.

- [ ] **Step 3: Remove the demo seed boundary**

Delete `apps/api/src/demo-data.ts`, remove its import and invocation from `apps/api/src/db.ts`, and remove the current machine/alert demo endpoint implementation from `apps/api/src/index.ts`. Keep the health endpoint and Better Auth handler intact until Tasks 2–4 replace the remaining local API surface.

Replace the README demo description with this sentence:

```md
LaundryGo shows no operational data until its server-to-server IRIS read integration is configured and returns a validated contract response.
```

- [ ] **Step 4: Run the regression test to verify it passes**

Run: `pnpm --filter @laundrygo/api test -- src/dashboard-source.test.ts`

Expected: PASS.

- [ ] **Step 5: Run static verification**

Run: `pnpm check && pnpm build`

Expected: both commands exit `0` before the new feature tasks begin.

### Task 2: Add local stakeholder identity, access, and audit persistence

**Files:**
- Modify: `apps/api/src/schema.ts`
- Modify: `apps/api/src/db.ts`
- Create: `apps/api/src/access-control.ts`
- Create: `apps/api/src/access-control.test.ts`

**Interfaces:**
- Produces `StakeholderRole`, `StakeholderIdentity`, `StakeholderAccess`, `AuthorizedScope`, `isBranchAllowed`, and `assertRoleCanReadRevenue`.
- Consumes Better Auth `user` only as `approvedByUserId` for local administrator auditability.

- [ ] **Step 1: Write failing scope tests**

```ts
// apps/api/src/access-control.test.ts
import { describe, expect, it } from 'vitest';
import { assertRoleCanReadRevenue, isBranchAllowed } from './access-control';

describe('local stakeholder scope', () => {
  it('allows an owner to read every branch in the configured tenant', () => {
    expect(isBranchAllowed({ tenantId: 't1', role: 'owner', branchIds: [] }, 'b9')).toBe(true);
  });

  it('rejects a manager request outside its approved branch set', () => {
    expect(isBranchAllowed({ tenantId: 't1', role: 'manager', branchIds: ['b1'] }, 'b9')).toBe(false);
  });

  it('does not grant revenue reporting to a technician', () => {
    expect(() => assertRoleCanReadRevenue('technician')).toThrow('ROLE_FORBIDDEN');
  });
});
```

- [ ] **Step 2: Run the access-control test to verify it fails**

Run: `pnpm --filter @laundrygo/api test -- src/access-control.test.ts`

Expected: FAIL because the access-control module does not exist.

- [ ] **Step 3: Add the local schema and pure authorization helpers**

Add Drizzle tables and equivalent SQLite `CREATE TABLE IF NOT EXISTS` statements for:

```text
stakeholder_identity(id, line_user_id unique, display_name, picture_url, status, created_at, updated_at)
stakeholder_access_request(id, identity_id, requested_at, resolved_at, resolution)
stakeholder_access(id, identity_id, tenant_id, role, status, approved_by_user_id, approved_at, revoked_at)
stakeholder_branch_scope(access_id, branch_id)
local_alert_rule(id, tenant_id, name, version, condition_json, cooldown_minutes, enabled)
local_alert_event(id, rule_id, branch_id, machine_id, dedup_key unique, evidence_json, detected_at, acknowledged_at, acknowledged_by_identity_id)
local_audit_log(id, actor_kind, actor_id, action, target_kind, target_id, metadata_json, created_at)
```

Implement the pure helper API exactly:

```ts
export type StakeholderRole = 'owner' | 'manager' | 'technician';
export interface AuthorizedScope { tenantId: string; role: StakeholderRole; branchIds: string[]; }
export function isBranchAllowed(scope: AuthorizedScope, branchId: string): boolean;
export function assertRoleCanReadRevenue(role: StakeholderRole): void;
```

- [ ] **Step 4: Run the access-control test to verify it passes**

Run: `pnpm --filter @laundrygo/api test -- src/access-control.test.ts`

Expected: PASS.

- [ ] **Step 5: Run static verification**

Run: `pnpm --filter @laundrygo/api check`

Expected: exit `0`.

### Task 3: Implement LIFF stakeholder session exchange and local approval state

**Files:**
- Modify: `apps/api/package.json`
- Modify: `apps/api/src/config.ts`
- Create: `apps/api/src/liff-auth.ts`
- Create: `apps/api/src/liff-auth.test.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `.env.example`
- Modify: `deploy/.env.production.example`

**Interfaces:**
- Produces `verifyLineIdToken`, `createStakeholderSession`, `readStakeholderSession`, `requireStakeholderScope`, and `POST /api/liff/session`.
- Consumes `LINE_CHANNEL_ID` and `STAKEHOLDER_SESSION_SECRET`; it does not use a LINE Messaging API access token.

- [ ] **Step 1: Write failing LIFF verification and pending-state tests**

```ts
// apps/api/src/liff-auth.test.ts
import { describe, expect, it, vi } from 'vitest';
import { resolveStakeholderLogin } from './liff-auth';

describe('LIFF stakeholder login', () => {
  it('creates a pending request but no session for an unknown verified LINE subject', async () => {
    const result = await resolveStakeholderLogin(
      { sub: 'U123', name: 'Pending user', picture: null },
      mockPendingStore(),
    );
    expect(result).toEqual({ status: 'pending' });
  });

  it('returns the approved scope only for an active access record', async () => {
    const result = await resolveStakeholderLogin(
      { sub: 'U456', name: 'Owner', picture: null },
      mockApprovedStore({ role: 'owner', tenantId: 'tenant-a', branchIds: [] }),
    );
    expect(result).toMatchObject({ status: 'active', scope: { role: 'owner' } });
  });
});
```

- [ ] **Step 2: Run the LIFF test to verify it fails**

Run: `pnpm --filter @laundrygo/api test -- src/liff-auth.test.ts`

Expected: FAIL because the LIFF authentication module does not exist.

- [ ] **Step 3: Add the verified exchange and HttpOnly stakeholder session**

Add `jose` and `zod` dependencies. Verify the ID token by POSTing it to LINE's token verification endpoint with the configured `LINE_CHANNEL_ID`; reject a missing subject, audience mismatch, expiry failure, or non-success response.

Implement these route results:

```text
POST /api/liff/session { idToken }
200 { status: "active", actor: { displayName, role, branchIds } } plus __Host-laundrygo-stakeholder cookie
202 { status: "pending" } with no session cookie
403 { error: "ACCESS_REVOKED" } with no session cookie
401 { error: "INVALID_LIFF_TOKEN" } with no session cookie
```

Use a five-minute HS256 JWT containing only `identityId`, `tenantId`, `role`, and `branchIds`; store it in a `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` cookie. `requireStakeholderScope` verifies signature and expiry on every stakeholder data route.

Add documented empty variables:

```text
LINE_CHANNEL_ID=
STAKEHOLDER_SESSION_SECRET=
IRIS_READ_BASE_URL=
IRIS_LAUNDRYGO_READ_API_KEY=
```

- [ ] **Step 4: Run the LIFF test to verify it passes**

Run: `pnpm --filter @laundrygo/api test -- src/liff-auth.test.ts`

Expected: PASS; unknown users receive pending state and only active records produce a session.

- [ ] **Step 5: Run static verification**

Run: `pnpm --filter @laundrygo/api check`

Expected: exit `0`.

### Task 4: Add local administrator approval and revocation routes

**Files:**
- Create: `apps/api/src/admin-access.ts`
- Create: `apps/api/src/admin-access.test.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces `requireLocalAdmin`, `POST /api/admin/access/:identityId/approve`, `POST /api/admin/access/:identityId/revoke`, and `GET /api/admin/access-requests`.
- Consumes a Better Auth session and `LOCAL_ADMIN_EMAILS` bootstrap allowlist.

- [ ] **Step 1: Write failing administrator-boundary tests**

```ts
// apps/api/src/admin-access.test.ts
import { describe, expect, it } from 'vitest';
import { approveAccessInputSchema, canAdministerAccess } from './admin-access';

describe('local access administration', () => {
  it('rejects an administrator approval without a tenant, role, and branch scope for manager', () => {
    expect(() => approveAccessInputSchema.parse({ role: 'manager', tenantId: 't1', branchIds: [] })).toThrow();
  });

  it('allows only configured local administrators to manage access', () => {
    expect(canAdministerAccess('admin@example.test', new Set(['admin@example.test']))).toBe(true);
    expect(canAdministerAccess('staff@example.test', new Set(['admin@example.test']))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the administrator test to verify it fails**

Run: `pnpm --filter @laundrygo/api test -- src/admin-access.test.ts`

Expected: FAIL because the access administration module does not exist.

- [ ] **Step 3: Implement approval, scope replacement, revocation, and audit writes**

Validate the exact payload below and reject technicians or managers with no branch scope. Owners receive an empty branch list to mean every branch in the configured tenant.

```ts
{
  tenantId: z.string().min(1),
  role: z.enum(['owner', 'manager', 'technician']),
  branchIds: z.array(z.string().uuid()).max(100),
}
```

`approve` upserts a single active `stakeholder_access`, replaces its branch scopes atomically, resolves the pending request, and appends `access.approved` to `local_audit_log`. `revoke` marks the access revoked, clears the branch scope rows, and appends `access.revoked`. Both routes require a valid Better Auth session whose email is in `LOCAL_ADMIN_EMAILS`.

- [ ] **Step 4: Run the administrator test to verify it passes**

Run: `pnpm --filter @laundrygo/api test -- src/admin-access.test.ts`

Expected: PASS.

- [ ] **Step 5: Run API verification**

Run: `pnpm --filter @laundrygo/api test && pnpm --filter @laundrygo/api check`

Expected: both commands exit `0`.

### Task 5: Add the validated IRIS adapter and scoped dashboard API

**Files:**
- Create: `apps/api/src/iris-read-contract.ts`
- Create: `apps/api/src/iris-read-client.ts`
- Create: `apps/api/src/iris-read-client.test.ts`
- Create: `apps/api/src/dashboard-service.ts`
- Create: `apps/api/src/dashboard-service.test.ts`
- Modify: `apps/api/src/index.ts`

**Interfaces:**
- Produces `IrisReadClient`, `getDashboard(scope, query)`, `getLiveBranch(scope, branchId)`, `getAlerts(scope, query)`, and `getEvents(scope, query)`.
- Consumes only `IRIS_READ_BASE_URL` and `IRIS_LAUNDRYGO_READ_API_KEY` on the server.

- [ ] **Step 1: Write failing contract-validation and local-scope tests**

```ts
// apps/api/src/dashboard-service.test.ts
import { describe, expect, it } from 'vitest';
import { filterBranchesForScope } from './dashboard-service';

describe('dashboard scope filtering', () => {
  const branches = [{ id: 'b1' }, { id: 'b2' }];
  it('keeps all branches for owners', () => {
    expect(filterBranchesForScope(branches, { tenantId: 't1', role: 'owner', branchIds: [] })).toEqual(branches);
  });
  it('removes unapproved branches for managers', () => {
    expect(filterBranchesForScope(branches, { tenantId: 't1', role: 'manager', branchIds: ['b1'] })).toEqual([{ id: 'b1' }]);
  });
});
```

- [ ] **Step 2: Run the adapter tests to verify they fail**

Run: `pnpm --filter @laundrygo/api test -- src/iris-read-client.test.ts src/dashboard-service.test.ts`

Expected: FAIL because neither adapter nor dashboard service exists.

- [ ] **Step 3: Implement strict IRIS response parsing and data routes**

Define Zod response envelopes requiring `contractVersion`, `source`, and `fetchedAt`. Reject an unknown contract version, malformed timestamp, or response without a branch/machine identifier with `502 IRIS_CONTRACT_INVALID`; never render partial unvalidated data.

Use this client shape:

```ts
export interface IrisReadClient {
  branches(): Promise<IrisBranchesResponse>;
  dashboard(query: IrisRangeQuery): Promise<IrisDashboardResponse>;
  live(branchId: string): Promise<IrisLiveResponse>;
  alerts(query: IrisRangeQuery): Promise<IrisAlertsResponse>;
  events(query: IrisEventQuery): Promise<IrisEventsResponse>;
}
```

Add stakeholder-gated routes:

```text
GET /api/dashboard?from=<ISO>&to=<ISO>&branchId=<UUID?>
GET /api/branches
GET /api/branches/:branchId/live
GET /api/alerts?from=<ISO>&to=<ISO>&branchId=<UUID?>
GET /api/events?from=<ISO>&to=<ISO>&branchId=<UUID?>
```

Call `requireStakeholderScope` first, reject an unapproved branch before calling IRIS, then apply `filterBranchesForScope` to every IRIS response as defense in depth. Add `Cache-Control: no-store` to all stakeholder responses.

- [ ] **Step 4: Run the adapter tests to verify they pass**

Run: `pnpm --filter @laundrygo/api test -- src/iris-read-client.test.ts src/dashboard-service.test.ts`

Expected: PASS; malformed contract data is rejected and local branch scope cannot be bypassed.

- [ ] **Step 5: Run API verification**

Run: `pnpm --filter @laundrygo/api test && pnpm --filter @laundrygo/api check`

Expected: both commands exit `0`.

### Task 6: Add bounded SSE fan-out, local reporting alerts, and safe summary tools

**Files:**
- Create: `apps/api/src/live-stream.ts`
- Create: `apps/api/src/live-stream.test.ts`
- Create: `apps/api/src/local-alerts.ts`
- Create: `apps/api/src/local-alerts.test.ts`
- Create: `apps/api/src/executive-summary.ts`
- Create: `apps/api/src/executive-summary.test.ts`
- Modify: `apps/api/src/index.ts`

**Interfaces:**
- Produces `GET /api/branches/:branchId/live/stream`, `GET /api/summary?from=<ISO>&to=<ISO>&branchId=<UUID?>`, `evaluateLocalAlert`, and `buildExecutiveSummary`.
- Consumes `IrisReadClient` from Task 5 and only normalized, validated input.

- [ ] **Step 1: Write failing alert and summary safety tests**

```ts
// apps/api/src/local-alerts.test.ts
import { describe, expect, it } from 'vitest';
import { alertDedupKey, evaluateLocalAlert } from './local-alerts';

describe('local reporting alerts', () => {
  it('deduplicates the same rule, branch, machine, and cooldown window', () => {
    expect(alertDedupKey('rule-1', 'branch-1', 'machine-1', '2026-07-17T10:00:00.000Z'))
      .toBe(alertDedupKey('rule-1', 'branch-1', 'machine-1', '2026-07-17T10:00:00.000Z'));
  });
  it('does not treat missing gas pressure as a safe gas reading', () => {
    expect(evaluateLocalAlert(gasRule(), { gasPressure: null, gasLeakDetected: null })).toEqual({ kind: 'unavailable' });
  });
});

// apps/api/src/executive-summary.test.ts
it('builds the fallback only from allowlisted aggregate facts', async () => {
  const result = await buildExecutiveSummary(allowlistedFacts());
  expect(result.source).toBe('deterministic');
  expect(result.text).not.toContain('SELECT');
  expect(result.text).not.toContain('lineUserId');
});
```

- [ ] **Step 2: Run the safety tests to verify they fail**

Run: `pnpm --filter @laundrygo/api test -- src/local-alerts.test.ts src/executive-summary.test.ts src/live-stream.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement bounded server-side updates and allowlisted summaries**

Use `streamSSE` from Hono to emit a `snapshot` event immediately and at most one `update` every five seconds. Stop polling when the response abort signal fires. The stream route requires the stakeholder scope and an allowed branch before it calls `IrisReadClient.live`.

Implement local alert deduplication with the unique `dedup_key`; record evidence JSON, rule id, version, source event time, and acknowledgement audit. Return `unavailable` for missing gas or coin-box inputs; never produce an all-clear alert from absent coverage.

Implement exactly these summary tools: `getKpi`, `getBranchComparison`, `getAlertCounts`, and `getDataCoverage`. Compose their inputs only from the validated dashboard, alert, and live responses already exposed by Task 5; `buildExecutiveSummary` accepts the four tool outputs only. The stakeholder-gated `/api/summary` route returns a deterministic Thai summary until a future configured provider is added; no model invocation, SQL string, telemetry record, LINE subject, or arbitrary URL is accepted as input.

- [ ] **Step 4: Run the safety tests to verify they pass**

Run: `pnpm --filter @laundrygo/api test -- src/local-alerts.test.ts src/executive-summary.test.ts src/live-stream.test.ts`

Expected: PASS; missing telemetry is unavailable, duplicate rules do not create duplicate events, and the summary sees aggregate facts only.

- [ ] **Step 5: Run API verification**

Run: `pnpm --filter @laundrygo/api test && pnpm --filter @laundrygo/api check`

Expected: both commands exit `0`.

### Task 7: Replace the demo UI with LIFF access states and real-data cards

**Files:**
- Create: `apps/web/src/api.ts`
- Create: `apps/web/src/dashboard-types.ts`
- Create: `apps/web/src/hooks/use-liff-session.ts`
- Create: `apps/web/src/components/access-state.tsx`
- Create: `apps/web/src/components/freshness-badge.tsx`
- Create: `apps/web/src/components/machine-card.tsx`
- Create: `apps/web/src/components/alert-list.tsx`
- Create: `apps/web/src/components/executive-summary.tsx`
- Create: `apps/web/src/components/admin-access.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/liff.ts`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes same-origin LaundryGo APIs from Tasks 3–6.
- Produces a phone-first page with `pending`, `revoked`, `integration unavailable`, `stale`, `unavailable`, and `active` states.

- [ ] **Step 1: Write failing pure rendering tests**

```ts
// apps/web/src/components/freshness-badge.test.ts
import { describe, expect, it } from 'vitest';
import { freshnessLabel } from './freshness-badge';

describe('freshness labels', () => {
  it('never labels unavailable data as live', () => {
    expect(freshnessLabel({ freshness: 'unavailable', lastSeen: null })).toBe('Source unavailable');
  });
});
```

- [ ] **Step 2: Run the web test to verify it fails**

Run: `pnpm --filter @laundrygo/web test -- src/components/freshness-badge.test.ts`

Expected: FAIL because the component helper does not exist.

- [ ] **Step 3: Implement LIFF bootstrap and truthful data UI**

Make `connectLiff` return `{ idToken, profile }` only after `liff.init` and login. On first render, post the ID token to `/api/liff/session`; render the pending screen if the response is `202`, the access-denied screen for `403`, and the dashboard only after an active session.

The dashboard fetches `/api/branches`, `/api/dashboard`, `/api/alerts`, `/api/summary`, and the selected `/api/branches/:id/live`. Connect to `/api/branches/:id/live/stream` with `EventSource`; on stream error, close it and refresh REST data every 30 seconds. Render every machine with state, remaining time, optional temperature, door status, source, event timestamp, register map version, and the explicit freshness badge. Render absent gas or coin-box coverage as `Source unavailable`.

Move the existing Better Auth account controls into a minimal `/mange` screen rather than leaving them in the stakeholder dashboard. That screen lists pending requests and uses the Task 4 approval/revocation routes; it must not display telemetry or revenue. Remove the demo estimate label, fixed branch label, and static `Live` badge. Keep HeroUI cards and mobile-first layout, with a single column at phone widths and horizontally scrollable report tables only above the card view.

- [ ] **Step 4: Run the web test to verify it passes**

Run: `pnpm --filter @laundrygo/web test -- src/components/freshness-badge.test.ts && pnpm --filter @laundrygo/web check`

Expected: both commands exit `0`.

- [ ] **Step 5: Build the production client**

Run: `pnpm --filter @laundrygo/web build`

Expected: Vite exits `0` and produces `apps/web/dist`.

### Task 8: Add mobile integration coverage and update the deployment runbook

**Files:**
- Create: `apps/web/playwright.config.ts`
- Create: `apps/web/e2e/stakeholder-dashboard.spec.ts`
- Modify: `apps/web/package.json`
- Modify: `README.md`
- Modify: `deploy/.env.production.example`

**Interfaces:**
- Produces `pnpm --filter @laundrygo/web test:e2e`.
- Uses a local mock LaundryGo API fixture, not an IRIS production URL.

- [ ] **Step 1: Write the phone-viewport E2E scenario**

```ts
// apps/web/e2e/stakeholder-dashboard.spec.ts
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

test('shows real-source metadata and unavailable sensor coverage without demo values', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Source unavailable')).toBeVisible();
  await expect(page.getByText('Last update')).toBeVisible();
  await expect(page.getByText('฿1,840')).toHaveCount(0);
  await expect(page.getByText('Live', { exact: true })).toHaveCount(0);
});
```

- [ ] **Step 2: Run the E2E test to verify it fails before the fixture is configured**

Run: `pnpm --filter @laundrygo/web test:e2e -- stakeholder-dashboard.spec.ts`

Expected: FAIL until the local mock API and Playwright web server are configured.

- [ ] **Step 3: Configure a local contract fixture and Playwright web server**

Add `@playwright/test`, a `test:e2e` script, and a Vite preview web server command. Configure the Playwright server with `VITE_LIFF_TEST_MODE=true`; only in that explicit test build, `connectLiff` returns a fixed non-production ID token. In the scenario, intercept `/api/liff/session` with an active stakeholder response and intercept the same-origin LaundryGo `/api/branches`, `/api/dashboard`, `/api/alerts`, `/api/summary`, and live endpoints with valid non-sensitive contract fixtures. The fixtures must include one fresh running machine, one stale machine, and one machine without gas coverage. They must not contain production machine, customer, LINE, or payment identifiers. The Node API is never started and the browser never calls IRIS in this test.

Update the README with exact local setup, required production variable names, approval flow, non-goals, health checks, backup path, and the statement that deployment requires a configured IRIS read credential. Do not add secrets or real endpoint values.

- [ ] **Step 4: Run the complete local verification gate**

Run: `pnpm test && pnpm check && pnpm build && pnpm --filter @laundrygo/web test:e2e`

Expected: all commands exit `0`.

- [ ] **Step 5: Review the final diff and runtime boundary**

Run: `rg -n '1840|seedDemoData|demo-only estimate|IRIS_LAUNDRYGO_READ_API_KEY' apps README.md deploy .env.example`

Expected: no fixed demo data remains; the integration key appears only in server-side environment templates and never in `apps/web`.
