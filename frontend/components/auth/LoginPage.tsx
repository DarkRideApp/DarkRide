import { useState, useEffect, type FormEvent } from 'react';
import { useAuth } from '@darkrideapp/plugin-sdk/react';

interface Provider {
  id: string;
  displayName: string;
  flow: 'credentials' | 'redirect';
  credentialFields?: Array<{ name: string; label: string; type: string }>;
}

export function LoginPage() {
  const { refreshAuth } = useAuth();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('/v1/auth/providers')
      .then(r => r.json())
      .then(d => setProviders(d.data || []))
      .catch(() => {});
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: 'core.local',
          credentials: { username, password },
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Login failed');
        setLoading(false);
        return;
      }

      // Success — refresh auth state to flip the guard
      await refreshAuth();

      // If the session cookie didn't stick (e.g. a Secure cookie served over
      // plain HTTP is silently dropped by the browser), the guard never flips
      // and we'd sit on the spinner forever. Detect it and surface an error.
      const me = await fetch('/v1/auth/me').then(r => r.json()).catch(() => null);
      if (!me?.authenticated) {
        setError('Signed in, but the browser did not store the session cookie — check the server\'s cookie/TLS configuration.');
        setLoading(false);
        return;
      }

      // Redirect to ?next= if it's a safe relative URL, otherwise go to root.
      // Uses window.location because LoginPage renders outside the BrowserRouter context.
      const urlParams = new URLSearchParams(window.location.search);
      const next = urlParams.get('next');
      if (next && next.startsWith('/') && !next.startsWith('//')) {
        window.location.href = next;
      }
    } catch {
      setError('Network error — check the server is running');
      setLoading(false);
    }
  };

  const redirectProviders = providers.filter(p => p.flow === 'redirect');

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="auth-title">DarkRide</h1>
        <p className="auth-subtitle">Sign in to continue</p>

        {error && <div className="auth-error">{error}</div>}

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="form-group">
            <label htmlFor="login-username">Username</label>
            <input
              id="login-username"
              className="form-input"
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              className="form-input"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          <button type="submit" className="btn btn-primary auth-btn" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>

        {redirectProviders.length > 0 && (
          <>
            <div className="auth-divider"><span>or</span></div>
            {redirectProviders.map(p => (
              <a
                key={p.id}
                href={`/v1/auth/initiate?providerId=${p.id}`}
                className="btn btn-secondary auth-btn"
              >
                Sign in with {p.displayName}
              </a>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
