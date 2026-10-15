import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Automations } from './Automations';
import { AuthContext, WebSocketContext, ToastProvider } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';

// jsdom doesn't implement HTMLDialogElement methods
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  });
});

const automation = {
  id: 1, name: 'Login flow', code: '', passcode: 'p', timeoutMs: 300000, requiresDevice: true, requiresHttpsCapture: false,
  isRule: false, isCaptureRule: false, priority: 0, enabled: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};

function reply(body: unknown) {
  return { type: 'restapi', id: '1', status: 200, body };
}

function createWs(opts: { unclaimed: number; claimed?: number; claimFails?: boolean }) {
  let unclaimed = opts.unclaimed;
  const sendRestApi = vi.fn(async (method: string, path: string) => {
    if (path === '/v1/automation/list') return reply({ data: [automation] });
    if (path === '/v1/automation/unclaimed') return reply({ data: { count: unclaimed } });
    if (path === '/v1/automation/queue/status') return reply({ data: { queue: [], processingQueue: false, devices: [] } });
    if (path === '/v1/automation/templates') return reply({ data: [] });
    if (method === 'POST' && path === '/v1/automation/claim-all') {
      if (opts.claimFails) throw new Error('Sign in to claim automations');
      const claimed = opts.claimed ?? unclaimed;
      unclaimed = 0;
      return reply({ data: { claimed } });
    }
    return reply({ data: [] });
  });
  const ws: WebSocketContextValue = {
    connected: true,
    sendMessage: vi.fn(),
    sendRestApi: sendRestApi as unknown as WebSocketContextValue['sendRestApi'],
    subscribe: vi.fn().mockReturnValue(() => {}),
  };
  return { ws, sendRestApi };
}

function renderPage(ws: WebSocketContextValue, scopes: string[] = ['core.automations:read', 'core.automations:edit']) {
  const auth = { hasScope: (s: string) => scopes.includes(s) } as any;
  return render(
    <AuthContext.Provider value={auth}>
      <WebSocketContext.Provider value={ws}>
        <ToastProvider>
          <MemoryRouter>
            <Automations />
          </MemoryRouter>
        </ToastProvider>
      </WebSocketContext.Provider>
    </AuthContext.Provider>,
  );
}

const paths = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.map((c) => `${c[0]} ${c[1]}`);

describe('Automations: claiming scripts nobody has claimed', () => {
  it('tells an editor how many scripts have no author', async () => {
    const { ws } = createWs({ unclaimed: 3 });
    renderPage(ws);

    const banner = await screen.findByTestId('automations-claim-banner');
    expect(banner).toHaveTextContent('3 automations have no author on record');
    expect(banner).toHaveTextContent('credentials');
    expect(screen.getByTestId('claim-all-button')).toBeInTheDocument();
  });

  it('says "automation" for one script', async () => {
    const { ws } = createWs({ unclaimed: 1 });
    renderPage(ws);

    expect(await screen.findByTestId('automations-claim-banner')).toHaveTextContent('1 automation has no author on record');
  });

  it('shows nothing when every script has an author', async () => {
    const { ws, sendRestApi } = createWs({ unclaimed: 0 });
    renderPage(ws);

    await screen.findByTestId('automations-page');
    await waitFor(() => expect(paths(sendRestApi)).toContain('GET /v1/automation/unclaimed'));
    expect(screen.queryByTestId('automations-claim-banner')).not.toBeInTheDocument();
  });

  it('neither asks nor shows the banner to someone who cannot edit', async () => {
    const { ws, sendRestApi } = createWs({ unclaimed: 3 });
    renderPage(ws, ['core.automations:read']);

    await screen.findByTestId('automations-page');
    expect(paths(sendRestApi)).not.toContain('GET /v1/automation/unclaimed');
    expect(screen.queryByTestId('automations-claim-banner')).not.toBeInTheDocument();
  });

  it('asks for confirmation, naming what claiming means, and claims nothing on cancel', async () => {
    const { ws, sendRestApi } = createWs({ unclaimed: 2 });
    renderPage(ws);

    fireEvent.click(await screen.findByTestId('claim-all-button'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('run with your permissions');
    fireEvent.click(screen.getByText('Cancel'));

    expect(paths(sendRestApi)).not.toContain('POST /v1/automation/claim-all');
    expect(screen.getByTestId('automations-claim-banner')).toBeInTheDocument();
  });

  it('claims them on confirm, reports how many, and clears the banner', async () => {
    const { ws, sendRestApi } = createWs({ unclaimed: 2 });
    renderPage(ws);

    fireEvent.click(await screen.findByTestId('claim-all-button'));
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));

    await waitFor(() => expect(paths(sendRestApi)).toContain('POST /v1/automation/claim-all'));
    expect(await screen.findByText('Claimed 2 automations')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('automations-claim-banner')).not.toBeInTheDocument());
  });

  it('keeps the banner and reports the error when the claim fails', async () => {
    const { ws } = createWs({ unclaimed: 2, claimFails: true });
    renderPage(ws);

    fireEvent.click(await screen.findByTestId('claim-all-button'));
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));

    expect(await screen.findByText('Sign in to claim automations')).toBeInTheDocument();
    expect(screen.getByTestId('automations-claim-banner')).toBeInTheDocument();
  });
});
