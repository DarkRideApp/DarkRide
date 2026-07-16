import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BlocklistPanel } from './BlocklistPanel';

function mockWs(domains: Array<{ id: number; domain: string }>) {
  const remove = vi.fn();
  const sendRestApi = vi.fn().mockImplementation((method: string, path: string) => {
    if (method === 'GET' && path === '/v1/blocklist/list') return Promise.resolve({ body: { data: domains } });
    if (method === 'DELETE') { remove(path); return Promise.resolve({ body: { success: true } }); }
    return Promise.resolve({ body: {} });
  });
  return { sendRestApi, remove };
}

describe('BlocklistPanel', () => {
  it('lists blocked domains and unblocks one', async () => {
    const ws = mockWs([{ id: 1, domain: 'ads.example.com' }]);
    render(<BlocklistPanel ws={ws as any} onClose={() => {}} />);
    expect(await screen.findByText('ads.example.com')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /unblock ads\.example\.com/i }));
    await waitFor(() => expect(ws.remove).toHaveBeenCalledWith('/v1/blocklist/remove/1'));
  });

  it('shows an empty state when nothing is blocked', async () => {
    const ws = mockWs([]);
    render(<BlocklistPanel ws={ws as any} onClose={() => {}} />);
    expect(await screen.findByText(/no blocked/i)).toBeInTheDocument();
  });
});
