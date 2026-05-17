import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '@darkrideapp/plugin-sdk/react';

interface ClientInfo {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  software_id?: string | null;
  software_version?: string | null;
}

export default function ConsentPage() {
  const [params] = useSearchParams();
  const { csrfToken } = useAuth();
  const [client, setClient] = useState<ClientInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const clientId = params.get('client_id') ?? '';
  const redirectUri = params.get('redirect_uri') ?? '';
  const scope = params.get('scope') ?? 'mcp';
  const state = params.get('state') ?? '';
  const codeChallenge = params.get('code_challenge') ?? '';
  const codeChallengeMethod = params.get('code_challenge_method') ?? '';

  useEffect(() => {
    if (!clientId) { setErr('missing client_id'); return; }
    fetch(`/oauth/client-info/${encodeURIComponent(clientId)}`)
      .then(async (res) => {
        if (res.status >= 400) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data) => setClient(data))
      .catch((e: any) => setErr(String(e.message ?? e)));
  }, [clientId]);

  async function submit(allow: boolean) {
    setSubmitting(true);
    const body = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      allow: String(allow),
    });
    try {
      // The endpoint returns { location } rather than a 302: the client's
      // redirect_uri is usually a loopback listener with no CORS headers, so
      // letting fetch follow a cross-origin 302 would fail with "Failed to
      // fetch". We navigate the browser top-level instead.
      const res = await fetch('/oauth/authorize/consent', {
        method: 'POST',
        body,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
        },
      });
      const json = await res.json().catch(() => ({} as any));
      if (!res.ok) {
        setErr(json?.error ?? `HTTP ${res.status}`);
        setSubmitting(false);
        return;
      }
      if (!json?.location) {
        setErr('consent response missing location');
        setSubmitting(false);
        return;
      }
      window.location.href = json.location;
    } catch (e: any) {
      setErr(String(e.message ?? e));
      setSubmitting(false);
    }
  }

  if (err) return <div style={{ padding: 24, color: 'var(--danger)' }}>Error: {err}</div>;
  if (!client) return <div style={{ padding: 24 }}>Loading...</div>;

  return (
    <div style={{
      maxWidth: 520, margin: '64px auto', padding: 24,
      background: 'var(--bg-secondary)', borderRadius: 8,
      border: '1px solid var(--border-color)',
    }}>
      <h1 style={{ marginBottom: 8 }}>{client.client_name}</h1>
      <p style={{ color: 'var(--text-muted)', marginBottom: 24 }}>
        wants to access DarkRide on your behalf.
      </p>

      <h3 style={{ marginBottom: 8 }}>Requested access</h3>
      <ul style={{ marginBottom: 24, paddingLeft: 20 }}>
        {scope.split(/\s+/).filter(Boolean).map(s => (
          <li key={s} style={{ marginBottom: 8 }}>
            <strong>{s}</strong> — Call DarkRide MCP tools on your behalf, with your current permissions.
          </li>
        ))}
      </ul>

      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 24 }}>
        You can revoke this authorization anytime from your profile.
      </p>

      <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="btn"
          disabled={submitting}
          onClick={() => submit(false)}
        >
          Deny
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={submitting}
          onClick={() => submit(true)}
        >
          {submitting ? 'Processing...' : 'Allow'}
        </button>
      </div>
    </div>
  );
}
