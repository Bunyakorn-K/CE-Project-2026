import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/admin/")({
  component: AdminHome
});

function AdminHome() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold">Admin</h1>
      <p className="text-default-500">
        Access approvals and AI console live under this section.
      </p>
      <nav className="flex flex-col gap-2">
        <a href="/admin/ai" className="w-fit rounded-lg bg-default-100 px-4 py-2 text-sm hover:bg-default-200">
          → AI Console
        </a>
      </nav>
    </div>
  );
}