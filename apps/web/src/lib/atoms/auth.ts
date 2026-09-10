import { createContext, useContext } from "react";
import { atom, useAtom } from "jotai";

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  roles: string[];
  grants: Array<{ role: string; branchId: string | null }>;
};

export const authAtom = atom<AuthUser | null>(null);

/** Convenience hook — pairs with the TanStack Router auth context in routes. */
export function useAuth() {
  const [user, setUser] = useAtom(authAtom);
  return {
    user,
    setUser,
    signOut: () => setUser(null),
    isOwner: user?.grants.some((g) => g.role === "owner") ?? false
  };
}

/** Router-provided auth context (set in beforeLoad of _authenticated). */
export const AuthContext = createContext<{ user: AuthUser | null; isAuthenticated: boolean }>({
  user: null,
  isAuthenticated: false
});

export function useRouterAuth() {
  return useContext(AuthContext);
}