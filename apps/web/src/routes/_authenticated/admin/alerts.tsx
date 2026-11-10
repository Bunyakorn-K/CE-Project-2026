import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { useEffect, useState } from "react";
import { apiErrorMessage, apiUrl } from "../../../lib/api/client";
import { authAtom } from "../../../lib/atoms/auth";
import { isOwner as hasOwnerGrant } from "../../../lib/access";
import {
  MONTHLY_BUDGET_MAX,
  MONTHLY_BUDGET_MIN,
  RENOTIFY_HOURS_MAX,
  RENOTIFY_HOURS_MIN,
  budgetWarning,
  clampMonthlyBudget,
  clampRenotifyHours,
  estimateCopy,
  formFromSettings,
  parseForm,
  usageCopy,
  type AlertSettings,
  type BudgetUsage,
  type SettingsForm
} from "../../../lib/alert-settings-view";

export const Route = createFileRoute("/_authenticated/admin/alerts")({
  component: AlertSettingsPage
});

type Payload = { settings: AlertSettings; usage: BudgetUsage };

async function fetchJson<T>(path: string, fallback: string): Promise<T> {
  const response = await fetch(apiUrl(path), { credentials: "include" });
  if (!response.ok) throw new Error(await apiErrorMessage(response, `${fallback} (HTTP ${response.status})`));
  return (await response.json()) as T;
}

/**
 * Alert delivery settings.
 *
 * The two numbers here decide how many LINE messages the shop spends: the floor
 * between repeats, and the monthly cap. Both used to be environment variables,
 * which made "the alerts are too noisy this week" a redeploy.
 */
