# A name instead of "LINE bot user", and a grant you can correct

**Date:** 2026-11-13
**Commit:** `bc2bcdd` · image `laundrytwin:deploy-bc2bcdd-20261113`
**Image id:** `sha256:7f72ff0c54d1bbd52f8d80cc04687c0f1a5be1d186b841260fbb57c950079ef3`

## 1. The requester's name was the bot's

Every pending request in `/admin` read **"LINE bot user"**, and the account approval
created kept that name. The cause was one line:

```ts
displayName: event.source?.displayName ?? "LINE bot user"
```

`displayName` is a **LIFF profile** field. On a Messaging API message event, `source`
carries a `userId` and nothing else, so the left side was always `undefined` and the
fallback always won. Two requests from two different people were indistinguishable, and
the fallback named the account after the bot.

**Fix:** ask the Messaging API. The person messaged the bot, so a 1:1 profile exists.
`lineProfileLookup` calls `getProfile`, time-boxed at 2.5 s and returning `null` on any
failure — no token, a timeout, a revoked account, LINE down. Callers keep their own
fallback, and the fallback is now `ไม่ทราบชื่อ (LINE)`: a name an operator can act on,
unlike one that reads like the bot asking for access.

### Accounts already named that way repair themselves

Two paths see a real name, and both write it back through `updateLiffDisplayName`, which
updates `liff_identity.display_name` and `user.name` together:

| path | when |
|---|---|
| a bot message from a known user | only while the stored name is still a placeholder, so the cost is one lookup, once |
| every LIFF sign-in | the ID token's `displayName`, already verified by LINE server-side |

**Measured on production, after the deploy:**

```text
before  [ {line: ด.ช.นน, user: ด.ช.นน},
          {line: LINE bot user, user: LINE bot user},      ← the approved manager
          {line: LINE bot user, user: LINE bot user} ]

sent a signed webhook as that manager (U3c32ee2…) asking "ภาพรวมสาขาวันนี้"

after   [ {line: ด.ช.นน, user: ด.ช.นน},
          {line: Oak, user: Oak},                          ← repaired from LINE
          {line: LINE bot user, user: LINE bot user} ]     ← not contacted since; repairs on next message or sign-in
```

The answer that turn produced was scoped to that manager's own branch
(`about you.wash & dry แม่โจ้ - หลิ่งมื่น`), so the lookup did not disturb identity
resolution.

## 2. A grant was write-once

Roles and branch scopes could only be corrected by revoking and creating another grant:
history lost, and the person has no access in between — for an ordinary event like a
manager changing shop.

`PATCH /api/admin/grants/:id` → `updateAccessGrant` changes the grant in place. It
refuses three cases, each for a different reason:

| refusal | cause |
|---|---|
| `not-found` | the grant is already revoked or does not exist (404) |
| `duplicate` | the account already holds that role for that branch (409) |
| `last-owner` | the change would leave the tenant with no owner (400 `LAST_OWNER`) |

An **unchanged** scope is a no-op: no write, and no audit entry claiming something
happened. A real change writes `access_grant.updated` with `from`/`to`, so the history
that used to be lost to a revoke-and-recreate is now a row.

`validateGrantScope` is shared with `POST`, so the role/branch rule (`owner` is
tenant-wide, `manager`/`technician` need exactly one branch) and the branch-exists check
cannot drift between creating and editing. The branch check is the ClickHouse-first one
fixed earlier today, which is why the editor reports `UNKNOWN_BRANCH` instead of a
warehouse outage.

`/admin` grows an editor per grant — in the phone card and as an inline row in the
desktop table. Its disabled state and its payload come from one pure function,
`buildGrantEdit`, for the same reason the create form's do: a form whose button rule
differs from its payload is how a form sends something it just refused.

## 3. What is verified, and what is not

Verified against production:

```text
image   laundrytwin:deploy-bc2bcdd-20261113 · 0 restarts · health 200
served  /assets/index-CRh3vq4h.js 200 (the chunk carrying "แก้ไขบทบาท")
API     PATCH /api/admin/grants/x  401 unauthenticated
        GET   /api/admin/grants    401 unauthenticated
bot     placeholder name repaired from LINE, answer scoped correctly (above)
```

**Not verified: the editor's live round trip.** Pressing แก้ไข and saving needs an owner
session, which a deploy token is not. Evidence for that path is 10 store tests, 5 route
tests and 5 decision tests, each written against a named failure — not a browser.

## 4. Deploy note: the container was removed before the image existed

Two mistakes, both mine, and the second only mattered because of the first.

1. **Wrong tag.** The release workflow builds `deploy-<sha>-<CI run id>`
   (`github.event.workflow_run.id` is the CI run that triggered it), not the *release*
   run's id. The manifest lookup 404'd, so the digest was empty.
2. **`docker rm -f` ran anyway**, on a shell with no `set -e` safety around the pull, and
   `compose up` then failed on an empty image reference. **The app was down** — two
   consecutive public checks answered 000 — until it was recreated from
   `laundrytwin:deploy-4aab158-20261113` a couple of minutes later.

The rule this re-learns, in the order it has to happen:

```text
1. pull the image by tag
2. verify it (bundle contains what you expect)
3. only then rm + up
```

Removing the old container is the point of no return; everything that can fail must fail
before it, not after.
