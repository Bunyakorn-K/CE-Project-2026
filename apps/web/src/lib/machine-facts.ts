import { freshnessMeta, type FreshnessMeta } from "./machine-status";

/**
 * Presentation of the two facts the Digital Twin card renders about a machine's
 * cycle count and its evidence age.
 *
 * Both of these used to assert things the payload did not support:
 *
 * - The cycle source read "ไม่มีแถว usage" for anything that was not a positive
 *   count, which told a technician investigating a busy machine that it had no
 *   usage at all. The API now distinguishes usage rows that exist but none
 *   counted (a real zero), no usage rows at all, and a source with no usage-row
 *   concept — three different claims.
 * - The twin carried no freshness at all, so a six-day-old `running` rendered
 *   exactly like a live one. Freshness is a separate axis from status.
 */

export type CycleCountSource = "usage_row" | "unavailable" | "unknown" | undefined;

export type MachineCycleFacts = { value: string; source: string };

export function machineCycleFacts(machine: {
  cycleCount: number | null | undefined;
  cycleCountSource?: CycleCountSource;
}): MachineCycleFacts {
  const source = machine.cycleCountSource;
  // A count with no stated basis is a number the reader cannot check, so it is
  // not shown at all. Same rule the demo dashboard follows for usageRowsInRange.
  if (source !== "usage_row") {
    return {
      value: "ไม่พร้อมใช้งาน",
      source:
        source === "unavailable"
          ? "ไม่มีแถว usage ในช่วงนี้"
          : source === "unknown"
            ? "แหล่งข้อมูลนี้ไม่มีข้อมูลแถว usage"
            : "ไม่ทราบที่มาของจำนวนรอบ"
    };
  }
  const count = machine.cycleCount;
  return {
    // Zero is a real, reportable answer here: the machine has usage rows and
    // none of them reached a counted state.
    value: typeof count === "number" && Number.isFinite(count) ? count.toLocaleString("th-TH") : "ไม่พร้อมใช้งาน",
    source: "นับจากแถว usage"
  };
}

/**
 * The freshness pill for the twin card, or null when the payload carries no
 * freshness field at all.
 *
 * Null is the right answer for an older API build: rendering nothing asserts
 * nothing, whereas defaulting to `fresh` would invent a currency claim.
 */
export function machineFreshnessRow(freshness: string | null | undefined): FreshnessMeta | null {
  if (!freshness) return null;
  return freshnessMeta(freshness);
}

/** A machine as the floor only needs its kind to be grouped and rendered. */
export type FloorMachine = { machineCode?: string; machineKind?: string; cycleCount?: number | null };

export type MachineFloorGroup<T> = { title: string; machines: T[] };

const WASHERS = "เครื่องซักผ้า";
const DRYERS = "เครื่องอบผ้า";
const OTHERS = "เครื่องประเภทอื่น";

/**
 * Splits a floor into the groups it renders.
 *
 * The floor summary states `เครื่องทั้งหมด` over the whole payload while the grid
 * rendered only washers and dryers, so any machine of another kind counted
 * toward the total and produced no card. `OTHERS` closes that gap: rendered now
 * matches stated. An empty group is dropped rather than rendering a heading with
 * nothing under it, which is what the old `MachineGroup` did.
 */
export function machineFloorGroups<T extends FloorMachine>(machines: T[]): MachineFloorGroup<T>[] {
  const washers = machines.filter((machine) => machine.machineKind === "washer");
  const dryers = machines.filter((machine) => machine.machineKind === "dryer");
  const others = machines.filter((machine) => machine.machineKind !== "washer" && machine.machineKind !== "dryer");

  return [
    { title: WASHERS, machines: washers },
    { title: DRYERS, machines: dryers },
    { title: OTHERS, machines: others }
  ].filter((group) => group.machines.length > 0);
}

export type MachineFloorCycles =
  | { kind: "complete"; value: string; coverage: string }
  | { kind: "partial"; value: string; coverage: string }
  | { kind: "unavailable"; value: string; coverage: string };

/**
 * The floor's cycle total, with its coverage stated.
 *
 * Summing only the machines that reported a count and printing the result under
 * `เครื่องทั้งหมด` presented one machine's cycles as the floor's. `partial`
 * keeps the sum but names how many machines it rests on, so a reader can tell a
 * floor total from a partial one.
 */
export function machineFloorCycles(machines: FloorMachine[]): MachineFloorCycles {
  const countable = machines.filter(
    (machine) => typeof machine.cycleCount === "number" && Number.isFinite(machine.cycleCount)
  );
  const total = machines.length.toLocaleString("th-TH");

  if (machines.length === 0 || countable.length === 0) {
    return { kind: "unavailable", value: "ไม่พร้อมใช้งาน", coverage: "ไม่ทราบจำนวนเครื่องที่นับได้" };
  }

  const sum = countable.reduce((totalCycles, machine) => totalCycles + (machine.cycleCount ?? 0), 0);
  const value = sum.toLocaleString("th-TH");

  if (countable.length === machines.length) {
    return { kind: "complete", value, coverage: `ครบทั้ง ${total} เครื่อง` };
  }
  return { kind: "partial", value, coverage: `นับได้ ${countable.length.toLocaleString("th-TH")} จาก ${total} เครื่อง` };
}
