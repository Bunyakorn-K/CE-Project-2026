# IRIS LaundryGo Read API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a versioned, tenant-scoped, read-only IRIS API that supplies real operational data to the standalone LaundryGo dashboard.

**Architecture:** The `iris-cloud` Hono Worker authenticates one server-to-server LaundryGo credential, binds it to exactly one configured tenant, and rejects all other tenant or branch access before querying data. It aggregates historical Postgres records, reads machine snapshots through the existing `STATE` service binding, and returns versioned DTOs that never expose commands, payments mutations, credentials, raw customer identity, or arbitrary SQL.

**Tech Stack:** Hono, Cloudflare Workers, TypeScript, Zod, Drizzle via `@iris/db`, Hyperdrive/Postgres, existing `STATE` service binding, Vitest.

## Global Constraints

- Work in a clean IRIS worktree branched from the current `origin/main`; do not edit `/Users/uunw/programming/meepian-projects/iris-project` directly.
- Read APIs authenticate only `X-LaundryGo-Read-Key`; the client key maps to `LAUNDRYGO_READ_TENANT_ID` and never accepts a tenant identifier from a request.
- Use `@iris/db` query helpers, never a direct `drizzle-orm` helper import.
- The Worker returns `503 READ_API_NOT_CONFIGURED` if either LaundryGo read secret is absent.
- The route exposes only `GET` and has no command, payment, telemetry-write, database, or MQTT endpoint.
- Live state comes through `env.STATE`; historical data comes from IRIS database projections. Do not give LaundryGo a `STATE` binding or database connection.
- Every payload includes `contractVersion: "2026-07-17"`, `source`, and `fetchedAt`; absent telemetry coverage is explicit rather than inferred.
- Do not set production secrets, deploy, migrate production data, or push a PR as part of this plan without a separate explicit request.

---

### Task 1: Define the public DTOs and read-client guard

**Files:**
- Create: `apps/cloud-workers/src/routes/laundrygo-read.contract.ts`
- Create: `apps/cloud-workers/src/routes/laundrygo-read.contract.test.ts`
- Create: `apps/cloud-workers/src/routes/laundrygo-read.ts`
- Modify: `apps/cloud-workers/src/env.d.ts`
- Modify: `apps/cloud-workers/src/index.ts`
- Modify: `apps/cloud-workers/wrangler.toml`

**Interfaces:**
- Produces `LAUNDRYGO_CONTRACT_VERSION`, `LaundryGoReadContext`, `requireLaundryGoReadContext`, `laundryGoError`, and Zod schemas consumed by `laundrygo-read.ts`.
- Consumes `Env` and `errorJson` from `src/lib/errors.ts`.

- [ ] **Step 1: Write failing guard and contract tests**

```ts
// apps/cloud-workers/src/routes/laundrygo-read.contract.test.ts
import { describe, expect, it } from 'vitest';
import { laundryGoReadRouter } from './laundrygo-read';
import type { Env } from '../env';

const env = {
  DATABASE_URL: 'postgres://test',
  LAUNDRYGO_READ_API_KEY: 'test-read-key',
  LAUNDRYGO_READ_TENANT_ID: '11111111-1111-1111-1111-111111111111',
} as Env;

describe('LaundryGo read-client guard', () => {
  it('rejects a missing client key before querying IRIS data', async () => {
    const response = await laundryGoReadRouter.fetch(
      new Request('https://example.test/v1/laundrygo/branches'),
      env,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'UNAUTHORIZED' });
  });

  it('returns 503 when the dedicated read integration is not configured', async () => {
    const response = await laundryGoReadRouter.fetch(
      new Request('https://example.test/v1/laundrygo/branches', {
        headers: { 'x-laundrygo-read-key': 'test-read-key' },
      }),
      {} as Env,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'READ_API_NOT_CONFIGURED' });
  });
});
```

- [ ] **Step 2: Run the guard test to verify it fails**

Run: `pnpm --filter @iris/cloud-workers test -- src/routes/laundrygo-read.contract.test.ts`

Expected: FAIL because `laundrygo-read` does not exist.

- [ ] **Step 3: Define the stable contract and constant-time guard**

