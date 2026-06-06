import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';

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
 *   - When override is permitted, shows a Monaco editor + Save/Reset
 *     actions, plus a Drift banner with **Keep mine** and a 3-way diff
 *     when the plugin has shipped a new default that conflicts with
 *     the operator's local edits.
 *
 * Communicates with the host via `useWebSocket().sendRestApi(...)` (same
 * helper SessionHistory and friends use), so the request is authenticated
 * by the WebSocket session — no CSRF token to thread, no fetch wiring.
 *
 * Plugins that want a different editor surface can pass a custom
 * `editor` render prop. For most managed scripts Monaco is appropriate
 * — same editor the host's ordinary AutomationEditor uses, with
 * TypeScript syntax + theme matching.
 */

interface ManagedAutomationView {
  pluginKey: string;
  scriptKey: string;
  name: string;
  description?: string;
  code: string;
  /** May be null when the plugin no longer declares this script. */
  currentDefaultCode: string | null;
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
  /**
   * Optional custom editor render. Receives current code + change handler.
   * Default is Monaco with TypeScript syntax.
   */
  editor?: (props: { code: string; onChange: (next: string) => void; readOnly: boolean }) => React.ReactNode;
  /** Optional className applied to the outer container. */
  className?: string;
}

export function ManagedAutomationScriptIDE({
  pluginKey,
  scriptKey,
  editor,
  className,
}: ManagedAutomationScriptIDEProps): React.JSX.Element {
  const ws = useWebSocket();
  const [view, setView] = useState<ManagedAutomationView | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [diff, setDiff] = useState<ThreeWayDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const basePath = `/v1/managed-automations/${encodeURIComponent(pluginKey)}/${encodeURIComponent(scriptKey)}`;

  /**
   * Wrap ws.sendRestApi into a tiny helper that surfaces server-side errors
   * as thrown `Error`s. The WebSocket REST envelope is `{ ok, body }` where
   * the actual API payload sits at `body.success` / `body.data` / `body.error`.
   */
  const api = useCallback(async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await ws.sendRestApi(method, path, body);
    const payload = res.body as { success?: boolean; data?: T; error?: string } | undefined;
    if (!payload || payload.success === false) {
      throw new Error(payload?.error ?? `${method} ${path} failed`);
    }
    return payload.data as T;
  }, [ws]);

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
  }, [api, basePath]);

  useEffect(() => {
    if (ws.connected) void refresh();
  }, [ws.connected, refresh]);

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
    : <MonacoEditor value={draft} onChange={setDraft} readOnly={readOnly} />;

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
          <button type="button" className="btn btn-sm" onClick={openDiff} disabled={busy}>
            View 3-way diff
          </button>
        )}
      </div>

      {view.hasDrift && (
        <div role="alert" style={{
          marginBottom: 8, padding: 8, border: '1px solid #d99', background: '#fee', borderRadius: 4,
        }}>
          The plugin has shipped a new default for this script. Your override is still running.{' '}
          <button type="button" className="btn btn-sm" onClick={keepMine} disabled={busy}>Keep mine</button>{' '}
          <button
            type="button"
            className="btn btn-sm"
            onClick={reset}
            disabled={busy || view.currentDefaultCode == null}
            title={view.currentDefaultCode == null ? 'No default available — plugin no longer declares this script' : undefined}
          >
            Reset to default
          </button>
        </div>
      )}

      {error && (
        <div role="alert" className="error" style={{ marginBottom: 8 }}>Error: {error}</div>
      )}

      {editorEl}

      {!readOnly && (
        <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={save}
            disabled={busy || !isDirty}
          >
            {view.isOverridden ? 'Save changes' : 'Save (creates override)'}
          </button>
          {view.isOverridden && (
            <button
              type="button"
              className="btn"
              onClick={reset}
              disabled={busy || view.currentDefaultCode == null}
              title={view.currentDefaultCode == null ? 'No default available — plugin no longer declares this script' : undefined}
            >
              Reset to default
            </button>
          )}
        </div>
      )}

      {diff && (
        <div style={{ marginTop: 16, border: '1px solid #ccc', padding: 8, borderRadius: 4 }}>
          <h4 style={{ marginTop: 0 }}>3-way diff</h4>
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
          <button type="button" className="btn btn-sm" onClick={() => setDiff(null)} style={{ marginTop: 8 }}>
            Close diff
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Monaco editor wrapper used as the default `editor` for
 * <ManagedAutomationScriptIDE>. Mirrors the AutomationEditor page:
 * dynamic-imports `monaco-editor` so the ~2MB chunk only loads when the IDE
 * actually mounts, TypeScript syntax, theme follows the OS preference.
 *
 * Kept in the same file (private export) because no other SDK component
 * needs it. If a plugin wants something other than Monaco it passes a
 * custom `editor` render prop and never touches this.
 */
function MonacoEditor({
  value,
  onChange,
  readOnly,
}: {
  value: string;
  onChange: (next: string) => void;
  readOnly: boolean;
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<any>(null);
  // Hold a ref on the latest onChange so the Monaco subscription doesn't have
  // to re-bind whenever the parent re-renders with a fresh callback identity.
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  // One-shot mount/unmount effect. We deliberately don't depend on `value`
  // here — Monaco owns the buffer once mounted; pushing every `value` change
  // into setValue() would fight the editor's cursor + undo stack. The
  // separate effect below syncs external resets (e.g. Reset to default).
  useEffect(() => {
    let disposed = false;
    let editor: any = null;
    let changeSub: any = null;

    (async () => {
      try {
        const monaco = await import('monaco-editor');
        if (disposed || !containerRef.current) return;

        const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        editor = monaco.editor.create(containerRef.current, {
          value,
          language: 'typescript',
          theme: isDark ? 'vs-dark' : 'vs-light',
          readOnly,
          minimap: { enabled: false },
          fontSize: 14,
          automaticLayout: true,
          scrollBeyondLastLine: false,
        });
        editorRef.current = editor;
        changeSub = editor.onDidChangeModelContent(() => {
          onChangeRef.current(editor.getValue());
        });
      } catch (e) {
        // If Monaco fails to load (rare in production — only happens if the
        // host doesn't ship it), the loading message stays and the operator
        // sees a clear "Monaco failed to load" message via console.
        // eslint-disable-next-line no-console
        console.error('[ManagedAutomationScriptIDE] Monaco failed to load:', e);
      }
    })();

    return () => {
      disposed = true;
      try { changeSub?.dispose(); } catch { /* best effort */ }
      try { editor?.dispose(); } catch { /* best effort */ }
      editorRef.current = null;
    };
    // We want to mount once per (container) lifecycle; rebinding on `value`
    // would dispose-and-recreate the editor on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external value resets (e.g. operator hits Reset, server returns
  // the fresh code) without nuking the editor.
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    if (ed.getValue() !== value) {
      ed.setValue(value);
    }
  }, [value]);

  // Sync readOnly toggles
  useEffect(() => {
    editorRef.current?.updateOptions?.({ readOnly });
  }, [readOnly]);

  return (
    <div
      ref={containerRef}
      data-testid="managed-automation-monaco"
      style={{
        height: 400,
        border: '1px solid var(--border-color, #ccc)',
        borderRadius: 4,
      }}
    />
  );
}
