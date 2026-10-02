import { Link } from "@tanstack/react-router";
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

/**
 * Revoke the Better Auth session.
 *
 * Exported for its own test rather than inlined: the 415 that made sign-out a
 * no-op is invisible to every other assertion about this component — the button
 * is present, clickable and hit-testable at every width, and the app still
 * navigates to `/login`, so both a layout suite and an end-to-end click read
 * green while the session was never revoked. Only the request itself carries
 * that difference, so it is a named function with a test that reads its headers.
 */
export function signOutRequest(): Promise<Response> {
  return fetch(apiUrl("/api/auth/sign-out"), {
    method: "POST",
    // Better Auth's sign-out handler parses a JSON body. Without this header the
    // request is refused 415 before the handler runs, so nothing clears the
    // session cookie and the browser stays signed in.
    headers: { "content-type": "application/json" },
    body: "{}",
    credentials: "include"
  });
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, signOut, isOwner } = useAuth();
  const visibleItems = isOwner ? [...navItems, ...ownerItems] : navItems;

  async function handleSignOut() {
    await Promise.allSettled([
      // The content-type is load-bearing, not decoration — see `signOutRequest`.
      signOutRequest(),
      fetch(apiUrl("/api/auth/liff/logout"), { method: "POST", credentials: "include" })
    ]);
    signOut();
    // A full page load, not a router navigation, and for a reason that is about
    // the LINE gate rather than this component. `LiffGate` sits ABOVE
    // RouterProvider and probes the session once, on mount, with `[]` deps — so a
    // client-side navigation leaves its `sessionUsable` flag describing the
    // session as it was *before* the sign-out. Arriving at /login with that
    // stale `true` is exactly the state `decideAfterSignIn` redirects on, so the
    // gate carried the browser straight back to /dashboard and a visitor who had
    // just signed out was put straight back into the product. Reloading remounts
    // the gate, which re-probes and finds the revoked session — so the sign-out
    // is the last word rather than the first move in a redirect.
    window.location.replace("/login");
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
