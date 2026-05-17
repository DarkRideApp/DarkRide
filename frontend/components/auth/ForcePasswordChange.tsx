import { useState, type FormEvent } from 'react';
import { useAuth } from '@darkrideapp/plugin-sdk/react';

export function ForcePasswordChange() {
  const { refreshAuth, csrfToken } = useAuth();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Check if this is a claim-URL flow
  const params = new URLSearchParams(window.location.search);
  const claimToken = params.get('token');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (password.length < 12) {
      setError('Password must be at least 12 characters');
      return;
    }

    setLoading(true);

    try {
      let res: Response;
      if (claimToken) {
        // Claim URL flow
        res = await fetch('/v1/auth/claim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: claimToken, password }),
        });
      } else {
        // Already authenticated, forced password change
        res = await fetch('/v1/profile/password', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
          },
          body: JSON.stringify({ newPassword: password }),
        });
      }

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to set password');
        setLoading(false);
        return;
      }

      await refreshAuth();
    } catch {
      setError('Network error');
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="auth-title">Set your password</h1>
        <p className="auth-subtitle">
          {claimToken
            ? 'Welcome! Set your password to activate your account.'
            : 'You need to change your password before continuing.'}
        </p>

        {error && <div className="auth-error">{error}</div>}

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="form-group">
            <label htmlFor="pw-new">New password</label>
            <input
              id="pw-new"
              className="form-input"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="new-password"
              autoFocus
              minLength={12}
              required
            />
            <p className="form-hint">At least 12 characters</p>
          </div>
          <div className="form-group">
            <label htmlFor="pw-confirm">Confirm password</label>
            <input
              id="pw-confirm"
              className="form-input"
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
          <button type="submit" className="btn btn-primary auth-btn" disabled={loading}>
            {loading ? 'Setting...' : 'Set password'}
          </button>
        </form>
      </div>
    </div>
  );
}
