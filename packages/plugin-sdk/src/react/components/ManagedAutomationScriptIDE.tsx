import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { ScheduleEditor, type ScheduleValue } from './ScheduleEditor';
import {
  scheduleConfigToEditor,
  editorValueToScheduleConfig,
  schedulesEqual,
} from '../helpers/schedule-bridge';

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
  /** Operator-owned enabled flag. */
  enabled: boolean;
  /** Operator-owned schedule JSON (matches `ScheduleConfig` stringified) or null. */
  schedule: string | null;
  /** Plugin's currently-shipped enabled default — revert target. */
  currentDefaultEnabled: boolean | null;
  /** Plugin's currently-shipped schedule default — revert target. */
  currentDefaultSchedule: string | null;
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
  // Start busy=true so the pre-WebSocket-connect state renders "Loading…"
  // instead of flashing "Not found." between mount and the first refresh.
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The ScheduleEditor reports its current working value via onChange;
  // we hold the latest payload so the external "Save schedule" button can
  // serialise it back to a ScheduleConfig and PUT.
  const scheduleDraftRef = useRef<{ value: ScheduleValue; cron: string } | null>(null);
  const [scheduleDirty, setScheduleDirty] = useState(false);
  // When the operator has no saved schedule (view.schedule === null), we
  // hide the editor behind a "Set schedule" button. Otherwise the editor
  // would seed itself with a placeholder cron and fire an initial onChange
  // — making "Save schedule" light up on first paint and contradicting the
  // "No schedule" hint right above it. Clicking the button flips this to
  // true, the editor mounts, and from that point the onChange genuinely
  // reflects operator intent.
  const [scheduleEditorOpen, setScheduleEditorOpen] = useState(false);

  const basePath = `/v1/managed-automations/${encodeURIComponent(pluginKey)}/${encodeURIComponent(scriptKey)}`;

  /**
   * Wrap ws.sendRestApi into a tiny helper that surfaces server-side errors
   * as thrown `Error`s. The WebSocket envelope is
   * `{ type, id, status, body }`; the JSON API payload sits inside `body`
   * as `{ success, data, error }`. We treat anything other than an
   * explicit `success: true` 2xx as a failure so an unexpected envelope
   * shape produces a useful error instead of silently resolving to undefined.
   */
  const api = useCallback(async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await ws.sendRestApi(method, path, body);
    if (typeof res.status === 'number' && (res.status < 200 || res.status >= 300)) {
      const payload = res.body as { error?: string } | undefined;
      throw new Error(payload?.error ?? `${method} ${path} failed (${res.status})`);
    }
    const payload = res.body as { success?: boolean; data?: T; error?: string } | undefined;
    if (!payload || payload.success !== true) {
      throw new Error(payload?.error ?? `${method} ${path} returned unexpected payload`);
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

  // ── Operational controls ──────────────────────────────────────────────

  const toggleEnabled = async (next: boolean) => {
    if (!view) return;
    setBusy(true);
    setError(null);
    try {
      const v = await api<ManagedAutomationView>('PUT', `${basePath}/enabled`, { enabled: next });
      setView(v);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const revertEnabled = async () => {
    if (!view) return;
    setBusy(true);
    setError(null);
    try {
      const v = await api<ManagedAutomationView>('POST', `${basePath}/revert/enabled`);
      setView(v);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveSchedule = async () => {
    if (!view) return;
    const payload = scheduleDraftRef.current;
    if (!payload) return;
    const config = editorValueToScheduleConfig(payload.value, payload.cron);
    const next = config ? JSON.stringify(config) : null;
    setBusy(true);
    setError(null);
    try {
      const v = await api<ManagedAutomationView>('PUT', `${basePath}/schedule`, { schedule: next });
      setView(v);
      setScheduleDirty(false);
      // If the user just saved a cleared schedule, close the editor so
      // the next render shows the "Set schedule…" affordance again.
      // Leaving it open would re-mount ScheduleEditor in the next paint
      // and its initial onChange would re-mark dirty against the now-null
      // saved value — mirror what revertSchedule does.
      if (!v.schedule) {
        setScheduleEditorOpen(false);
        scheduleDraftRef.current = null;
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const revertSchedule = async () => {
    if (!view) return;
    setBusy(true);
    setError(null);
    try {
      const v = await api<ManagedAutomationView>('POST', `${basePath}/revert/schedule`);
      setView(v);
      setScheduleDirty(false);
      scheduleDraftRef.current = null;
      // If the plugin default is null, revert lands the operator back in
      // "no schedule" territory — close the editor again so the UI matches.
      if (!v.schedule) setScheduleEditorOpen(false);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  // Schedule editor working state — derived from view.schedule (current
  // operator value) so the editor seeds correctly on first render. The
  // ScheduleEditor takes a cron string; the bridge picks an opening tab.
  // useMemo MUST sit above the early returns below — react hooks must run
  // unconditionally on every render. We tolerate `view == null` inline.
  const scheduleParsed = useMemo(() => {
    if (!view?.schedule) return null;
    try { return scheduleConfigToEditor(JSON.parse(view.schedule)); }
    catch { return null; }
  }, [view?.schedule]);
  const scheduleDefaultParsed = useMemo(() => {
    if (!view?.currentDefaultSchedule) return null;
    try { return scheduleConfigToEditor(JSON.parse(view.currentDefaultSchedule)); }
    catch { return null; }
  }, [view?.currentDefaultSchedule]);
  const scheduleConfigCurrent = useMemo(() => {
    try { return view?.schedule ? JSON.parse(view.schedule) : null; } catch { return null; }
  }, [view?.schedule]);
  const scheduleConfigDefault = useMemo(() => {
    try { return view?.currentDefaultSchedule ? JSON.parse(view.currentDefaultSchedule) : null; } catch { return null; }
  }, [view?.currentDefaultSchedule]);

  if (!view && busy) return <div className={className}>Loading…</div>;
  if (!view && error) return <div className={className} role="alert">Error: {error}</div>;
  if (!view) return <div className={className}>Not found.</div>;

  const isDirty = draft !== view.code;
  const readOnly = !view.allowUserOverride;
  const editorEl = editor
    ? editor({ code: draft, onChange: setDraft, readOnly })
    : <MonacoEditor value={draft} onChange={setDraft} readOnly={readOnly} />;

  // Revert-button enable logic: scheduleDiffersFromDefault compares the
  // stored operator value (view.schedule) to the plugin's default
  // (view.currentDefaultSchedule) so the button is enabled IFF the
  // operator has a value that doesn't match the plugin's snapshot.
  // Unsaved draft state doesn't count — revert restores from the server.
  const scheduleDiffersFromDefault = !schedulesEqual(scheduleConfigCurrent, scheduleConfigDefault);
  const enabledDiffersFromDefault =
    view.currentDefaultEnabled !== null && view.enabled !== view.currentDefaultEnabled;

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
        <div role="alert" style={{ color: '#a00', marginBottom: 8 }}>Error: {error}</div>
      )}

      {/* Operational settings — enabled toggle + schedule editor, each with
          a Revert button that's enabled only when the operator's value
          differs from the plugin's currently-shipped default. */}
      <fieldset
        data-testid="managed-automation-ops"
        style={{
          marginBottom: 12, padding: 12, border: '1px solid #ddd', borderRadius: 4,
        }}
      >
        <legend style={{ padding: '0 6px', fontSize: 12, color: '#666' }}>Operational settings</legend>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={view.enabled}
              disabled={busy}
              onChange={(e) => void toggleEnabled(e.target.checked)}
              data-testid="managed-automation-enabled-toggle"
            />
            Enabled
          </label>
          <span style={{ color: '#888', fontSize: 12 }}>
            {view.enabled ? 'Scheduler will fire this on its cadence' : 'Disabled — scheduler skips it'}
          </span>
          <div style={{ marginLeft: 'auto' }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={revertEnabled}
              disabled={busy || !enabledDiffersFromDefault}
              title={
                view.currentDefaultEnabled === null
                  ? 'No plugin default recorded'
                  : !enabledDiffersFromDefault
                    ? 'Already matches the plugin default'
                    : `Reverts to plugin default (${view.currentDefaultEnabled ? 'enabled' : 'disabled'})`
              }
              data-testid="managed-automation-revert-enabled"
            >
              Revert to default
            </button>
          </div>
        </div>

        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <strong style={{ fontSize: 13 }}>Schedule</strong>
            <span style={{ color: '#888', fontSize: 12 }}>
              {view.schedule ? 'Operator-set' : 'No schedule — automation only runs manually'}
            </span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              {(view.schedule || scheduleEditorOpen) && (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={saveSchedule}
                  disabled={busy || !scheduleDirty}
                  data-testid="managed-automation-save-schedule"
                >
                  Save schedule
                </button>
              )}
              <button
                type="button"
                className="btn btn-sm"
                onClick={revertSchedule}
                disabled={busy || !scheduleDiffersFromDefault}
                title={
                  scheduleConfigDefault == null
                    ? 'Plugin ships no default schedule — Revert would clear yours'
                    : !scheduleDiffersFromDefault
                      ? 'Already matches the plugin default'
                      : 'Restores the plugin default schedule'
                }
                data-testid="managed-automation-revert-schedule"
              >
                Revert to default
              </button>
            </div>
          </div>

          {view.schedule || scheduleEditorOpen ? (
            <ScheduleEditor
              inline
              value={scheduleParsed?.cronString ?? scheduleDefaultParsed?.cronString ?? '*/5 * * * *'}
              defaultValue={scheduleDefaultParsed?.cronString ?? '*/5 * * * *'}
              onChange={(value, cron) => {
                scheduleDraftRef.current = { value, cron };
                // Mark dirty whenever the editor produces a value that differs
                // from the server-saved one. We compare the serialised
                // ScheduleConfig to dodge formatting noise inside the editor.
                const next = editorValueToScheduleConfig(value, cron);
                setScheduleDirty(!schedulesEqual(next, scheduleConfigCurrent));
              }}
            />
          ) : (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setScheduleEditorOpen(true)}
              disabled={busy}
              data-testid="managed-automation-set-schedule"
            >
              Set schedule…
            </button>
          )}
        </div>
      </fieldset>

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
  const [loadFailed, setLoadFailed] = useState(false);
  const [monacoReady, setMonacoReady] = useState(false);
  // Hold latest props in refs so the async-mounting Monaco can read the
  // freshest values when it finally instantiates. Without this, if the
  // parent updates `value` (e.g. a Reset/Save resolved) DURING the
  // dynamic `import('monaco-editor')`, Monaco would create with the
  // stale captured value and the [value]-sync effect below would bail
  // out because editorRef hadn't been set yet — leaving the editor
  // permanently desynced.
  const valueRef = useRef(value);
  const readOnlyRef = useRef(readOnly);
  const onChangeRef = useRef(onChange);
  useEffect(() => { valueRef.current = value; }, [value]);
  useEffect(() => { readOnlyRef.current = readOnly; }, [readOnly]);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  // One-shot mount/unmount. Read from the refs at the moment Monaco
  // is actually ready, not from the closure-captured initial values.
  useEffect(() => {
    let disposed = false;
    let editor: any = null;
    let changeSub: any = null;

    (async () => {
      // Monaco web-worker setup lives in the host's frontend entry point
      // (frontend/main.tsx) — that way every page that ever mounts a
      // Monaco editor, INCLUDING plugin pages that embed this IDE
      // without ever visiting AutomationEditor, gets the workers
      // configured. If a hypothetical embedder forgets to set it up,
      // monaco.editor.create still works but silently loses TypeScript
      // language features. We can't paper over it here because
      // `new URL(specifier, import.meta.url)` (the canonical Vite/
      // Webpack-5 worker bundling pattern) requires ESM, but the SDK is
      // published as CommonJS for compatibility.

      // ── Dynamic import ──────────────────────────────────────────────
      let monaco: typeof import('monaco-editor');
      try {
        monaco = await import('monaco-editor');
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[ManagedAutomationScriptIDE] monaco-editor module failed to load (is the host shipping the peer dependency?):', e);
        if (!disposed) setLoadFailed(true);
        return;
      }
      if (disposed || !containerRef.current) return;

      // ── Editor creation ─────────────────────────────────────────────
      try {
        const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        editor = monaco.editor.create(containerRef.current, {
          value: valueRef.current,        // freshest props, not the mount-time closure
          language: 'typescript',
          theme: isDark ? 'vs-dark' : 'vs-light',
          readOnly: readOnlyRef.current,
          minimap: { enabled: false },
          fontSize: 14,
          automaticLayout: true,
          scrollBeyondLastLine: false,
        });
        editorRef.current = editor;
        changeSub = editor.onDidChangeModelContent(() => {
          onChangeRef.current(editor.getValue());
        });
        setMonacoReady(true);
      } catch (e) {
        // Initialization fault distinct from load fault — name it so
        // plugin authors aren't sent hunting for a peer-dep issue when
        // it's actually a worker / container / theme problem.
        // eslint-disable-next-line no-console
        console.error('[ManagedAutomationScriptIDE] Monaco editor.create failed:', e);
        if (!disposed) setLoadFailed(true);
      }
    })();

    return () => {
      disposed = true;
      try { changeSub?.dispose(); } catch { /* best effort */ }
      try { editor?.dispose(); } catch { /* best effort */ }
      editorRef.current = null;
    };
    // We want to mount once per (container) lifecycle; rebinding on `value`
    // would dispose-and-recreate the editor on every keystroke. Props that
    // change during mount are picked up via the refs above.
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

  // Fallback: <textarea> if Monaco failed to load (e.g. host doesn't ship it).
  if (loadFailed) {
    return (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        readOnly={readOnly}
        spellCheck={false}
        rows={20}
        style={{
          width: '100%',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          fontSize: 13,
          padding: 8,
          boxSizing: 'border-box',
          border: '1px solid #ccc',
          borderRadius: 4,
        }}
      />
    );
  }

  return (
    <div
      style={{
        position: 'relative',
        height: 400,
        border: '1px solid var(--border-color, #ccc)',
        borderRadius: 4,
      }}
    >
      <div ref={containerRef} data-testid="managed-automation-monaco" style={{ width: '100%', height: '100%' }} />
      {!monacoReady && (
        <div
          aria-live="polite"
          style={{
            position: 'absolute', inset: 0, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            color: '#888', fontSize: 13, pointerEvents: 'none',
          }}
        >
          Loading editor…
        </div>
      )}
    </div>
  );
}
