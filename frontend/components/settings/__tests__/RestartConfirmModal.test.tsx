import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RestartConfirmModal } from '../RestartConfirmModal';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';

function makeWs(opts: { sendRestApi?: ReturnType<typeof vi.fn> } = {}) {
  return {
    connected: true,
    serverReady: true,
    startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi: opts.sendRestApi ?? vi.fn(async () => ({ body: { success: true } })),
    subscribe: () => () => {},
    subscribeBinary: vi.fn(),
    setOnApiError: vi.fn(),
  } as any;
}

describe('RestartConfirmModal', () => {
  it('renders title, description, and two buttons', () => {
    render(
      <WebSocketContext.Provider value={makeWs()}>
        <RestartConfirmModal onClose={() => {}} />
      </WebSocketContext.Provider>,
    );
    expect(screen.getByText(/Restart Server\?/i)).toBeInTheDocument();
    expect(screen.getByText(/Connected clients will reconnect/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Restart$/i })).toBeInTheDocument();
  });

  it('Cancel calls onClose without hitting the API', () => {
    const onClose = vi.fn();
    const sendRestApi = vi.fn();
    render(
      <WebSocketContext.Provider value={makeWs({ sendRestApi })}>
        <RestartConfirmModal onClose={onClose} />
      </WebSocketContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onClose).toHaveBeenCalled();
    expect(sendRestApi).not.toHaveBeenCalled();
  });

  it('Restart calls POST /v1/system/restart and closes', () => {
    const onClose = vi.fn();
    const sendRestApi = vi.fn(async () => ({ body: { success: true } }));
    render(
      <WebSocketContext.Provider value={makeWs({ sendRestApi })}>
        <RestartConfirmModal onClose={onClose} />
      </WebSocketContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Restart$/i }));
    expect(sendRestApi).toHaveBeenCalledWith('POST', '/v1/system/restart');
    expect(onClose).toHaveBeenCalled();
  });

  it('clicking the overlay (outside the modal) closes', () => {
    const onClose = vi.fn();
    const { container } = render(
      <WebSocketContext.Provider value={makeWs()}>
        <RestartConfirmModal onClose={onClose} />
      </WebSocketContext.Provider>,
    );
    const overlay = container.querySelector('.modal-overlay')!;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalled();
  });
});
