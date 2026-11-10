/**
 * The assistant's answer as a LINE Flex Message.
 *
 * WHY. The bot was sending `answer.text` straight out, so a model that answered in
 * markdown produced literal `**`, `###`, and dashes on a phone — the reader saw the
 * markup instead of the answer, and a list of three numbers became a paragraph.
 * LINE text messages do not render markdown; a flex bubble is the only way to show
 * a label and its value on one line.
 *
 * WHY PARSING AND NOT A JSON CONTRACT. Asking the model for JSON makes every
 * failure a JSON blob on the user's phone, and this assistant also answers
 * questions that have no rows at all ("ทำไมเครื่อง 3 หยุด"). So the answer keeps
 * its natural shape and this module finds the structure the model already uses:
 * a heading, `ชื่อ: ค่า` lines, and bullets. Anything it cannot read stays prose —
 * a card with less structure, never a card that invents some.
 *
 * WHAT MUST STAY TRUE. The card is a rendering of the text, never a second source:
 * every character in it comes from the answer, and `altText` is built from the same
 * parsed structure so the notification and the card cannot disagree.
 */

import type { FlexContents } from "../alert-flex";

export const ANSWER_ALT_LIMIT = 400;

/** Beyond these a card stops being scannable and becomes the paragraph it replaced. */
const MAX_ROWS = 8;
const MAX_BULLETS = 8;
const MAX_PROSE_LINES = 3;

export type AnswerRow = { label: string; value: string };

export type ParsedAnswer = {
  title: string | null;
  intro: string[];
  rows: AnswerRow[];
  bullets: string[];
  outro: string[];
};

/** `**bold**`, `__bold__`, `` `code` `` and leading list markers, removed. */
export function stripMarkdown(input: string): string {
  return input
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s*/, "")
    .replace(/^\s*[-*•]\s+/, "")
    .replace(/\s+$/, "");
}

