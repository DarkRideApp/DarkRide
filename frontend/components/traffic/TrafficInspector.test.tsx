import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { TrafficInspector } from './TrafficInspector';

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

type Handler = (msg: any) => void;
const handlers: Record<string, Handler> = {};
vi.mock('@darkrideapp/plugin-sdk/react', () => ({
  useWebSocket: () => ({
    connected: true,
    subscribe: (evt: string, cb: Handler) => { handlers[evt] = cb; return () => {}; },
    sendRestApi: vi.fn().mockResolvedValue({ body: { data: { items: [] } } }),
  }),
}));

describe('TrafficInspector — history cap', () => {
  it('retains at most 5000 live entries, dropping the oldest', () => {
    render(<TrafficInspector deviceId="dev1" sessionId={1} mode="live" />);
    act(() => {
      for (let i = 1; i <= 5001; i++) {
        handlers['traffic-entry']({
          entry: {
            id: i,
            deviceId: 'dev1',
            requestMethod: 'GET',
            requestUrl: `https://h/${i}`,
            capturedAt: '2025-01-01T00:00:00Z',
          },
        });
      }
    });
    expect(screen.getByText('5000 entries')).toBeInTheDocument();
  });
});
