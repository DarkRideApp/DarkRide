import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { AuthContext, type AuthState, type AuthStatus, type AuthUser } from '../contexts/AuthContext';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);

  const refreshAuth = useCallback(async () => {
    try {
      const res = await fetch('/v1/auth/me');
      const data = await res.json();

      if (data.authenticated) {
        setUser(data.user);
        setCsrfToken(data.csrfToken || null);
        if (data.passwordMustChange) {
          setStatus('password-must-change');
        } else {
          setStatus('authenticated');
        }
      } else if (data.setupRequired) {
        setStatus('setup-required');
      } else {
        setStatus('unauthenticated');
      }
    } catch {
      // Network error (server not ready) — stay in loading state and retry.
      // fetch() only throws on network failures; HTTP 401/403 are handled
      // above via response parsing. So this catch only fires when the
      // server is unreachable, not when the user is unauthenticated.
      setTimeout(() => refreshAuth(), 2000);
    }
  }, []);

  useEffect(() => {
    refreshAuth();
  }, [refreshAuth]);

  const hasScope = useCallback((scope: string): boolean => {
    if (!user) return false;
    if (user.scopes.includes('core.admin:*')) return true;
    if (user.scopes.includes(scope)) return true;
    // Check verb wildcard: core.settings:* covers core.settings:read
    const [area] = scope.split(':');
    if (user.scopes.includes(`${area}:*`)) return true;
    return false;
  }, [user]);

  const logout = useCallback(async () => {
    try {
      await fetch('/v1/auth/logout', {
        method: 'POST',
        headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {},
      });
    } catch { /* ignore */ }
    setUser(null);
    setCsrfToken(null);
    setStatus('unauthenticated');
  }, [csrfToken]);

  const value: AuthState = { status, user, csrfToken, hasScope, logout, refreshAuth };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
