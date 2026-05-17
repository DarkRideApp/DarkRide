import { useContext } from 'react';
import { AuthContext, type AuthState } from '../contexts/AuthContext';

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** Returns null if outside AuthProvider — safe for components that optionally use auth */
export function useAuthOptional(): AuthState | null {
  return useContext(AuthContext);
}
