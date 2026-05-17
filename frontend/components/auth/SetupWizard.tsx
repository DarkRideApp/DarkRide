import { useState, type FormEvent } from 'react';
import { useAuth } from '@darkrideapp/plugin-sdk/react';

export function SetupWizard() {
  const { refreshAuth } = useAuth();
  const [token, setToken] = useState(() => {
    // Pre-fill from URL ?token=... if present
    const params = new URLSearchParams(window.location.search);
    return params.get('token') || '';
  });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

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
      const res = await fetch('/v1/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, username, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Setup failed');
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
        <h1 className="auth-title">Welcome to DarkRide</h1>
        <p className="auth-subtitle">Create your admin account to get started.</p>

        {error && <div className="auth-error">{error}</div>}

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="form-group">
            <label htmlFor="setup-token">Setup token</label>
            <input
              id="setup-token"
              className="form-input"
              type="text"
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder="From your server logs"
              required
            />
            <p className="form-hint">
              The setup token was printed to your server logs when DarkRide started.
            </p>
          </div>
          <div className="form-group">
            <label htmlFor="setup-username">Username</label>
            <input
              id="setup-username"
              className="form-input"
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="setup-password">Password</label>
            <input
              id="setup-password"
              className="form-input"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={12}
              required
            />
            <p className="form-hint">At least 12 characters</p>
          </div>
          <div className="form-group">
            <label htmlFor="setup-confirm">Confirm password</label>
            <input
              id="setup-confirm"
              className="form-input"
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
          <button type="submit" className="btn btn-primary auth-btn" disabled={loading}>
            {loading ? 'Creating...' : 'Create admin account'}
          </button>
        </form>
      </div>
    </div>
  );
}