function isFence(line: string): boolean {
  return /^\s*(```|~~~)/.test(line);
}

function headingOf(line: string): string | null {
  const match = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
  return match ? stripMarkdown(match[1]).trim() : null;
}

/** `ชื่อ: ค่า` where the label is short enough to be a label and the value exists. */
function rowOf(line: string): AnswerRow | null {
  const cleaned = stripMarkdown(line).trim();
  if (!cleaned) return null;
  const match = cleaned.match(/^([^:：]{1,28})[:：]\s*(.+)$/);
  if (!match) return null;
  const label = match[1].trim();
  const value = match[2].trim();
  // A sentence with a colon in the middle is prose, not a row: a label has no
  // trailing punctuation and is not itself a clause.
  if (!label || !value || /[.!?。]$/.test(label)) return null;
  return { label, value };
}

function bulletOf(line: string): string | null {
  let current = line;
  let found = false;
  // "- 1. คิวรอ 4 คัน" is a bullet whose text starts with a number; stripping only
  // the first marker would leave "1." in the card.
  for (;;) {
    const match = current.match(/^\s*(?:[-*•]|\d+[.)])\s+(.+)$/);
    if (!match) break;
    found = true;
    current = match[1];
  }
  return found ? stripMarkdown(current).trim() : null;
}

/**
 * Split an answer into the parts a card can show.
 *
 * The first heading becomes the title (a card has one header); later headings are
 * prose, because a second big title inside the body reads as a broken layout.
 */
export function parseAnswer(text: string): ParsedAnswer {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const parsed: ParsedAnswer = { title: null, intro: [], rows: [], bullets: [], outro: [] };
  let inFence = false;
  let seenStructure = false;

  for (const raw of lines) {
    if (isFence(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const line = raw.trim();
    if (!line || /^[-—_]{3,}$/.test(line)) continue;

    const heading = !inFence ? headingOf(raw) : null;
    if (heading) {
      if (!parsed.title && parsed.rows.length === 0 && parsed.bullets.length === 0) {
        parsed.title = heading;
      } else {
        parsed.outro.push(heading);
        seenStructure = true;
      }
      continue;
    }

    const bullet = inFence ? null : bulletOf(raw);
    if (bullet && parsed.bullets.length < MAX_BULLETS) {
      parsed.bullets.push(bullet);
      seenStructure = true;
      continue;
    }

    const row = inFence ? null : rowOf(raw);
    if (row && parsed.rows.length < MAX_ROWS) {
      parsed.rows.push(row);
      seenStructure = true;
      continue;
    }

    // Prose lands before the first structure and after it; a card keeps the first
    // lines of each, because the rest is what the reader scrolls past.
    const target = seenStructure ? parsed.outro : parsed.intro;
    if (target.length < MAX_PROSE_LINES) target.push(stripMarkdown(line));
  }

  return parsed;
}

/** True when the answer has enough shape to be worth a card. */
export function looksStructured(parsed: ParsedAnswer): boolean {
  return parsed.rows.length > 0 || parsed.bullets.length > 0 || Boolean(parsed.title);
}

function text(content: string, options: Record<string, unknown> = {}) {
  return { type: "text", text: content, wrap: true, ...options };
}

/**
 * Spacing is a `margin` on the next component, never a spacer.
 *
 * LINE validates the message and rejects any spacer that is not the first or last
 * element of its box — "spacer must be the fist or last element of the box". The
 * first version of this module put spacers between rows and the API refused every
 * card; `validate/push` caught it before a phone did.
 */
function withMargin(component: Record<string, unknown>, margin?: string) {
  return margin ? { ...component, margin } : component;
}

/** A label and its value on one line — the whole reason this module exists. */
function rowComponent(row: AnswerRow) {
  return {
    type: "box",
    layout: "horizontal",
    spacing: "md",
    alignItems: "center",
    contents: [
      text(row.label, { size: "sm", color: "#6B7280", flex: 4 }),
      text(row.value, { size: "md", color: "#111827", flex: 6, align: "end", weight: "bold" })
    ]
  };
}

function bulletComponent(bullet: string) {
  return {
    type: "box",
    layout: "horizontal",
    spacing: "sm",
    contents: [
      text("•", { size: "sm", color: "#9CA3AF", flex: 0 }),
      text(bullet, { size: "sm", color: "#374151", flex: 1 })
    ]
  };
}

export type AnswerCardOptions = {
  /** Header colour, so a role's card matches the panel it came from. */
  accent?: string;
  /** Shown in small grey text at the bottom — the LIFF link or a caveat. */
  footer?: string;
};

/**
 * The bubble. `null` when the answer has no structure at all, so the caller sends
 * a plain text message rather than an empty card with one paragraph in it.
 */
export function buildAnswerFlex(
  parsed: ParsedAnswer,
  options: AnswerCardOptions = {}
): FlexContents | null {
  if (!looksStructured(parsed)) return null;

  const accent = options.accent ?? "#1f6feb";
  const body: Record<string, unknown>[] = [];

  parsed.intro.forEach((line, index) => {
    body.push(withMargin(text(line, { size: "sm", color: "#374151" }), index === 0 ? undefined : "sm"));
  });

  parsed.rows.forEach((row, index) => {
    const first = index === 0;
    body.push(withMargin(rowComponent(row), first && parsed.intro.length === 0 ? undefined : "sm"));
  });

  parsed.bullets.forEach((bullet, index) => {
    body.push(withMargin(bulletComponent(bullet), index === 0 ? "md" : "xs"));
  });

  parsed.outro.forEach((line, index) => {
    body.push(withMargin(text(line, { size: "sm", color: "#374151" }), index === 0 ? "md" : "sm"));
  });

  if (options.footer) {
    body.push(withMargin(text(options.footer, { size: "xxs", color: "#9CA3AF" }), "md"));
  }

  const bubble: Record<string, unknown> = {
    type: "bubble",
    body: { type: "box", layout: "vertical", spacing: "none", contents: body }
  };

  if (parsed.title) {
    bubble.header = {
      type: "box",
      layout: "vertical",
      backgroundColor: accent,
      paddingAll: "16px",
      contents: [text(parsed.title, { size: "md", color: "#FFFFFF", weight: "bold" })]
    };
  }

  return bubble;
}

/**
 * What the notification banner and a client that cannot render flex will show.
 * Built from the same parsed structure as the card, so the two cannot disagree.
 */
export function answerAltText(parsed: ParsedAnswer): string {
  const parts: string[] = [];
  if (parsed.title) parts.push(parsed.title);
  if (parsed.intro.length > 0) parts.push(parsed.intro[0]);
  for (const row of parsed.rows.slice(0, 3)) parts.push(`${row.label}: ${row.value}`);
  for (const bullet of parsed.bullets.slice(0, 2)) parts.push(`• ${bullet}`);
  if (parts.length === 0) parts.push("คำตอบจากผู้ช่วย LaundryTwin");

  const joined = parts.join(" · ");
  return joined.length <= ANSWER_ALT_LIMIT ? joined : `${joined.slice(0, ANSWER_ALT_LIMIT - 1)}…`;
}