```ts
// apps/cloud-workers/src/routes/laundrygo-read.contract.ts
import { z } from 'zod';
import type { Context } from 'hono';
import type { Env } from '../env';

export const LAUNDRYGO_CONTRACT_VERSION = '2026-07-17';
export const laundryGoRangeQuerySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  branchId: z.string().uuid().optional(),
});

export interface LaundryGoReadContext {
  tenantId: string;
}

export type LaundryGoReadAuthResult =
  | { ok: true; context: LaundryGoReadContext }
  | { ok: false; error: 'READ_API_NOT_CONFIGURED' | 'UNAUTHORIZED'; status: 401 | 503 };

export function requireLaundryGoReadContext(c: Context<{ Bindings: Env }>): LaundryGoReadAuthResult {
  const expected = c.env.LAUNDRYGO_READ_API_KEY;
  const tenantId = c.env.LAUNDRYGO_READ_TENANT_ID;
  if (!expected || !tenantId) return { ok: false, error: 'READ_API_NOT_CONFIGURED', status: 503 };
  const supplied = c.req.header('x-laundrygo-read-key') ?? '';
  if (supplied.length !== expected.length) return { ok: false, error: 'UNAUTHORIZED', status: 401 };
  let mismatch = 0;
  for (let index = 0; index < supplied.length; index += 1) {
    mismatch |= supplied.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return mismatch === 0
    ? { ok: true, context: { tenantId } }
    : { ok: false, error: 'UNAUTHORIZED', status: 401 };
}
```

Add these optional secrets to `Env`:

```ts
LAUNDRYGO_READ_API_KEY?: string;
LAUNDRYGO_READ_TENANT_ID?: string;
```

Create `laundrygo-read.ts` with a router-wide middleware that calls `requireLaundryGoReadContext`, returns the result's explicit error/status when `ok` is false, and saves the authenticated `tenantId` in Hono context for later resource handlers. Mount the router in `src/index.ts` with `app.route('/v1/laundrygo', laundryGoReadRouter)`. At this task it has no resources yet, so an authenticated request falls through to `404`. Add only commented secret documentation to `wrangler.toml`; never put values in the file.

- [ ] **Step 4: Run the guard test to verify it passes**

Run: `pnpm --filter @iris/cloud-workers test -- src/routes/laundrygo-read.contract.test.ts`

Expected: PASS; the unauthenticated request is `401` and the unconfigured request is `503`.

- [ ] **Step 5: Run focused static verification**

Run: `pnpm --filter @iris/cloud-workers check-types && pnpm --filter @iris/cloud-workers lint`

Expected: both commands exit `0`.

- [ ] **Step 6: Commit the isolated contract guard in the IRIS worktree**

```bash
git add apps/cloud-workers/src/routes/laundrygo-read.ts apps/cloud-workers/src/routes/laundrygo-read.contract.ts apps/cloud-workers/src/routes/laundrygo-read.contract.test.ts apps/cloud-workers/src/env.d.ts apps/cloud-workers/src/index.ts apps/cloud-workers/wrangler.toml
git commit -m "feat(cloud): add LaundryGo read API guard"
```

### Task 2: Serve tenant-scoped branches, KPI, and normalized alert evidence

**Files:**
- Modify: `apps/cloud-workers/src/routes/laundrygo-read.ts`
- Create: `apps/cloud-workers/src/routes/laundrygo-read.test.ts`
- Modify: `apps/cloud-workers/src/index.ts`

**Interfaces:**
- Consumes `LaundryGoReadContext`, `laundryGoRangeQuerySchema`, and `LAUNDRYGO_CONTRACT_VERSION` from Task 1.
- Produces these `GET` resources:
  - `/v1/laundrygo/branches`
  - `/v1/laundrygo/dashboard?from=<ISO>&to=<ISO>&branchId=<UUID?>`
  - `/v1/laundrygo/alerts?from=<ISO>&to=<ISO>&branchId=<UUID?>`
  - `/v1/laundrygo/events?from=<ISO>&to=<ISO>&branchId=<UUID?>&cursor=<ISO?>`

- [ ] **Step 1: Write failing tenant and aggregate tests**

