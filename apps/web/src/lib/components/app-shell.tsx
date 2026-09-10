import { useAuth } from "../atoms/auth";
import { useAbility } from "../abilities";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: "📊" },
  { href: "/machines", label: "Machines", icon: "🧺" },
  { href: "/analytics", label: "Analytics", icon: "📈" }
];

const adminNavItems = [
  { href: "/admin", label: "Admin", icon: "⚙️" },
  { href: "/admin/ai", label: "AI Settings", icon: "🤖" }
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, signOut } = useAuth();
  const pathname = window.location.pathname;
  const grants = user?.grants ?? [];

  return (
    <div className="min-h-screen bg-background text-foreground">
      <nav className="sticky top-0 z-40 border-b border-divider bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold">LaundroTwin</span>
            <span className="text-xs text-default-400">Backoffice</span>
          </div>
          <div className="hidden flex-1 gap-1 sm:flex">
            {navItems.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
                  pathname === item.href
                    ? "bg-primary/10 text-primary"
                    : "text-default-500 hover:bg-default-100"
                }`}
              >
                <span>{item.icon}</span>
                <span>{item.label}</span>
              </a>
            ))}
            {grants.some((g: { role: string }) => g.role === "owner") && adminNavItems.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
                  pathname === item.href
                    ? "bg-primary/10 text-primary"
                    : "text-default-500 hover:bg-default-100"
                }`}
              >
                <span>{item.icon}</span>
                <span>{item.label}</span>
              </a>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-default-500 sm:inline">{user?.name}</span>
            <button
              onClick={() => void signOut()}
              className="rounded-lg px-3 py-2 text-sm text-default-500 hover:bg-default-100"
            >
              Sign out
            </button>
          </div>
        </div>
      </nav>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}