import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { LoadingSpinner } from '@darkrideapp/plugin-sdk/react';
import { Breadcrumbs } from '@darkrideapp/plugin-sdk/react';
import { ApiReferencePanel } from '../components/editor/ApiReferencePanel';
import type { Automation, ScheduleConfig, DeviceFilter, DeviceFilterRule, Device } from '../../shared/types/api';
import { DEVICE_FILTERABLE_FIELDS } from '../../shared/types/api';
import { matchesDeviceFilter, getFilterWarnings, migrateDeviceFilter } from '../../shared/lib/device-filter';
import type { ValidationResult, SessionStatusUpdate } from '../../shared/types/websocket';
import { useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { ScheduleEditor, type ScheduleValue } from '@darkrideapp/plugin-sdk/react';
import type { DeviceAPI } from '../../shared/types/automation';
import { useAuthOptional } from '@darkrideapp/plugin-sdk/react';
import { AccessDenied } from '../components/auth/AccessDenied';
import { useToast } from '@darkrideapp/plugin-sdk/react';

// Monaco web-worker configuration lives in frontend/main.tsx — set there once
// at module-eval time so every page that mounts a Monaco editor (this one,
// CodeBrowser, the SDK's ManagedAutomationScriptIDE on plugin pages) picks
// it up automatically.

const DEFAULT_CAPTURE_RULE_CODE = `export default async function captureRule(device: DeviceAPI) {
  // Capture rules run once when traffic capture starts.
  // Register hooks here — they persist for the capture session.

  device.http.hook(
    { hostname: 'example.com' },
    async (req) => {
      console.log('Request:', req.method, req.url);
      return req;
    },
    async (resp) => {
      console.log('Response:', resp.status);
      return resp;
    }
  );
}
`;

const DEFAULT_CODE = `export default async function automation(device: DeviceAPI) {
  // --- Quick Reference (see API Docs tab for full details) ---
  //
  // FINDING & CLICKING ELEMENTS
  //   await device.click({ text: 'Sign In' });
  //   await device.click({ resourceId: 'com.example:id/button' });
  //   await device.longClick({ text: 'Item' }, 1000);
  //   await device.pressButton({ text: 'Submit' });     // scrolls to it, then clicks
  //
  // WAITING & CHECKING
  //   await device.waitFor({ text: 'Home' }, 10000);
  //   await device.waitForAndClick({ text: 'OK' });
  //   if (await device.exists({ text: 'Error' })) { ... }
  //
  // TEXT INPUT
  //   await device.setText({ resourceId: 'com.example:id/input' }, 'hello');
  //   const label = await device.getText({ resourceId: 'com.example:id/title' });
  //
  // SCROLLING
  //   await device.scroll('down', 50);
  //   await device.scrollToElement({ text: 'More' });
  //
  // GESTURES & KEYS
  //   await device.swipe(500, 1500, 500, 500, 300);
  //   await device.tapAt(540, 960);
  //   await device.pressKey('BACK');
  //
  // APPS
  //   await device.startApp('com.example.app');
  //   await device.stopApp('com.example.app');
  //
  // DEVICE INFO & DOM
  //   const info = await device.deviceInfo();
  //   const dom = await device.getDOM();
  //   const fullDom = await device.gatherDOM({ maxScrollPages: 3 });
  //   const updated = await device.updateDOM();
  //   const webviews = await device.getWebViewInfo();
  //   const screenshot = await device.screenshot('step1');
  //
  // HTTP REQUESTS
  //   const res = await device.httpGet('https://api.example.com/data');
  //   const res2 = await device.httpPost('https://api.example.com', { key: 'value' });
  //
  // TRAFFIC HOOKS (requires HTTPS capture)
  //   // Filters accept strings (substring match) or RegExp
  //   const hookId = device.http.hook(
  //     { hostname: 'example.com' },
  //     async (req) => { console.log(req.url); return req; },
  //     async (resp) => { console.log(resp.status); return resp; }
  //   );
  //   device.http.hookRequest({ path: '/login' }, async (req) => req);
  //   device.http.hookResponse({ hostname: /api\.example/ }, async (resp) => resp);
  //   device.http.unhook(hookId);
  //   device.http.unhookAll();
  //
  // PROXY & TLS
  //   await device.setProxy('nordvpn', { country: 'us' });
  //   await device.setTlsProfile('chrome');
  //
  // FRIDA (requires rooted device)
  //   await device.frida.run('com.example.app', 'ssl-pinning-bypass');
  //   await device.frida.run('com.example.app', ['script1', 'script2']);
  //   await device.frida.inject('com.example.app', 'Java.perform(...)');
  //   await device.frida.loadScript('my-hook');
  //   const msgs = await device.frida.getMessages();
  //   await device.frida.send({ type: 'config', value: 42 });
  //   await device.frida.stop();
  //
  // CREDENTIALS
  //   const creds = await device.getCredentials('com.example.app');
  //
  // DOM UTILITIES (via global 'dom' object)
  //   const allNodes = dom.flatten(tree);
  //   const inputs = dom.findAll(tree, n => n.className === 'EditText');
  //   const btn = dom.find(tree, n => n.text === 'OK');
  //   const { x, y } = dom.getCenter(node);
  //   const texts = dom.getAllText(tree);
  //
  // UTILITIES
  //   await device.sleep(2000);
  //
  // --- Start your automation below ---

}
`;

function checkDeviceCompatibility(device: Device, filter: DeviceFilter | null): string[] {
  if (!filter) return [];
  return getFilterWarnings(device as any, filter);
}

export function AutomationEditor() {
  useDocumentTitle('Automation Editor');
  const auth = useAuthOptional();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const ws = useWebSocket();
  const toast = useToast();
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const editorInstanceRef = useRef<any>(null);
  const validateTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const handleSaveRef = useRef<() => void>(() => {});
  // initialCodeRef tracks the latest `code` for the one-shot Monaco init.
  // Templates fetch asynchronously and the Monaco init effect ([loading] dep)
  // captures `code` at the moment it runs — without this ref, if the template
  // resolves AFTER Monaco mounts the editor uses DEFAULT_CODE; if the template
  // resolves BEFORE Monaco mounts the editor still uses DEFAULT_CODE because
  // the effect closes over the stale state. The ref is read at create() time.
  const initialCodeRef = useRef<string>('');

  const isNew = !id || id === 'new';
  const location = useLocation();
  const [loading, setLoading] = useState(!isNew);
  // monacoLoading is true while the Monaco editor chunk is lazy-loading (the
  // `await import('monaco-editor')` below). The chunk is ~2MB so the wait
  // can be visible on first load; without this flag the container is just
  // an empty div for several seconds.
  const [monacoLoading, setMonacoLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('New Automation');
  const [code, setCode] = useState(DEFAULT_CODE);
  const [timeoutMs, setTimeoutMs] = useState(300000);
  const [requiresDevice, setRequiresDevice] = useState(true);
  const [requiresHttpsCapture, setRequiresHttpsCapture] = useState(false);
  const [isRule, setIsRule] = useState(false);
  const [isCaptureRule, setIsCaptureRule] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [priority, setPriority] = useState(100);
  const [passcode, setPasscode] = useState('');
  const [errorCount, setErrorCount] = useState(0);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [dirty, setDirty] = useState(isNew);
  const suppressDirty = useRef(!isNew); // suppress dirty during initial data load
  const [saveFlash, setSaveFlash] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<'config' | 'api-docs'>('config');

  // Schedule state
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleString, setScheduleString] = useState('*/30 * * * *');
  const scheduleValueRef = useRef<ScheduleValue | null>(null);

  // Device filter state
  const [filterRules, setFilterRules] = useState<DeviceFilterRule[]>([]);
  const [filterDeviceIds, setFilterDeviceIds] = useState<string[]>([]);
  const [knownDevices, setKnownDevices] = useState<Array<{ id: string; name: string | null }>>([]);
  const [showRunModal, setShowRunModal] = useState(false);
  const [runModalDevices, setRunModalDevices] = useState<Device[]>([]);
  const [runModalLoading, setRunModalLoading] = useState(false);
  const [confirmDevice, setConfirmDevice] = useState<{ device: Device; warnings: string[] } | null>(null);
  const [running, setRunning] = useState(false);

  // Fetch existing automation
  useEffect(() => {
    if (isNew || !ws.connected) return;
    ws.sendRestApi('GET', `/v1/automation/view/${id}`).then(res => {
      const a: Automation = res.body?.data;
      if (a) {
        setName(a.name);
        setCode(a.code);
        setTimeoutMs(a.timeoutMs);
        setRequiresDevice(a.requiresDevice ?? true);
        setRequiresHttpsCapture(a.requiresHttpsCapture);
        setIsRule(a.isRule);
        setIsCaptureRule(a.isCaptureRule);
        setEnabled(a.enabled);
        setPriority(a.priority);
        setPasscode(a.passcode);

        // Parse schedule
        if (a.schedule) {
          try {
            const sched = JSON.parse(a.schedule) as ScheduleConfig;
            setScheduleEnabled(true);
            if (sched.type === 'interval') {
              const mins = Math.round(sched.intervalMs / 60000);
              setScheduleString(mins >= 60 && mins % 60 === 0 ? `0 */${mins / 60} * * *` : `*/${mins} * * * *`);
            } else if (sched.type === 'cron') {
              if (sched.expressions.length > 0) setScheduleString(sched.expressions[0]);
            } else if (sched.type === 'windowed_interval') {
              setScheduleString(`Every ${sched.intervalMinutes}m ${sched.windowStart}-${sched.windowEnd}`);
            }
          } catch { /* invalid JSON */ }
        }

        // Parse device filter (handles old and new formats)
        if (a.deviceFilter) {
          try {
            const raw = JSON.parse(a.deviceFilter);
            const df = migrateDeviceFilter(raw);
            setFilterRules(df.rules);
            if (df.deviceIds?.length) setFilterDeviceIds(df.deviceIds);
          } catch { /* invalid JSON */ }
        }
      }
      setLoading(false);
      // Allow ScheduleEditor to mount and fire its initial onChange before listening for dirty
      requestAnimationFrame(() => { suppressDirty.current = false; });
    }).catch(() => { setLoading(false); suppressDirty.current = false; });
  }, [ws, id, isNew]);

  const hasScope = auth?.hasScope ?? (() => true);

  // Fetch known devices for device filter
  useEffect(() => {
    if (!ws.connected) return;
    if (!hasScope('core.devices:read')) return;
    ws.sendRestApi('GET', '/v1/device/list').then(res => {
      const devices = res.body?.data;
      if (Array.isArray(devices)) {
        setKnownDevices(devices.map((d: any) => ({ id: d.id, name: d.name })));
      }
    }).catch(() => {});
  }, [ws]);

  // Keep initialCodeRef in sync with the latest `code` so the Monaco init
  // effect (which runs once when [loading] settles) can read the freshest
  // value at create() time — see the ref declaration above for rationale.
  useEffect(() => { initialCodeRef.current = code; }, [code]);

  // Pre-set type from navigation state when creating new.
  // templateFetchedRef ensures the template is loaded exactly once across the
  // editor's lifetime — without it, a WS reconnect would re-trigger the effect
  // and overwrite the user's in-progress edits with the original template body.
  const templateFetchedRef = useRef(false);
  useEffect(() => {
    if (!isNew) return;
    const navType = (location.state as any)?.type;
    const templateId = (location.state as any)?.templateId;

    if (templateId) {
      // Wait for the WebSocket to connect before firing the fetch — the effect
      // re-runs when ws.connected flips because it's in the deps list. Without
      // that, navigating to /ui/automations/new from a route that mounted
      // before the WS handshake completed left the fetch ungrounded forever.
      if (!ws.connected || templateFetchedRef.current) return;
      templateFetchedRef.current = true;
      ws.sendRestApi('GET', `/v1/automation/template/${templateId}`).then(res => {
        const tmpl = res.body?.data;
        if (tmpl) {
          setName(tmpl.name);
          setCode(tmpl.code);
          setRequiresDevice(tmpl.requiresDevice);
          setRequiresHttpsCapture(tmpl.requiresHttpsCapture);
          // Update Monaco editor if already initialized
          if (editorInstanceRef.current) {
            editorInstanceRef.current.setValue(tmpl.code);
          }
        }
      }).catch(() => {
        // Let the user retry by navigating away and back; clearing the ref
        // would re-fire on the next reconnect and could overwrite manual edits.
      });
    } else if (navType === 'rule') {
      setIsRule(true);
      setIsCaptureRule(false);
    } else if (navType === 'captureRule') {
      setIsCaptureRule(true);
      setIsRule(false);
      setCode(DEFAULT_CAPTURE_RULE_CODE);
    }
  }, [isNew, location.state, ws, ws.connected]);

  // Initialize Monaco editor
  useEffect(() => {
    if (!editorContainerRef.current) return;

    let disposed = false;
    let editor: any = null;
    let inlineProvider: any = null;

    (async () => {
      try {
        const monaco = await import('monaco-editor');
        if (disposed) return;

        // Fetch type definitions
        try {
          const typesRes = await ws.sendRestApi('GET', '/v1/automation/types');
          const typeDefs = typeof typesRes.body === 'string' ? typesRes.body : typesRes.body?.data;
          if (typeDefs) {
            monaco.languages.typescript.typescriptDefaults.addExtraLib(
              typeDefs,
              'file:///node_modules/@types/darkride/index.d.ts'
            );
          }
        } catch {
          // Types not available, continue without
        }

        monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
          target: monaco.languages.typescript.ScriptTarget.ES2020,
          allowNonTsExtensions: true,
          moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
          module: monaco.languages.typescript.ModuleKind.CommonJS,
          strict: true,
          esModuleInterop: true,
        });

        const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

        editor = monaco.editor.create(editorContainerRef.current!, {
          // Read from the ref so a template fetch that resolved before Monaco
          // mounted still seeds the editor with the correct code. Falls back
          // to the React state if the ref hasn't been primed yet.
          value: initialCodeRef.current || code,
          language: 'typescript',
          theme: isDark ? 'vs-dark' : 'vs-light',
          minimap: { enabled: false },
          fontSize: 14,
          automaticLayout: true,
          scrollBeyondLastLine: false,
          inlineSuggest: { enabled: true },
        });

        editorInstanceRef.current = editor;

        // Register AI inline completions provider
        let aiDebounceTimer: ReturnType<typeof setTimeout> | undefined;
        let aiAbortController: AbortController | undefined;

        inlineProvider = monaco.languages.registerInlineCompletionsProvider('typescript', {
          provideInlineCompletions: async (model, position, _ctx, token) => {
            // Cancel any pending request
            if (aiDebounceTimer) clearTimeout(aiDebounceTimer);
            if (aiAbortController) aiAbortController.abort();

            const textUntilPosition = model.getValueInRange({
              startLineNumber: 1,
              startColumn: 1,
              endLineNumber: position.lineNumber,
              endColumn: position.column,
            });

            if (textUntilPosition.trim().length < 10) {
              return { items: [] };
            }

            const textAfterPosition = model.getValueInRange({
              startLineNumber: position.lineNumber,
              startColumn: position.column,
              endLineNumber: model.getLineCount(),
              endColumn: model.getLineMaxColumn(model.getLineCount()),
            });

            return new Promise((resolve) => {
              aiDebounceTimer = setTimeout(async () => {
                const controller = new AbortController();
                aiAbortController = controller;

                token.onCancellationRequested(() => controller.abort());

                try {
                  // CSRF token is required for cookie-auth POSTs — without it
                  // the auth middleware returns 403 Forbidden.
                  const res = await fetch('/v1/ai/complete', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      ...(auth?.csrfToken ? { 'X-CSRF-Token': auth.csrfToken } : {}),
                    },
                    body: JSON.stringify({
                      prefix: textUntilPosition,
                      suffix: textAfterPosition,
                      language: 'typescript',
                    }),
                    signal: controller.signal,
                  });

                  if (!res.ok) {
                    resolve({ items: [] });
                    return;
                  }

                  const data = await res.json();
                  const completion = data.data?.completion;

                  if (!completion) {
                    resolve({ items: [] });
                    return;
                  }

                  resolve({
                    items: [{
                      insertText: completion,
                      range: {
                        startLineNumber: position.lineNumber,
                        startColumn: position.column,
                        endLineNumber: position.lineNumber,
                        endColumn: position.column,
                      },
                    }],
                  });
                } catch {
                  resolve({ items: [] });
                }
              }, 300);
            });
          },
          freeInlineCompletions() {},
        });

        // Track Monaco markers for error count
        monaco.editor.onDidChangeMarkers(([uri]) => {
          const markers = monaco.editor.getModelMarkers({ resource: uri });
          const errors = markers.filter(m => m.severity === monaco.MarkerSeverity.Error);
          setErrorCount(errors.length);
        });

        // Ctrl+S / Cmd+S to save
        editor.addAction({
          id: 'save-automation',
          label: 'Save Automation',
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
          run: () => { handleSaveRef.current(); },
        });

        // Debounced server validation + dirty tracking
        editor.onDidChangeModelContent(() => {
          setDirty(true);
          if (validateTimerRef.current) clearTimeout(validateTimerRef.current);
          validateTimerRef.current = setTimeout(() => {
            const currentCode = editor.getValue();
            if (!isNew && id) {
              ws.sendMessage('validate-automation', { code: currentCode, automationId: Number(id) });
            }
          }, 500);
        });

        // Editor is fully wired up — clear the spinner overlay.
        setMonacoLoading(false);
      } catch {
        // Monaco failed to load - show textarea fallback. Clear the spinner
        // either way; the fallback UI is its own state.
        setMonacoLoading(false);
      }
    })();

    return () => {
      disposed = true;
      if (editor) editor.dispose();
      if (inlineProvider) inlineProvider.dispose();
      if (validateTimerRef.current) clearTimeout(validateTimerRef.current);
    };
  }, [loading]); // Re-init after loading completes

  const getCode = (): string => {
    return editorInstanceRef.current?.getValue() || code;
  };

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const currentCode = getCode();
      let schedule: ScheduleConfig | null = null;
      if (scheduleEnabled && scheduleValueRef.current) {
        const sv = scheduleValueRef.current;
        switch (sv.mode) {
          case 'interval':
            schedule = { type: 'interval', intervalMs: sv.intervalMinutes * 60000 };
            break;
          case 'daily':
          case 'cron':
            schedule = { type: 'cron', expressions: [scheduleString] };
            break;
          case 'windowed':
            schedule = { type: 'windowed_interval', intervalMinutes: sv.windowIntervalMinutes, windowStart: sv.windowStart, windowEnd: sv.windowEnd };
            break;
        }
      }
      const deviceFilter = (filterRules.length || filterDeviceIds.length)
        ? {
            rules: filterRules,
            deviceIds: filterDeviceIds.length ? filterDeviceIds : undefined,
          }
        : null;
      const body = { name, code: currentCode, timeoutMs, requiresDevice, requiresHttpsCapture, isRule, isCaptureRule, priority, enabled, schedule, deviceFilter };
      if (isNew) {
        const res = await ws.sendRestApi('POST', '/v1/automation/create', body);
        const newId = res.body?.data?.id;
        if (newId) navigate(`/ui/automations/${newId}/edit`, { replace: true });
      } else {
        await ws.sendRestApi('PUT', `/v1/automation/update/${id}`, body);
      }
      setDirty(false);
      setSaveFlash(true);
      setTimeout(() => setSaveFlash(false), 2000);
    } catch {
      toast.error('Failed to save automation');
    } finally {
      setSaving(false);
    }
  }, [name, timeoutMs, requiresHttpsCapture, isRule, isCaptureRule, priority, enabled, isNew, id, ws, navigate, scheduleEnabled, scheduleString, filterRules, filterDeviceIds, toast]);

  handleSaveRef.current = handleSave;

  const handleInsertSnippet = useCallback((snippet: string) => {
    const editor = editorInstanceRef.current;
    if (!editor) return;
    const position = editor.getPosition();
    if (!position) return;
    editor.executeEdits('api-reference', [{
      range: {
        startLineNumber: position.lineNumber,
        startColumn: position.column,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      },
      text: snippet,
    }]);
    editor.focus();
  }, []);

  // Global Ctrl+S / Cmd+S handler for when focus is outside Monaco
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSaveRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Warn before navigating away with unsaved changes
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // Server validation results
  useEffect(() => {
    return ws.subscribe('validation-result', (msg: ValidationResult) => {
      const errs = msg.errors.filter(e => e.severity === 1);
      setServerErrors(errs.map(e => `Line ${e.line}: ${e.message}`));
    });
  }, [ws]);

  // Track automation running state via session-status broadcasts
  useEffect(() => {
    if (isNew) return;
    const automationId = Number(id);
    return ws.subscribe('session-status', (msg: SessionStatusUpdate) => {
      if (msg.automationId !== automationId) return;
      if (msg.status === 'running') {
        setRunning(true);
      } else {
        setRunning(false);
      }
    });
  }, [ws, id, isNew]);

  const openLiveLog = () => {
    window.dispatchEvent(new CustomEvent('livelog:open', { detail: { filters: ['automation-runner', 'automation'] } }));
  };

  const handleRun = async () => {
    if (isNew || running) return;
    setRunning(true);
    openLiveLog();
    try {
      await ws.sendRestApi('POST', `/v1/automation/run/${id}`);
    } catch {
      setRunning(false);
    }
  };

  const handleOpenRunModal = async () => {
    setShowRunModal(true);
    setRunModalLoading(true);
    setConfirmDevice(null);
    try {
      const res = await ws.sendRestApi('GET', '/v1/device/list');
      const devices = res.body?.data;
      if (Array.isArray(devices)) setRunModalDevices(devices);
    } catch {
      // ignore
    } finally {
      setRunModalLoading(false);
    }
  };

  const handleRunOnDevice = async (deviceId: string) => {
    if (isNew || running) return;
    setRunning(true);
    setShowRunModal(false);
    setConfirmDevice(null);
    window.dispatchEvent(new CustomEvent('livelog:open', { detail: { filters: ['automation-runner', 'automation'], deviceId } }));
    try {
      await ws.sendRestApi('POST', `/v1/automation/run/${id}`, { deviceId, triggerType: 'manual' });
    } catch {
      setRunning(false);
    }
  };

  const currentDeviceFilter: DeviceFilter | null =
    (filterRules.length || filterDeviceIds.length)
      ? {
          rules: filterRules,
          deviceIds: filterDeviceIds.length ? filterDeviceIds : undefined,
        }
      : null;

  if (auth && !auth.hasScope('core.automations:edit')) return <AccessDenied scope="core.automations:edit" />;
  if (loading) return <LoadingSpinner large center />;

  const canEdit = !auth || auth.hasScope('core.automations:edit');
  const canExecute = !auth || auth.hasScope('core.automations:execute');
  const totalErrors = errorCount + serverErrors.length;

  return (
    <div data-testid="automation-editor">
      <Breadcrumbs items={[
        { label: 'Automations', to: '/ui/automations' },
        { label: isNew ? 'New Automation' : `Edit: ${name}` },
      ]} />
      <div className="page-header">
        <h1>{isNew ? 'New Automation' : `Edit: ${name}`}</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {totalErrors > 0 && (
            <span className="error-count-badge" data-testid="error-count">{totalErrors} errors</span>
          )}
          {saveFlash && <span className="save-flash">Saved</span>}
          <button className={`btn${dirty ? ' btn-unsaved' : ''}`} onClick={handleSave} disabled={saving || !canEdit}>
            {saving ? 'Saving...' : dirty ? 'Save *' : 'Save'}
          </button>
          {!isNew && canExecute && (
            <span style={{ display: 'inline-flex' }}>
              <button
                className="btn btn-primary"
                onClick={handleRun}
                disabled={running}
                style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
                data-testid="btn-run"
              >
                {running ? 'Running...' : 'Run'}
              </button>
              <button
                className="btn btn-primary"
                onClick={handleOpenRunModal}
                disabled={running}
                style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: '1px solid rgba(255,255,255,0.3)', padding: '6px 8px' }}
                data-testid="btn-run-dropdown"
                title="Run on specific device"
              >
                &#9662;
              </button>
            </span>
          )}
          {!isNew && (
            <button className="btn" onClick={() => navigate(`/ui/automations/${id}/history`)}>History</button>
          )}
        </div>
      </div>

      <div className="editor-mobile-notice" data-testid="editor-mobile-notice">
        <strong>Limited editing on mobile</strong> — For the best experience with the code editor, use a desktop browser. You can still view and make small edits here.
      </div>

      <div className="automation-editor-layout">
        <div className="editor-container" style={{ position: 'relative' }}>
          <div
            ref={editorContainerRef}
            data-testid="monaco-editor"
            style={{ height: '100%', minHeight: 400 }}
          />
          {monacoLoading && (
            <div
              data-testid="monaco-loading"
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 12,
                background: 'var(--bg-primary)',
                color: 'var(--text-secondary)',
                fontSize: 13,
                pointerEvents: 'none',
              }}
            >
              <LoadingSpinner large />
              <span>Loading code editor…</span>
            </div>
          )}
        </div>
        <div className="config-panel">
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border-color)', marginBottom: 8 }}>
            <button
              data-testid="tab-config"
              onClick={() => setSidebarTab('config')}
              style={{
                flex: 1,
                padding: '6px 0',
                fontSize: 13,
                fontWeight: sidebarTab === 'config' ? 700 : 400,
                background: 'none',
                border: 'none',
                borderBottom: sidebarTab === 'config' ? '2px solid var(--primary)' : '2px solid transparent',
                cursor: 'pointer',
                color: 'inherit',
              }}
            >
              Config
            </button>
            <button
              data-testid="tab-api-docs"
              onClick={() => setSidebarTab('api-docs')}
              style={{
                flex: 1,
                padding: '6px 0',
                fontSize: 13,
                fontWeight: sidebarTab === 'api-docs' ? 700 : 400,
                background: 'none',
                border: 'none',
                borderBottom: sidebarTab === 'api-docs' ? '2px solid var(--primary)' : '2px solid transparent',
                cursor: 'pointer',
                color: 'inherit',
              }}
            >
              API Docs
            </button>
          </div>
          {sidebarTab === 'config' ? (
            <div className="card">
              <h3 style={{ marginBottom: 12, fontSize: 15 }}>Configuration</h3>
              <div className="form-group">
                <label>Name</label>
                <input className="form-input" value={name} onChange={e => { setName(e.target.value); setDirty(true); }} />
              </div>
              <div className="form-group">
                <label>Timeout (seconds)</label>
                <input
                  className="form-input"
                  type="number"
                  value={Math.round(timeoutMs / 1000)}
                  onChange={e => { setTimeoutMs(Number(e.target.value) * 1000); setDirty(true); }}
                />
              </div>
              <div className="form-group">
                <label>
                  <input
                    type="checkbox"
                    checked={requiresDevice}
                    onChange={e => { setRequiresDevice(e.target.checked); setDirty(true); }}
                  />{' '}
                  Requires Device
                </label>
              </div>
              {requiresDevice && (
                <div className="form-group">
                  <label>
                    <input
                      type="checkbox"
                      checked={requiresHttpsCapture}
                      onChange={e => { setRequiresHttpsCapture(e.target.checked); setDirty(true); }}
                    />{' '}
                    Requires HTTPS Capture
                  </label>
                </div>
              )}
              <div className="form-group">
                <label>Type</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ cursor: 'pointer' }}>
                    <input type="radio" name="type" checked={!isRule && !isCaptureRule}
                      onChange={() => { setIsRule(false); setIsCaptureRule(false); setDirty(true); }} /> Automation
                  </label>
                  <label style={{ cursor: 'pointer' }}>
                    <input type="radio" name="type" checked={isRule}
                      onChange={() => { setIsRule(true); setIsCaptureRule(false); setDirty(true); }} /> Rule
                  </label>
                  <label style={{ cursor: 'pointer' }}>
                    <input type="radio" name="type" checked={isCaptureRule}
                      onChange={() => { setIsCaptureRule(true); setIsRule(false); setDirty(true); }} /> Capture Rule
                  </label>
                </div>
              </div>
              {(isRule || isCaptureRule) && (
                <div className="form-group">
                  <label>Priority</label>
                  <input
                    className="form-input"
                    type="number"
                    value={priority}
                    onChange={e => { setPriority(Number(e.target.value)); setDirty(true); }}
                  />
                </div>
              )}
              <div className="form-group">
                <label>
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={e => { setEnabled(e.target.checked); setDirty(true); }}
                  />{' '}
                  Enabled
                </label>
              </div>
              {!isRule && !isCaptureRule && (
                <>
                  <div style={{ borderTop: '1px solid var(--border-color)', marginTop: 12, paddingTop: 12 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={scheduleEnabled}
                        onChange={e => { setScheduleEnabled(e.target.checked); setDirty(true); }}
                      />
                      Schedule
                    </label>
                    {scheduleEnabled && (
                      <ScheduleEditor
                        value={scheduleString}
                        modes={['interval', 'daily', 'windowed', 'cron']}
                        inline
                        compact
                        onChange={(val, cronStr) => {
                          scheduleValueRef.current = val;
                          setScheduleString(cronStr);
                          if (!suppressDirty.current) setDirty(true);
                        }}
                      />
                    )}
                  </div>
                  {requiresDevice && (
                  <div style={{ borderTop: '1px solid var(--border-color)', marginTop: 12, paddingTop: 12 }}>
                    <label style={{ fontWeight: 600, fontSize: 13 }}>Device Requirements</label>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                      {filterRules.map((rule, idx) => {
                        const fieldDef = DEVICE_FILTERABLE_FIELDS.find(f => f.field === rule.field);
                        return (
                          <div key={idx} style={{ display: 'flex', gap: 4, alignItems: 'center' }} data-testid={`filter-rule-${idx}`}>
                            <select
                              className="form-input"
                              value={rule.field}
                              onChange={e => {
                                const newField = DEVICE_FILTERABLE_FIELDS.find(f => f.field === e.target.value);
                                if (!newField) return;
                                const newRules = [...filterRules];
                                const defaultOp = newField.operators[0];
                                const defaultVal = newField.type === 'boolean' ? true : newField.type === 'number' ? 0 : '';
                                newRules[idx] = { field: newField.field, operator: defaultOp, value: defaultVal };
                                setFilterRules(newRules);
                                setDirty(true);
                              }}
                              style={{ width: 130, fontSize: 12 }}
                            >
                              {DEVICE_FILTERABLE_FIELDS.map(f => (
                                <option key={f.field} value={f.field}>{f.label}</option>
                              ))}
                            </select>
                            <select
                              className="form-input"
                              value={rule.operator}
                              onChange={e => {
                                const newRules = [...filterRules];
                                newRules[idx] = { ...rule, operator: e.target.value as DeviceFilterRule['operator'] };
                                setFilterRules(newRules);
                                setDirty(true);
                              }}
                              style={{ width: 70, fontSize: 12 }}
                            >
                              {(fieldDef?.operators ?? ['eq']).map(op => (
                                <option key={op} value={op}>
                                  {op === 'eq' ? '=' : op === 'neq' ? '!=' : op === 'gt' ? '>' : op === 'gte' ? '>=' : op === 'lt' ? '<' : op === 'lte' ? '<=' : op === 'contains' ? 'contains' : op}
                                </option>
                              ))}
                            </select>
                            {fieldDef?.type === 'boolean' ? (
                              <select
                                className="form-input"
                                value={rule.value ? 'true' : 'false'}
                                onChange={e => {
                                  const newRules = [...filterRules];
                                  newRules[idx] = { ...rule, value: e.target.value === 'true' };
                                  setFilterRules(newRules);
                                  setDirty(true);
                                }}
                                style={{ width: 70, fontSize: 12 }}
                                data-testid={`filter-value-${idx}`}
                              >
                                <option value="true">Yes</option>
                                <option value="false">No</option>
                              </select>
                            ) : fieldDef?.type === 'number' ? (
                              <input
                                className="form-input"
                                type="number"
                                value={rule.value ?? ''}
                                onChange={e => {
                                  const newRules = [...filterRules];
                                  newRules[idx] = { ...rule, value: e.target.value === '' ? 0 : Number(e.target.value) };
                                  setFilterRules(newRules);
                                  setDirty(true);
                                }}
                                style={{ width: 70, fontSize: 12 }}
                                data-testid={`filter-value-${idx}`}
                              />
                            ) : (
                              <input
                                className="form-input"
                                type="text"
                                value={rule.value ?? ''}
                                onChange={e => {
                                  const newRules = [...filterRules];
                                  newRules[idx] = { ...rule, value: e.target.value };
                                  setFilterRules(newRules);
                                  setDirty(true);
                                }}
                                style={{ width: 100, fontSize: 12 }}
                                data-testid={`filter-value-${idx}`}
                              />
                            )}
                            <button
                              className="btn btn-sm"
                              onClick={() => {
                                setFilterRules(prev => prev.filter((_, i) => i !== idx));
                                setDirty(true);
                              }}
                              style={{ padding: '2px 6px', fontSize: 12, lineHeight: 1 }}
                              data-testid={`filter-remove-${idx}`}
                            >
                              ✕
                            </button>
                          </div>
                        );
                      })}
                      <button
                        className="btn btn-sm"
                        onClick={() => {
                          const first = DEVICE_FILTERABLE_FIELDS[0];
                          setFilterRules(prev => [...prev, {
                            field: first.field,
                            operator: first.operators[0],
                            value: first.type === 'boolean' ? true : first.type === 'number' ? 0 : '',
                          }]);
                          setDirty(true);
                        }}
                        style={{ alignSelf: 'flex-start', fontSize: 12 }}
                        data-testid="filter-add-rule"
                      >
                        + Add filter
                      </button>
                    </div>
                    {knownDevices.length > 0 && (
                      <div className="form-group" style={{ marginTop: 8 }}>
                        <label style={{ fontSize: 13 }}>Restrict to devices</label>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
                          {knownDevices.map(d => (
                            <label key={d.id} style={{ fontSize: 12, cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                checked={filterDeviceIds.includes(d.id)}
                                onChange={e => {
                                  setFilterDeviceIds(prev =>
                                    e.target.checked ? [...prev, d.id] : prev.filter(x => x !== d.id)
                                  );
                                  setDirty(true);
                                }}
                              />{' '}
                              {d.name || d.id}
                            </label>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  )}
                </>
              )}
              {passcode && (
                <div className="form-group">
                  <label>Passcode</label>
                  <code style={{ fontSize: 12, wordBreak: 'break-all' }}>{passcode}</code>
                </div>
              )}
              {serverErrors.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <label style={{ color: 'var(--error)', fontSize: 13, fontWeight: 600 }}>Server Errors</label>
                  {serverErrors.map((e, i) => (
                    <div key={i} style={{ fontSize: 12, color: 'var(--error)', marginTop: 4 }}>{e}</div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <ApiReferencePanel onInsertSnippet={handleInsertSnippet} />
          )}
        </div>
      </div>
      {showRunModal && (
        <div
          className="modal-overlay"
          data-testid="run-modal"
          onClick={e => { if (e.target === e.currentTarget) { setShowRunModal(false); setConfirmDevice(null); } }}
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div className="card" style={{ width: '100%', maxWidth: 480, maxHeight: '70vh', overflow: 'auto', padding: 20, margin: '0 12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ margin: 0 }}>Run on Device</h3>
              <button className="btn btn-sm" onClick={() => { setShowRunModal(false); setConfirmDevice(null); }}>&#10005;</button>
            </div>
            {confirmDevice ? (
              <div data-testid="run-confirm">
                <p style={{ marginBottom: 8 }}>
                  <strong>{confirmDevice.device.name || confirmDevice.device.id}</strong> does not match requirements:
                </p>
                <ul style={{ margin: '0 0 12px 16px', fontSize: 13 }}>
                  {confirmDevice.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
                <p style={{ marginBottom: 12, fontSize: 13 }}>Run anyway?</p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn btn-primary"
                    onClick={() => handleRunOnDevice(confirmDevice.device.id)}
                    data-testid="run-confirm-yes"
                  >
                    Run Anyway
                  </button>
                  <button className="btn" onClick={() => setConfirmDevice(null)} data-testid="run-confirm-no">Cancel</button>
                </div>
              </div>
            ) : runModalLoading ? (
              <LoadingSpinner />
            ) : runModalDevices.length === 0 ? (
              <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>No devices found.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {runModalDevices.map(d => {
                  const warnings = checkDeviceCompatibility(d, currentDeviceFilter);
                  const hasWarnings = warnings.length > 0;
                  return (
                    <button
                      key={d.id}
                      className="btn"
                      disabled={!d.isOnline}
                      onClick={() => {
                        if (hasWarnings) {
                          setConfirmDevice({ device: d, warnings });
                        } else {
                          handleRunOnDevice(d.id);
                        }
                      }}
                      data-testid={`run-device-${d.id}`}
                      style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        opacity: !d.isOnline ? 0.4 : hasWarnings ? 0.6 : 1,
                        textAlign: 'left', padding: '8px 12px',
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{d.name || d.id}</div>
                        {d.name && <div style={{ fontSize: 11, opacity: 0.7 }}>{d.id}</div>}
                        {hasWarnings && d.isOnline && (
                          <div style={{ fontSize: 11, color: 'var(--color-warning, #f59e0b)', marginTop: 2 }}>
                            {warnings.join(', ')}
                          </div>
                        )}
                        {d.isBusy && d.isOnline && (
                          <div style={{ fontSize: 11, color: 'var(--color-warning, #f59e0b)', marginTop: 2 }}>
                            Currently running an automation
                          </div>
                        )}
                      </div>
                      <span style={{
                        display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                        background: !d.isOnline ? '#6b7280' : d.isBusy ? '#f59e0b' : '#22c55e',
                        flexShrink: 0, marginLeft: 8,
                      }} />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
