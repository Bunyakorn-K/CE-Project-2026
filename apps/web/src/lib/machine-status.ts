/** One status vocabulary for both the Digital Twin (which reads the API
 *  `MachineStatus` union) and the live machine page (which also sees raw IRIS
 *  demo/live state words). Every known fact_machine_usage enum gets a Thai
 *  label; `paid` and `finished` stay distinct because the API now reports them
 *  as distinct values and the ML contract counts both. */
export type MachineStatusMeta = { label: string; className: string };

const STATUSES: Record<string, MachineStatusMeta> = {
  running: { label: "กำลังใช้งาน", className: "status-pill--success" },
  washing: { label: "กำลังซัก", className: "status-pill--success" },
  drying: { label: "กำลังอบ", className: "status-pill--success" },
  paid: { label: "ชำระแล้ว", className: "status-pill--warning" },
  // "finished" is a completed cycle, not a payment receipt. Upstream still
  // needs to say what distinguishes it from `paid`; until then the labels
  // describe the enum name and do not claim a payment.
  finished: { label: "จบรอบแล้ว", className: "status-pill--success" },
  pending: { label: "รอชำระ", className: "status-pill--warning" },
  pending_payment: { label: "รอชำระ", className: "status-pill--warning" },
  cancelled: { label: "ยกเลิกแล้ว", className: "status-pill--warning" },
  admitted: { label: "เริ่มรอบแล้ว", className: "status-pill--success" },
  idle: { label: "ว่าง", className: "status-pill--neutral" },
  ready: { label: "ว่าง", className: "status-pill--neutral" },
  offline: { label: "ออฟไลน์", className: "status-pill--danger" },
  unknown: { label: "ไม่ทราบสถานะ", className: "status-pill--neutral" }
};

const UNKNOWN: MachineStatusMeta = { label: "ไม่ทราบสถานะ", className: "status-pill--neutral" };

export function machineStatusMeta(status: string | null | undefined): MachineStatusMeta {
  if (!status) return UNKNOWN;
  // An unrecognized enum is shown verbatim rather than hidden behind
  // "unknown": docs/03_data_contracts/data_contracts.md wants an unknown value
  // flagged for data quality, not swallowed.
  return STATUSES[status] ?? { label: status, className: "status-pill--neutral" };
}
