import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { useState } from "react";
import { apiErrorMessage, apiUrl } from "../../../lib/api/client";
import { authAtom } from "../../../lib/atoms/auth";
import { isOwner as hasOwnerGrant } from "../../../lib/access";

export const Route = createFileRoute("/_authenticated/admin/line")({
  component: LineMenuPage
});

type Menu = {
  key: string;
  name: string;
  chatBarText: string;
  labels: string[];
  areas: { bounds: { x: number; width: number }; action: { type: string; uri?: string; text?: string } }[];
};

type Payload = {
  liffConfigured: boolean;
  lineConfigured: boolean;
  syncedAt: number | null;
  ids: Record<string, string>;
  menus: Menu[];
};

type SyncResult = {
  created: string[];
  deleted: string[];
  linked: { lineUserId: string; key: string }[];
  failed: { lineUserId: string; error: string }[];
};

const ROLE_LABEL: Record<string, string> = {
  owner: "เจ้าของ",
  manager: "ผู้จัดการ",
  technician: "ช่าง",
  default: "ยังไม่ได้รับสิทธิ์"
};

async function fetchJson<T>(path: string, fallback: string): Promise<T> {
  const response = await fetch(apiUrl(path), { credentials: "include" });
  if (!response.ok) throw new Error(await apiErrorMessage(response, `${fallback} (HTTP ${response.status})`));
  return (await response.json()) as T;
}

/**
 * The LINE rich menu, per role.
 *
 * A rich menu is the panel above the keyboard, and LINE lets a bot link a
 * different one to each user — so the owner sees a backoffice button and a
 * technician sees "แจ้งซ่อม". LINE cannot edit a menu, so a sync creates new
 * menus, uploads the images, re-points everyone and deletes the old ones; that is
 * why this is a button with a result, not a form.
 */
function LineMenuPage() {
  const [user] = useAtom(authAtom);
  const isOwner = hasOwnerGrant(user);
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["rich-menus"],
    queryFn: () => fetchJson<Payload>("/api/admin/rich-menus", "ไม่สามารถโหลดเมนู LINE ได้"),
    enabled: isOwner
  });

  const sync = useMutation({
    mutationFn: async () => {
      const response = await fetch(apiUrl("/api/admin/rich-menus/sync"), {
        method: "POST",
        credentials: "include"
      });
      if (!response.ok) throw new Error(await apiErrorMessage(response, "ซิงก์เมนูไม่สำเร็จ"));
      return (await response.json()) as SyncResult;
    },
    onSuccess: (result) => {
      const failed = result.failed.length;
      setNotice(
        `สร้าง ${result.created.length} เมนู · ลบของเดิม ${result.deleted.length} · ผูกให้ผู้ใช้ ${result.linked.length} คน` +
          (failed ? ` · ล้มเหลว ${failed} คน` : "")
      );
      void queryClient.invalidateQueries({ queryKey: ["rich-menus"] });
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "ซิงก์เมนูไม่สำเร็จ")
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
        <p className="text-danger">{query.error instanceof Error ? query.error.message : "โหลดเมนูไม่ได้"}</p>
      </div>
    );
  }

  const { menus, syncedAt, lineConfigured, liffConfigured } = query.data;

  return (
    <div className="mx-auto w-full max-w-2xl p-4 sm:p-6">
      <Link to="/admin" className="text-sm text-muted underline">
        ← กลับหน้าผู้ดูแล
      </Link>
      <h1 className="mt-3 text-2xl font-bold">เมนู LINE ตามบทบาท</h1>
      <p className="mt-1 text-sm text-muted">
        แผงเมนูเหนือคีย์บอร์ดในแชท LINE — แต่ละคนเห็นเมนูตามสิทธิ์ของตัวเอง (ไม่กินโควตาข้อความ)
      </p>

      {!lineConfigured || !liffConfigured ? (
        <p className="mt-4 rounded-xl border border-warning p-3 text-sm text-warning">
          {!lineConfigured ? "ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN · " : ""}
          {!liffConfigured ? "ยังไม่ได้ตั้งค่า LIFF_ID (ปุ่มจะเปิดไปไม่ได้)" : ""}
        </p>
      ) : null}

      <section className="mt-5 space-y-3">
        {menus.map((menu) => (
          <div key={menu.key} className="rounded-xl border border-border p-4">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold">{ROLE_LABEL[menu.key] ?? menu.key}</h2>
              <span className="text-xs text-muted">{menu.chatBarText}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {menu.labels.map((label, index) => (
                <span key={`${menu.key}-${label}`} className="rounded-lg bg-surface-secondary px-2 py-1 text-xs">
                  {label}
                  {menu.areas[index]?.action.type === "message" ? " (ข้อความ)" : ""}
                </span>
              ))}
            </div>
          </div>
        ))}
      </section>

      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={() => sync.mutate()}
          disabled={sync.isPending || !lineConfigured || !liffConfigured}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground disabled:opacity-60"
        >
          {sync.isPending ? "กำลังซิงก์…" : "ซิงก์เมนูกับ LINE"}
        </button>
        {notice ? <span className="text-xs text-muted">{notice}</span> : null}
      </div>

      <p className="mt-6 text-xs text-muted">
        {syncedAt
          ? `ซิงก์ล่าสุด ${new Date(syncedAt).toLocaleString("th-TH")}`
          : "ยังไม่เคยซิงก์ — เมนูจะยังไม่ปรากฏในแชท"}
        {" · "}การเปลี่ยนสิทธิ์มีผลเมื่อผู้ใช้เปิดแอปครั้งถัดไป
      </p>
    </div>
  );
}
