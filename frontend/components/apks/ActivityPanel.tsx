import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { useWebSocket, useToast, ElapsedTimer } from '@darkrideapp/plugin-sdk/react';
import { useAnalysisActivity, type AnalysisJobItem } from './useAnalysisActivity';
import { formatDuration, formatDateRelative, toMs } from '../../utils/format';

const STAGE_LABELS: Record<string, string> = {
  metadata: 'Metadata', decompiling: 'Decompiling', storing: 'Storing', scanning: 'Scanning', done: 'Done',
};

interface ActivityPanelProps {
  onClose: () => void;
}

/** Slide-over listing analysis jobs: Running (cancel), Recent (retry failed). */
export function ActivityPanel({ onClose }: ActivityPanelProps) {
  const ws = useWebSocket();
  const toast = useToast();
  const navigate = useNavigate();
  const { jobs, active, fetchJobs, markViewed } = useAnalysisActivity();

  // Opening the panel acknowledges failures (chip goes quiet)
  useEffect(() => { markViewed(); }, [markViewed]);

  const recent = jobs.filter(j => j.status === 'completed' || j.status === 'failed').slice(0, 20);

  const cancel = async (jobId: number) => {
    try {
      const res = await ws.sendRestApi('POST', `/v1/apps/analysis-jobs/${jobId}/cancel`);
      if (!res.body?.success) { toast.error(res.body?.error || 'Failed to cancel job'); return; }
      toast.success('Analysis job cancelled');
      fetchJobs();
    } catch { toast.error('Failed to cancel job'); }
  };

  const retry = async (apkVersionId: number) => {
    try {
      const res = await ws.sendRestApi('POST', `/v1/apps/analyze/${apkVersionId}`);
      if (!res.body?.success) { toast.error(res.body?.error || 'Failed to restart analysis'); return; }
      toast.success('Analysis restarted');
      fetchJobs();
    } catch { toast.error('Failed to restart analysis'); }
  };

  const openJob = (job: AnalysisJobItem) => {
    onClose();
    if (job.status === 'completed' && job.trackedAppId) {
      navigate(`/ui/apps/${job.trackedAppId}/analysis/${job.apkVersionId}`);
    } else if (job.trackedAppId) {
      navigate(`/ui/apps/${job.trackedAppId}`);
    }
  };

  const title = (j: AnalysisJobItem) => `${j.appName || j.packageName} · v${j.versionName || j.versionCode}`;

  return (
    <>
      <div className="activity-panel-overlay" onClick={onClose} data-testid="activity-panel-overlay" />
      <div className="activity-panel" data-testid="activity-panel" role="dialog" aria-modal="true" aria-label="Analysis activity">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>Analysis Activity</span>
          <button className="action-menu-trigger" aria-label="Close activity panel" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="activity-panel-section">Running — {active.length}</div>
        {active.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Nothing running.</div>}
        {active.map(j => (
          <div key={j.id} className="activity-job" onClick={() => openJob(j)} data-testid={`activity-job-${j.id}`}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>{title(j)}</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {j.status === 'pending' ? 'queued' : j.startedAt ? <ElapsedTimer since={j.startedAt} /> : ''}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, color: j.status === 'pending' ? 'var(--text-muted)' : 'var(--badge-running)', flex: 1 }}>
                {j.status === 'pending' ? 'Waiting for worker…' : (STAGE_LABELS[j.stage || ''] || 'Running')}
              </span>
              <button className="btn btn-sm" onClick={e => { e.stopPropagation(); cancel(j.id); }}>Cancel</button>
            </div>
          </div>
        ))}

        <div className="activity-panel-section">Recent</div>
        {recent.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No recent jobs.</div>}
        {recent.map(j => (
          <div key={j.id} className="activity-job" onClick={() => openJob(j)} data-testid={`activity-job-${j.id}`}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12 }}>{title(j)}</span>
              {j.status === 'failed'
                ? <span className="badge badge-failed" style={{ fontSize: 10 }}>Failed</span>
                : <span className="badge badge-success" style={{ fontSize: 10 }}>Ready</span>}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {j.status === 'failed'
                  ? j.error || 'Unknown error'
                  : j.startedAt && j.completedAt
                    ? `completed in ${formatDuration(toMs(j.completedAt) - toMs(j.startedAt))} · ${formatDateRelative(j.completedAt)}`
                    : formatDateRelative(j.createdAt)}
              </span>
              {j.status === 'failed' && (
                <button className="btn btn-sm" onClick={e => { e.stopPropagation(); retry(j.apkVersionId); }}>Retry</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
