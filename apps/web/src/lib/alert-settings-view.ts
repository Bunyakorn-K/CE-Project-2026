// The alert-settings form, as data.
//
// The API clamps to the same ranges; this module exists so the page can show the
// consequence of a number *before* it is saved — "12 hours is 120 messages a
// month for two channels" is the fact that decides whether the value is right,
// and it is not obvious from the number alone.

export const RENOTIFY_HOURS_MIN = 1;
export const RENOTIFY_HOURS_MAX = 168;
export const MONTHLY_BUDGET_MIN = 0;
export const MONTHLY_BUDGET_MAX = 1000;

export type AlertSettings = {
  renotifyHours: number;
  monthlyBudget: number;
  updatedAt: number | null;
  source: "stored" | "environment";
};

export type BudgetUsage = { month: string; used: number; cap: number; remaining: number };

export type SettingsForm = { renotifyHours: string; monthlyBudget: string };

export function formFromSettings(settings: AlertSettings): SettingsForm {
  return {
    renotifyHours: String(settings.renotifyHours),
    monthlyBudget: String(settings.monthlyBudget)
  };
}

/**
 * Parse what the owner typed. An empty or non-numeric field is `null` — the
 * caller sends only the fields that parsed, so a typo in one box cannot silently
 * reset the other to a default.
 */
export function parseForm(form: SettingsForm): { renotifyHours: number | null; monthlyBudget: number | null } {
  const parse = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : null;
  };
  return { renotifyHours: parse(form.renotifyHours), monthlyBudget: parse(form.monthlyBudget) };
}

export function clampRenotifyHours(value: number): number {
  return Math.min(RENOTIFY_HOURS_MAX, Math.max(RENOTIFY_HOURS_MIN, Math.round(value)));
}

export function clampMonthlyBudget(value: number): number {
  return Math.min(MONTHLY_BUDGET_MAX, Math.max(MONTHLY_BUDGET_MIN, Math.round(value)));
}

/**
 * What a floor costs per month, for the two gas channels this deployment alerts
 * on. Shown next to the input so the number is judged against the allowance
 * rather than in the abstract.
 */
export function monthlyEstimate(renotifyHours: number, channels = 2): number {
  if (!Number.isFinite(renotifyHours) || renotifyHours <= 0) return 0;
  return Math.round((24 / renotifyHours) * channels * 30);
}

export function estimateCopy(renotifyHours: number, channels = 2): string {
  const estimate = monthlyEstimate(renotifyHours, channels);
  const perDay = Math.round((24 / renotifyHours) * channels * 10) / 10;
  return `≈ ${perDay} ข้อความ/วัน · ${estimate} ข้อความ/เดือน (${channels} ช่อง)`;
}

/** How much of the month's allowance is left, in the owner's words. */
export function usageCopy(usage: BudgetUsage): { text: string; tone: "ok" | "warn" | "spent" } {
  const pct = usage.cap > 0 ? Math.round((usage.used / usage.cap) * 100) : 100;
  const text = `ใช้ไป ${usage.used} จาก ${usage.cap} ข้อความ (${pct}%) · เหลือ ${usage.remaining} · เดือน ${usage.month}`;
  if (usage.remaining <= 0) return { text: `${text} — เพดานเต็มแล้ว การแจ้งเตือนจะถูกระงับ`, tone: "spent" };
  if (pct >= 80) return { text: `${text} — ใกล้เต็ม`, tone: "warn" };
  return { text, tone: "ok" };
}

/** A warning when the floor would spend the cap before the month ends. */
export function budgetWarning(renotifyHours: number, monthlyBudget: number, channels = 2): string | null {
  const estimate = monthlyEstimate(renotifyHours, channels);
  if (monthlyBudget <= 0) return "เพดาน 0 หมายถึงไม่ส่งการแจ้งเตือนเลย";
  if (estimate > monthlyBudget) {
    return `ที่ ${renotifyHours} ชม. จะใช้ประมาณ ${estimate} ข้อความ/เดือน เกินเพดาน ${monthlyBudget} — ส่วนที่เกินจะถูกระงับ`;
  }
  return null;
}
