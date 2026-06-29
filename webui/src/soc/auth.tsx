/**
 * Auth + RBAC React context for the SOC console (Wave 1).
 *
 * Loads GET /api/auth/me (session + role) and GET /api/roles (the permission
 * matrix) once on mount, and exposes a `hasPermission(resource, action)` helper the
 * whole app uses to gate nav, routes and actions.
 *
 * Back-compat is preserved end-to-end:
 *   - auth DISABLED                → `authEnabled=false`, hasPermission() === true.
 *   - auth ON but RBAC disabled    → backend reports the role as `super_admin`, so
 *                                    the matrix grants everything (and we also short-
 *                                    circuit `rbacEnabled=false` → allow).
 *   - auth ON + RBAC ON            → hasPermission consults the matrix for the role.
 *
 * The provider also owns the login/logout transitions so App.tsx can stay thin.
 */
import * as React from 'react';
import { api, setUnauthorizedHandler } from '@/lib/api';
import type { AuthMe, RolesResponse, UserRole } from '@/lib/types';

export interface AuthContextValue {
  /** Whether the backend has auth enforcement turned on. */
  authEnabled: boolean;
  /** Whether RBAC is enforced (false → every authenticated user is super_admin). */
  rbacEnabled: boolean;
  /** True when allowed to use the console (auth off, or a valid session). */
  isAuthenticated: boolean;
  /** The signed-in username (or null when auth is off / unauthenticated). */
  username: string | null;
  /** The signed-in user's role (or null). */
  role: UserRole | string | null;
  /** Whether the current user must change their password before continuing. */
  mustChangePassword: boolean;
  /** The role → resource → [actions] matrix from GET /api/roles (when available). */
  matrix: Record<string, Record<string, string[]>>;
  /** Whether the initial auth/roles load is still in flight. */
  loading: boolean;
  /** Re-fetch /api/auth/me (+ /api/roles); call after login / password change. */
  refresh: () => Promise<AuthMe | null>;
  /** Log out (best-effort) and reset the session to unauthenticated. */
  logout: () => Promise<void>;
  /**
   * Whether the current principal may perform `action` on `resource`.
   * Returns true when auth is off OR rbac is off (back-compat). When rbac is on it
   * consults the loaded matrix for the user's role (deny-by-default if unknown).
   */
  hasPermission: (resource: string, action: string) => boolean;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

const EMPTY_MATRIX: Record<string, Record<string, string[]>> = {};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [me, setMe] = React.useState<AuthMe | null>(null);
  const [matrix, setMatrix] = React.useState<Record<string, Record<string, string[]>>>(EMPTY_MATRIX);
  const [rbacEnabled, setRbacEnabled] = React.useState(false);
  const [loading, setLoading] = React.useState(true);

  const refresh = React.useCallback(async (): Promise<AuthMe | null> => {
    let next: AuthMe | null = null;
    try {
      next = await api.auth.me();
    } catch {
      next = null;
    }
    setMe(next);
    // Only fetch the matrix when there is an authenticated principal (the /roles
    // route requires a session). When auth is off, allow-all makes it unnecessary.
    if (next && next.authenticated && next.auth_enabled) {
      try {
        const roles: RolesResponse = await api.roles.get();
        setMatrix(roles.matrix ?? EMPTY_MATRIX);
        setRbacEnabled(Boolean(roles.rbac_enabled));
      } catch {
        setMatrix(EMPTY_MATRIX);
        setRbacEnabled(false);
      }
    } else {
      setMatrix(EMPTY_MATRIX);
      setRbacEnabled(false);
    }
    return next;
  }, []);

  React.useEffect(() => {
    let alive = true;
    void (async () => {
      await refresh();
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [refresh]);

  const logout = React.useCallback(async () => {
    try {
      await api.auth.logout();
    } catch {
      /* drop to unauthenticated regardless */
    }
    setMe((prev) => (prev ? { ...prev, authenticated: false, user: null } : prev));
    setMatrix(EMPTY_MATRIX);
    setRbacEnabled(false);
  }, []);

  const authEnabled = Boolean(me?.auth_enabled);
  const isAuthenticated = !authEnabled || Boolean(me?.authenticated);
  const role = me?.user?.role ?? null;
  const username = me?.user?.username ?? null;
  const mustChangePassword = Boolean(me?.user?.must_change_password);

  const hasPermission = React.useCallback(
    (resource: string, action: string): boolean => {
      // Auth off OR rbac off → everything allowed (mirrors the backend gate).
      if (!authEnabled || !rbacEnabled) return true;
      if (!role) return false;
      if (role === 'super_admin') return true;
      const actions = matrix[role]?.[resource];
      if (!actions) return false;
      return actions.includes('*') || actions.includes(action);
    },
    [authEnabled, rbacEnabled, role, matrix],
  );

  const value = React.useMemo<AuthContextValue>(
    () => ({
      authEnabled,
      rbacEnabled,
      isAuthenticated,
      username,
      role,
      mustChangePassword,
      matrix,
      loading,
      refresh,
      logout,
      hasPermission,
    }),
    [
      authEnabled,
      rbacEnabled,
      isAuthenticated,
      username,
      role,
      mustChangePassword,
      matrix,
      loading,
      refresh,
      logout,
      hasPermission,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

/** Access the auth/RBAC context. Throws if used outside <AuthProvider>. */
export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an <AuthProvider>');
  return ctx;
}

/** Register / clear the global 401 handler so a lapsed session bounces to login. */
export function useUnauthorizedRedirect(onUnauthorized: () => void, active: boolean): void {
  React.useEffect(() => {
    if (!active) {
      setUnauthorizedHandler(null);
      return undefined;
    }
    setUnauthorizedHandler(onUnauthorized);
    return () => setUnauthorizedHandler(null);
  }, [onUnauthorized, active]);
}