```ts
// apps/cloud-workers/src/routes/laundrygo-read.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../lib/db', () => ({ getDb: vi.fn() }));
import { getDb } from '../lib/db';
import { laundryGoReadRouter } from './laundrygo-read';
import type { Env } from '../env';

const tenantId = '11111111-1111-1111-1111-111111111111';
const branchId = '22222222-2222-2222-2222-222222222222';
const env = {
  DATABASE_URL: 'postgres://test',
  LAUNDRYGO_READ_API_KEY: 'test-read-key',
  LAUNDRYGO_READ_TENANT_ID: tenantId,
} as Env;
const headers = { 'x-laundrygo-read-key': 'test-read-key' };

describe('LaundryGo dashboard read API', () => {
  beforeEach(() => vi.mocked(getDb).mockReset());

  it('returns only branches belonging to the credential tenant', async () => {
    vi.mocked(getDb).mockResolvedValue({
      select: vi.fn(() => ({ from: () => ({ where: async () => [{ id: branchId, tenantId, name: 'Rama II', timezone: 'Asia/Bangkok', status: 'active' }] }) })),
    } as never);
    const response = await laundryGoReadRouter.fetch(new Request('https://example.test/v1/laundrygo/branches', { headers }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ contractVersion: '2026-07-17', branches: [{ id: branchId }] });
  });

  it('returns 404 when a requested branch is outside the credential tenant', async () => {
    vi.mocked(getDb).mockResolvedValue({
      select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [] }) })),
    } as never);
    const response = await laundryGoReadRouter.fetch(new Request(`https://example.test/v1/laundrygo/dashboard?from=2026-07-01T00:00:00.000Z&to=2026-07-02T00:00:00.000Z&branchId=${branchId}`, { headers }), env);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'BRANCH_NOT_FOUND' });
  });
});
```

- [ ] **Step 2: Run the route test to verify it fails**

Run: `pnpm --filter @iris/cloud-workers test -- src/routes/laundrygo-read.test.ts`

Expected: FAIL because `laundryGoReadRouter` does not exist.

- [ ] **Step 3: Implement the read-only route with an explicit tenant predicate**

Use these helper signatures in `laundrygo-read.ts`:

```ts
async function requireBranchInTenant(db: Awaited<ReturnType<typeof getDb>>, tenantId: string, branchId: string): Promise<void>;
async function readDashboard(db: Awaited<ReturnType<typeof getDb>>, tenantId: string, range: { from: Date; to: Date; branchId?: string }): Promise<LaundryGoDashboard>;
async function readAlerts(db: Awaited<ReturnType<typeof getDb>>, tenantId: string, range: { from: Date; to: Date; branchId?: string }): Promise<LaundryGoAlert[]>;
async function readEvents(db: Awaited<ReturnType<typeof getDb>>, tenantId: string, range: { from: Date; to: Date; branchId?: string; cursor?: Date }): Promise<LaundryGoEventPage>;
```

Implement each query with `tenantId` as a mandatory predicate. For `branchId`, first call `requireBranchInTenant`; never merely append the branch filter. Calculate revenue from `payment.status = 'paid'`, `payment.paidAt` in range, and `payment.parentPaymentId IS NULL` so split-payment children are not double counted. Calculate cycles from non-cancelled `machineUsage` records in range. Calculate utilization as `min(1, totalCycleMinutes / availableMachineMinutes)` and return `null` when no machines exist.

Return alert rows with `ruleId`, `ruleUpdatedAt`, evidence metadata, and `ruleVersion: null` when the upstream alert rule has no version field. Return event `state` as an opaque normalized source snapshot plus `coverage` flags; do not reinterpret an absent field as a normal reading.

- [ ] **Step 4: Run the route tests to verify they pass**

Run: `pnpm --filter @iris/cloud-workers test -- src/routes/laundrygo-read.contract.test.ts src/routes/laundrygo-read.test.ts`

Expected: PASS; tests prove a credential cannot widen the tenant scope and all successful responses include the contract version.

- [ ] **Step 5: Run focused static verification**

Run: `pnpm --filter @iris/cloud-workers check-types && pnpm --filter @iris/cloud-workers lint`

Expected: both commands exit `0`.

- [ ] **Step 6: Commit the historical read model in the IRIS worktree**

```bash
git add apps/cloud-workers/src/routes/laundrygo-read.ts apps/cloud-workers/src/routes/laundrygo-read.test.ts apps/cloud-workers/src/index.ts
git commit -m "feat(cloud): expose tenant-scoped LaundryGo reporting data"
```

### Task 3: Add live-state projection without exposing the state service

**Files:**
- Modify: `apps/cloud-workers/src/routes/laundrygo-read.ts`
- Modify: `apps/cloud-workers/src/routes/laundrygo-read.test.ts`

**Interfaces:**
- Produces `GET /v1/laundrygo/branches/:branchId/live`.
- Consumes branch and machine metadata from `@iris/db` and `env.STATE` only inside the IRIS Worker.

- [ ] **Step 1: Write a failing live-state test**

```ts
it('projects live state through the IRIS service binding and marks unavailable state truthfully', async () => {
  const stateFetch = vi.fn(async (url: string) => {
    expect(url).toContain('/machines/WSH-001/state');
    return new Response(JSON.stringify({ phase: 'RUNNING', remaining_sec: 600, last_seen: '2026-07-17T10:00:00.000Z' }));
  });
  vi.mocked(getDb).mockResolvedValue(mockBranchWithWasherMachine() as never);
  const response = await laundryGoReadRouter.fetch(
    new Request(`https://example.test/v1/laundrygo/branches/${branchId}/live`, { headers }),
    { ...env, STATE: { fetch: stateFetch } } as Env,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ machines: [{ state: 'RUNNING', source: 'durable-object' }] });
});
```

- [ ] **Step 2: Run the live-state test to verify it fails**

Run: `pnpm --filter @iris/cloud-workers test -- src/routes/laundrygo-read.test.ts`

Expected: FAIL with `404` because the live route is absent.

- [ ] **Step 3: Implement bounded live-state reads**

Query only non-deleted machines belonging to the authenticated tenant and branch. Reuse `edgeMachineId` and `edgeMachineIdSqlExpr` already exported by `@iris/contracts` and covered by `packages/contracts/src/edge-machine-id.test.ts`; do not duplicate or relocate the mapping.

For each machine, call `env.STATE.fetch('https://do/machines/<piMachineId>/state')` with a 1.5 second timeout. A missing binding, failed request, invalid payload, or stale `last_seen` returns a machine record with `state: null`, `freshness: 'unavailable'`, and a reason. It does not fail the whole branch response and does not substitute legacy demo data.

- [ ] **Step 4: Run the live-state test to verify it passes**

Run: `pnpm --filter @iris/cloud-workers test -- src/routes/laundrygo-read.test.ts`

Expected: PASS; live state is projected through `STATE` and no binding remains in the response.

- [ ] **Step 5: Run the cloud-worker test suite**

Run: `pnpm --filter @iris/cloud-workers test && pnpm --filter @iris/cloud-workers check-types`

Expected: both commands exit `0`.

- [ ] **Step 6: Commit the live projection in the IRIS worktree**

```bash
git add apps/cloud-workers/src/routes/laundrygo-read.ts apps/cloud-workers/src/routes/laundrygo-read.test.ts
git commit -m "feat(cloud): add LaundryGo live machine projection"
```

### Task 4: Document and freeze the integration boundary

**Files:**
- Create: `docs/contracts/laundrygo-read-v1.md`
- Modify: `apps/cloud-workers/README.md`

**Interfaces:**
- Documents the exact HTTP headers, version, query parameters, response envelopes, error codes, source coverage rules, and prohibited operations used by the standalone consumer.

- [ ] **Step 1: Write the contract document before final verification**

Document these exact response rules:

```text
Header: X-LaundryGo-Read-Key
Success envelope: { contractVersion, source, fetchedAt, ...resource }
Errors: UNAUTHORIZED, READ_API_NOT_CONFIGURED, BRANCH_NOT_FOUND, INVALID_RANGE
Tenant: selected only from LAUNDRYGO_READ_TENANT_ID
Prohibited methods: POST, PUT, PATCH, DELETE
Unavailable sensor fields: null plus coverage.reason
```

- [ ] **Step 2: Add a source-level regression test for prohibited methods**

```ts
it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('rejects %s on every LaundryGo resource', async (method) => {
  const response = await laundryGoReadRouter.fetch(
    new Request('https://example.test/v1/laundrygo/branches', { method, headers }),
    env,
  );
  expect(response.status).toBe(404);
});
```

- [ ] **Step 3: Run the full verification gate**

Run: `pnpm --filter @iris/cloud-workers test && pnpm --filter @iris/cloud-workers check-types && pnpm --filter @iris/cloud-workers lint`

Expected: all commands exit `0`.

- [ ] **Step 4: Commit the contract documentation in the IRIS worktree**

```bash
git add docs/contracts/laundrygo-read-v1.md apps/cloud-workers/README.md apps/cloud-workers/src/routes/laundrygo-read.test.ts
git commit -m "docs(cloud): specify LaundryGo read integration"
```
