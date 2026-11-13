// The machinery does not belong on the phone.
//
// The prompt used to ask for a provenance line — "ที่มา: get_cycles_daily (real data)"
// — because a number nobody can trace is a number to distrust. That is true for the
// backoffice console, where the reader is debugging the assistant, and it is noise on
// the phone, where the reader owns a laundry and asked how the day went. Tool names
// and the word "real" do not help them decide anything.
//
// So the delivery path strips it, and keeps the one provenance statement that *is*
// for the reader: a simulated answer must still say it is simulated. Deleting that
// with the tool names would turn the dashboard's most important disclaimer into
// silence.

/** A line whose entire content is provenance rather than an answer. */
const PROVENANCE_LINE =
  /^\s*(?:[-•*]\s*)?(?:ที่มา|แหล่งข้อมูล|ข้อมูลจาก|source)\s*[:：]\s*.*(?:get_[a-z_]+|real|synthetic|mixed|demo|clickhouse|postgres|iris).*$/i;

/** Inline tails the model likes to append to a sentence. */
const INLINE_TAIL = /\s*\((?:real data|synthetic data|mixed data|real|synthetic|mixed)\)\s*$/i;

/** Provenance that carries a warning the reader must still see. */
const SIMULATED = /synthetic|mixed|demo|จำลอง/i;

export const SIMULATED_NOTICE = "ข้อมูลชุดนี้เป็นข้อมูลจำลอง ไม่ใช่ข้อมูลจริงของร้าน";

/**
 * Remove tool-level provenance, keep the simulated-data warning.
 *
 * A line that names a tool *and* says the data is synthetic is replaced by the
 * warning in words the reader can act on, rather than dropped — the whole point of
 * the rule it comes from.
 */
export function stripProvenance(input: string): string {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let announcedSimulated = false;

  for (const line of lines) {
    if (PROVENANCE_LINE.test(line)) {
      if (SIMULATED.test(line) && !announcedSimulated) {
        out.push(SIMULATED_NOTICE);
        announcedSimulated = true;
      }
      continue;
    }
    out.push(line.replace(INLINE_TAIL, ""));
  }

  // Collapse the blank runs a removed line leaves behind, so the card does not open
  // with an empty paragraph where the provenance used to be.
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
}
