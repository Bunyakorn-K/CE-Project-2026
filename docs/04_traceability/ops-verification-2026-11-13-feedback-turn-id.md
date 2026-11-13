# The thumbs pointed at a turn that did not exist

**Date:** 2026-11-13
**Commit:** `a59025e` · image `laundrytwin:deploy-a59025e-20261113`

## The symptom, from the phone

Tapping **"มีประโยชน์"** on a card that had been delivered 2 h 14 min earlier answered:

> ให้คะแนนคำตอบนี้ไม่ได้ (ไม่พบคำตอบ หรือไม่ใช่คำตอบของคุณ)

## The cause: two ids for one answer

`conversation.ts` makes a `turnId` and hands it to the card, whose buttons carry
`fb:up:<turnId>`. `recordFeedback` then resolves that id against `chat_turn` — and
`appendTurn` was generating **its own** `randomUUID()` for the row. So the button pointed
at an id nothing had ever stored, and every tap could only report "not found".

The row existed. The card existed. They disagreed about the id.

## Why no test caught it

Every layer was green, and each was tested in isolation:

| layer | test | what it used |
|---|---|---|
| payload parser | `parsePostbackData("fb:up:<uuid>")` | a literal uuid |
| card builder | `buildAnswerFlex(..., { feedbackFor: "turn-123" })` | `turn-123`, a string that cannot collide with a row |
| store | `recordFeedback({ turnId, lineUserId })` | a turn inserted by the test itself |

The join — *does the id on the card exist in the transcript?* — was nobody's subject. The
fixture `turn-123` guaranteed it could not be noticed: it names a turn that cannot exist,
and nothing asserted that it should.

## The fix

`appendTurn` accepts the caller's id (`id?: string`), and the bot passes the id it already
put on the card. One id, generated once.

The new test closes the seam: send a message, read the turn id **back out of the delivered
card**, and tap it. Against the old code it fails with
`expected [ Array(1) ] to include '13ae3031-…'` — the card's id against the transcript's.

## Verified

```text
853 API / 335 web / 117 ETL · build 0 · check 0
image laundrytwin:deploy-a59025e-20261113 · 0 restarts · health 200
sent "สาขาหลิ่งมื่น ภาพรวมวันนี้" → new card
     chat_turn 147b9b13-ffea-4c0e-9d5a-c57c79b1bc99 · card · 2026-11-13T12:57:33Z
```

**Not yet observed:** a real tap on a card produced after the deploy. The tap needs the
phone, and the row it would write is the check — `chat_feedback` should gain a row whose
`turn_id` is present in `chat_turn`, which is exactly what the two older rows are not:

```text
chat_feedback (before this deploy)
  03e71eb0-… up   2026-11-11T08:40Z   → no chat_turn row with this id
  79c4fe4d-… up   2026-11-11T10:06Z   → no chat_turn row with this id
```

Those two were recorded when the ids still agreed, which is what makes the regression a
regression rather than a feature that never worked — and they are worth knowing about,
because a rating whose turn is gone cannot be joined to the answer it rated.
