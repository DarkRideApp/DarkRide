import React, { useEffect, useRef, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { pluginRegistry, usePluginRegistrySnapshot } from '@darkrideapp/plugin-sdk/react';
import { installSlotInspectorShortcut } from '@darkrideapp/plugin-sdk/react';
import './plugins'; // side-effect: registers all plugin frontend entries
import { WebSocketContext, useWebSocketManager } from '@darkrideapp/plugin-sdk/react';
import { ToastProvider, useToast } from '@darkrideapp/plugin-sdk/react';
import { AuthProvider, useAuth } from '@darkrideapp/plugin-sdk/react';
import { AuthGuard } from './components/auth/AuthGuard';
import { AppLayout } from './components/layout/AppLayout';
import { StartupScreen } from './components/StartupScreen';
import { ClipboardToastBridge } from './components/terminal/ClipboardToastBridge';
import { Dashboard } from './pages/Dashboard';
import { Devices } from './pages/Devices';
import { DeviceView } from './pages/DeviceView';
import { Automations } from './pages/Automations';
import { AutomationEditor } from './pages/AutomationEditor';
import { AutomationReviewer, SessionTimeline } from './pages/AutomationReviewer';
import { Proxies } from './pages/Proxies';
import { Traffic } from './pages/Traffic';
import { SelectorDebugger } from './pages/SelectorDebugger';
import { Utils } from './pages/Utils';
import { SettingsLayout } from './components/settings/SettingsLayout';
import { NotificationsPage } from './pages/settings/NotificationsPage';
import { IntegrationsPage } from './pages/settings/IntegrationsPage';
import { AIPage } from './pages/settings/AIPage';
import { AnalysisPage } from './pages/settings/AnalysisPage';
import { CloudStoragePage } from './pages/settings/CloudStoragePage';
import { CertificatesPage } from './pages/settings/CertificatesPage';
import { TrafficSettingsPage } from './pages/settings/TrafficSettingsPage';
import { ChangelogPage } from './pages/settings/ChangelogPage';
import { LicensePage } from './pages/settings/LicensePage';
import { Credentials } from './pages/Credentials';
import { SessionHistory } from './pages/SessionHistory';
import { ProxiedRequests } from './pages/ProxiedRequests';
import { AppLibrary } from './pages/AppLibrary';
import { AppDetail } from './pages/AppDetail';
import { ApkAnalysis } from './pages/ApkAnalysis';
import { Frida } from './pages/Frida';
import { CloudBrowser } from './pages/CloudBrowser';
import { ApiCatalogue } from './pages/ApiCatalogue';
import { ApiExplorer } from './pages/ApiExplorer';
import { RequestBuilder } from './pages/RequestBuilder';
import { Jobs } from './pages/Jobs';
import { PluginManager } from './pages/PluginManager';
import { PluginMarketplace } from './pages/PluginMarketplace';
import { ProfilePage } from './pages/ProfilePage';
import { AdminUsersPage } from './pages/AdminUsersPage';
import { McpSettings } from './pages/McpSettings';
import { SdkCatalog } from './pages/SdkCatalog';
import ConsentPage from './pages/oauth/ConsentPage';

/**
 * Provides a reactive snapshot of the current enabled plugin pages.
 *
 * Returns `[]` until the registry's disabled-plugin list has loaded so that
 * direct navigation to a disabled plugin's URL doesn't briefly render its
 * page before the fetch resolves.
 *
 * Exported for direct unit testing.
 */
export function usePluginPages() {
  return usePluginRegistrySnapshot(r => r.isDisabledLoaded() ? r.getPages() : []);
}

/**
 * Provides a reactive snapshot of the current enabled plugin settings entries.
 *
 * Returns `[]` until the registry's disabled-plugin list has loaded so that
 * direct navigation to a disabled plugin's settings URL doesn't briefly
 * render its component before the fetch resolves.
 *
 * Exported for direct unit testing.
 */
export function usePluginSettings() {
  return usePluginRegistrySnapshot(r => r.isDisabledLoaded() ? r.getSettings() : []);
}

/**
 * Catch-all route element that defers the "redirect to /ui/" decision
 * until the disabled-plugins fetch has resolved.
 *
 * Why: deep-linking to a plugin URL (e.g. F5 on `/ui/my-plugin/1/detail/52`)
 * races against the disabled-plugins fetch. Until it resolves, usePluginPages
 * returns `[]` so React Router can't match the plugin route — and the
 * catch-all would fire, redirecting the user back to `/ui/`. By the time the
 * fetch resolves, the user has already been bounced.
 *
 * This component holds the catch-all match in a render-nothing state until
 * pages are loaded; React Router then re-evaluates and matches the real
 * plugin route on the next render. Only legitimate 404s (paths that don't
 * match any route after pages load) actually redirect.
 */
function PluginAwareCatchAll() {
  const loaded = usePluginRegistrySnapshot(r => r.isDisabledLoaded());
  if (!loaded) return null;
  return <Navigate to="/ui/" replace />;
}

/** Connects WebSocket API errors to the toast system */
function WsToastBridge({ setOnApiError }: { setOnApiError: (cb: ((msg: string) => void) | null) => void }) {
  const toast = useToast();
  useEffect(() => {
    setOnApiError((msg: string) => toast.error(msg));
    return () => setOnApiError(null);
  }, [setOnApiError, toast]);
  return null;
}

/**
 * The authenticated app — only renders after AuthGuard confirms the user
 * is logged in. Establishes the WebSocket connection HERE (not before auth)
 * so the session cookie is always present for WS auth.
 */
function AuthenticatedApp() {
  const wsManager = useWebSocketManager();
  const [restarting, setRestarting] = useState(false);
  const [restartMessage, setRestartMessage] = useState<string>('Applying plugin changes. This page will reconnect automatically.');
  const [restartError, setRestartError] = useState<string | null>(null);
  // Tracks whether THIS browser tab saw a restart since first mount. The
  // ready-after-restart handler reloads the page to pick up any new plugin
  // frontend entries — plugin frontends are baked into the build-time Vite
  // glob (see frontend/plugins.ts), so a newly-installed plugin's UI
  // (nav menu items, pages, settings) only appears after the bundle has
  // been rebuilt AND the browser reloaded to fetch the new bundle.
  const sawRestartRef = useRef(false);
  const { hasScope } = useAuth();
  // Subscribe to the plugin registry so this component re-renders (and React
  // Router rebuilds its route config) whenever setDisabledPlugins is called.
  const pluginPages = usePluginPages();
  const pluginSettings = usePluginSettings();

  // Fetch plugin enabled/disabled state and update the frontend registry.
  // Only admins can hit /v1/plugins/installed; for other users we fall back
  // to an empty disabled list so the registry's disabledLoaded gate still
  // flips and plugin nav/pages can render.
  useEffect(() => {
    if (!wsManager.serverReady) return;
    if (!hasScope('core.plugins:manage')) {
      pluginRegistry.setDisabledPlugins([]);
      return;
    }
    wsManager.sendRestApi('GET', '/v1/plugins/installed').then((res) => {
      if (res?.body?.success) {
        const disabled = (res.body.data?.plugins || [])
          .filter((p: any) => !p.enabled)
          .map((p: any) => p.name);
        pluginRegistry.setDisabledPlugins(disabled);
      } else {
        pluginRegistry.setDisabledPlugins([]);
      }
    }).catch(() => {
      pluginRegistry.setDisabledPlugins([]);
    });
  }, [wsManager, wsManager.serverReady, hasScope]);

  useEffect(() => {
    const unsub = wsManager.subscribe('system:restarting', (msg: any) => {
      setRestarting(true);
      setRestartError(null);
      sawRestartRef.current = true;
      if (typeof msg?.message === 'string' && msg.message) setRestartMessage(msg.message);
    });
    return unsub;
  }, [wsManager]);

  useEffect(() => {
    // Production rebuild can fail (e.g. vite build error). When it does the
    // backend stays running with the old bundle; surface the error so the
    // user knows to check logs / run npm run build manually instead of
    // staring at "Restarting..." forever.
    const unsub = wsManager.subscribe('system:restart-failed', (msg: any) => {
      setRestartError(typeof msg?.message === 'string' ? msg.message : 'Restart failed.');
    });
    return unsub;
  }, [wsManager]);

  useEffect(() => {
    const unsub = wsManager.subscribe('startup-progress', (msg: any) => {
      if (msg.phase === 'ready') {
        setRestarting(false);
        setRestartError(null);
        // If this tab observed an explicit restart, force a full reload so
        // the freshly-built bundle is fetched. Plugin frontends are pulled
        // into the bundle via Vite's build-time import.meta.glob; without
        // a reload, a newly-installed plugin's nav/pages are invisible
        // until the user manually refreshes.
        if (sawRestartRef.current) {
          sawRestartRef.current = false;
          window.location.reload();
        }
      }
    });
    return unsub;
  }, [wsManager]);

  // Safety net: if the WS disconnects after we saw a restart event, force a
  // reload on the next reconnect — without waiting for `startup-progress`
  // `ready` to land. The startup-progress handler above is the happy path,
  // but in production the message ordering across a WS close → reconnect
  // boundary isn't guaranteed; relying solely on it left users staring at
  // a stale bundle until they manually refreshed.
  const sawDisconnectAfterRestartRef = useRef(false);
  useEffect(() => {
    if (!wsManager.connected && sawRestartRef.current) {
      sawDisconnectAfterRestartRef.current = true;
      return;
    }
    if (wsManager.connected && sawDisconnectAfterRestartRef.current) {
      sawDisconnectAfterRestartRef.current = false;
      sawRestartRef.current = false;
      window.location.reload();
    }
  }, [wsManager.connected]);

  if (!wsManager.serverReady) {
    return (
      <WebSocketContext.Provider value={wsManager}>
        <ToastProvider>
          <WsToastBridge setOnApiError={wsManager.setOnApiError} />
          <StartupScreen connected={wsManager.connected} message={wsManager.startupMessage} />
        </ToastProvider>
      </WebSocketContext.Provider>
    );
  }

  return (
    <WebSocketContext.Provider value={wsManager}>
      <ToastProvider>
      {restarting && (
        <div className="restart-overlay">
          <div className="restart-overlay-content">
            {restartError ? (
              <>
                <h3>Restart failed</h3>
                <p>{restartError}</p>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => { setRestarting(false); setRestartError(null); }}
                >
                  Dismiss
                </button>
              </>
            ) : (
              <>
                <span className="spinner" />
                <h3>Restarting...</h3>
                <p>{restartMessage}</p>
              </>
            )}
          </div>
        </div>
      )}
      <WsToastBridge setOnApiError={wsManager.setOnApiError} />
      <ClipboardToastBridge />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/ui/" replace />} />
          <Route path="/ui" element={<AppLayout />}>
            <Route index element={<Dashboard />} />
            <Route path="devices" element={<Devices />} />
            <Route path="devices/:id" element={<DeviceView />} />
            <Route path="devices/:id/:tab" element={<DeviceView />} />
            <Route path="automations" element={<Automations />} />
            <Route path="automations/new" element={<AutomationEditor />} />
            <Route path="automations/:id/edit" element={<AutomationEditor />} />
            <Route path="automations/:id/history" element={<AutomationReviewer />} />
            <Route path="automations/session/:sessionId" element={<SessionTimeline />} />
            <Route path="sessions" element={<SessionHistory />} />
            <Route path="proxied-requests" element={<ProxiedRequests />} />
            <Route path="request-builder" element={<RequestBuilder />} />
            <Route path="traffic" element={<Traffic />} />
            <Route path="selector-debugger" element={<SelectorDebugger />} />
            <Route path="apks" element={<AppLibrary />} />
            <Route path="apps/:trackedAppId" element={<AppDetail />} />
            <Route path="apps/:trackedAppId/analysis/:versionId" element={<ApkAnalysis />} />
            <Route path="frida" element={<Frida />} />
            <Route path="marketplace" element={<PluginMarketplace />} />
            <Route path="cloud" element={<CloudBrowser />} />
            <Route path="api-catalogue" element={<ApiCatalogue />} />
            <Route path="api-catalogue/groups/:groupId/explorer" element={<ApiExplorer />} />
            <Route path="settings" element={<SettingsLayout />}>
              <Route index element={<Navigate to="/ui/settings/notifications" replace />} />
              <Route path="notifications" element={<NotificationsPage />} />
              <Route path="integrations" element={<IntegrationsPage />} />
              <Route path="ai" element={<AIPage />} />
              <Route path="analysis" element={<AnalysisPage />} />
              <Route path="cloud-storage" element={<CloudStoragePage />} />
              <Route path="certificates" element={<CertificatesPage />} />
              <Route path="traffic" element={<TrafficSettingsPage />} />
              <Route path="plugins" element={<PluginManager />} />
              {/* Marketplace is now top-level at /ui/marketplace. Keep this
                  inner route as a back-compat redirect so deep links / docs
                  pointing at /ui/settings/plugins/marketplace land in the
                  right place. */}
              <Route path="plugins/marketplace" element={<Navigate to="/ui/marketplace" replace />} />
              <Route path="proxies" element={<Proxies />} />
              <Route path="credentials" element={<Credentials />} />
              <Route path="jobs" element={<Jobs />} />
              <Route path="mcp" element={<McpSettings />} />
              <Route path="utils" element={<Utils />} />
              <Route path="sdk-catalog" element={<SdkCatalog />} />
              <Route path="changelog" element={<ChangelogPage />} />
              <Route path="license" element={<LicensePage />} />
              {pluginSettings.map(s => (
                <Route
                  key={s.pluginName}
                  path={`plugins/${s.pluginName}/settings`}
                  element={<s.component />}
                />
              ))}
            </Route>
            <Route path="settings/marketplace" element={<Navigate to="/ui/marketplace" replace />} />
            <Route path="settings/cloud" element={<Navigate to="/ui/settings/cloud-storage" replace />} />
            <Route path="oauth/consent" element={<ConsentPage />} />
            <Route path="profile" element={<ProfilePage />} />
            <Route path="admin/users" element={<AdminUsersPage />} />
            {/* Plugin routes — sourced from pluginPages (a reactive snapshot)
                so React Router rebuilds its config when a plugin is disabled. */}
            {pluginPages.map((page) => (
              <Route
                key={page.path}
                path={page.path.replace(/^\//, '')}
                element={<React.Suspense fallback={<div />}><page.component /></React.Suspense>}
              />
            ))}
            {/* Backwards compat redirects */}
            <Route path="proxies" element={<Navigate to="/ui/settings/proxies" replace />} />
            <Route path="credentials" element={<Navigate to="/ui/settings/credentials" replace />} />
            <Route path="jobs" element={<Navigate to="/ui/settings/jobs" replace />} />
            <Route path="utils" element={<Navigate to="/ui/settings/utils" replace />} />
            {/* Catch-all: wait for plugin pages to load before deciding it's
                a real 404. Without this, deep-linking to a plugin URL on a
                fresh page load would race the disabled-plugins fetch — the
                plugin route doesn't exist yet (usePluginPages returns []),
                so the catch-all fires and bounces the user to /ui/. */}
            <Route path="*" element={<PluginAwareCatchAll />} />
          </Route>
        </Routes>
      </BrowserRouter>
      </ToastProvider>
    </WebSocketContext.Provider>
  );
}

/**
 * Top-level app structure:
 *   AuthProvider (context) → AuthGuard (login/setup gate) → AuthenticatedApp (WS + routes)
 *
 * AuthGuard renders BEFORE the WS connection is established. It checks auth
 * state via HTTP (GET /v1/auth/me). If the user isn't authenticated, it shows
 * the login/setup/claim page — none of which need WebSockets. Only once auth
 * is confirmed does AuthenticatedApp mount, which establishes the WS connection
 * (with the session cookie already in place).
 */
export function App() {
  useEffect(() => {
    const uninstall = installSlotInspectorShortcut();
    return uninstall;
  }, []);

  return (
    <AuthProvider>
      <AuthGuard>
        <AuthenticatedApp />
      </AuthGuard>
    </AuthProvider>
  );
}
