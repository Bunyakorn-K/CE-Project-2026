// Two branches, one label.
//
// LINE caps a quick-reply label at 20 characters, and the bot's picker was passing
// the full branch name through and letting the adapter cut it. Branches of one
// franchise share a prefix — "about you.wash & dry แม่โจ้ - …" — so the cut landed in
// the part that is identical for every branch, and the picker offered two buttons
// reading "about you.wash & dry". The tap still worked; choosing was impossible.
//
// So the label is built from the end, where the distinguishing words are, and widened
// only as far as it has to be to stay unique. The value sent back is always the real
// branch id — only what the reader sees is shortened.

/** LINE's hard cap on a quick-reply label. */
export const QUICK_REPLY_LABEL_MAX = 20;

/** "about you.wash & dry แม่โจ้ - หลิ่งมื่น" → ["about you.wash & dry แม่โจ้", "หลิ่งมื่น"] */
const SEPARATOR = /\s+[-–—]\s+/;

/**
 * Words that invert a sentence when they are the part that gets cut.
 *
 * The picker really holds a branch named
 * "SANDBOX ทดสอบ (ไม่ใช่สาขาจริง) - อย่ารับงานลูกค้าที่นี่". Cut from the left to 20
 * characters its label reads "…รับงานลูกค้าที่นี่" — the opposite instruction. A label
 * may be vague; it may not say the reverse of the name.
 */
const NEGATION = /อย่า|ไม่|ห้าม|ยกเลิก|งด/;

function segmentsOf(name: string): string[] {
  const parts = name
    .split(SEPARATOR)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [name.trim()];
}

/** Keep the end, because that is the part that differs branch to branch. */
function tailFit(text: string, max: number): string {
  if (text.length <= max) return text;
  return `…${text.slice(text.length - (max - 1))}`;
}

/** Keep the beginning, cut at a word boundary so no word is half-shown. */
function headFit(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const atSpace = cut.lastIndexOf(" ");
  return `${(atSpace > 0 ? cut.slice(0, atSpace) : cut).trimEnd()}…`;
}

/**
 * Shorten one label, preferring the end but never cutting a negation away.
 *
 * `fullName` is what `headFit` falls back to, and is only used when the end cannot be
 * shown safely.
 */
function fit(text: string, fullName: string, max: number): string {
  if (text.length <= max) return text;
  // A negation anywhere in the part being shortened is a reason not to shorten it from
  // the front: "อย่ารับงานลูกค้าที่นี่" becomes "…รับงานลูกค้าที่นี่" whether the cut
  // lands before or inside the word, and Thai has no spaces to cut at.
  if (NEGATION.test(text)) return headFit(fullName, max);
  return tailFit(text, max);
}

/** The shortest label that still names this branch, ignoring its siblings. */
export function shortBranchLabel(name: string, max = QUICK_REPLY_LABEL_MAX): string {
  const parts = segmentsOf(name);
  return fit(parts[parts.length - 1] ?? name.trim(), name.trim(), max);
}

/**
 * Labels for a whole list, widened until each one is distinct.
 *
 * One branch per franchise usually needs the last segment alone. Two sites in the same
 * zone need "โซนเหลือง - A" as well, so the segment count grows before anything is
 * truncated further. If even the full names collide, a position suffix separates them —
 * an ambiguous button is worse than an ugly one.
 */
export function shortBranchLabels(names: string[], max = QUICK_REPLY_LABEL_MAX): string[] {
  if (names.length === 0) return [];
  const segments = names.map(segmentsOf);
  const widest = Math.max(...segments.map((parts) => parts.length));

  for (let take = 1; take <= widest; take++) {
    const labels = segments.map((parts, index) =>
      take === 1
        ? shortBranchLabel(names[index], max)
        : fit(parts.slice(-take).join(" - "), names[index].trim(), max)
    );
    if (new Set(labels).size === labels.length) return labels;
  }

  // Nothing distinguishes them, so the shortest label stays and the duplicates are
  // numbered. A wider label buys nothing when the names are identical.
  const seen = new Map<string, number>();
  return names.map((name) => {
    const shortest = shortBranchLabel(name, max);
    const count = (seen.get(shortest) ?? 0) + 1;
    seen.set(shortest, count);
    return count === 1 ? shortest : tailFit(`${shortest} (${count})`, max);
  });
}
