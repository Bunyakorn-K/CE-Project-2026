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

function segmentsOf(name: string): string[] {
  const parts = name
    .split(SEPARATOR)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [name.trim()];
}

/**
 * Keep the end of a string, because that is the part that differs.
 *
 * Cut from the left, not the right: "…ตลาดโซนเหลือง" tells the reader which branch,
 * while "about you.wash & dr…" tells them which franchise, which they already know.
 */
function fit(text: string, max: number): string {
  if (text.length <= max) return text;
  return `…${text.slice(text.length - (max - 1))}`;
}

/** The shortest label that still names this branch, ignoring its siblings. */
export function shortBranchLabel(name: string, max = QUICK_REPLY_LABEL_MAX): string {
  const parts = segmentsOf(name);
  return fit(parts[parts.length - 1] ?? name.trim(), max);
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
    const labels = segments.map((parts) => fit(parts.slice(-take).join(" - "), max));
    if (new Set(labels).size === labels.length) return labels;
  }

  // Nothing distinguishes them, so the shortest label stays and the duplicates are
  // numbered. A wider label buys nothing when the names are identical.
  const seen = new Map<string, number>();
  return segments.map((parts) => {
    const shortest = fit(parts[parts.length - 1] ?? "", max);
    const count = (seen.get(shortest) ?? 0) + 1;
    seen.set(shortest, count);
    return count === 1 ? shortest : fit(`${shortest} (${count})`, max);
  });
}
