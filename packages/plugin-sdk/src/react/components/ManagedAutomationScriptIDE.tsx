import React, { useEffect, useState, useCallback } from 'react';

/**
 * Drop-in IDE component a plugin embeds on its own page to expose a managed
 * automation to the operator. The same component serves every plugin —
 * keying is by (`pluginKey`, `scriptKey`), which is also how the host
 * REST endpoints route requests. Plugins supply the keys; the component
 * does the rest:
 *
 *   - GETs the managed-automation view (effective code + drift state).
 *   - When `allow_user_override` is false, renders a read-only viewer
 *     (or the plugin can simply omit the component on those scripts).
 *   - When override is permitted, shows an editor with Save + Reset
 *     buttons, plus a Drift banner with **Keep mine** and a 3-way diff
 *     when the plugin has shipped a new default that conflicts with
 *     the operator's local edits.
 *
 * The editor is a plain `<textarea>` to keep the SDK lean; plugins that
 * want Monaco / CodeMirror can wrap a custom render via the `editor`
 * prop. For most managed scripts the textarea is enough — the operator's
 * job here is small tweaks, not greenfield authoring.
 */

interface ManagedAutomationView {
  pluginKey: string;
  scriptKey: string;
  name: string;
  description?: string;
  code: string;
  currentDefaultCode: string;
  baseDefaultCode: string | null;
  isOverridden: boolean;
  allowUserOverride: boolean;
  hasDrift: boolean;
}

interface ThreeWayDiff {
  ancestor: string | null;
  incoming: string | null;
  yours: string;
}

export interface ManagedAutomationScriptIDEProps {
  pluginKey: string;
  scriptKey: string;
  /** Optional custom editor render. Receives current code + change handler. */
  editor?: (props: { code: string; onChange: (next: string) => void; readOnly: boolean }) => React.ReactNode;
  /** Optional className applied to the outer container. */
  className?: string;
}

/** Fetch helper that throws on non-2xx with the server's error message. */
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    throw new Error(json.error ?? `${method} ${path} failed (${res.status})`);
  }
  return json.data as T;
}

export function ManagedAutomationScriptIDE({
  pluginKey,
  scriptKey,
  editor,
  className,
}: ManagedAutomationScriptIDEProps): React.JSX.Element {
  const [view, setView] = useState<ManagedAutomationView | null>(null);
  const [draft, setDraft] = useState<string>('');     // edits not yet saved
  const [diff, setDiff] = useState<ThreeWayDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const basePath = `/v1/managed-automations/${encodeURIComponent(pluginKey)}/${encodeURIComponent(scriptKey)}`;

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const v = await api<ManagedAutomationView>('GET', basePath);
      setView(v);
      setDraft(v.code);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }, [basePath]);

  useEffect(() => { void refresh(); }, [refresh]);

  const save = async () => {
    if (!view) return;
    setBusy(true);
    setError(null);
    try {
      const v = await api<ManagedAutomationView>('PUT', `${basePath}/code`, { code: draft });
      setView(v);
      setDraft(v.code);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!view) return;
    if (!confirm('Reset to plugin default? Your local edits will be lost.')) return;
    setBusy(true);
    setError(null);
    try {
      const v = await api<ManagedAutomationView>('POST', `${basePath}/reset`);
      setView(v);
      setDraft(v.code);
      setDiff(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const keepMine = async () => {
    if (!view) return;
    setBusy(true);
    setError(null);
    try {
      const v = await api<ManagedAutomationView>('POST', `${basePath}/keep-mine`);
      setView(v);
      setDiff(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const openDiff = async () => {
    setBusy(true);
    setError(null);
    try {
      const d = await api<ThreeWayDiff>('GET', `${basePath}/diff`);
      setDiff(d);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!view && busy) return <div className={className}>Loading…</div>;
  if (!view && error) return <div className={className} role="alert">Error: {error}</div>;
  if (!view) return <div className={className}>Not found.</div>;

  const isDirty = draft !== view.code;
  const readOnly = !view.allowUserOverride;
  const editorEl = editor
    ? editor({ code: draft, onChange: setDraft, readOnly })
    : (
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        readOnly={readOnly}
        spellCheck={false}
        rows={20}
        style={{
          width: '100%',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          fontSize: 13,
          padding: 8,
          boxSizing: 'border-box',
        }}
      />
    );

  return (
    <div className={className} data-testid="managed-automation-ide">
      <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <strong>{view.name}</strong>{' '}
          <span style={{ color: '#888', fontSize: 12 }}>
            {readOnly ? '(read-only — plugin owns this script)' : view.isOverridden ? '(overridden)' : '(plugin default)'}
          </span>
          {view.description && (
            <div style={{ color: '#666', fontSize: 12, marginTop: 2 }}>{view.description}</div>
          )}
        </div>
        {view.hasDrift && (
          <button type="button" onClick={openDiff} disabled={busy}>
            View 3-way diff
          </button>
        )}
      </div>

      {view.hasDrift && (
        <div role="alert" style={{
          marginBottom: 8, padding: 8, border: '1px solid #d99', background: '#fee', borderRadius: 4,
        }}>
          The plugin has shipped a new default for this script. Your override is still running.{' '}
          <button type="button" onClick={keepMine} disabled={busy}>Keep mine</button>{' '}
          <button type="button" onClick={reset} disabled={busy}>Reset to default</button>
        </div>
      )}

      {error && (
        <div role="alert" style={{ color: '#a00', marginBottom: 8 }}>Error: {error}</div>
      )}

      {editorEl}

      {!readOnly && (
        <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
          <button type="button" onClick={save} disabled={busy || !isDirty}>
            {view.isOverridden ? 'Save changes' : 'Save (creates override)'}
          </button>
          {view.isOverridden && (
            <button type="button" onClick={reset} disabled={busy}>
              Reset to default
            </button>
          )}
        </div>
      )}

      {diff && (
        <div style={{ marginTop: 16, border: '1px solid #ccc', padding: 8 }}>
          <h4>3-way diff</h4>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, fontFamily: 'monospace', fontSize: 12 }}>
            <div>
              <div><strong>Ancestor</strong> (forked from)</div>
              <pre style={{ whiteSpace: 'pre-wrap' }}>{diff.ancestor ?? '(none)'}</pre>
            </div>
            <div>
              <div><strong>Incoming</strong> (plugin default)</div>
              <pre style={{ whiteSpace: 'pre-wrap' }}>{diff.incoming ?? '(none)'}</pre>
            </div>
            <div>
              <div><strong>Yours</strong> (running)</div>
              <pre style={{ whiteSpace: 'pre-wrap' }}>{diff.yours}</pre>
            </div>
          </div>
          <button type="button" onClick={() => setDiff(null)} style={{ marginTop: 8 }}>Close diff</button>
        </div>
      )}
    </div>
  );
}
