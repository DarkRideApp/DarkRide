import React, { useState, useEffect, useCallback } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { PageHeader } from '@darkrideapp/plugin-sdk/react';
import { SkeletonTable } from '@darkrideapp/plugin-sdk/react';
import { useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { Play, Clock, AlertCircle, CheckCircle, RefreshCw, Settings } from 'lucide-react';
import { ScheduleEditor } from '@darkrideapp/plugin-sdk/react';
import { useAuthOptional } from '@darkrideapp/plugin-sdk/react';
import { AccessDenied } from '../components/auth/AccessDenied';

interface Job {
  id: string;
  name: string;
  description: string;
  category: string;
  schedule: string;
  defaultSchedule: string;
  canRunManually: boolean;
  enabled: boolean;
  lastRunAt: number | null;
  lastError: string | null;
  status: string;
}

function formatAge(epochMs: number | null): string {
  if (!epochMs) return 'Never';
  const ago = Date.now() - epochMs;
  if (ago < 60_000) return 'Just now';
  if (ago < 3600_000) return `${Math.floor(ago / 60_000)}m ago`;
  if (ago < 86400_000) return `${Math.floor(ago / 3600_000)}h ago`;
  return `${Math.floor(ago / 86400_000)}d ago`;
}

const CATEGORY_LABELS: Record<string, string> = {
  sync: 'Sync',
  maintenance: 'Maintenance',
  analysis: 'Analysis',
};

const CATEGORY_ORDER = ['sync', 'maintenance', 'analysis'];

export function Jobs() {
  useDocumentTitle('Jobs');
  const auth = useAuthOptional();
  const ws = useWebSocket();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Map<string, { ok: boolean; error?: string }>>(new Map());
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const fetchJobs = useCallback(async () => {
    const res = await ws.sendRestApi('GET', '/v1/jobs');
    if (res?.body?.success) setJobs(res.body.data);
    setLoading(false);
  }, [ws]);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  useEffect(() => {
    const timer = setInterval(fetchJobs, 30_000);
    return () => clearInterval(timer);
  }, [fetchJobs]);

  const handleRun = async (id: string) => {
    setRunning(prev => new Set(prev).add(id));
    setResults(prev => { const next = new Map(prev); next.delete(id); return next; });
    try {
      const res = await ws.sendRestApi('POST', `/v1/jobs/${id}/run`);
      setResults(prev => new Map(prev).set(id, { ok: res?.body?.success ?? false, error: res?.body?.error }));
    } catch (err: any) {
      setResults(prev => new Map(prev).set(id, { ok: false, error: err.message }));
    } finally {
      setRunning(prev => { const next = new Set(prev); next.delete(id); return next; });
      fetchJobs();
    }
  };

  const handleToggle = async (job: Job) => {
    await ws.sendRestApi('PUT', `/v1/jobs/${job.id}/config`, { enabled: !job.enabled });
    fetchJobs();
  };

  const handleSaveSchedule = async (id: string, schedule: string) => {
    setSaving(true);
    await ws.sendRestApi('PUT', `/v1/jobs/${id}/config`, { schedule });
    setEditing(null);
    setSaving(false);
    fetchJobs();
  };

  if (auth && !auth.hasScope('core.jobs:manage')) return <AccessDenied scope="core.jobs:manage" />;
  if (loading) return <div className="table-card"><SkeletonTable rows={6} columns={4} /></div>;

  const grouped = new Map<string, Job[]>();
  for (const job of jobs) {
    const list = grouped.get(job.category) || [];
    list.push(job);
    grouped.set(job.category, list);
  }

  const categories = CATEGORY_ORDER.filter(c => grouped.has(c));

  return (
    <div data-testid="jobs-page">
      <header className="settings-page-header">
        <h1>Jobs</h1>
        <div className="settings-page-actions">
          <button className="btn btn-sm" onClick={fetchJobs}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </header>

      {categories.map(category => (
        <div key={category} style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
            {CATEGORY_LABELS[category] || category}
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(grouped.get(category) || []).map(job => {
              const isRunning = running.has(job.id) || job.status === 'running';
              const result = results.get(job.id);
              const isEditing = editing === job.id;
              return (
                <div
                  key={job.id}
                  className="card"
                  style={{ padding: '14px 16px', opacity: job.enabled ? 1 : 0.5 }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    {/* Status indicator */}
                    <div style={{ flexShrink: 0 }}>
                      {!job.enabled ? (
                        <div style={{ width: 18, height: 18, borderRadius: '50%', border: '2px solid var(--text-muted)', opacity: 0.4 }} />
                      ) : isRunning ? (
                        <RefreshCw size={18} className="spin" style={{ color: 'var(--accent)' }} />
                      ) : job.lastError ? (
                        <AlertCircle size={18} style={{ color: 'var(--status-error, #ef4444)' }} />
                      ) : (
                        <CheckCircle size={18} style={{ color: 'var(--status-online, #22c55e)' }} />
                      )}
                    </div>

                    {/* Info */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{job.name}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{job.description}</div>
                    </div>

                    {/* Schedule */}
                    <div style={{ textAlign: 'right', flexShrink: 0, minWidth: 140 }}>
                      <div
                        style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end', color: 'var(--text-muted)', cursor: 'pointer' }}
                        onClick={() => setEditing(editing === job.id ? null : job.id)}
                        title="Click to edit schedule"
                      >
                        <Clock size={11} />
                        <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 11 }}>{job.schedule}</span>
                        <Settings size={10} style={{ opacity: 0.5 }} />
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                        Last: {formatAge(job.lastRunAt)}
                      </div>
                    </div>

                    {/* Enable toggle */}
                    <button
                      className="btn btn-sm"
                      onClick={() => handleToggle(job)}
                      style={{ flexShrink: 0, minWidth: 70, fontSize: 11 }}
                      data-testid={`toggle-job-${job.id}`}
                    >
                      {job.enabled ? 'Disable' : 'Enable'}
                    </button>

                    {/* Run button */}
                    {job.canRunManually && (
                      <button
                        className="btn btn-sm btn-primary"
                        onClick={() => handleRun(job.id)}
                        disabled={isRunning || !job.enabled}
                        style={{ flexShrink: 0, minWidth: 80 }}
                        data-testid={`run-job-${job.id}`}
                      >
                        {isRunning ? (
                          <><RefreshCw size={12} className="spin" /> Running</>
                        ) : (
                          <><Play size={12} /> Run Now</>
                        )}
                      </button>
                    )}
                  </div>

                  {/* Schedule editor */}
                  {isEditing && (
                    <ScheduleEditor
                      value={job.schedule}
                      defaultValue={job.defaultSchedule}
                      onSave={(schedule) => handleSaveSchedule(job.id, schedule)}
                      onCancel={() => setEditing(null)}
                      saving={saving}
                    />
                  )}

                  {/* Error / result feedback */}
                  {job.lastError && !result && (
                    <div style={{ marginTop: 8, padding: '6px 10px', borderRadius: 4, background: 'rgba(239,68,68,0.08)', color: '#ef4444', fontSize: 12 }}>
                      Last error: {job.lastError}
                    </div>
                  )}
                  {result && !result.ok && (
                    <div style={{ marginTop: 8, padding: '6px 10px', borderRadius: 4, background: 'rgba(239,68,68,0.08)', color: '#ef4444', fontSize: 12 }}>
                      Failed: {result.error}
                    </div>
                  )}
                  {result?.ok && (
                    <div style={{ marginTop: 8, padding: '6px 10px', borderRadius: 4, background: 'rgba(34,197,94,0.08)', color: '#22c55e', fontSize: 12 }}>
                      Completed successfully
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

    </div>
  );
}
