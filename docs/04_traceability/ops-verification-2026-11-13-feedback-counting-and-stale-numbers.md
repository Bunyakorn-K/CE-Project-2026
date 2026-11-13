# What a second tap means, and why the rated answer was stale

**Date:** 2026-11-13
**Commits:** `a59025e` (turn id), `908494e` (re-measure a numbers question)
**Image:** `laundrytwin:deploy-908494e-20261113`

## 1. The counting rule, measured

Asked after tapping "มีประโยชน์" twice and then "ไม่ตรงคำถาม": what does that count as?

The rule is one rating per answer:

| sequence on the same card | result |
|---|---|
| up, then up again | one row; the second tap answers `duplicate` and changes nothing |
| up, then down | **the row is replaced** — the later tap is read as a correction |
| down, then up | likewise; the last tap wins |

Measured in `chat_feedback` for the taps in question:

```text
2026-11-11T08:40:50Z  up    03e71eb0-…   no chat_turn row
2026-11-11T10:06:46Z  up    79c4fe4d-…   no chat_turn row
2026-11-13T12:59:50Z  down  147b9b13-…   chat_turn: "ภาพรวมวันนี้ (2026-11-13) สาขา about you…"
```

So the card was rated **one** time, as **ไม่ตรงคำถาม**. The two "มีประโยชน์" taps had been
on the same card and were overwritten by the correction — which is the intended behaviour,
because a second, different tap is a person changing their mind, not a second opinion.

Worth knowing: the console's scoreboard counts rows, so this card contributes `0 up / 1
down`. If a card should be allowed to be rated once and never changed, that is a different
product decision — the current one is "the last tap wins".

## 2. Why the answer deserved the down

The same turn, read back from the transcript:

```text
Q: สาขาหลิ่งมื่น ภาพรวมวันนี้
steps: 1   tool_calls: 0   scope_key: 5e9611c1… (หลิ่งมื่น)
A: ภาพรวมวันนี้ (2026-11-13) … รายได้ 3,040 บาท · 50 รอบ · 33.7 นาที
```

**One model step, zero tool calls.** The figures are the ones from the card delivered at
17:34 — 2.5 hours earlier. The transcript is in the prompt, so the previous answer's
numbers were read as this answer's evidence: memory was a source of *numbers*, not just of
intent. That is the same defect as the branch-scope one, one layer down.

This is the worst shape a wrong answer can have: it is well-formed, correctly scoped,
plausible, and unmeasured.

## 3. The fix

`needsFreshNumbers(text)` says whether the message asks for a measurement (generous on
purpose: a false positive costs one model call, a false negative ships stale numbers). When
such a question finishes with `toolCalls === 0`, the turn is asked once more with the reason
stated:

> คุณยังไม่ได้เรียกเครื่องมือในคำตอบนี้เลย — ตัวเลขที่ตอบไปแล้วในบทสนทนาก่อนหน้าเป็นของเวลา
> นั้น ไม่ใช่ของตอนนี้ … ถ้าผลออกมาเหมือนเดิม ก็ต้องเรียกเครื่องมือมายืนยันใหม่ ห้ามใช้ความจำ
> แทนการวัด

A greeting or a thank-you matches none of the terms, so "ขอบคุณครับ" is not re-measured.

## 4. Verified

```text
858 API / 335 web / 117 ETL · build 0 · check 0
image laundrytwin:deploy-908494e-20261113 · 0 restarts · health 200
```

Two fixtures had to become factories: they returned a single `Response` object, and a body
can be read once. The retry made a second request and the mock threw — a fixture built for
one call, meeting code that makes two.

**Not yet observed on production:** a numbers question whose first attempt calls no tool.
That needs the model to misbehave in the specific way it did at 19:57; the retry is covered
by the harness (two requests, the second carrying the instruction) rather than by a live
incident.
