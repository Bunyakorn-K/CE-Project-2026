// A number is only true when it was measured for the question that asked it.
//
// Measured on production 2026-11-13: "สาขาหลิ่งมื่น ภาพรวมวันนี้" was answered in one
// model step with **zero tool calls**, and the figures were the ones from a card
// delivered 2.5 hours earlier. The transcript sits in the prompt as conversation
// memory, and the model treated the previous answer's numbers as this answer's
// evidence — the same failure the `scope_key` change fixed for branch scope, one layer
// down: memory was allowed to be a *source of numbers* rather than a source of intent.
//
// The answer looked right, which is the dangerous part. So a question that asks for a
// measurement is checked after the fact: no tool call means the numbers came from
// somewhere else, and the turn is retried once with that said out loud.

/** Words that mean the message asks about data rather than about the bot. */
const DATA_TERMS = [
  "รายได้",
  "กำไร",
  "ยอด",
  "รอบซัก",
  "รอบ",
  "กี่",
  "เท่าไหร่",
  "เท่าไร",
  "วันนี้",
  "เมื่อวาน",
  "เดือน",
  "สัปดาห์",
  "สัปดา",
  "ปี",
  "ภาพรวม",
  "สรุป",
  "เปรียบเทียบ",
  "สูงสุด",
  "ต่ำสุด",
  "เฉลี่ย",
  "เครื่อง",
  "สาขา",
  "อุณหภูมิ",
  "แจ้งเตือน",
  "ซ่อม",
  "ใช้งาน"
];

/**
 * Does this message ask for a number that has to come from a tool call?
 *
 * Deliberately generous: a false positive costs one extra model call on a turn that
 * did not need it, while a false negative ships yesterday's numbers as today's. A
 * greeting or a thank-you contains none of these words and returns false, because
 * "ขอบคุณครับ" has no figures to check.
 */
export function needsFreshNumbers(text: string): boolean {
  const normalised = text.trim().toLowerCase();
  if (normalised.length === 0) return false;
  return DATA_TERMS.some((term) => normalised.includes(term));
}

/**
 * The instruction added when a measured question came back with no measurement.
 *
 * It has to say *why*, not just "use a tool": a model that reused a number believed it
 * was being consistent with the conversation.
 */
export const FRESH_DATA_NUDGE = [
  "สำคัญ: คำถามนี้ต้องการตัวเลขที่วัดในรอบนี้",
  "คุณยังไม่ได้เรียกเครื่องมือในคำตอบนี้เลย — ตัวเลขที่ตอบไปแล้วในบทสนทนาก่อนหน้าเป็นของเวลานั้น ไม่ใช่ของตอนนี้",
  "ต้องเรียกเครื่องมืออย่างน้อยหนึ่งครั้งก่อนตอบ และใช้เฉพาะตัวเลขที่ได้จากการเรียกครั้งนี้",
  "ถ้าผลออกมาเหมือนเดิม ก็ต้องเรียกเครื่องมือมายืนยันใหม่ ห้ามใช้ความจำแทนการวัด"
].join("\n");
