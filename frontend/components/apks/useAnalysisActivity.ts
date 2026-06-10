import { useCallback, useEffect, useState } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { toMs } from '../../utils/format';

export interface AnalysisJobItem {
  id: number;
  apkVersionId: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  stage: string | null;
  error: string | null;
  createdAt: string | number;
  startedAt: string | number | null;
  completedAt: string | number | null;
  trackedAppId: number | null;
  packageName: string;
  appName: string | null;
  versionCode: number;
  versionName: string | null;
}

const VIEWED_KEY = 'apk-activity-viewed';
// Broadcast so every live hook instance (chip + panel) stays in sync — opening
// the panel must clear the chip's "unseen failed" state without a remount.
const VIEWED_EVENT = 'apk-activity-viewed';

/**
 * Live analysis-job feed for the APK section. Fetches recent jobs and
 * refreshes on apk:analysis-update / apk:ai-agent-update WS events.
 * "Unseen failures" = failed jobs that finished after the panel was last opened.
 */
export function useAnalysisActivity() {
  const ws = useWebSocket();
  const [jobs, setJobs] = useState<AnalysisJobItem[]>([]);
  const [lastViewed, setLastViewed] = useState<number>(() => Number(localStorage.getItem(VIEWED_KEY) || 0));

  const fetchJobs = useCallback(() => {
    if (!ws.connected) return;
    ws.sendRestApi('GET', '/v1/apps/analysis-jobs/recent').then(res => {
      if (res.body?.success) setJobs(res.body.data);
    }).catch(() => {});
  }, [ws]);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  useEffect(() => {
    const unsubs = ['apk:analysis-update', 'apk:ai-agent-update'].map(evt =>
      ws.subscribe(evt, () => fetchJobs()),
    );
    return () => unsubs.forEach(u => u());
  }, [ws, fetchJobs]);

  const markViewed = useCallback(() => {
    const now = Date.now();
    localStorage.setItem(VIEWED_KEY, String(now));
    setLastViewed(now);
    window.dispatchEvent(new CustomEvent(VIEWED_EVENT, { detail: now }));
  }, []);

  // Sync lastViewed across hook instances when any of them marks viewed.
  useEffect(() => {
    const onViewed = (e: Event) => setLastViewed((e as CustomEvent<number>).detail);
    window.addEventListener(VIEWED_EVENT, onViewed);
    return () => window.removeEventListener(VIEWED_EVENT, onViewed);
  }, []);

  const active = jobs.filter(j => j.status === 'running' || j.status === 'pending');
  const unseenFailed = jobs.filter(j =>
    j.status === 'failed' && j.completedAt != null && toMs(j.completedAt) > lastViewed,
  );

  return { jobs, active, unseenFailed, fetchJobs, markViewed };
}
