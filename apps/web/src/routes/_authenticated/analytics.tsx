import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/analytics")({
  component: AnalyticsPage
});

function AnalyticsPage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold">Analytics</h1>
      <p className="text-default-500">Coming soon — revenue/cycles/utilization/temperature/weather charts.</p>
    </div>
  );
}