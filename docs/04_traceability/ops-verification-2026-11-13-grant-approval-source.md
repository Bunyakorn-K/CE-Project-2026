# Approving an access request said the warehouse was down

**Date:** 2026-11-13
**Commit:** `d5f613a` · image `laundrytwin:deploy-d5f613a-20261113`
**Status:** fixed and deployed; the pending request is untouched and can now be approved.

## Symptom

Tapping "อนุมัติคำขอ" in `/admin` answered, for every branch and every time:

> อนุมัติคำขอไม่สำเร็จ: ยังไม่ได้เชื่อมต่อแหล่งข้อมูลรายงาน กรุณาติดต่อผู้ดูแลระบบ

The branch select right beside the button was populated with real branches from the
warehouse, so the page was visibly connected while the action reported it was not.

## Cause

`validateGrantScope` checked the chosen `branchId` against **IRIS** unconditionally:

```ts
const branches = await iris.getBranches();
```

This deployment is ClickHouse-only — `IRIS_READ_BASE_URL` is not set (§ verified with
`printenv`, empty) — so `iris.getBranches()` throws, `irisError` maps it to
`ANALYTICS_SOURCE_UNAVAILABLE`, and the browser renders that code's Thai copy. A
validation the caller could never satisfy was reported as an outage, which is the same
class of defect as the malformed-cursor 502: the wrong party is told to fix it.

## Fix

The branch is validated against the same source the admin page's branch picker used —
the rule `/api/report/branches` already applies:

```ts
const clickhouseFirst = isDevelopmentAuthBypassEnabled() || (!isDemoModeEnabled() && !isIrisReadConfigured());
if (clickhouseFirst) { /* queryBranches(clickhouse, branchId) */ } else { /* iris.getBranches() */ }
```

An unknown branch is still `400 UNKNOWN_BRANCH`, which names what the caller got wrong.

## Why the tests did not catch it

The grant tests stubbed `irisClient` and nothing else, so they exercised the branch the
deployment does not take. They now wire both sources, and two cases cover the production
shape:

- `approves a pending request on a warehouse-only deployment` → 200
- `still refuses a branch the warehouse does not have` → 400 `UNKNOWN_BRANCH`

## Evidence

```text
production IRIS_READ_BASE_URL          (absent)  -> the ClickHouse branch is taken
the selected branch through the app SQL
  dim_branch FINAL, active = 1, id = e118c081…  -> about you.wash & dry แม่โจ้ - ตลาดโซนเหลือง
pending request                         18867f2d… (LINE bot user) approved_at = null
805 API / 330 web / 117 ETL · build 0 · check 0
image laundrytwin:deploy-d5f613a-20261113 · health 200
```

The approval itself was **not** performed here: it needs an owner session, and granting
access is not something to do on someone's behalf. The pending request is still pending.

---

# The approval worked, and now it is announced

**Commit:** `43fa79f` · image `laundrytwin:deploy-43fa79f-20261113`

## The previous fix is confirmed against the real request

The request in the screenshot was approved after `d5f613a` was deployed:

```text
liff_access_request  U3c32ee294f24266a63ffe0cb354dc9de  ("LINE bot user")
                     requested_at 1794557754982 → approved_at 1794558473038
access_grant         role manager · branch 5e9611c1… (about you.wash & dry แม่โจ้ - หลิ่งมื่น)
                     user "LINE bot user" <line-U3c32ee…@liff.local>
```

That is the end-to-end proof the branch validation now passes on a ClickHouse-only
deployment — the route that answered 503 answered 200 and wrote the grant.

## Announcing it

Approval used to be silent. It happens on a screen the requester cannot see, so the
request merely stopped being pending and the person who was told "รอผู้ดูแลอนุมัติ" had
no way to learn it was granted, or for what.

`notifyAccessApproved` pushes one message naming the role and the branch and the two
things to type first. Properties that matter:

| property | why |
|---|---|
| recorded in `alert_notification` as `access:<requestId>` | it is a real push, so it is counted against the same 300/month allowance (36 used this month) |
| never throws | the grant is already written; a refused notice must not read as a failed approval |
| unique index on (alert id, line user) | the same approval cannot be announced twice |
| `skipped` with no row when no token | an unconfigured deployment must not claim it sent something |

The route answers `notified: sent | failed | skipped` and the admin page says which of
the three happened, so "approved" and "approved and told" are different sentences.

```text
812 API / 330 web / 117 ETL · build 0 · check 0
image laundrytwin:deploy-43fa79f-20261113 · health 200 · LINE token present in container
```

**Not yet observed live:** this deploy landed after the last approval, so no notice has
been sent in production. The send path is the same LINE client the bot answers with
every day, and the wiring is covered by the route test; the next approval is what
confirms it end to end.
