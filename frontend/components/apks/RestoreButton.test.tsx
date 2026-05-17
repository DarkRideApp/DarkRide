import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import { RestoreButton } from './RestoreButton';

function makeWs(sendRestApi: WebSocketContextValue['sendRestApi']): WebSocketContextValue {
  return {
    connected: true,
    serverReady: true,
    startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi,
    subscribe: vi.fn().mockReturnValue(() => {}),
    subscribeBinary: vi.fn().mockReturnValue(() => {}),
  };
}

function renderButton(ws: WebSocketContextValue, props: Partial<React.ComponentProps<typeof RestoreButton>> = {}) {
  return render(
    <WebSocketContext.Provider value={ws}>
      <RestoreButton packageName="com.foo" versionId={1} {...props} />
    </WebSocketContext.Provider>,
  );
}

describe('RestoreButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('posts to /restore on click and fires onComplete on success', async () => {
    const sendRestApi = vi.fn().mockResolvedValueOnce({
      type: 'restapi', id: '1', status: 200, body: { kind: 'downloaded', artifacts: 3 },
    });
    const onComplete = vi.fn();
    renderButton(makeWs(sendRestApi), { onComplete });

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(sendRestApi).toHaveBeenCalledWith('POST', '/v1/apks/com.foo/1/restore');
  });

  it('shows Retry label after a failure', async () => {
    const sendRestApi = vi.fn().mockResolvedValueOnce({
      type: 'restapi', id: '1', status: 409, body: { error: 'no cloud copy' },
    });
    renderButton(makeWs(sendRestApi));

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(screen.getByText(/Retry restore/i)).toBeTruthy());
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('disables the button while busy', async () => {
    let resolveApi: any;
    const sendRestApi = vi.fn().mockReturnValueOnce(
      new Promise((r) => { resolveApi = r; }),
    );
    renderButton(makeWs(sendRestApi));

    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByRole('button')).toBeDisabled();
    expect(screen.getByText(/Restoring…/)).toBeTruthy();

    // Resolve to avoid unhandled rejection
    resolveApi({ type: 'restapi', id: '1', status: 200, body: { kind: 'already-local' } });
  });

  it('renders the default label before interaction', () => {
    const sendRestApi = vi.fn();
    renderButton(makeWs(sendRestApi));
    expect(screen.getByRole('button').textContent).toBe('Restore');
  });

  it('renders a custom label', () => {
    const sendRestApi = vi.fn();
    renderButton(makeWs(sendRestApi), { label: 'Restore old version' });
    expect(screen.getByRole('button').textContent).toBe('Restore old version');
  });

  it('url-encodes the packageName', async () => {
    const sendRestApi = vi.fn().mockResolvedValueOnce({
      type: 'restapi', id: '1', status: 200, body: { kind: 'downloaded' },
    });
    render(
      <WebSocketContext.Provider value={makeWs(sendRestApi)}>
        <RestoreButton packageName="com.foo.bar" versionId={42} />
      </WebSocketContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(sendRestApi).toHaveBeenCalledWith('POST', '/v1/apks/com.foo.bar/42/restore'));
  });
});
