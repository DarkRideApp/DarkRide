// Monaco worker config — must be before any monaco import
(self as any).MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'typescript' || label === 'javascript') {
      return new Worker(
        new URL('monaco-editor/esm/vs/language/typescript/ts.worker.js', import.meta.url),
        { type: 'module' },
      );
    }
    return new Worker(
      new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
      { type: 'module' },
    );
  },
};

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { useAuthOptional } from '@darkrideapp/plugin-sdk/react';
import { AccessDenied } from '../components/auth/AccessDenied';
import { ConfirmDialog } from '@darkrideapp/plugin-sdk/react';
import { DeviceViewer } from '../components/devices/DeviceViewer';

const DEFAULT_FRIDA_CODE = `// Frida JavaScript — runs inside the target process
Java.perform(function() {
  // Hook example:
  // var Activity = Java.use('com.example.MainActivity');
  // Activity.isRooted.implementation = function() {
  //   console.log('isRooted called, returning false');
  //   return false;
  // };

  console.log('[DarkRide] Script loaded');
});
`;

const CATEGORY_ORDER = [
  'cert-pinning',
  'root-detection',
  'integrity',
  'anti-debug',
  'emulator-detection',
  'analytics-bypass',
  'utility',
];

const CATEGORY_LABELS: Record<string, string> = {
  'cert-pinning': 'Certificate Pinning',
  'root-detection': 'Root Detection',
  'integrity': 'Integrity Checks',
  'anti-debug': 'Anti-Debugging',
  'emulator-detection': 'Emulator Detection',
  'analytics-bypass': 'Analytics / Monitoring Bypass',
  'utility': 'Utility',
};

interface FridaMessage {
  type: string;
  payload: any;
  timestamp?: string;
}

interface FridaScript {
  id: number;
  name: string;
  code: string;
  targetApp: string | null;
  description: string | null;
  category: string | null;
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}

/** sendRestApi always resolves (even for 500s). This wrapper throws on error responses. */
async function fridaApi(ws: ReturnType<typeof useWebSocket>, method: string, path: string, body?: any) {
  const res = await ws.sendRestApi(method, path, body);
  if (!res.body?.success) {
    throw new Error(res.body?.error || `Request failed (${res.status})`);
  }
  return res;
}

