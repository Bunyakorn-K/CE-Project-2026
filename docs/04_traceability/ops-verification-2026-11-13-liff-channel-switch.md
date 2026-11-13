# LIFF moved to a published LINE Login channel

**Date:** 2026-11-13
**Commit:** `4aab158` · image `laundrytwin:deploy-4aab158-20261113`
**Digest:** `sha256:06cfa874a80c5b900428f74956913ff8143b1f81bad430bf498b902d875e724e`

## Why

Every ordinary user hit LINE's own page before the app loaded:

> 400 Bad Request — This channel is now developing status. User need to have developer role.

The channel that owned the previous LIFF app (`2011592166-uToRdTwS`) was unpublished, so
only channel admins could sign in. A LIFF app inside an unpublished channel behaves the
same way, so this was never fixed by choosing a different SDK.

## What changed

| value | before | after |
|---|---|---|
| `LIFF_ID` | `2011592166-uToRdTwS` | `2011807354-DuoPfzrR` |
| `LINE_LOGIN_CHANNEL_IDS` | `2011592166,2011592167,2011592168` | `2011807354,2011592166,2011592167,2011592168` |
| `VITE_LIFF_ID` (CI secret) | `2011592166-uToRdTwS` | `2011807354-DuoPfzrR` |

The old channel id is **kept** in `LINE_LOGIN_CHANNEL_IDS` — the verifier accepts a
list, so a rollback does not need a second redeploy to re-open the old tokens.

`LINE_LOGIN_CHANNEL_IDS` is the part that would have been missed: it is the `client_id`
the server sends to `oauth2/v2.1/verify` (`apps/api/src/index.ts` → `verifyLiffIdToken`),
and nothing derives it from `LIFF_ID`. Updating only the LIFF id and the image would
publish, redirect, and then reject every token with `LIFF_VERIFICATION_FAILED` — a
sign-in failure that looks like a broken deployment.

## Evidence

Measured, in order:

```text
build before the secret was updated
  digest sha256:99e5e6fb…          ← identical to the deployed image
  bundle "2011592166-uToRdTwS" ×3  ← the build arg had not changed, so the cache
                                     returned the old layers: the secret was still old

build after the secret was updated
  digest sha256:06cfa874…          ← different
  bundle "2011807354-DuoPfzrR" ×3  ← new id baked in, old id absent

deployed image  laundrytwin:deploy-4aab158-20261113
  LIFF_ID=2011807354-DuoPfzrR
  LINE_LOGIN_CHANNEL_IDS=2011807354,2011592166,2011592167,2011592168
  health 200

public bundle (https://laundrytwin.duckdns.org)
  assets/index-D6pnF4YT.js → "2011807354-DuoPfzrR"

auth boundary unchanged
  GET  /api/me                     401
  POST /api/auth/liff/exchange     401 LIFF_VERIFICATION_FAILED  (bogus token)
  GET  /dashboard                  200 (SPA)
```

The identical digest before the secret changed is the useful half of this record: a
rebuild that "succeeds" is not evidence the build inputs changed, and grepping the
produced bundle for the expected id is what distinguishes the two.

## The rich menu was re-synced (owner click)

LINE cannot edit a menu, so a sync creates new menus, relinks users, and deletes the
old ones. Measured after the owner pressed "ซิงก์เมนูกับ LINE" at `/admin/line`:

```text
before                          after
richmenu-b8d…  manager:v3       richmenu-0d84ab7a…  owner:v3
richmenu-2ed…  owner:v3         richmenu-f0f3ad65…  manager:v3
richmenu-235…  technician:v3    richmenu-cf717fdf…  technician:v3
richmenu-e3e…  default:v3       richmenu-6477c992…  default:v3

every URI on every menu → liff.line.me/2011807354-DuoPfzrR/…
unwrap: GET /v2/bot/user/all/richmenu   → richmenu-6477c992… (default)
        U284d77f… (owner)               → richmenu-0d84ab7a…
        U3c32ee2… (manager, approved)   → richmenu-f0f3ad65…
sqlite  rich_menu: four rows, synced_at 1794561800626
```

The per-user links are the half worth checking: the default menu being right says
nothing about whether a manager is still pointed at the old panel.

## Channel map (measured on the console by the owner)

| channel | id | role |
|---|---|---|
| Messaging API (the bot) | `2011658980` | sends every message: alerts, digest, chat, approval notices |
| LINE Login + LIFF (new) | `2011807354` | identity: `2011807354-DuoPfzrR` |
| retired MINI App | `2011592166` | held the previous LIFF app; unpublished, so nobody could sign in |
| unknown | `2011592167`, `2011592168` | still in `LINE_LOGIN_CHANNEL_IDS`; nothing uses them |

The bot is a **different channel** from the retired one, which is what makes deleting
the MINI App safe — deleting the channel that owns `LINE_CHANNEL_ACCESS_TOKEN` would
stop every message in the product, not just sign-in.

**`LINE_LOGIN_CHANNEL_IDS` is a trust list, not a convenience list.** Every id in it is
a channel whose ID tokens this API will accept as an identity, so once the new channel is
proven, the list should narrow to `2011807354` alone. It is deliberately not narrowed in
this deploy: the rollback target is still the old channel, and narrowing before a live
sign-in has been measured trades a real recovery path for a theoretical one.

## Still outstanding

1. **A real sign-in on the new channel.** `/api/auth/liff/exchange` is proven wired and
   is now verifying against the new client id, but no live token has been traded since
   the switch. The check that closes it: open
   `https://liff.line.me/2011807354-DuoPfzrR/dashboard` on a phone that is **not** an
   admin of the channel, sign in, and confirm `/api/auth/liff/exchange` answers 200.
   Until that is done, "the channel is published" is the owner's statement, not a
   measurement from here.
