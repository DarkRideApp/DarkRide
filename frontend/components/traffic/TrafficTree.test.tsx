import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TrafficTree } from './TrafficTree';

function mockWs(opts: {
  hosts: Array<{ hostname: string; count: number }>;
  paths?: Record<string, Array<{ path: string; count: number; latestId: number }>>;
}) {
  const sendRestApi = vi.fn().mockImplementation((_m: string, path: string) => {
    const url = new URL(path, 'http://x');
    const host = url.searchParams.get('hostname');
    if (host) {
      return Promise.resolve({ body: { data: { paths: opts.paths?.[host] ?? [], truncated: false } } });
    }
    return Promise.resolve({ body: { data: { hosts: opts.hosts } } });
  });
  return { sendRestApi };
}

describe('TrafficTree', () => {
  it('renders hosts with counts', async () => {
    const ws = mockWs({ hosts: [{ hostname: 'api.foo.com', count: 3 }, { hostname: 'cdn.bar.com', count: 1 }] });
    render(<TrafficTree ws={ws as any} onSelectHost={() => {}} onSelectPath={() => {}} />);
    expect(await screen.findByText('api.foo.com')).toBeInTheDocument();
    expect(screen.getByText('cdn.bar.com')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('expands a host to load and show its paths', async () => {
    const ws = mockWs({
      hosts: [{ hostname: 'api.foo.com', count: 2 }],
      paths: { 'api.foo.com': [{ path: '/users', count: 2, latestId: 9 }] },
    });
    render(<TrafficTree ws={ws as any} onSelectHost={() => {}} onSelectPath={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /expand api\.foo\.com/i }));
    expect(await screen.findByText('/users')).toBeInTheDocument();
  });

  it('fires onSelectHost when a host row is clicked', async () => {
    const onSelectHost = vi.fn();
    const ws = mockWs({ hosts: [{ hostname: 'api.foo.com', count: 1 }] });
    render(<TrafficTree ws={ws as any} onSelectHost={onSelectHost} onSelectPath={() => {}} />);
    fireEvent.click(await screen.findByText('api.foo.com'));
    expect(onSelectHost).toHaveBeenCalledWith('api.foo.com');
  });

  it('fires onSelectPath with host, path and latestId', async () => {
    const onSelectPath = vi.fn();
    const ws = mockWs({
      hosts: [{ hostname: 'api.foo.com', count: 1 }],
      paths: { 'api.foo.com': [{ path: '/orders', count: 1, latestId: 42 }] },
    });
    render(<TrafficTree ws={ws as any} onSelectHost={() => {}} onSelectPath={onSelectPath} />);
    fireEvent.click(await screen.findByRole('button', { name: /expand api\.foo\.com/i }));
    fireEvent.click(await screen.findByText('/orders'));
    expect(onSelectPath).toHaveBeenCalledWith('api.foo.com', '/orders', 42);
  });

  it('shows an empty state when there is no traffic', async () => {
    const ws = mockWs({ hosts: [] });
    render(<TrafficTree ws={ws as any} onSelectHost={() => {}} onSelectPath={() => {}} />);
    expect(await screen.findByText(/no traffic captured/i)).toBeInTheDocument();
  });
});
