# Two branches, one readable button

**Date:** 2026-11-13
**Commits:** `e16316b` (labels), `c94aa83` (never invert a negation)
**Image:** `laundrytwin:deploy-c94aa83-20261113`

## The defect, from a real phone

The branch picker rendered two buttons reading **"about you.wash & dry"**, and a third
cut off. The tap carried the right branch id, so the flow worked; choosing between the
branches did not.

Cause: the picker passed `branch.branchName` as the quick-reply label and the adapter cut
it at LINE's 20-character limit (`label.slice(0, 20)`). Branches of one franchise share a
prefix, so the cut landed in exactly the part that is identical for all of them:

```text
about you.wash & dry แม่โจ้ - ตลาดโซนเหลือง   →  "about you.wash & dry"
about you.wash & dry แม่โจ้ - หลิ่งมื่น        →  "about you.wash & dry"
```

## The fix

`shortBranchLabel` builds the label from the **end**, where the distinguishing words are:
the last `" - "`-delimited segment, cut from the left with an ellipsis if it is still too
long. `shortBranchLabels` widens one segment at a time only until the labels are distinct,
and numbers identical names rather than leaving two buttons with the same text. The value
sent back is still the real branch id — only the label is shortened.

Both pickers use it: `branchScopeReplies` (the "which branch?" quick replies) and
`branchChoiceReplies` (`ตั้งสาขาประจำ`).

**Against the three branch names the warehouse actually holds:**

```text
SANDBOX ทดสอบ (ไม่ใช่สาขาจริง) - อย่ารับงานลูกค้าที่นี่   →  "SANDBOX ทดสอบ…"
about you.wash & dry แม่โจ้ - ตลาดโซนเหลือง              →  "ตลาดโซนเหลือง"
about you.wash & dry แม่โจ้ - หลิ่งมื่น                   →  "หลิ่งมื่น"
```

## The second defect the fix created, caught before deploy

Trimming from the front turned the SANDBOX branch's label into `…รับงานลูกค้าที่นี่` —
the **opposite** of `อย่ารับงานลูกค้าที่นี่`. The negation is the first word, so any front
cut removes it, and Thai gives no space to cut at.

A label now falls back to the beginning of the name, at a word boundary, whenever the part
being shortened contains a negation. That gives `SANDBOX ทดสอบ…`: vague, but not a lie.

The general rule: **a truncation rule has to ask what the cut removes, not only how long
the result is.** Length was the visible symptom; meaning was the actual constraint.

## Verified

```text
tests    10 on the label builder — tail kept, left cut, colliding tails widened,
         identical names numbered, never over LINE's 20, the negation case, and the
         three real production names
         852 API / 335 web / 117 ETL · build 0 · check 0
deployed image laundrytwin:deploy-c94aa83-20261113 · 0 restarts · health 200
live     sent "ลืมสาขาประจำ" then "ภาพรวมวันนี้เป็นยังไง" as the owner; the bot held the
         question (chat_pending), which only the picker path does — so the picker fired
         against production branches
```

**Not verified from here:** the rendered buttons. The reply travels to LINE and the bot
does not store outbound quick-reply labels, so the labels in the screenshot above are the
function's output over the measured branch names, not a screenshot of the result.

## Still available, if the tail rule is not enough

The owner asked for either trimming or a **custom label per branch**. Trimming ships
today because it needs no schema. A custom label would be the real answer for a branch
whose name refuses to shorten — an operator-entered `short_name` in a small table, read by
`branchScopeReplies` with the tail rule as fallback. Not built: it is a schema change, an
admin field, and a migration, and the tail rule covers every branch the warehouse holds.
