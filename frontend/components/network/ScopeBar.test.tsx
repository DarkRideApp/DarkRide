import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ScopeBar } from './ScopeBar';
import type { NetworkScope } from './NetworkScopeContext';

function mockWs(opts: { capturing?: boolean } = {}) {
  const sendRestApi = vi.fn().mockImplementation((_m: string, path: string) => {
    if (path.startsWith('/v1/device/list')) {
      return Promise.resolve({ body: { data: [{ id: 'dev-1', name: 'Pixel' }] } });
    }
    if (path.startsWith('/v1/automation/sessions')) {
      return Promise.resolve({ body: { data: { sessions: [{ id: 5, name: 'checkout run', deviceId: 'dev-1' }] } } });
    }
    if (path.startsWith('/v1/capture/status/')) {
      return Promise.resolve({ body: { data: { capturing: opts.capturing ?? false, sessionId: opts.capturing ? 5 : null } } });
    }
    return Promise.resolve({ body: {} });
  });
  return { sendRestApi, subscribe: vi.fn().mockReturnValue(() => {}) };
}

describe('ScopeBar', () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it('renders All / Device / Session controls', async () => {
    render(<ScopeBar ws={mockWs() as any} scope={{ kind: 'all' }} onScopeChange={() => {}} />);
    expect(await screen.findByTestId('scope-kind-all')).toBeInTheDocument();
    expect(screen.getByTestId('scope-kind-device')).toBeInTheDocument();
    expect(screen.getByTestId('scope-kind-session')).toBeInTheDocument();
  });

  it('selecting a device fires onScopeChange', async () => {
    const onScopeChange = vi.fn();
    render(<ScopeBar ws={mockWs() as any} scope={{ kind: 'device', deviceId: '' }} onScopeChange={onScopeChange} />);
    const select = await screen.findByTestId('scope-device-select');
    fireEvent.change(select, { target: { value: 'dev-1' } });
    expect(onScopeChange).toHaveBeenCalledWith({ kind: 'device', deviceId: 'dev-1' });
  });

  it('session scope shows export + copy-link actions and copies the deep link', async () => {
    const scope: NetworkScope = { kind: 'session', sessionId: 5 };
    render(<ScopeBar ws={mockWs() as any} scope={scope} onScopeChange={() => {}} />);
    expect(await screen.findByTestId('scope-export-har')).toBeInTheDocument();
    expect(screen.getByTestId('scope-export-zip')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('scope-copy-link'));
    await waitFor(() =>
      expect((navigator.clipboard.writeText as any)).toHaveBeenCalledWith(
        expect.stringContaining('/ui/network?scope=session:5'),
      ),
    );
  });

  it('shows active capture status and stops the selected session capture', async () => {
    const ws = mockWs({ capturing: true });
    render(<ScopeBar ws={ws as any} scope={{ kind: 'session', sessionId: 5 }} onScopeChange={() => {}} />);
    expect(await screen.findByTestId('scope-capture-status')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('scope-stop-capture'));
    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith(
        'POST',
        '/v1/capture/stop',
        { deviceId: 'dev-1' },
      );
    });
    await waitFor(() => expect(screen.queryByTestId('scope-capture-status')).not.toBeInTheDocument());
  });
});
