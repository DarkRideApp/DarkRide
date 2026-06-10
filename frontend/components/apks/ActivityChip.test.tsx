import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import { ActivityChip } from './ActivityChip';

const job = (over: Partial<any> = {}) => ({
  id: 1, apkVersionId: 10, status: 'running', stage: 'decompiling', error: null,
  createdAt: '2026-06-10T10:00:00Z', startedAt: '2026-06-10T10:00:05Z', completedAt: null,
  trackedAppId: 5, packageName: 'com.x', appName: 'X', versionCode: 3, versionName: '3.0', ...over,
});

function mockWs(jobs: any[]): WebSocketContextValue {
  return {
    connected: true, serverReady: true, startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockResolvedValue({ type: 'restapi', id: '1', status: 200, body: { success: true, data: jobs } }),
    subscribe: vi.fn().mockReturnValue(() => {}),
  } as any;
}

function renderChip(jobs: any[], onClick = vi.fn()) {
  render(
    <WebSocketContext.Provider value={mockWs(jobs)}>
      <ActivityChip onClick={onClick} />
    </WebSocketContext.Provider>,
  );
  return onClick;
}

beforeEach(() => localStorage.clear());

describe('ActivityChip', () => {
  it('shows running count when jobs are active', async () => {
    renderChip([job(), job({ id: 2, status: 'pending' })]);
    await waitFor(() => expect(screen.getByTestId('activity-chip')).toHaveTextContent('2 jobs'));
    expect(screen.getByTestId('activity-chip')).toHaveClass('activity-chip-running');
  });

  it('shows failed count when failures are newer than last view', async () => {
    renderChip([job({ status: 'failed', error: 'boom', completedAt: '2026-06-10T10:05:00Z' })]);
    await waitFor(() => expect(screen.getByTestId('activity-chip')).toHaveTextContent('1 failed'));
    expect(screen.getByTestId('activity-chip')).toHaveClass('activity-chip-failed');
  });

  it('is quiet when idle and failures already viewed', async () => {
    localStorage.setItem('apk-activity-viewed', String(Date.parse('2026-06-10T11:00:00Z')));
    renderChip([job({ status: 'failed', error: 'boom', completedAt: '2026-06-10T10:05:00Z' })]);
    await waitFor(() => expect(screen.getByTestId('activity-chip')).toHaveTextContent('Activity'));
  });

  it('uses the singular noun for a single running job', async () => {
    renderChip([job()]);
    await waitFor(() => expect(screen.getByTestId('activity-chip')).toHaveTextContent('1 job'));
    expect(screen.getByTestId('activity-chip')).not.toHaveTextContent('1 jobs');
  });

  it('invokes onClick', async () => {
    const onClick = renderChip([]);
    await waitFor(() => screen.getByTestId('activity-chip'));
    fireEvent.click(screen.getByTestId('activity-chip'));
    expect(onClick).toHaveBeenCalled();
  });
});
