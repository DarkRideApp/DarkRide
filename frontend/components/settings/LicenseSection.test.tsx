import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';
import { ToastProvider } from '@darkrideapp/plugin-sdk/react';
import { LicenseSection } from './LicenseSection';

function makeWs(restApi: ReturnType<typeof vi.fn>) {
  return {
    connected: true,
    serverReady: true,
    startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi: restApi,
    subscribe: vi.fn(() => () => {}),
    subscribeBinary: vi.fn(() => () => {}),
  };
}

function renderAt(path: string, restApi: ReturnType<typeof vi.fn>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <WebSocketContext.Provider value={makeWs(restApi)}>
        <ToastProvider>
          <LicenseSection />
        </ToastProvider>
      </WebSocketContext.Provider>
    </MemoryRouter>,
  );
}

describe('LicenseSection', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('shows the empty state when no license is active', async () => {
    const api = vi.fn(async () => ({ status: 200, body: { success: true, data: { active: false } } }));
    renderAt('/ui/settings?section=license', api);
    await waitFor(() => expect(screen.getByText(/no license/i)).toBeInTheDocument());
    expect(screen.getByPlaceholderText(/paste/i)).toBeInTheDocument();
  });

  it('shows license info when a license is active', async () => {
    const api = vi.fn(async () => ({
      status: 200,
      body: {
        success: true,
        data: {
          active: true,
          email: 'cube@example.com',
          plan: 'pro',
          expiresAt: '2027-05-04T00:00:00.000Z',
          issuedAt: '2026-05-04T00:00:00.000Z',
          subscriptionId: 'sub_x',
          licenseId: 1,
        },
      },
    }));
    renderAt('/ui/settings?section=license', api);
    await waitFor(() => expect(screen.getByText(/cube@example\.com/)).toBeInTheDocument());
    expect(screen.getAllByText(/pro/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/2027/)).toBeInTheDocument();
  });

  it('saves a pasted license via PUT /v1/license', async () => {
    let calls = 0;
    const api = vi.fn(async (method: string, path: string, body?: any) => {
      calls++;
      if (method === 'GET') {
        return calls === 1
          ? { status: 200, body: { success: true, data: { active: false } } }
          : { status: 200, body: { success: true, data: { active: true, email: 'cube@example.com', plan: 'pro', expiresAt: '2027-01-01T00:00:00.000Z', issuedAt: '2026-01-01T00:00:00.000Z', subscriptionId: 's', licenseId: 1 } } };
      }
      if (method === 'PUT') {
        expect(path).toBe('/v1/license');
        expect(body.jws).toBe('eyJaaa.bbb.ccc');
        return { status: 200, body: { success: true, data: { active: true, email: 'cube@example.com', plan: 'pro', expiresAt: '2027-01-01T00:00:00.000Z', issuedAt: '2026-01-01T00:00:00.000Z', subscriptionId: 's', licenseId: 1 } } };
      }
      return { status: 500, body: { success: false } };
    });
    renderAt('/ui/settings?section=license', api);
    await waitFor(() => screen.getByPlaceholderText(/paste/i));

    fireEvent.change(screen.getByPlaceholderText(/paste/i), { target: { value: 'eyJaaa.bbb.ccc' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(screen.getByText(/cube@example\.com/)).toBeInTheDocument());
  });

  it('auto-fills the textarea from ?key= deep-link query param', async () => {
    const api = vi.fn(async () => ({ status: 200, body: { success: true, data: { active: false } } }));
    renderAt('/ui/settings?section=license&key=eyJdeep.linked.value', api);
    await waitFor(() => {
      const ta = screen.getByPlaceholderText(/paste/i) as HTMLTextAreaElement;
      expect(ta.value).toBe('eyJdeep.linked.value');
    });
  });

  it('shows the inline error message when PUT returns 400', async () => {
    const api = vi.fn(async (method: string) => {
      if (method === 'GET') return { status: 200, body: { success: true, data: { active: false } } };
      return { status: 400, body: { success: false, error: 'Invalid signature: bad sig' } };
    });
    renderAt('/ui/settings?section=license', api);
    await waitFor(() => screen.getByPlaceholderText(/paste/i));
    fireEvent.change(screen.getByPlaceholderText(/paste/i), { target: { value: 'garbage' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(screen.getByText(/invalid signature/i)).toBeInTheDocument());
  });
});
