#!/usr/bin/env node
// LaundryTwin one-shot alert sweep: fetch recent IRIS alerts and push LINE
// notifications. Safe to run repeatedly (idempotency + cooldown live in the
// alert_notification table).
//
// Config via env (see .env.example): IRIS_READ_BASE_URL,
// IRIS_LAUNDRYTWIN_READ_API_KEY, LINE_CHANNEL_ACCESS_TOKEN; optional
// ALERT_COOLDOWN_MS (default 3600000 = 1h).

import { initializeDatabase } from "../src/db";
import { createIrisReadClient } from "../src/iris-read-client";
import { LineAdapter } from "../src/bot/line-adapter";
import { runAlertSweep } from "../src/alert-engine";

function parsePositiveInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function main(): Promise<void> {
  initializeDatabase();
  const iris = createIrisReadClient();
  const now = new Date();
  const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const alerts = await iris.getAlerts({ from: from.toISOString(), to: now.toISOString() });
  const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const summary = await runAlertSweep(alerts.alerts, {
    adapter: new LineAdapter(lineToken),
    adapterAvailable: Boolean(lineToken),
    cooldownMs: parsePositiveInt("ALERT_COOLDOWN_MS", 60 * 60 * 1000)
  });
  console.log(
    JSON.stringify(
      {
        window: { from: from.toISOString(), to: now.toISOString() },
        fetched: alerts.alerts.length,
        lineConfigured: Boolean(lineToken),
        summary
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error("Alert sweep failed:", error);
  process.exit(1);
});
