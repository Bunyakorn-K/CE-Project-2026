// "Which branch?" — asked once, before answering, when the question has no branch.
//
// A person with two branches asks "ภาพรวมวันนี้เป็นยังไง" and gets a card headed
// with one branch, then two sets of numbers inside it, then a total. The sentence is
// true and useless: the reader has to work out which half is theirs, and the bot has
// quietly decided the scope instead of asking.
//
// So when the question is a scope-less overview, the person can see more than one
// branch, and nothing has been remembered, the bot asks first. The question is held
// while they choose, and the answer they get is the one they asked for.

export type BranchRef = { branchId: string; branchName: string };

/** The payload for "don't narrow it — show me everything I can see". */
export const ALL_BRANCHES = "all";

/**
 * Questions that are about "the shop" rather than about something specific.
 *
 * Deliberately narrow. A question that names a machine, an alert or a date range is
 * answerable without choosing a branch; only the ones that mean "how is business"
 * need the scope settled first. Asking on every question would be worse than the
 * problem it solves.
 */
const OVERVIEW_TERMS = [
  "ภาพรวม",
  "สรุป",
  "เป็นยังไง",
  "เป็นอย่างไร",
  "รายได้",
  "กำไร",
  "ยอดขาย",
  "รอบซัก",
  "กี่รอบ",
  "เท่าไหร่",
  "วันนี้",
  "เมื่อวาน"
];

/** Words that mean the question already has a scope, so asking would be noise. */
const SCOPED_TERMS = ["เครื่อง", "แจ้งเตือน", "ซ่อม", "อุณหภูมิ", "สาขา"];

export function isOverviewQuestion(text: string): boolean {
  const normalised = text.trim().toLowerCase();
  if (normalised.length === 0) return false;
  if (SCOPED_TERMS.some((term) => normalised.includes(term))) return false;
  return OVERVIEW_TERMS.some((term) => normalised.includes(term));
}

/**
 * Does the text name one of the person's branches?
 *
 * Matched on the distinguishing tail of the name rather than the whole string: the
 * branches all start with the same brand ("about you.wash & dry …"), so a substring
 * test on the full name would match every branch at once. The tail is the part after
 * the last "-", which is what people actually type.
 */
export function mentionsBranch(text: string, branches: BranchRef[]): boolean {
  const normalised = text.trim().toLowerCase();
  return branches.some((branch) => {
    const name = branch.branchName.toLowerCase();
    const tail = name.split("-").pop()?.trim() ?? name;
    return name.length > 0 && (normalised.includes(name) || (tail.length >= 3 && normalised.includes(tail)));
  });
}

export function shouldAskWhichBranch(input: {
  text: string;
  branches: BranchRef[];
  /** True when a branch is already remembered for this person. */
  hasRememberedBranch: boolean;
}): boolean {
  if (input.hasRememberedBranch) return false;
  if (input.branches.length < 2) return false;
  if (!isOverviewQuestion(input.text)) return false;
  return !mentionsBranch(input.text, input.branches);
}

/** The picker: every branch, plus "ทุกสาขา" — the scope the bot assumed before. */
export function branchScopeReplies(branches: BranchRef[]): { label: string; data: string }[] {
  const options = branches.slice(0, 12).map((branch) => ({
    label: branch.branchName,
    data: `pref:branch:${branch.branchId}`
  }));
  return [...options, { label: "ทุกสาขา", data: `pref:branch:${ALL_BRANCHES}` }];
}

export function askWhichBranchText(branches: BranchRef[]): string {
  if (branches.length === 0) return "ยังไม่พบสาขาที่คุณเข้าถึงได้ — ลองติดต่อผู้ดูแลระบบ";
  return [
    "ต้องการดูสาขาไหนครับ",
    `คุณเข้าถึงได้ ${branches.length} สาขา — เลือกจากปุ่มด้านล่าง แล้วผมจะตอบคำถามเดิมให้`,
    "(เลือกแล้วจำไว้เป็นสาขาประจำได้ทันที — เปลี่ยนหรือลืมได้ทุกเมื่อด้วยคำว่า “ลืมสาขาประจำ”)"
  ].join("\n");
}
