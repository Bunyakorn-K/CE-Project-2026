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
        <p className="text-muted">หน้านี้ใช้ได้เฉพาะเจ้าของระบบ</p>
        <Link to="/dashboard" className="mt-3 inline-block text-accent underline">
          กลับแดชบอร์ด
        </Link>
      </div>
    );
  }

  if (query.isLoading) {
    return <div className="flex min-h-[40vh] items-center justify-center text-muted">กำลังโหลด…</div>;
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
      <Link to="/admin" className="text-sm text-muted underline">
        ← กลับหน้าผู้ดูแล
      </Link>
      <h1 className="mt-3 text-2xl font-bold">การแจ้งเตือน LINE</h1>
      <p className="mt-1 text-sm text-muted">
        แพ็กเกจฟรีของ LINE ส่งได้ 300 ข้อความ/เดือน (การตอบกลับข้อความที่ผู้ใช้ส่งมาฟรี ไม่นับ)
      </p>

      <section className="mt-5 rounded-xl border border-border p-4">
        <h2 className="text-sm font-semibold text-muted">การใช้โควตาเดือนนี้</h2>
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

      <section className="mt-4 rounded-xl border border-border p-4">
        <label className="block text-sm font-semibold text-muted" htmlFor="renotify">
          แจ้งซ้ำได้ทุกกี่ชั่วโมง
        </label>
        <p className="mt-1 text-xs text-muted">
          ภายในช่วงนี้ เรื่องเดิมจะไม่เด้งซ้ำ ({RENOTIFY_HOURS_MIN}–{RENOTIFY_HOURS_MAX} ชม.)
        </p>
        <input
          id="renotify"
          type="number"
          min={RENOTIFY_HOURS_MIN}
          max={RENOTIFY_HOURS_MAX}
          value={form.renotifyHours}
          onChange={(event) => setForm((current) => ({ ...current, renotifyHours: event.target.value }))}
          className="mt-2 w-32 rounded-lg border border-border px-3 py-2 text-sm"
        />
        <p className="mt-1 text-xs text-muted">{estimateCopy(hours)}</p>
      </section>

      <section className="mt-4 rounded-xl border border-border p-4">
        <label className="block text-sm font-semibold text-muted" htmlFor="budget">
          เพดานข้อความต่อเดือน
        </label>
        <p className="mt-1 text-xs text-muted">
          เมื่อถึงเพดาน ระบบจะหยุดส่งและบันทึกว่า “ถูกระงับเพราะเพดาน” ({MONTHLY_BUDGET_MIN}–{MONTHLY_BUDGET_MAX})
        </p>
        <input
          id="budget"
          type="number"
          min={MONTHLY_BUDGET_MIN}
          max={MONTHLY_BUDGET_MAX}
          value={form.monthlyBudget}
          onChange={(event) => setForm((current) => ({ ...current, monthlyBudget: event.target.value }))}
          className="mt-2 w-32 rounded-lg border border-border px-3 py-2 text-sm"
        />
      </section>

      {warning ? <p className="mt-3 text-sm text-warning">{warning}</p> : null}

      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground disabled:opacity-60"
        >
          {save.isPending ? "กำลังบันทึก…" : "บันทึก"}
        </button>
        {notice ? <span className="text-xs text-muted">{notice}</span> : null}
      </div>

      <p className="mt-6 text-xs text-muted">
        ค่าปัจจุบันมาจาก{settings.source === "stored" ? "การตั้งค่าที่บันทึกไว้" : "ค่าเริ่มต้นของระบบ (ยังไม่เคยบันทึก)"}
        {settings.updatedAt ? ` · แก้ไขล่าสุด ${new Date(settings.updatedAt).toLocaleString("th-TH")}` : ""}
      </p>

      <DigestCard />
    </div>
  );
}

/**
 * The daily digest.
 *
 * Off by default, with nobody on the list: a bot that starts messaging on its own is
 * the shop's decision. The hour is Bangkok's, and the server decides whether it is
 * time, so changing it here takes effect on the next five-minute check.
 */
type DigestSettings = {
  enabled: boolean;
  sendHour: number;
  sendMinute: number;
  updatedAt: number | null;
  source: "stored" | "default";
};

type DigestPerson = { lineUserId: string; displayName: string | null; roles: string[] };

type DigestPayload = {
  settings: DigestSettings;
  recipients: DigestPerson[];
  candidates: DigestPerson[];
  sentToday: { lineUserId: string; status: string; sentAt: number }[];
};

