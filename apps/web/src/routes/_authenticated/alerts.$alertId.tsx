import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiErrorMessage, apiUrl } from "../../lib/api/client";
import {
  deliveryLine,
  detailRows,
  rawEvidenceJson,
  severityMeta,
  type AlertDetail
} from "../../lib/alert-detail-view";

export const Route = createFileRoute("/_authenticated/alerts/$alertId")({
  component: AlertDetailPage
});

async function fetchAlert(alertId: string): Promise<AlertDetail> {
  const response = await fetch(apiUrl(`/api/alerts/${encodeURIComponent(alertId)}`), { credentials: "include" });
  if (!response.ok) throw new Error(await apiErrorMessage(response, "เปิดการแจ้งเตือนนี้ไม่ได้"));
  const body = (await response.json()) as { alert: AlertDetail };
  return body.alert;
}

const toneClass: Record<string, string> = {
  critical: "bg-danger-100 text-danger-700",
  warning: "bg-warning-100 text-warning-700",
  info: "bg-primary-100 text-primary-700"
};

/**
 * One alert, the page a LINE card opens.
 *
 * It shows the alert AS IT WAS SENT — the stored message and evidence, not a
 * re-read of the warehouse — because the reader tapped a notification and is
 * asking "what did you tell me, and why". The raw evidence is printed under the
 * formatted rows so nothing can be quietly dropped from the summary.
 */
function AlertDetailPage() {
  const { alertId } = Route.useParams();
  const [ackState, setAckState] = useState<"idle" | "saving" | "done" | "error">("idle");
  const [ackError, setAckError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["alert", alertId],
    queryFn: () => fetchAlert(alertId)
  });

  if (query.isLoading) {
    return <div className="flex min-h-[60vh] items-center justify-center text-muted">กำลังโหลด…</div>;
  }

  if (query.isError || !query.data) {
    const message = query.error instanceof Error ? query.error.message : "เปิดการแจ้งเตือนนี้ไม่ได้";
    return (
      <div className="mx-auto w-full max-w-2xl p-6">
        <p className="text-danger">{message}</p>
        <p className="mt-2 text-sm text-muted">
          ลิงก์นี้เปิดได้เฉพาะผู้ที่ได้รับการแจ้งเตือน หรือผู้ที่มีสิทธิ์ในสาขาของการแจ้งเตือนนั้น
        </p>
        <Link to="/dashboard" className="mt-4 inline-block text-accent underline">
          กลับหน้าแดชบอร์ด
        </Link>
      </div>
    );
  }

  const alert = query.data;
  const severity = severityMeta(alert.severity);
  const delivery = deliveryLine(alert);
  const rows = detailRows(alert);

  async function acknowledge() {
    if (!alert.branchId) return;
    setAckState("saving");
    setAckError(null);
    try {
      const response = await fetch(apiUrl(`/api/alerts/${encodeURIComponent(alert.id)}/acknowledge`), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ branchId: alert.branchId })
      });
      if (!response.ok) {
        setAckError(await apiErrorMessage(response, "รับทราบไม่สำเร็จ"));
        setAckState("error");
        return;
      }
      setAckState("done");
    } catch {
      setAckError("รับทราบไม่สำเร็จ");
      setAckState("error");
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl p-4 sm:p-6">
      <Link to="/dashboard" className="text-sm text-muted underline">
        ← กลับแดชบอร์ด
      </Link>

      <header className="mt-3 flex flex-col gap-2">
        <span className={`w-fit rounded-full px-3 py-1 text-tiny font-semibold ${toneClass[severity.tone]}`}>
          {severity.label}
        </span>
        <h1 className="text-2xl font-bold leading-snug">{alert.title}</h1>
        <p className={delivery.tone === "failed" ? "text-small text-danger" : "text-small text-default-500"}>
          {delivery.text}
        </p>
      </header>

      <section className="mt-5 rounded-xl border border-border p-4">
        <h2 className="mb-3 text-sm font-semibold text-muted">ข้อมูลที่ใช้ตัดสิน</h2>
        <dl className="grid gap-2">
          {rows.map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-4 border-b border-border pb-2 last:border-0">
              <dt className="text-sm text-muted">{row.label}</dt>
              <dd className="text-right text-sm font-semibold break-all">{row.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mt-4 rounded-xl border border-border p-4">
        <h2 className="mb-2 text-sm font-semibold text-muted">ข้อความที่ส่งไป</h2>
        <pre className="whitespace-pre-wrap break-words text-sm text-foreground">{alert.message}</pre>
      </section>

      <section className="mt-4 rounded-xl border border-border p-4">
        <h2 className="mb-2 text-sm font-semibold text-muted">ข้อมูลดิบ (evidence)</h2>
        <pre className="max-h-72 overflow-auto rounded-lg bg-surface-secondary p-3 text-xs">{rawEvidenceJson(alert)}</pre>
      </section>

      {alert.branchId ? (
        <div className="mt-5">
          <button
            type="button"
            onClick={acknowledge}
            disabled={ackState === "saving" || ackState === "done"}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground disabled:opacity-60"
          >
            {ackState === "done" ? "รับทราบแล้ว" : ackState === "saving" ? "กำลังบันทึก…" : "รับทราบการแจ้งเตือนนี้"}
          </button>
          {ackState === "done" ? (
            <p className="mt-2 text-xs text-muted">ระบบจะไม่แจ้งเตือนซ้ำสำหรับรายการนี้</p>
          ) : null}
          {ackError ? <p className="mt-2 text-xs text-danger">{ackError}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
