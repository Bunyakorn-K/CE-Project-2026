// System-prompt template rendering for the AI assistant.
//
// The AI console advertises three template variables — {{role}}, {{branches}}
// and {{tools}} — under the "System prompt" editor. Before this module existed
// nothing substituted them: the owner's text was handed to the gateway
// verbatim, so a prompt containing {{tools}} told the model it had tools while
// the literal string `{{tools}}` went out on the wire.
//
// Two rules this module exists to enforce:
//
//   1. The context is always server-derived. Nothing here reads a value the
//      browser supplied, so a prompt cannot talk the model into a wider scope
//      than the caller's own grants allow.
//   2. A variable that has no value renders an explicit statement, never an
//      empty string. An empty field is read as "broken template" and is a
//      false capability claim when the variable was {{tools}}.

export type PromptContext = {
  /** Server-derived role, e.g. "owner", "manager, technician". */
  roleLabel: string;
  /** Server-derived branch scope, rendered by branchLabel(). */
  branches: string;
  /** Tool names the caller will actually hand the model. May be empty. */
  toolNames: readonly string[];
};

/**
 * Rendered for {{tools}} when the caller passes no tools. The AI console is a
 * plain chat completion, so naming a catalogue there would advertise a
 * capability the request does not have.
 */
export const NO_TOOLS_LABEL = "(หน้านี้เป็น plain chat completion ไม่มีเครื่องมือวิเคราะห์แนบมา)";

const NO_BRANCH_LABEL = "ไม่มีสาขาที่เข้าถึงได้";

/** Human-readable branch scope. The wildcard "*" is the tenant-wide owner scope. */
export function branchLabel(branchIds: readonly string[]): string {
  if (branchIds.includes("*")) return "ทุกสาขา";
  if (branchIds.length === 0) return NO_BRANCH_LABEL;
  return branchIds.join(", ");
}

/**
 * Substitute the advertised variables in an owner-authored system prompt.
 *
 * Unknown `{{...}}` sequences are left in place: silently deleting text an
 * owner wrote would hide a typo in their own prompt, which is a worse failure
 * than a literal they can see and fix.
 */
export function renderSystemPrompt(template: string, ctx: PromptContext): string {
  // A function replacer, not a string: values may contain $&, $1, and friends,
  // which a string replacement would expand as capture-group references.
  const substitute = (value: string) => () => value;
  return template
    .replaceAll("{{role}}", substitute(ctx.roleLabel))
    .replaceAll("{{branches}}", substitute(ctx.branches))
    .replaceAll("{{tools}}", substitute(ctx.toolNames.length > 0 ? ctx.toolNames.join(", ") : NO_TOOLS_LABEL));
}

export type AssistantPromptInput = {
  /** The owner-authored prompt from AI settings. Blank is allowed. */
  ownerPrompt: string;
  roleLabel: string;
  branches: string;
  /** Tools actually passed to the model on this request. */
  toolNames: readonly string[];
  canViewRevenue: boolean;
};

/**
 * Build the assistant's system prompt from two parts:
 *
 *   1. the owner's text, from the AI console, with variables substituted; and
 *   2. the server rules below, which the owner cannot edit or remove.
 *
 * The split matters. The owner's prompt is the product's personality knob and
 * must actually be used — the console is where they set it, and an assistant
 * that ignores it is broken. But these rules encode the project's engineering
 * invariants (never invent a number, money is satang, revenue is role-derived,
 * synthetic data must be labelled) and an owner editing a persona must not be
 * able to talk them out. So the rules are appended last and always present.
 */
export function buildAssistantSystemPrompt(input: AssistantPromptInput): string {
  const { ownerPrompt, roleLabel, branches, toolNames, canViewRevenue } = input;
  const parts: string[] = [];

  const rendered = renderSystemPrompt(ownerPrompt, { roleLabel, branches, toolNames }).trim();
  if (rendered.length > 0) parts.push(rendered);

  parts.push(
    [
      "[กฎของระบบ — เจ้าของระบบปรับแต่งข้างต้นไม่ได้]",
      `ผู้ใช้มีสิทธิ์: ${roleLabel}`,
      `สาขาที่เข้าถึงได้: ${branches}`,
      "ตอบเป็นภาษาไทย กระชับ และอ้างอิงข้อมูลจากเครื่องมือ (tools) เท่านั้น",
      "ถ้าข้อมูลที่ได้เป็นข้อมูลจำลอง (dataSource เป็น synthetic หรือ mixed) ให้บอกผู้ใช้อย่างชัดเจนว่าเป็นข้อมูลจำลอง",
      "ตัวเลขเงินในข้อมูลเป็นสตางค์ (satang) ให้แปลงเป็นบาทก่อนแสดง",
      "ถ้าผู้ใช้ถามสิ่งที่ไม่มีข้อมูล ให้ตอบตรงๆ ว่าหาไม่เจอ อย่าเดาตัวเลข",
      canViewRevenue
        ? "ถ้าผู้ใช้ขอข้อมูลที่ไม่มี ให้ตอบว่าไม่มีข้อมูล อย่าสร้างค่าขึ้นเอง"
        : "ถ้าผู้ใช้ขอข้อมูลรายได้ ให้บอกว่าไม่มีสิทธิ์ดูข้อมูลรายได้"
    ].join("\n")
  );

  return parts.join("\n\n");
}
