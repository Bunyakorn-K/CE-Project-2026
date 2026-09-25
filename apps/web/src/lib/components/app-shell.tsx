import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useAuth } from "../atoms/auth";
import { apiUrl } from "../api/client";

type NavIconName = "dashboard" | "machines" | "analytics" | "playground" | "admin" | "ai" | "menu" | "logout";
type NavItem = { to: "/dashboard" | "/machines" | "/analytics" | "/playground" | "/admin" | "/admin/ai"; label: string; icon: NavIconName };

const navItems: NavItem[] = [
  { to: "/dashboard", label: "ภาพรวม", icon: "dashboard" },
  { to: "/machines", label: "เครื่องซักผ้า", icon: "machines" },
  { to: "/analytics", label: "วิเคราะห์", icon: "analytics" }
];
const ownerItems: NavItem[] = [
  { to: "/playground", label: "Playground", icon: "playground" },
  { to: "/admin", label: "ผู้ดูแล", icon: "admin" },
  { to: "/admin/ai", label: "ตั้งค่า AI", icon: "ai" }
];

function NavIcon({ name }: { name: NavIconName }) {
  const paths: Record<NavIconName, ReactNode> = {
    dashboard: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    machines: <><path d="M6 3h12v18H6z" /><path d="M9 7h6M9 17h6M9 11h6" /></>,
    analytics: <><path d="M4 19V5M4 19h17" /><path d="m7 15 3-4 3 2 5-7" /></>,
    playground: <><path d="m9 3 6 0 0 6 6 0 0 6-6 0 0 6-6 0 0-6-6 0 0-6 6 0z" /></>,
    admin: <><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /><circle cx="12" cy="12" r="5" /></>,
    ai: <><path d="M6 4h12v12H6z" /><path d="M9 19h6M9 22h6M9 8h6M9 12h4" /></>,
    menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
    logout: <><path d="M10 5H5v14h5M14 8l4 4-4 4M9 12h9" /></>
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function NavigationLink({ item }: { item: NavItem }) {
  return <Link to={item.to} className="nav-link" activeOptions={{ exact: item.to === "/admin" }} activeProps={{ "aria-current": "page", "data-active": "true" }}><NavIcon name={item.icon} /><span>{item.label}</span></Link>;
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, signOut, isOwner } = useAuth();
  const navigate = useNavigate();
  const visibleItems = isOwner ? [...navItems, ...ownerItems] : navItems;

  async function handleSignOut() {
    await Promise.allSettled([
      fetch(apiUrl("/api/auth/sign-out"), { method: "POST", credentials: "include" }),
      fetch(apiUrl("/api/auth/liff/logout"), { method: "POST", credentials: "include" })
    ]);
    signOut();
    void navigate({ to: "/login", replace: true });
  }

  return (
    <div className="app-shell">
      <nav className="app-topbar" aria-label="เมนูหลัก">
        <div className="app-topbar-inner">
          <Link to="/dashboard" className="brand-lockup" aria-label="LaundryTwin ภาพรวมการดำเนินงาน">
            <span className="brand-symbol brand-symbol--text">LT</span>
            <span><span className="brand-name">LaundryTwin</span><span className="brand-context">Operations workspace</span></span>
          </Link>
          <div className="primary-nav">{visibleItems.map((item) => <NavigationLink key={item.to} item={item} />)}</div>
          <div className="account-actions">
            <span className="account-name">{user?.name}</span>
            <button type="button" onClick={() => void handleSignOut()} className="signout-button" aria-label="ออกจากระบบ"><span>ออกจากระบบ</span><NavIcon name="logout" /></button>
            <details className="mobile-nav">
              <summary className="mobile-nav-summary" aria-label="เปิดเมนู"><NavIcon name="menu" /><span>เมนู</span></summary>
              <div className="mobile-nav-panel">{visibleItems.map((item) => <NavigationLink key={item.to} item={item} />)}</div>
            </details>
          </div>
        </div>
      </nav>
      <main className="content-frame">{children}</main>
    </div>
  );
}