function AlertSettingsPage() {
  const [user] = useAtom(authAtom);
  const isOwner = hasOwnerGrant(user);
  const queryClient = useQueryClient();
  const [form, setForm] = useState<SettingsForm>({ renotifyHours: "", monthlyBudget: "" });
  const [hydrated, setHydrated] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["alert-settings"],
    queryFn: () => fetchJson<Payload>("/api/admin/alert-settings", "ไม่สามารถโหลดการตั้งค่าการแจ้งเตือนได้"),
    enabled: isOwner
  });

  useEffect(() => {
    if (!query.data || hydrated) return;
    setForm(formFromSettings(query.data.settings));
    setHydrated(true);
  }, [query.data, hydrated]);

  const save = useMutation({
    mutationFn: async () => {
      const parsed = parseForm(form);
      const body: Record<string, number> = {};
      if (parsed.renotifyHours !== null) body.renotifyHours = clampRenotifyHours(parsed.renotifyHours);
      if (parsed.monthlyBudget !== null) body.monthlyBudget = clampMonthlyBudget(parsed.monthlyBudget);
      const response = await fetch(apiUrl("/api/admin/alert-settings"), {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error(await apiErrorMessage(response, "บันทึกไม่สำเร็จ"));
      return (await response.json()) as Payload;
    },
    onSuccess: (payload) => {
      setForm(formFromSettings(payload.settings));
      setNotice("บันทึกแล้ว — รอบสแกนถัดไปจะใช้ค่าใหม่ทันที");
      void queryClient.invalidateQueries({ queryKey: ["alert-settings"] });
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "บันทึกไม่สำเร็จ")
  });

  if (!isOwner) {
    return (
      <div className="mx-auto w-full max-w-2xl p-6">
        <p className="text-default-600">หน้านี้ใช้ได้เฉพาะเจ้าของระบบ</p>
        <Link to="/dashboard" className="mt-3 inline-block text-primary underline">
          กลับแดชบอร์ด
        </Link>
      </div>
    );
  }

  if (query.isLoading) {
    return <div className="flex min-h-[40vh] items-center justify-center text-default-500">กำลังโหลด…</div>;
  }

  if (query.isError || !query.data) {
    return (
      <div className="mx-auto w-full max-w-2xl p-6">
        <p className="text-danger">{query.error instanceof Error ? query.error.message : "โหลดการตั้งค่าไม่ได้"}</p>
      </div>
    );
  }

  const { settings, usage } = query.data;
  const usageLine = usageCopy(usage);
  const hours = parseForm(form).renotifyHours ?? settings.renotifyHours;
  const budget = parseForm(form).monthlyBudget ?? settings.monthlyBudget;
  const warning = budgetWarning(hours, budget);

  return (
    <div className="mx-auto w-full max-w-2xl p-4 sm:p-6">
      <Link to="/admin" className="text-small text-default-500 underline">
        ← กลับหน้าผู้ดูแล
      </Link>
      <h1 className="mt-3 text-2xl font-bold">การแจ้งเตือน LINE</h1>
      <p className="mt-1 text-small text-default-500">
        แพ็กเกจฟรีของ LINE ส่งได้ 300 ข้อความ/เดือน (การตอบกลับข้อความที่ผู้ใช้ส่งมาฟรี ไม่นับ)
      </p>

      <section className="mt-5 rounded-large border border-default-200 p-4">
        <h2 className="text-small font-semibold text-default-600">การใช้โควตาเดือนนี้</h2>
        <p
          className={
            usageLine.tone === "spent"
              ? "mt-2 text-small font-semibold text-danger"
              : usageLine.tone === "warn"
                ? "mt-2 text-small font-semibold text-warning"
                : "mt-2 text-small"
          }
        >
          {usageLine.text}
        </p>
      </section>

      <section className="mt-4 rounded-large border border-default-200 p-4">
        <label className="block text-small font-semibold text-default-600" htmlFor="renotify">
          แจ้งซ้ำได้ทุกกี่ชั่วโมง
        </label>
        <p className="mt-1 text-tiny text-default-500">
          ภายในช่วงนี้ เรื่องเดิมจะไม่เด้งซ้ำ ({RENOTIFY_HOURS_MIN}–{RENOTIFY_HOURS_MAX} ชม.)
        </p>
        <input
          id="renotify"
          type="number"
          min={RENOTIFY_HOURS_MIN}
          max={RENOTIFY_HOURS_MAX}
          value={form.renotifyHours}
          onChange={(event) => setForm((current) => ({ ...current, renotifyHours: event.target.value }))}
          className="mt-2 w-32 rounded-medium border border-default-300 px-3 py-2 text-small"
        />
        <p className="mt-1 text-tiny text-default-500">{estimateCopy(hours)}</p>
      </section>

      <section className="mt-4 rounded-large border border-default-200 p-4">
        <label className="block text-small font-semibold text-default-600" htmlFor="budget">
          เพดานข้อความต่อเดือน
        </label>
        <p className="mt-1 text-tiny text-default-500">
          เมื่อถึงเพดาน ระบบจะหยุดส่งและบันทึกว่า “ถูกระงับเพราะเพดาน” ({MONTHLY_BUDGET_MIN}–{MONTHLY_BUDGET_MAX})
        </p>
        <input
          id="budget"
          type="number"
          min={MONTHLY_BUDGET_MIN}
          max={MONTHLY_BUDGET_MAX}
          value={form.monthlyBudget}
          onChange={(event) => setForm((current) => ({ ...current, monthlyBudget: event.target.value }))}
          className="mt-2 w-32 rounded-medium border border-default-300 px-3 py-2 text-small"
        />
      </section>

      {warning ? <p className="mt-3 text-small text-warning">{warning}</p> : null}

      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="rounded-medium bg-primary px-4 py-2 text-small font-semibold text-primary-foreground disabled:opacity-60"
        >
          {save.isPending ? "กำลังบันทึก…" : "บันทึก"}
        </button>
        {notice ? <span className="text-tiny text-default-600">{notice}</span> : null}
      </div>

      <p className="mt-6 text-tiny text-default-500">
        ค่าปัจจุบันมาจาก{settings.source === "stored" ? "การตั้งค่าที่บันทึกไว้" : "ค่าเริ่มต้นของระบบ (ยังไม่เคยบันทึก)"}
        {settings.updatedAt ? ` · แก้ไขล่าสุด ${new Date(settings.updatedAt).toLocaleString("th-TH")}` : ""}
      </p>
    </div>
  );
}
