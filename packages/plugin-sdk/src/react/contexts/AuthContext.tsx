import { createContext } from 'react';

type AuthStatus = 'loading' | 'setup-required' | 'unauthenticated' | 'password-must-change' | 'authenticated';

interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  email: string | null;
  scopes: string[];
  providerId: string;
}

export interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  csrfToken: string | null;
  hasScope: (scope: string) => boolean;
  logout: () => Promise<void>;
  refreshAuth: () => Promise<void>;
}

export { type AuthUser, type AuthStatus };

export const AuthContext = createContext<AuthState | null>(null);
