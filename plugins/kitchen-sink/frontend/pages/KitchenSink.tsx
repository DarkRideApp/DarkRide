import React, { useState } from 'react';
import { FlaskConical, Check, X, Play } from 'lucide-react';
import { ExtensionSlot } from '@darkrideapp/plugin-sdk/react';

interface HealthCheck {
  name: string;
  status: 'pass' | 'fail' | 'pending';
  detail?: string;
}

export function KitchenSink() {
  const [checks, setChecks] = useState<HealthCheck[]>([]);
  const [loading, setLoading] = useState(false);

  async function runChecks() {
    setLoading(true);
    setChecks([]);
    const results: HealthCheck[] = [];

    // Check 1: Plugin API route works
    try {
      const res = await fetch('/v1/kitchen-sink/health');
      const data = await res.json();
      results.push({
        name: 'API Routes',
        status: data.success ? 'pass' : 'fail',
        detail: data.message ?? 'Route registered and responding',
      });
    } catch (err) {
      results.push({ name: 'API Routes', status: 'fail', detail: String(err) });
    }

    // Check 2: Echo endpoint
    try {
      const res = await fetch('/v1/kitchen-sink/echo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: true }),
      });
      const data = await res.json();
      results.push({
        name: 'Echo Endpoint',
        status: data.data?.test === true ? 'pass' : 'fail',
        detail: 'POST body echoed correctly',
      });
    } catch (err) {
      results.push({ name: 'Echo Endpoint', status: 'fail', detail: String(err) });
    }

    // Check 3: Plugin registry metadata
    try {
      const res = await fetch('/v1/plugins/registry');
      const data = await res.json();
      const ks = data.data?.find((p: any) => p.name === 'kitchen-sink');
      results.push({
        name: 'Plugin Registry',
        status: ks ? 'pass' : 'fail',
        detail: ks ? `v${ks.version} — ${ks.nav.length} nav, ${ks.settings.length} settings, ${ks.commands.length} commands` : 'Not found in registry',
      });
    } catch (err) {
      results.push({ name: 'Plugin Registry', status: 'fail', detail: String(err) });
    }

    // Check 4: File storage — write, read back, verify, fetch via HTTP
    try {
      const writeRes = await fetch('/v1/kitchen-sink/file-test', { method: 'POST' });
      const writeData = await writeRes.json();
      if (!writeData.success) throw new Error(writeData.error);

      const { written, readBack, url, match } = writeData.data;
      if (!match) {
        results.push({ name: 'File Storage (write/read)', status: 'fail', detail: `Mismatch: wrote "${written}", read "${readBack}"` });
      } else {
        results.push({ name: 'File Storage (write/read)', status: 'pass', detail: `Write + read verified` });
      }

      // Fetch the file via the framework serving endpoint
      const fileRes = await fetch(url);
      if (fileRes.ok) {
        const fileContent = await fileRes.text();
        results.push({
          name: 'File Storage (HTTP serve)',
          status: fileContent === written ? 'pass' : 'fail',
          detail: fileRes.ok ? `Served at ${url}` : 'Content mismatch',
        });
      } else {
        results.push({ name: 'File Storage (HTTP serve)', status: 'fail', detail: `${fileRes.status} from ${url}` });
      }
    } catch (err) {
      results.push({ name: 'File Storage', status: 'fail', detail: String(err) });
    }

    // Check 5: Unified tools — call via REST API
    try {
      const toolRes = await fetch('/v1/tools/kitchen_sink_greet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'DarkRide' }),
      });
      const toolData = await toolRes.json();
      results.push({
        name: 'Unified Tools (REST)',
        status: toolData.success && toolData.data?.message?.includes('DarkRide') ? 'pass' : 'fail',
        detail: toolData.data?.message ?? toolData.error ?? 'No response',
      });
    } catch (err) {
      results.push({ name: 'Unified Tools (REST)', status: 'fail', detail: String(err) });
    }

    // Check 6: Navigation (we're here, so it works!)
    results.push({
      name: 'Navigation',
      status: 'pass',
      detail: 'Page rendered via plugin nav item',
    });

    // Check 7: Frontend route registration
    results.push({
      name: 'Frontend Routes',
      status: 'pass',
      detail: 'This page loaded via plugin route registration',
    });

    setChecks(results);
    setLoading(false);
  }

  const passCount = checks.filter((c) => c.status === 'pass').length;
  const failCount = checks.filter((c) => c.status === 'fail').length;

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center gap-3 mb-6">
        <FlaskConical className="w-6 h-6" />
        <h1 className="text-xl font-semibold">Kitchen Sink Test Plugin</h1>
      </div>

      <p className="text-sm text-zinc-400 mb-4">
        This plugin exercises every DarkRide extension point. If you can see this page,
        navigation, routing, and page registration are working.
      </p>

      <button
        onClick={runChecks}
        disabled={loading}
        className="flex items-center gap-2 px-4 py-2 mb-6 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-sm font-medium"
      >
        <Play className="w-4 h-4" />
        {loading ? 'Running...' : 'Run Tests'}
      </button>

      {loading ? (
        <p className="text-zinc-400">Running checks...</p>
      ) : checks.length > 0 ? (
        <>
          <div className="mb-4 text-sm">
            <span className="text-green-400">{passCount} passed</span>
            {failCount > 0 && <span className="text-red-400 ml-3">{failCount} failed</span>}
          </div>

          <div className="space-y-2">
            {checks.map((check) => (
              <div
                key={check.name}
                className={`flex items-center gap-3 p-3 rounded border ${
                  check.status === 'pass'
                    ? 'border-green-800 bg-green-950/30'
                    : 'border-red-800 bg-red-950/30'
                }`}
              >
                {check.status === 'pass' ? (
                  <Check className="w-4 h-4 text-green-400 shrink-0" />
                ) : (
                  <X className="w-4 h-4 text-red-400 shrink-0" />
                )}
                <div>
                  <div className="font-medium text-sm">{check.name}</div>
                  {check.detail && (
                    <div className="text-xs text-zinc-400">{check.detail}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <div className="mt-8 p-4 rounded border border-zinc-700 bg-zinc-800/50">
        <h2 className="text-sm font-semibold mb-2">Extension Points Exercised</h2>
        <ul className="text-xs text-zinc-400 space-y-1">
          <li>Nav items (sidebar)</li>
          <li>Frontend pages and routes</li>
          <li>Backend API routes</li>
          <li>Database tables and migrations</li>
          <li>AI tools and contexts</li>
          <li>Scheduled jobs</li>
          <li>Settings keys</li>
          <li>Command palette commands</li>
          <li>Notification event types</li>
          <li>Hook bus (define + subscribe)</li>
          <li>UI slots (declare + contribute)</li>
        </ul>
      </div>

      <ExtensionSlot id="kitchen-sink:demo:extra" />
    </div>
  );
}
