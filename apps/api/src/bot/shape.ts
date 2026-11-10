/**
 * Fitting an answer into the shape a chat message can carry.
 *
 * WHY. A model asked for an overview will happily return four hundred words, and
 * LINE shows that as a wall the reader scrolls past — or, past 5,000 characters,
 * refuses it outright. The card is the first message; anything long enough to need a
 * second one gets exactly one more, and then it stops.
 *
 * THE RULE THAT MATTERS: never cut a word in half. Thai has no spaces between words,
 * so the safe boundaries are a paragraph break, then a sentence end, then a space —
 * in that order. A split inside "เครื่องซักผ้า" is worse than a shorter answer.
 */

export const MAX_PART_CHARS = 900;
export const MAX_PARTS = 2;

export type ShapedAnswer = {
  parts: string[];
  /** True when the answer was longer than the two messages this chat will send. */
  truncated: boolean;
};

function hardSplit(text: string, limit: number): string[] {
  // Last resort: cut at the last space before the limit, and if there is none, at
  // the limit itself. A single 3,000-character token has no good boundary.
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const slice = rest.slice(0, limit);
    const space = slice.lastIndexOf(" ");
    const cut = space > limit * 0.6 ? space : limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * Split on paragraph breaks, then on sentence ends inside an oversized paragraph.
 * Each returned chunk is at most `limit` characters.
 */
function splitBlocks(paragraph: string, limit: number): string[] {
  if (paragraph.length <= limit) return [paragraph];

  // Sentence boundaries that exist in Thai and English answers.
  const sentences = paragraph.split(/(?<=[.!?。])\s+/);
  const out: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) out.push(current);
    if (sentence.length <= limit) {
      current = sentence;
    } else {
      out.push(...hardSplit(sentence, limit));
      current = "";
    }
  }
  if (current) out.push(current);
  return out;
}

export function shapeAnswer(text: string, limit = MAX_PART_CHARS, maxParts = MAX_PARTS): ShapedAnswer {
  const normalised = text.replace(/\r\n/g, "\n").trim();
  if (!normalised) return { parts: [], truncated: false };

  const blocks = normalised.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const chunks: string[] = [];

  for (const block of blocks) {
    if (chunks.length === 0) {
      chunks.push(...splitBlocks(block, limit));
      continue;
    }
    // A block that still fits the last chunk is joined to it, so a bullet list is
    // not split across two messages for no reason.
    const last = chunks[chunks.length - 1];
    if (last.length + block.length + 2 <= limit) {
      chunks[chunks.length - 1] = `${last}\n\n${block}`;
      continue;
    }
    chunks.push(...splitBlocks(block, limit));
  }

  if (chunks.length <= maxParts) return { parts: chunks, truncated: false };

  const kept = chunks.slice(0, maxParts);
  // The cut is visible: an answer that stops mid-thought without a marker reads as
  // a broken bot rather than a short one.
  const lastIndex = kept.length - 1;
  kept[lastIndex] = `${kept[lastIndex].slice(0, limit - 1).trimEnd()}…`;
  return { parts: kept, truncated: true };
}

/** The note appended when an answer was cut, so the reader knows to ask for more. */
export const TRUNCATION_NOTE = "คำตอบยาวเกินกว่าที่แชทจะแสดงได้ — ถามเจาะจงขึ้นได้ เช่นระบุช่วงเวลาหรือสาขา";
