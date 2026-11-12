// How money is told to a shop owner.
//
// The warehouse stores satang, and the prompt tells the model to convert to baht —
// which it does, and then writes both: "96,000 สตางค์ = 960 บาท". That sentence is
// an audit trail, not an answer. Nobody reading it on a phone needs the satang, and
// the conversion step in the middle invites the reader to check arithmetic instead
// of reading revenue.
//
// The prompt still asks for baht (it keeps the model's own arithmetic honest), and
// this normaliser makes the output certain: whatever the model writes, the person
// sees baht.

const SATANG_AND_BAHT = /([\d,]+(?:\.\d+)?)\s*สตางค์\s*=\s*([\d,]+(?:\.\d+)?)\s*บาท/g;
const SATANG_ONLY = /([\d,]+(?:\.\d+)?)\s*สตางค์/g;

/** `960` → "960", `960.5` → "960.50", `960.00` → "960". */
export function formatBaht(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  const text = Number.isInteger(rounded)
    ? rounded.toLocaleString("en-US")
    : rounded.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${text} บาท`;
}

/**
 * Rewrite every satang figure as the baht it equals.
 *
 * Two shapes, in this order: the redundant pair the model likes to write is
 * collapsed to the baht it already computed, then any remaining satang is divided.
 * Running the pair rule first matters — the second rule would otherwise convert the
 * already-correct half of "96,000 สตางค์ = 960 บาท" and leave "960 สตางค์ = 9.6 บาท".
 */
export function bahtOnly(text: string): string {
  return text
    .replace(SATANG_AND_BAHT, (_match, _satang: string, baht: string) => `${baht} บาท`)
    .replace(SATANG_ONLY, (_match, satang: string) => formatBaht(Number(satang.replace(/,/g, "")) / 100));
}
