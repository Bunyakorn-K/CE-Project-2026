import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/machines")({
  component: MachinesPage
});

function MachinesPage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold">Machines</h1>
      <p className="text-default-500">Coming soon — live machine states (branch-scoped).</p>
    </div>
  );
}