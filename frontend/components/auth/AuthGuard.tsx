import { useAuth } from '@darkrideapp/plugin-sdk/react';
import { LoginPage } from './LoginPage';
import { SetupWizard } from './SetupWizard';
import { ForcePasswordChange } from './ForcePasswordChange';
import type { ReactNode } from 'react';

export function AuthGuard({ children }: { children: ReactNode }) {
  const { status } = useAuth();

  // Check for a claim token in the URL — if present, show the password-set
  // form even when unauthenticated (the token IS the auth for this flow)
  const hasClaimToken = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).has('token');

  switch (status) {
    case 'loading':
      return (
        <div className="auth-loading">
          <div className="auth-spinner" />
          <p>Loading...</p>
        </div>
      );
    case 'setup-required':
      return <SetupWizard />;
    case 'unauthenticated':
      // Claim URL flow: user has a ?token= param → show password-set form
      if (hasClaimToken) return <ForcePasswordChange />;
      return <LoginPage />;
    case 'password-must-change':
      return <ForcePasswordChange />;
    case 'authenticated':
      return <>{children}</>;
  }
}
