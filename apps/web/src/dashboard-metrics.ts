export function summarizeMachineActivity(
  machines: Array<{ state: string | null; freshness: "fresh" | "stale" | "unavailable" }>
) {
  return {
    running: machines.filter((machine) => /run|wash|dry|rinse|spin/i.test(machine.state ?? "")).length,
    ready: machines.filter((machine) => /idle|ready|available/i.test(machine.state ?? "")).length,
    unavailable: machines.filter((machine) => machine.freshness === "unavailable").length
  };
}