export function Frida() {
  useDocumentTitle('Frida');
  const auth = useAuthOptional();
  const ws = useWebSocket();

  // Device + app selection
  const [devices, setDevices] = useState<{ id: string; name?: string; isRooted?: boolean | number }[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [apps, setApps] = useState<{ name: string; identifier: string; pid?: number }[]>([]);
  const [selectedApp, setSelectedApp] = useState<string>('');
  const [appSearch, setAppSearch] = useState('');
  const [showAppDropdown, setShowAppDropdown] = useState(false);

  // Auto-start HTTPS capture with Frida
  const [autoCapture, setAutoCapture] = useState(false);
  const [trafficEntries, setTrafficEntries] = useState<Array<{ url: string; method: string; status: number | null; timestamp: string }>>([]);

  // Gadget mode (non-rooted devices)
  const [gadgetMode, setGadgetMode] = useState(false);
  const [injectedApks, setInjectedApks] = useState<any[]>([]);
  const [injecting, setInjecting] = useState(false);

  // Scripts
  const [scripts, setScripts] = useState<FridaScript[]>([]);
  const [activeScript, setActiveScript] = useState<FridaScript | null>(null);
  const [scriptName, setScriptName] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const [deleteScriptConfirm, setDeleteScriptConfirm] = useState<FridaScript | null>(null);

  // Library/My Scripts tabs + multi-select
  const [activeTab, setActiveTab] = useState<'library' | 'my-scripts'>('library');
  const [selectedScriptIds, setSelectedScriptIds] = useState<Set<number>>(new Set());
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

  // Frida session state
  const [fridaStatus, setFridaStatus] = useState<'stopped' | 'starting' | 'attached'>('stopped');
  const [attachedApp, setAttachedApp] = useState<string>('');
  const [attachedPid, setAttachedPid] = useState<number | null>(null);

  // Output log
  const [messages, setMessages] = useState<FridaMessage[]>([]);
  const [logPaused, setLogPaused] = useState(false);
  const messageIndexRef = useRef(0);

  // Releases
  const [releases, setReleases] = useState<any[]>([]);
  const [selectedVersion, setSelectedVersion] = useState('latest');

  // Script library sidebar
  const [showLibrary, setShowLibrary] = useState(true);

  // Editor refs
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const editorInstanceRef = useRef<any>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const handleSaveRef = useRef<() => void>(() => {});

  // ---------- Derived data ----------

  const builtinScripts = useMemo(() => scripts.filter(s => s.isBuiltin), [scripts]);
  const userScripts = useMemo(() => scripts.filter(s => !s.isBuiltin), [scripts]);

  const scriptsByCategory = useMemo(() => {
    const map: Record<string, FridaScript[]> = {};
    for (const s of builtinScripts) {
      const cat = s.category || 'utility';
      if (!map[cat]) map[cat] = [];
      map[cat].push(s);
    }
    return map;
  }, [builtinScripts]);

  // Category chip data
  const categoryChips = useMemo(() => {
    return CATEGORY_ORDER.map(slug => {
      const catScripts = scriptsByCategory[slug] || [];
      const selectedCount = catScripts.filter(s => selectedScriptIds.has(s.id)).length;
      return { slug, label: CATEGORY_LABELS[slug], total: catScripts.length, selected: selectedCount };
    }).filter(c => c.total > 0);
  }, [scriptsByCategory, selectedScriptIds]);

  const totalSelected = selectedScriptIds.size;

  // ---------- Data fetching ----------

  // Fetch devices on mount
  useEffect(() => {
    ws.sendRestApi('GET', '/v1/device/list')
      .then(res => {
        if (res.body?.data) setDevices(res.body.data);
      })
      .catch(() => {});
  }, [ws]);

  // Start frida-server and fetch apps when device changes (or use gadget mode for non-rooted)
  const [appListError, setAppListError] = useState<string>('');
  useEffect(() => {
    if (!selectedDeviceId) {
      setApps([]);
      setAppListError('');
      setGadgetMode(false);
      return;
    }
    setAppListError('');

    const device = devices.find(d => d.id === selectedDeviceId);
    const rooted = device?.isRooted;

    if (!rooted) {
      // Non-rooted: gadget mode — build app list from injected APKs
      setGadgetMode(true);
      ws.sendRestApi('GET', '/v1/frida/gadget/injected')
        .then(res => {
          const list = res.body?.data || [];
          setInjectedApks(list);
          setApps(list.map((a: any) => ({
            name: a.packageName,
            identifier: a.packageName,
          })));
        })
        .catch(() => {
          setInjectedApks([]);
          setApps([]);
        });
      return;
    }

    // Rooted: use frida-server
    // Only list apps if frida-server is already running — don't auto-start it.
    // frida-server is started explicitly when the user clicks Run/Attach.
    setGadgetMode(false);
    fridaApi(ws, 'GET', `/v1/frida/apps/${selectedDeviceId}`)
      .then(res => { setApps(res.body.data); })
      .catch(() => {
        // frida-server not running yet — leave list empty until user starts it
        setApps([]);
      });
  }, [ws, selectedDeviceId, devices]);

  // Fetch scripts and releases
  useEffect(() => {
    ws.sendRestApi('GET', '/v1/frida/scripts')
      .then(res => {
        if (res.body?.data) setScripts(res.body.data);
      })
      .catch(() => {});
    ws.sendRestApi('GET', '/v1/frida/releases')
      .then(res => {
        if (res.body?.data) setReleases(res.body.data);
      })
      .catch(() => {});
  }, [ws]);

  // ---------- Monaco editor ----------

  useEffect(() => {
    if (!editorContainerRef.current) return;
    let disposed = false;
    let editor: any = null;

    (async () => {
      const monaco = await import('monaco-editor');
      if (disposed) return;

      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      editor = monaco.editor.create(editorContainerRef.current!, {
        value: activeScript?.code || DEFAULT_FRIDA_CODE,
        language: 'javascript',
        theme: isDark ? 'vs-dark' : 'vs-light',
        minimap: { enabled: false },
        fontSize: 14,
        automaticLayout: true,
        scrollBeyondLastLine: false,
      });
      editorInstanceRef.current = editor;

      editor.onDidChangeModelContent(() => {
        setDirty(true);
      });

      // Ctrl+S
      editor.addAction({
        id: 'save-frida-script',
        label: 'Save Script',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: () => {
          handleSaveRef.current();
        },
      });
    })();

    return () => {
      disposed = true;
      if (editor) editor.dispose();
      editorInstanceRef.current = null;
    };
  }, []); // Init once

  // ---------- Handlers ----------

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const code = editorInstanceRef.current?.getValue() || '';
      if (activeScript?.id) {
        await ws.sendRestApi('PUT', `/v1/frida/scripts/${activeScript.id}`, {
          name: scriptName,
          code,
        });
      } else {
        const res = await ws.sendRestApi('POST', '/v1/frida/scripts', {
          name: scriptName || 'Untitled',
          code,
          targetApp: selectedApp || null,
        });
        if (res.body?.data) {
          setActiveScript(res.body.data);
        }
      }
      setDirty(false);
      // Refresh script list
      const listRes = await ws.sendRestApi('GET', '/v1/frida/scripts');
      if (listRes.body?.data) setScripts(listRes.body.data);
    } catch {}
    setSaving(false);
  }, [ws, activeScript, scriptName, selectedApp]);

  handleSaveRef.current = handleSave;

  // Global Ctrl+S
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

  // Ensure HTTPS capture is running if autoCapture is enabled.
  // Surfaces backend failures into the message log so the toggle isn't silent.
  const ensureCapture = useCallback(async () => {
    if (!autoCapture || !selectedDeviceId) return;
    try {
      const res = await ws.sendRestApi('POST', '/v1/capture/start', { deviceId: selectedDeviceId });
      // sendRestApi always resolves, even for 500s — inspect res.body.success.
      if (res.body?.success === false) {
        const msg = res.body?.error || 'capture start failed';
        // Already capturing is a success-equivalent from the user's POV.
        if (!/already capturing|session.*active/i.test(msg)) {
          setMessages(prev => [...prev, {
            type: 'error',
            payload: `Auto-start HTTPS capture failed: ${msg}`,
            timestamp: new Date().toISOString(),
          }]);
        }
      }
    } catch (err: any) {
      setMessages(prev => [...prev, {
        type: 'error',
        payload: `Auto-start HTTPS capture failed: ${err?.message ?? err}`,
        timestamp: new Date().toISOString(),
      }]);
    }
  }, [autoCapture, selectedDeviceId, ws]);

  // Fire ensureCapture when the toggle flips on (or a device is selected while
  // on) — don't wait for the user to click Run. Previously the toggle only
  // took effect inside handleRun, which looked like the toggle "did nothing"
  // until you also clicked Run.
  useEffect(() => {
    if (!autoCapture || !selectedDeviceId) return;
    ensureCapture();
  }, [autoCapture, selectedDeviceId, ensureCapture]);

  const handleRunSelected = useCallback(async () => {
    if (!selectedDeviceId || !selectedApp || totalSelected === 0) return;
    setFridaStatus('starting');
    setMessages([]);
    messageIndexRef.current = 0;
    try {
      await ensureCapture();
      const selectedNames = scripts
        .filter(s => selectedScriptIds.has(s.id))
        .map(s => s.name);

      if (!gadgetMode) {
        await fridaApi(ws, 'POST', `/v1/frida/start/${selectedDeviceId}`, { version: selectedVersion });
      }

      const body: any = {
        bundleId: selectedApp,
        scripts: selectedNames,
        mode: gadgetMode ? 'attach' : 'spawn',
      };
      if (gadgetMode) body.app_name = selectedApp;

      const res = await fridaApi(ws, 'POST', `/v1/frida/spawn/${selectedDeviceId}`, body);
      setAttachedPid(res.body.data.pid);
      setAttachedApp(selectedApp);
      setFridaStatus('attached');
    } catch (err: any) {
      setMessages(prev => [
        ...prev,
        { type: 'error', payload: `Run failed: ${err.message}`, timestamp: new Date().toISOString() },
      ]);
      setFridaStatus('stopped');
    }
  }, [ws, selectedDeviceId, selectedApp, gadgetMode, scripts, selectedScriptIds, totalSelected, selectedVersion]);

  const handleRun = useCallback(async () => {
    if (!selectedDeviceId || !selectedApp) return;
    setFridaStatus('starting');
    setMessages([]);
    messageIndexRef.current = 0;
    try {
      await ensureCapture();
      if (gadgetMode) {
        // Gadget mode: attach by app name (gadget is already in the APK)
        const code = editorInstanceRef.current?.getValue() || '';
        const body: any = {
          bundleId: selectedApp,
          mode: 'attach',
          app_name: selectedApp,
        };
        if (code.trim()) body.code = code;
        const res = await fridaApi(ws, 'POST', `/v1/frida/spawn/${selectedDeviceId}`, body);
        setAttachedPid(res.body.data.pid);
        setAttachedApp(selectedApp);
      } else {
        // Normal mode: start frida-server and spawn
        await fridaApi(ws, 'POST', `/v1/frida/start/${selectedDeviceId}`, { version: selectedVersion });
        const body: any = { bundleId: selectedApp };
        const code = editorInstanceRef.current?.getValue() || '';
        if (code.trim()) body.code = code;
        const spawnRes = await fridaApi(ws, 'POST', `/v1/frida/spawn/${selectedDeviceId}`, body);
        setAttachedPid(spawnRes.body.data.pid);
        setAttachedApp(selectedApp);
      }
      setFridaStatus('attached');
    } catch (err: any) {
      setMessages(prev => [
        ...prev,
        {
          type: 'error',
          payload: `Run failed: ${err.message}`,
          timestamp: new Date().toISOString(),
        },
      ]);
      setFridaStatus('stopped');
    }
  }, [ws, selectedDeviceId, selectedApp, gadgetMode, selectedVersion]);

  const handleAttach = useCallback(async () => {
    if (!selectedDeviceId || !selectedApp) return;
    setFridaStatus('starting');
    setMessages([]);
    messageIndexRef.current = 0;
    try {
      await ensureCapture();
      await fridaApi(ws, 'POST', `/v1/frida/start/${selectedDeviceId}`, { version: selectedVersion });
      const app = apps.find(a => a.identifier === selectedApp);
      if (!app?.pid) {
        throw new Error('App is not running (no PID)');
      }
      const code = editorInstanceRef.current?.getValue() || '';
      await fridaApi(ws, 'POST', `/v1/frida/spawn/${selectedDeviceId}`, {
        bundleId: selectedApp,
        code,
        mode: 'attach',
        pid: app.pid,
      });
      setAttachedPid(app.pid);
      setAttachedApp(selectedApp);
      setFridaStatus('attached');
    } catch (err: any) {
      setMessages(prev => [
        ...prev,
        {
          type: 'error',
          payload: `Attach failed: ${err.message}`,
          timestamp: new Date().toISOString(),
        },
      ]);
      setFridaStatus('stopped');
    }
  }, [ws, selectedDeviceId, selectedApp, apps, selectedVersion]);

  const handleStop = useCallback(async () => {
    if (!selectedDeviceId) return;
    try {
      await ws.sendRestApi('POST', `/v1/frida/stop/${selectedDeviceId}`);
    } catch {}
    setFridaStatus('stopped');
    setAttachedPid(null);
    setAttachedApp('');
  }, [ws, selectedDeviceId]);

  // Message polling (when attached)
  useEffect(() => {
    if (fridaStatus !== 'attached' || !selectedDeviceId || logPaused) return;
    const interval = setInterval(async () => {
      try {
        const res = await ws.sendRestApi(
          'GET',
          `/v1/frida/messages/${selectedDeviceId}?since=${messageIndexRef.current}`,
        );
        if (res.body?.data?.messages?.length) {
          setMessages(prev => [...prev, ...res.body.data.messages]);
          messageIndexRef.current = res.body.data.next_index;
          if (logContainerRef.current) {
            logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
          }
        }
      } catch {}
    }, 500);
    return () => clearInterval(interval);
  }, [ws, selectedDeviceId, fridaStatus, logPaused]);

  // Subscribe to live traffic entries when capture is active
  useEffect(() => {
    if (!autoCapture || fridaStatus !== 'attached') return;
    const unsub = ws.subscribe('traffic-entry', (msg: any) => {
      const entry = msg.entry;
      if (!entry) return;
      // Only show entries for our device
      if (selectedDeviceId && entry.deviceId && entry.deviceId !== selectedDeviceId) return;
      setTrafficEntries(prev => {
        const next = [...prev, {
          url: entry.requestUrl || '',
          method: entry.requestMethod || 'GET',
          status: entry.responseStatus,
          timestamp: entry.capturedAt || new Date().toISOString(),
        }];
        return next.length > 200 ? next.slice(-200) : next;
      });
    });
    return unsub;
  }, [ws, autoCapture, fridaStatus, selectedDeviceId]);

  // Clear traffic entries when starting a new run
  useEffect(() => {
    if (fridaStatus === 'starting') setTrafficEntries([]);
  }, [fridaStatus]);

  // Open / new script
  const openScript = useCallback((script: FridaScript) => {
    setActiveScript(script);
    setScriptName(script.name);
    if (editorInstanceRef.current) {
      editorInstanceRef.current.setValue(script.code);
      // Make editor read-only for builtin scripts
      editorInstanceRef.current.updateOptions({ readOnly: !!script.isBuiltin });
    }
    // Auto-populate app selector from script's targetApp
    if (script.targetApp) {
      setSelectedApp(script.targetApp);
      const match = apps.find(a => a.identifier === script.targetApp);
      setAppSearch(match ? match.name : script.targetApp);
    }
    setDirty(false);
  }, [apps]);

  const handleNewScript = useCallback(() => {
    setActiveScript(null);
    setScriptName('');
    if (editorInstanceRef.current) {
      editorInstanceRef.current.setValue(DEFAULT_FRIDA_CODE);
      editorInstanceRef.current.updateOptions({ readOnly: false });
    }
    setDirty(false);
    setActiveTab('my-scripts');
  }, []);

  const handleDuplicateScript = useCallback(async (script: FridaScript) => {
    try {
      const res = await ws.sendRestApi('POST', '/v1/frida/scripts', {
        name: script.name + ' (copy)',
        code: script.code,
        targetApp: script.targetApp || null,
        description: script.description || null,
      });
      if (res.body?.data) {
        const listRes = await ws.sendRestApi('GET', '/v1/frida/scripts');
        if (listRes.body?.data) setScripts(listRes.body.data);
        setActiveScript(res.body.data);
        setScriptName(res.body.data.name);
        if (editorInstanceRef.current) {
          editorInstanceRef.current.setValue(res.body.data.code);
          editorInstanceRef.current.updateOptions({ readOnly: false });
        }
        setActiveTab('my-scripts');
        setDirty(false);
      }
    } catch {}
  }, [ws]);

  const handleDeleteScript = useCallback((id: number, name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const script = scripts.find(s => s.id === id);
    if (script) setDeleteScriptConfirm(script);
  }, [scripts]);

  const confirmDeleteScript = useCallback(async (id: number) => {
    try {
      await ws.sendRestApi('DELETE', `/v1/frida/scripts/${id}`);
      setScripts(prev => prev.filter(s => s.id !== id));
      setSelectedScriptIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      if (activeScript?.id === id) {
        handleNewScript();
      }
    } catch {}
    setDeleteScriptConfirm(null);
  }, [ws, activeScript, handleNewScript]);

  // Multi-select helpers
  const toggleScriptSelection = useCallback((id: number) => {
    setSelectedScriptIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleCategory = useCallback((slug: string) => {
    const catScripts = scriptsByCategory[slug] || [];
    const allSelected = catScripts.every(s => selectedScriptIds.has(s.id));
    setSelectedScriptIds(prev => {
      const next = new Set(prev);
      for (const s of catScripts) {
        if (allSelected) next.delete(s.id);
        else next.add(s.id);
      }
      return next;
    });
  }, [scriptsByCategory, selectedScriptIds]);

  const toggleCategoryCollapse = useCallback((slug: string) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }, []);

  // App search filtering
  const filteredApps = apps.filter(
    a =>
      a.name.toLowerCase().includes(appSearch.toLowerCase()) ||
      a.identifier.toLowerCase().includes(appSearch.toLowerCase()),
  );

  // Status color
  const statusColor =
    fridaStatus === 'attached'
      ? 'var(--success, #22c55e)'
      : fridaStatus === 'starting'
        ? 'var(--warning, #eab308)'
        : 'var(--text-muted, #888)';

  if (auth && !auth.hasScope('core.frida:read')) return <AccessDenied scope="core.frida:read" />;

  const canManageFrida = !auth || auth.hasScope('core.frida:manage');

  return (
    <div data-testid="frida-page">
      <div className="page-header">
        <h1>Frida</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: statusColor,
            }}
          />
          <span style={{ fontSize: 13, opacity: 0.7 }}>
            {fridaStatus === 'attached'
              ? `Attached to ${attachedApp} (PID ${attachedPid})`
              : fridaStatus === 'starting'
                ? 'Starting...'
                : 'Stopped'}
          </span>
        </div>
      </div>

      {/* Toolbar row */}
      <div
        className="frida-toolbar"
        style={{
          display: 'flex',
          gap: 12,
          marginBottom: 12,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        {/* Toggle library */}
        <button
          className="btn btn-sm"
          onClick={() => setShowLibrary(v => !v)}
          title={showLibrary ? 'Hide script library' : 'Show script library'}
        >
          {showLibrary ? 'Hide Scripts' : 'Scripts'}
        </button>

        {/* Device selector */}
        <select
          className="form-input"
          style={{ width: 200 }}
          value={selectedDeviceId}
          onChange={e => setSelectedDeviceId(e.target.value)}
        >
          <option value="">Select Device...</option>
          {devices.map(d => (
            <option key={d.id} value={d.id}>
              {d.name || d.id}
            </option>
          ))}
        </select>

        {gadgetMode && selectedDeviceId && (
          <span className="badge badge-warning" style={{ fontSize: 11 }}>Gadget Mode</span>
        )}

        {/* App selector (searchable) */}
        <div style={{ position: 'relative', width: 280 }}>
          <input
            className="form-input"
            style={{ width: '100%' }}
            placeholder="Search apps..."
            value={appSearch}
            onChange={e => {
              setAppSearch(e.target.value);
              setSelectedApp(e.target.value); // Allow typing custom bundle IDs
              setShowAppDropdown(true);
            }}
            onFocus={() => setShowAppDropdown(true)}
            onBlur={() => setTimeout(() => setShowAppDropdown(false), 200)}
          />
          {showAppDropdown && filteredApps.length > 0 && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                right: 0,
                maxHeight: 240,
                overflow: 'auto',
                background: 'var(--card-bg, #1e1e1e)',
                border: '1px solid var(--border-color, #333)',
                borderRadius: 4,
                zIndex: 100,
              }}
            >
              {filteredApps.map(a => (
                <div
                  key={a.identifier}
                  style={{
                    padding: '6px 10px',
                    cursor: 'pointer',
                    fontSize: 13,
                    background:
                      selectedApp === a.identifier ? 'var(--primary-bg, #2563eb22)' : 'transparent',
                  }}
                  onMouseDown={() => {
                    setSelectedApp(a.identifier);
                    setAppSearch(a.name);
                    setShowAppDropdown(false);
                  }}
                >
                  <div style={{ fontWeight: 500 }}>{a.name}</div>
                  <div style={{ fontSize: 11, opacity: 0.6 }}>
                    {a.identifier}
                    {a.pid ? ` (PID ${a.pid})` : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
          {appListError && (
            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, padding: '6px 10px', fontSize: 12, color: 'var(--error, #ef4444)', background: 'var(--card-bg, #1e1e1e)', border: '1px solid var(--error, #ef4444)', borderRadius: 4, zIndex: 100 }}>
              {appListError}
            </div>
          )}
        </div>

        {/* Version selector */}
        <select
          className="form-input"
          style={{ width: 150 }}
          value={selectedVersion}
          onChange={e => setSelectedVersion(e.target.value)}
        >
          <option value="latest">Latest</option>
          {releases
            .filter(r => r.isDownloaded)
            .map(r => (
              <option key={r.version} value={r.version}>
                {r.version}
              </option>
            ))}
        </select>

        <div style={{ flex: 1 }} />

        {/* Gadget: Inject & Install */}
        {gadgetMode && selectedDeviceId && selectedApp && (
          <button
            className="btn"
            disabled={injecting}
            onClick={async () => {
              setInjecting(true);
              try {
                const injectRes = await fridaApi(ws, 'POST', '/v1/frida/gadget/inject', {
                  packageName: selectedApp,
                });
                const injectedApkId = injectRes.body.data.id;
                await fridaApi(ws, 'POST', `/v1/frida/gadget/install/${selectedDeviceId}`, {
                  injectedApkId,
                });
                // Refresh injected APK list
                const listRes = await ws.sendRestApi('GET', '/v1/frida/gadget/injected');
                const list = listRes.body?.data || [];
                setInjectedApks(list);
                setApps(list.map((a: any) => ({
                  name: a.packageName,
                  identifier: a.packageName,
                })));
              } catch (err: any) {
                setMessages(prev => [
                  ...prev,
                  {
                    type: 'error',
                    payload: `Inject failed: ${err.message}`,
                    timestamp: new Date().toISOString(),
                  },
                ]);
              } finally {
                setInjecting(false);
              }
            }}
          >
            {injecting ? 'Injecting...' : 'Inject & Install'}
          </button>
        )}

        {/* Options */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer', color: 'var(--text-muted)' }}>
          <input
            type="checkbox"
            checked={autoCapture}
            onChange={e => setAutoCapture(e.target.checked)}
          />
          Auto-start HTTPS capture
        </label>

        {/* Action buttons */}
        {canManageFrida && (
          <>
            <button
              className="btn btn-primary"
              onClick={handleRun}
              disabled={!selectedDeviceId || !selectedApp || fridaStatus !== 'stopped'}
            >
              {gadgetMode ? 'Launch' : 'Run'}
            </button>
            <button
              className="btn btn-secondary"
              onClick={handleAttach}
              disabled={!selectedDeviceId || !selectedApp || fridaStatus !== 'stopped'}
            >
              Attach
            </button>
            <button
              className="btn btn-danger"
              onClick={handleStop}
              disabled={fridaStatus === 'stopped'}
            >
              Stop
            </button>
          </>
        )}
      </div>

      {/* Quick Profile Bar — category chips + run selected.
          The chips look enigmatic to a new user without an explainer; one
          short sentence above transforms "rectangle of buttons" into
          "1-click bypass profiles" (per fresh review §1b — this feature is
          a Burp-tier capability that nothing in the UI explains). */}
      {builtinScripts.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 12,
              marginBottom: 6,
              flexWrap: 'wrap',
            }}
          >
            <h2 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: 'var(--text-primary)' }}>
              Bypass profiles
            </h2>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              Pick categories, hit Run Selected — DarkRide pre-bakes Frida scripts that defeat SSL pinning, root detection, integrity checks, and anti-debug for most apps.
            </span>
          </div>
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexWrap: 'wrap',
            padding: '8px 12px',
            background: 'var(--card-bg, #1e1e1e)',
            borderRadius: 6,
            border: '1px solid var(--border-color, #333)',
          }}
        >
          {categoryChips.map(chip => {
            const isActive = chip.selected > 0;
            const allSelected = chip.selected === chip.total;
            return (
              <button
                key={chip.slug}
                onClick={() => toggleCategory(chip.slug)}
                style={{
                  padding: '4px 10px',
                  fontSize: 12,
                  borderRadius: 12,
                  border: `1px solid ${isActive ? 'var(--primary, #3b82f6)' : 'var(--border-color, #555)'}`,
                  background: allSelected ? 'var(--primary, #3b82f6)' : isActive ? 'var(--primary-bg, #2563eb22)' : 'transparent',
                  color: allSelected ? '#fff' : 'inherit',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {chip.label}
                <span style={{ opacity: 0.7, marginLeft: 4 }}>
                  {chip.selected}/{chip.total}
                </span>
              </button>
            );
          })}

          <div style={{ flex: 1 }} />

          {totalSelected > 0 && (
            <>
              <span style={{ fontSize: 12, opacity: 0.7 }}>
                {totalSelected} script{totalSelected !== 1 ? 's' : ''} selected
              </span>
              <button
                className="btn btn-sm btn-primary"
                onClick={handleRunSelected}
                disabled={!selectedDeviceId || !selectedApp || fridaStatus !== 'stopped'}
              >
                Run Selected
              </button>
            </>
          )}
        </div>
        </div>
      )}

      <div className="editor-mobile-notice" data-testid="editor-mobile-notice">
        <strong>Limited editing on mobile</strong> — The Frida IDE works best on desktop. You can still view scripts and run basic operations here.
      </div>

      {/* Main layout: scripts sidebar | editor+output | device stream */}
      <div
        className="frida-main-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: showLibrary
            ? '240px 1fr 320px'
            : '1fr 320px',
          gap: 16,
          height: 'calc(100vh - 300px)',
        }}
      >
        {/* Script Library Sidebar (collapsible) */}
        {showLibrary && (
          <div className="card" style={{ overflow: 'auto', padding: 0, display: 'flex', flexDirection: 'column' }}>
            {/* Tabs */}
            <div style={{ display: 'flex', borderBottom: '1px solid var(--border-color, #333)' }}>
              <button
                onClick={() => setActiveTab('library')}
                style={{
                  flex: 1,
                  padding: '8px 0',
                  fontSize: 12,
                  fontWeight: 600,
                  background: 'transparent',
                  border: 'none',
                  borderBottom: activeTab === 'library' ? '2px solid var(--primary, #3b82f6)' : '2px solid transparent',
                  color: activeTab === 'library' ? 'var(--primary, #3b82f6)' : 'inherit',
                  cursor: 'pointer',
                }}
              >
                Library ({builtinScripts.length})
              </button>
              {activeTab === 'library' && (
                <button
                  title="Re-sync builtin scripts from server"
                  onClick={async () => {
                    try {
                      const res = await ws.sendRestApi('POST', '/v1/frida/scripts/reseed');
                      if (res.body?.data) setScripts(res.body.data);
                    } catch {}
                  }}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-muted, #888)',
                    cursor: 'pointer',
                    padding: '4px 8px',
                    fontSize: 14,
                    alignSelf: 'center',
                  }}
                >
                  &#x21bb;
                </button>
              )}
              <button
                onClick={() => setActiveTab('my-scripts')}
                style={{
                  flex: 1,
                  padding: '8px 0',
                  fontSize: 12,
                  fontWeight: 600,
                  background: 'transparent',
                  border: 'none',
                  borderBottom: activeTab === 'my-scripts' ? '2px solid var(--primary, #3b82f6)' : '2px solid transparent',
                  color: activeTab === 'my-scripts' ? 'var(--primary, #3b82f6)' : 'inherit',
                  cursor: 'pointer',
                }}
              >
                My Scripts ({userScripts.length})
              </button>
            </div>

            <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
              {activeTab === 'library' ? (
                /* Library tab — grouped by category */
                <>
                  {CATEGORY_ORDER.map(slug => {
                    const catScripts = scriptsByCategory[slug];
                    if (!catScripts?.length) return null;
                    const collapsed = collapsedCategories.has(slug);
                    const allSelected = catScripts.every(s => selectedScriptIds.has(s.id));
                    const someSelected = catScripts.some(s => selectedScriptIds.has(s.id));

                    return (
                      <div key={slug} style={{ marginBottom: 4 }}>
                        {/* Category header */}
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            padding: '4px 4px',
                            cursor: 'pointer',
                            fontSize: 11,
                            fontWeight: 600,
                            textTransform: 'uppercase',
                            letterSpacing: '0.5px',
                            opacity: 0.7,
                          }}
                          onClick={() => toggleCategoryCollapse(slug)}
                        >
                          <input
                            type="checkbox"
                            checked={allSelected}
                            ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
                            onChange={(e) => {
                              e.stopPropagation();
                              toggleCategory(slug);
                            }}
                            onClick={(e) => e.stopPropagation()}
                            style={{ marginRight: 4 }}
                          />
                          <span style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', display: 'inline-block' }}>
                            &#9660;
                          </span>
                          {CATEGORY_LABELS[slug]}
                          <span style={{ marginLeft: 'auto', fontWeight: 400 }}>{catScripts.length}</span>
                        </div>

                        {/* Scripts in category */}
                        {!collapsed && catScripts.map(s => (
                          <div
                            key={s.id}
                            onClick={() => openScript(s)}
                            style={{
                              padding: '4px 8px 4px 24px',
                              borderRadius: 4,
                              cursor: 'pointer',
                              fontSize: 12,
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              background:
                                activeScript?.id === s.id ? 'var(--primary-bg, #2563eb22)' : 'transparent',
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={selectedScriptIds.has(s.id)}
                              onChange={(e) => {
                                e.stopPropagation();
                                toggleScriptSelection(s.id);
                              }}
                              onClick={(e) => e.stopPropagation()}
                            />
                            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {s.name}
                            </span>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </>
              ) : (
                /* My Scripts tab — flat list, editable */
                <>
                  {canManageFrida && (
                    <div style={{ marginBottom: 8 }}>
                      <button className="btn btn-sm" onClick={handleNewScript} style={{ width: '100%' }}>
                        + New Script
                      </button>
                    </div>
                  )}
                  {userScripts.map(s => (
                    <div
                      key={s.id}
                      onClick={() => openScript(s)}
                      style={{
                        padding: '6px 8px',
                        borderRadius: 4,
                        cursor: 'pointer',
                        fontSize: 12,
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        background:
                          activeScript?.id === s.id ? 'var(--primary-bg, #2563eb22)' : 'transparent',
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                        {s.targetApp && (
                          <div style={{ fontSize: 11, opacity: 0.6 }}>{s.targetApp}</div>
                        )}
                      </div>
                      {canManageFrida && (
                        <button
                          className="btn btn-sm"
                          onClick={(e) => handleDeleteScript(s.id, s.name, e)}
                          style={{ opacity: 0.5, padding: '2px 6px', fontSize: 11, flexShrink: 0 }}
                          title="Delete script"
                        >
                          x
                        </button>
                      )}
                    </div>
                  ))}
                  {userScripts.length === 0 && (
                    <div style={{ fontSize: 12, opacity: 0.5, textAlign: 'center', padding: 16 }}>
                      No custom scripts yet
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* Center: Editor + Output Log stacked */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
          {/* Editor */}
          <div
            className="card"
            style={{
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              padding: 0,
              minHeight: 0,
              flex: 2,
            }}
          >
            {/* Script header */}
            <div
              style={{
                padding: '8px 12px',
                borderBottom: '1px solid var(--border-color, #333)',
                display: 'flex',
                gap: 8,
                alignItems: 'center',
              }}
            >
              <input
                className="form-input"
                style={{ flex: 1 }}
                placeholder="Script name..."
                value={scriptName}
                onChange={e => {
                  setScriptName(e.target.value);
                  setDirty(true);
                }}
                readOnly={activeScript?.isBuiltin}
              />
              {activeScript?.isBuiltin ? (
                <button
                  className="btn btn-sm"
                  onClick={() => handleDuplicateScript(activeScript)}
                  title="Duplicate as editable user script"
                >
                  Duplicate
                </button>
              ) : (
                <button
                  className="btn btn-sm btn-primary"
                  onClick={handleSave}
                  disabled={saving}
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
              )}
              {dirty && !activeScript?.isBuiltin && (
                <span style={{ fontSize: 11, opacity: 0.5 }}>unsaved</span>
              )}
              {activeScript?.isBuiltin && (
                <span style={{ fontSize: 11, opacity: 0.5 }}>read-only</span>
              )}
            </div>
            <div ref={editorContainerRef} style={{ flex: 1, minHeight: 0 }} />
          </div>

          {/* Output Log */}
          <div
            className="card"
            style={{
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              padding: 0,
              flex: 1,
              minHeight: 120,
            }}
          >
            <div
              style={{
                padding: '8px 12px',
                borderBottom: '1px solid var(--border-color, #333)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <strong style={{ fontSize: 13 }}>Output</strong>
              <div style={{ display: 'flex', gap: 4 }}>
                <button className="btn btn-sm" onClick={() => {
                  const text = messages.map(msg => {
                    const ts = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : '';
                    const payload = typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload);
                    return `[${ts}] ${payload}`;
                  }).join('\n');
                  navigator.clipboard.writeText(text);
                }}>
                  Copy
                </button>
                <button className="btn btn-sm" onClick={() => setLogPaused(p => !p)}>
                  {logPaused ? 'Resume' : 'Pause'}
                </button>
                <button className="btn btn-sm" onClick={() => setMessages([])}>
                  Clear
                </button>
              </div>
            </div>
            <div
              ref={logContainerRef}
              style={{
                flex: 1,
                overflow: 'auto',
                padding: '8px 12px',
                fontFamily: 'monospace',
                fontSize: 12,
              }}
            >
              {messages.map((msg, i) => (
                <div
                  key={i}
                  style={{
                    color:
                      msg.type === 'error'
                        ? 'var(--error, #ef4444)'
                        : msg.type === 'send'
                          ? 'var(--primary, #3b82f6)'
                          : 'inherit',
                    marginBottom: 2,
                  }}
                >
                  <span style={{ opacity: 0.5 }}>
                    [{msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : ''}]
                  </span>{' '}
                  {typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload)}
                </div>
              ))}
            </div>
          </div>

          {/* Live traffic summary — inside the center column so it stacks
              below the Output log instead of hijacking a grid cell that
              should belong to the Device Stream panel. */}
          {autoCapture && trafficEntries.length > 0 && (
            <div className="card" style={{
              maxHeight: 200, overflow: 'auto', fontSize: 11, fontFamily: 'monospace',
              background: 'var(--bg-secondary)',
              padding: 0,
            }}>
              <div style={{ padding: '4px 12px', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', borderBottom: '1px solid var(--border-color)', position: 'sticky', top: 0, background: 'var(--bg-secondary)' }}>
                Traffic ({trafficEntries.length})
              </div>
              {trafficEntries.slice().reverse().map((entry, i) => {
                const portPathRe = /:\d+\/.*/;
                const statusColor = entry.status === null ? '#6b7280'
                  : entry.status === 0 ? '#ef4444'
                  : entry.status >= 200 && entry.status < 300 ? '#22c55e'
                  : entry.status >= 400 ? '#ef4444' : '#f97316';
                // Extract just the pathname for compact display
                let displayUrl = entry.url;
                try { displayUrl = new URL(entry.url).pathname; } catch {}
                return (
                  <div key={i} style={{ padding: '2px 12px', display: 'flex', gap: 8, alignItems: 'baseline', borderBottom: '1px solid var(--border-color)', opacity: entry.status === 0 ? 1 : 0.85 }}>
                    <span style={{ color: statusColor, fontWeight: 600, minWidth: 28, textAlign: 'right' }}>
                      {entry.status === 0 ? 'TLS' : entry.status ?? '...'}
                    </span>
                    <span style={{ color: '#3b82f6', minWidth: 32 }}>{entry.method}</span>
                    <span style={{
                      flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      color: entry.status === 0 ? '#ef4444' : 'var(--text-primary)',
                      fontWeight: entry.status === 0 ? 600 : 400,
                    }}
                      title={entry.url}
                    >
                      {entry.status === 0 ? entry.url.replace('https://', '').replace(portPathRe, '') + ' (SSL pinning)' : displayUrl}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right panel: Device Stream */}
        <div
          className="card frida-device-panel"
          style={{
            overflow: 'hidden',
            padding: 0,
            alignSelf: 'start',
          }}
        >
          {selectedDeviceId && <DeviceViewer deviceId={selectedDeviceId} />}
        </div>
      </div>

      {deleteScriptConfirm && (
        <ConfirmDialog
          title="Delete Script"
          message={`Are you sure you want to delete "${deleteScriptConfirm.name}"?`}
          onConfirm={() => confirmDeleteScript(deleteScriptConfirm.id)}
          onCancel={() => setDeleteScriptConfirm(null)}
        />
      )}
    </div>
  );
}