function DigestCard() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [hour, setHour] = useState("7");
  const [minute, setMinute] = useState("0");
  const [pick, setPick] = useState("");

  const query = useQuery({
    queryKey: ["digest"],
    queryFn: () => fetchJson<DigestPayload>("/api/admin/digest", "ไม่สามารถโหลดการตั้งค่าสรุปรายวันได้")
  });

  useEffect(() => {
    if (!query.data) return;
    setHour(String(query.data.settings.sendHour));
    setMinute(String(query.data.settings.sendMinute));
  }, [query.data]);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["digest"] });

  const save = useMutation({
    mutationFn: async (body: { enabled?: boolean; sendHour?: number; sendMinute?: number }) => {
      const response = await fetch(apiUrl("/api/admin/digest"), {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error(await apiErrorMessage(response, "บันทึกไม่สำเร็จ"));
    },
    onSuccess: () => {
      setNotice("บันทึกแล้ว — รอบตรวจถัดไป (ทุก 5 นาที) จะใช้ค่าใหม่");
      refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "บันทึกไม่สำเร็จ")
  });

  const add = useMutation({
    mutationFn: async (lineUserId: string) => {
      const response = await fetch(apiUrl("/api/admin/digest/recipients"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lineUserId })
      });
      if (!response.ok) throw new Error(await apiErrorMessage(response, "เพิ่มผู้รับไม่สำเร็จ"));
    },
    onSuccess: () => {
      setPick("");
      setNotice("เพิ่มผู้รับแล้ว");
      refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "เพิ่มผู้รับไม่สำเร็จ")
  });

  const remove = useMutation({
    mutationFn: async (lineUserId: string) => {
      const response = await fetch(apiUrl(`/api/admin/digest/recipients/${encodeURIComponent(lineUserId)}`), {
        method: "DELETE",
        credentials: "include"
      });
      if (!response.ok) throw new Error(await apiErrorMessage(response, "ลบผู้รับไม่สำเร็จ"));
    },
    onSuccess: () => {
      setNotice("ลบผู้รับแล้ว");
      refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "ลบผู้รับไม่สำเร็จ")
  });

  if (query.isLoading) return <p className="mt-6 text-muted">กำลังโหลดสรุปรายวัน…</p>;
  if (query.isError || !query.data) return null;

  const { settings, recipients, candidates, sentToday } = query.data;
  const busy = save.isPending || add.isPending || remove.isPending;
  const remaining = candidates.filter(
    (person) => !recipients.some((row) => row.lineUserId === person.lineUserId)
  );

  return (
    <section className="mt-8 rounded-xl border border-border p-4">
      <h2 className="text-base font-bold">สรุปรายวัน (digest)</h2>
      <p className="mt-1 text-xs text-muted">
        ข้อความเดียวสรุปเมื่อวาน — รายได้ จำนวนรอบซัก และการแจ้งเตือน ค่าเริ่มต้นคือ<strong>ปิด</strong>
        และยังไม่มีผู้รับ ต้องเปิดและเพิ่มผู้รับเอง · 1 ข้อความ/วัน นับรวมโควตาเดียวกับการแจ้งเตือน
      </p>

      <label className="mt-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(event) => save.mutate({ enabled: event.target.checked })}
          disabled={busy}
        />
        เปิดส่งสรุปรายวัน
      </label>

      <div className="mt-3 flex items-end gap-2">
        <div>
          <label className="block text-xs text-muted" htmlFor="digest-hour">
            เวลา (ชั่วโมง)
          </label>
          <input
            id="digest-hour"
            type="number"
            min={0}
            max={23}
            value={hour}
            onChange={(event) => setHour(event.target.value)}
            className="mt-1 w-24 rounded-lg border border-border px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-muted" htmlFor="digest-minute">
            นาที
          </label>
          <input
            id="digest-minute"
            type="number"
            min={0}
            max={59}
            value={minute}
            onChange={(event) => setMinute(event.target.value)}
            className="mt-1 w-24 rounded-lg border border-border px-3 py-2 text-sm"
          />
        </div>
        <button
          type="button"
          onClick={() =>
            save.mutate({ sendHour: Number(hour), sendMinute: Number(minute) })
          }
          disabled={busy}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground disabled:opacity-60"
        >
          บันทึกเวลา
        </button>
        <span className="text-xs text-muted">เวลาไทย (UTC+7)</span>
      </div>

      <div className="mt-4">
        <h3 className="text-sm font-semibold text-muted">ผู้รับ ({recipients.length})</h3>
        {recipients.length === 0 ? (
          <p className="mt-1 text-xs text-muted">ยังไม่มีผู้รับ — ระบบจะไม่ส่งอะไรเลย</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {recipients.map((person) => (
              <li key={person.lineUserId} className="flex items-center gap-2 text-sm">
                <span>{person.displayName ?? person.lineUserId}</span>
                <span className="text-xs text-muted">{person.roles.join(", ") || "ไม่มีสิทธิ์แล้ว"}</span>
                <button
                  type="button"
                  onClick={() => remove.mutate(person.lineUserId)}
                  disabled={busy}
                  className="text-xs text-danger underline"
                >
                  ลบ
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 flex items-center gap-2">
          <select
            value={pick}
            onChange={(event) => setPick(event.target.value)}
            className="rounded-lg border border-border px-3 py-2 text-sm"
          >
            <option value="">— เลือกบัญชีที่ผูก LINE แล้ว —</option>
            {remaining.map((person) => (
              <option key={person.lineUserId} value={person.lineUserId}>
                {(person.displayName ?? person.lineUserId) +
                  (person.roles.length > 0 ? ` (${person.roles.join(", ")})` : " (ไม่มีสิทธิ์)")}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => pick && add.mutate(pick)}
            disabled={busy || !pick}
            className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-60"
          >
            เพิ่มผู้รับ
          </button>
        </div>
      </div>

      {sentToday.length > 0 ? (
        <p className="mt-3 text-xs text-muted">
          วันนี้: {sentToday.map((row) => `${row.status} ${new Date(row.sentAt).toLocaleTimeString("th-TH")}`).join(" · ")}
        </p>
      ) : null}

      {notice ? <p className="mt-3 text-xs text-muted">{notice}</p> : null}
      <p className="mt-2 text-xs text-muted">
        {settings.source === "stored"
          ? `แก้ไขล่าสุด ${settings.updatedAt ? new Date(settings.updatedAt).toLocaleString("th-TH") : "-"}`
          : "ยังไม่เคยตั้งค่า — ค่าเริ่มต้น 07:00 และปิดอยู่"}
      </p>
    </section>
  );
}
