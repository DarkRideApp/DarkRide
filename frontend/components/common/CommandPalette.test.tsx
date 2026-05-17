import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CommandPalette } from './CommandPalette';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';

const mockDevices = [
  { id: 'emulator-5554', name: 'Pixel 6 Pro', manufacturer: 'Google', model: 'Pixel 6 Pro', androidVersion: '13', platform: 'android' },
  { id: 'abc123', name: 'Galaxy S21', manufacturer: 'Samsung', model: 'SM-G991B', androidVersion: '12', platform: 'android' },
];

const mockAutomations = [
  { id: 1, name: 'Login Flow', isRule: false },
  { id: 2, name: 'Rate Limit Check', isRule: true },
];

const mockTrackedApps = [
  { id: 1, packageName: 'com.example.myapp', appName: 'My App', latestVersion: '1.2.3' },
  { id: 2, packageName: 'com.acme.thing', appName: undefined, latestVersion: null },
];

function createMockWs(overrides?: Partial<WebSocketContextValue>): WebSocketContextValue {
  return {
    connected: true,
    serverReady: true,
    startupMessage: 'Server ready',
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockImplementation((_method: string, path: string) => {
      if (path === '/v1/device/list') {
        return Promise.resolve({ type: 'restapi', id: '1', status: 200, body: { success: true, data: mockDevices } });
      }
      if (path === '/v1/automation/list') {
        return Promise.resolve({ type: 'restapi', id: '2', status: 200, body: { success: true, data: mockAutomations } });
      }
      if (path === '/v1/apps/tracked') {
        return Promise.resolve({ type: 'restapi', id: '3', status: 200, body: { success: true, data: mockTrackedApps } });
      }
      return Promise.resolve({ type: 'restapi', id: '9', status: 200, body: { data: [] } });
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

function renderPalette(ws?: WebSocketContextValue) {
  const mockWs = ws || createMockWs();
  return render(
    <WebSocketContext.Provider value={mockWs}>
      <MemoryRouter>
        <CommandPalette />
      </MemoryRouter>
    </WebSocketContext.Provider>
  );
}

async function openPalette() {
  await act(async () => {
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
  });
}

async function closePaletteViaEscape() {
  await act(async () => {
    fireEvent.keyDown(document, { key: 'Escape' });
  });
}

describe('CommandPalette', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('open/close behaviour', () => {
    it('is hidden by default', () => {
      renderPalette();
      expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument();
    });

    it('opens on Ctrl+K', async () => {
      renderPalette();
      await openPalette();
      expect(screen.getByTestId('command-palette')).toBeInTheDocument();
    });

    it('closes on Ctrl+K again', async () => {
      renderPalette();
      await openPalette();
      expect(screen.getByTestId('command-palette')).toBeInTheDocument();
      await openPalette();
      expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument();
    });

    it('closes on Escape', async () => {
      renderPalette();
      await openPalette();
      expect(screen.getByTestId('command-palette')).toBeInTheDocument();
      await closePaletteViaEscape();
      expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument();
    });

    it('closes when clicking the overlay', async () => {
      renderPalette();
      await openPalette();
      await act(async () => {
        fireEvent.click(screen.getByTestId('command-palette-overlay'));
      });
      expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument();
    });
  });

  describe('static items', () => {
    it('renders static page items', async () => {
      renderPalette();
      await openPalette();
      expect(screen.getByTestId('command-item-page-dashboard')).toBeInTheDocument();
      expect(screen.getByTestId('command-item-page-devices')).toBeInTheDocument();
      expect(screen.getByTestId('command-item-page-automations')).toBeInTheDocument();
    });

    it('renders static action items', async () => {
      renderPalette();
      await openPalette();
      expect(screen.getByTestId('command-item-action-new-automation')).toBeInTheDocument();
      expect(screen.getByTestId('command-item-action-add-device')).toBeInTheDocument();
    });
  });

  describe('search/filter', () => {
    it('filters items by query', async () => {
      renderPalette();
      await openPalette();

      await act(async () => {
        fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: 'dashboard' } });
      });

      expect(screen.getByTestId('command-item-page-dashboard')).toBeInTheDocument();
      expect(screen.queryByTestId('command-item-page-proxies')).not.toBeInTheDocument();
    });

    it('shows empty state when no results', async () => {
      renderPalette();
      await openPalette();

      await act(async () => {
        fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: 'xyzzy_no_match_here' } });
      });

      expect(screen.getByText(/No results for/)).toBeInTheDocument();
    });

    it('matches by keyword', async () => {
      renderPalette();
      await openPalette();

      await act(async () => {
        fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: 'postman' } });
      });

      expect(screen.getByTestId('command-item-page-request-builder')).toBeInTheDocument();
    });
  });

  describe('keyboard navigation', () => {
    beforeEach(() => {
      // jsdom doesn't implement scrollIntoView — provide a no-op mock
      window.HTMLElement.prototype.scrollIntoView = vi.fn();
    });

    it('navigates down with ArrowDown', async () => {
      renderPalette();
      await openPalette();

      const items = screen.getAllByTestId(/^command-item-/);
      expect(items[0]).toHaveClass('selected');

      await act(async () => {
        fireEvent.keyDown(document, { key: 'ArrowDown' });
      });
      expect(items[1]).toHaveClass('selected');
    });

    it('navigates up with ArrowUp', async () => {
      renderPalette();
      await openPalette();

      await act(async () => {
        fireEvent.keyDown(document, { key: 'ArrowDown' });
        fireEvent.keyDown(document, { key: 'ArrowDown' });
      });
      const items = screen.getAllByTestId(/^command-item-/);
      expect(items[2]).toHaveClass('selected');

      await act(async () => {
        fireEvent.keyDown(document, { key: 'ArrowUp' });
      });
      expect(items[1]).toHaveClass('selected');
    });
  });

  describe('dynamic items — loading', () => {
    it('shows loading indicator while fetching', async () => {
      let resolveDevices!: (v: any) => void;
      const pendingDevices = new Promise(resolve => { resolveDevices = resolve; });

      const ws = createMockWs({
        sendRestApi: vi.fn().mockImplementation((_method: string, path: string) => {
          if (path === '/v1/device/list') return pendingDevices;
          return Promise.resolve({ type: 'restapi', id: '9', status: 200, body: { data: [] } });
        }),
      });

      renderPalette(ws);

      // Open palette — this triggers fetchDynamicItems which won't resolve yet
      await act(async () => {
        fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
        // Let microtasks run so the fetch starts
        await Promise.resolve();
      });

      expect(screen.getByTestId('command-palette-loading')).toBeInTheDocument();

      // Resolve the pending fetch
      await act(async () => {
        resolveDevices({ type: 'restapi', id: '1', status: 200, body: { data: [] } });
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.queryByTestId('command-palette-loading')).not.toBeInTheDocument();
    });
  });

  describe('dynamic items — devices', () => {
    it('renders device items after fetch', async () => {
      renderPalette();
      await openPalette();

      await waitFor(() => {
        expect(screen.getByTestId('command-item-device-emulator-5554')).toBeInTheDocument();
        expect(screen.getByTestId('command-item-device-abc123')).toBeInTheDocument();
      });
    });

    it('uses device name as label', async () => {
      renderPalette();
      await openPalette();

      await waitFor(() => {
        expect(screen.getByText('Pixel 6 Pro')).toBeInTheDocument();
        expect(screen.getByText('Galaxy S21')).toBeInTheDocument();
      });
    });

    it('falls back to device id when name is missing', async () => {
      const ws = createMockWs({
        sendRestApi: vi.fn().mockImplementation((_method: string, path: string) => {
          if (path === '/v1/device/list') {
            return Promise.resolve({ type: 'restapi', id: '1', status: 200, body: { data: [{ id: 'no-name-device' }] } });
          }
          return Promise.resolve({ type: 'restapi', id: '9', status: 200, body: { data: [] } });
        }),
      });

      renderPalette(ws);
      await openPalette();

      await waitFor(() => {
        expect(screen.getByText('no-name-device')).toBeInTheDocument();
      });
    });

    it('matches device by manufacturer in search', async () => {
      renderPalette();
      await openPalette();

      await waitFor(() => {
        expect(screen.getByTestId('command-item-device-abc123')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: 'Samsung' } });
      });

      expect(screen.getByTestId('command-item-device-abc123')).toBeInTheDocument();
      expect(screen.queryByTestId('command-item-device-emulator-5554')).not.toBeInTheDocument();
    });
  });

  describe('dynamic items — automations', () => {
    it('renders automation items after fetch', async () => {
      renderPalette();
      await openPalette();

      await waitFor(() => {
        expect(screen.getByTestId('command-item-automation-1')).toBeInTheDocument();
        expect(screen.getByTestId('command-item-automation-2')).toBeInTheDocument();
      });
    });

    it('shows Rule badge for isRule automations', async () => {
      renderPalette();
      await openPalette();

      await waitFor(() => {
        expect(screen.getByTestId('command-item-badge-automation-2')).toBeInTheDocument();
        expect(screen.getByTestId('command-item-badge-automation-2')).toHaveTextContent('Rule');
      });
    });

    it('does not show badge for non-rule automations', async () => {
      renderPalette();
      await openPalette();

      await waitFor(() => {
        expect(screen.getByTestId('command-item-automation-1')).toBeInTheDocument();
      });

      expect(screen.queryByTestId('command-item-badge-automation-1')).not.toBeInTheDocument();
    });
  });

  describe('dynamic items — APKs', () => {
    it('renders APK items after fetch', async () => {
      renderPalette();
      await openPalette();

      await waitFor(() => {
        expect(screen.getByTestId('command-item-apk-1')).toBeInTheDocument();
        expect(screen.getByTestId('command-item-apk-2')).toBeInTheDocument();
      });
    });

    it('uses appName as label when available', async () => {
      renderPalette();
      await openPalette();

      await waitFor(() => {
        expect(screen.getByText('My App')).toBeInTheDocument();
      });
    });

    it('falls back to packageName when appName is missing', async () => {
      renderPalette();
      await openPalette();

      await waitFor(() => {
        expect(screen.getByText('com.acme.thing')).toBeInTheDocument();
      });
    });

    it('matches APK by packageName in search', async () => {
      renderPalette();
      await openPalette();

      await waitFor(() => {
        expect(screen.getByTestId('command-item-apk-1')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: 'com.example' } });
      });

      expect(screen.getByTestId('command-item-apk-1')).toBeInTheDocument();
      expect(screen.queryByTestId('command-item-apk-2')).not.toBeInTheDocument();
    });
  });

  describe('dynamic items — ordering', () => {
    it('shows static Pages before dynamic Devices', async () => {
      renderPalette();
      await openPalette();

      await waitFor(() => {
        expect(screen.getByTestId('command-item-device-emulator-5554')).toBeInTheDocument();
      });

      const groupLabels = screen.getAllByText(/^(Pages|Actions|Devices|Automations|APKs)$/).filter(
        el => el.classList.contains('command-palette-group-label')
      );
      const labelTexts = groupLabels.map(el => el.textContent);
      const pagesIdx = labelTexts.indexOf('Pages');
      const devicesIdx = labelTexts.indexOf('Devices');
      expect(pagesIdx).toBeGreaterThanOrEqual(0);
      expect(devicesIdx).toBeGreaterThan(pagesIdx);
    });
  });

  describe('cache', () => {
    it('does not re-fetch when re-opened within 30s', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const ws = createMockWs();
      renderPalette(ws);

      // First open
      await act(async () => {
        fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(screen.getByTestId('command-item-device-emulator-5554')).toBeInTheDocument();
      });

      const firstCallCount = (ws.sendRestApi as ReturnType<typeof vi.fn>).mock.calls.length;

      // Close
      await act(async () => {
        fireEvent.keyDown(document, { key: 'Escape' });
      });

      // Advance time but stay under TTL
      act(() => { vi.advanceTimersByTime(10_000); });

      // Re-open
      await act(async () => {
        fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(screen.getByTestId('command-item-device-emulator-5554')).toBeInTheDocument();
      });

      // No new API calls should have been made
      expect((ws.sendRestApi as ReturnType<typeof vi.fn>).mock.calls.length).toBe(firstCallCount);

      vi.useRealTimers();
    });

    it('re-fetches after 30s cache expiry', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const ws = createMockWs();
      renderPalette(ws);

      // First open
      await act(async () => {
        fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(screen.getByTestId('command-item-device-emulator-5554')).toBeInTheDocument();
      });

      const firstCallCount = (ws.sendRestApi as ReturnType<typeof vi.fn>).mock.calls.length;

      // Close
      await act(async () => {
        fireEvent.keyDown(document, { key: 'Escape' });
      });

      // Advance past TTL
      act(() => { vi.advanceTimersByTime(31_000); });

      // Re-open
      await act(async () => {
        fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(screen.getByTestId('command-item-device-emulator-5554')).toBeInTheDocument();
      });

      // New API calls should have been made
      expect((ws.sendRestApi as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(firstCallCount);

      vi.useRealTimers();
    });
  });

  describe('error handling', () => {
    it('shows static items even when all API calls fail', async () => {
      const ws = createMockWs({
        sendRestApi: vi.fn().mockRejectedValue(new Error('Network error')),
      });

      renderPalette(ws);
      await openPalette();

      // Wait for the failed fetch to settle
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // Static items still present
      expect(screen.getByTestId('command-item-page-dashboard')).toBeInTheDocument();
      // No crash, loading indicator gone
      expect(screen.queryByTestId('command-palette-loading')).not.toBeInTheDocument();
    });

    it('shows static items when individual endpoints return empty data', async () => {
      const ws = createMockWs({
        sendRestApi: vi.fn().mockResolvedValue({ type: 'restapi', id: '1', status: 200, body: { data: [] } }),
      });

      renderPalette(ws);
      await openPalette();

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.getByTestId('command-item-page-dashboard')).toBeInTheDocument();
    });
  });
});
