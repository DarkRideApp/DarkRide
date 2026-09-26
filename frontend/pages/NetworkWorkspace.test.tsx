import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NetworkWorkspace } from './NetworkWorkspace';

// null = no auth context (single-user mode): every pane is visible.
let mockAuth: { hasScope: (s: string) => boolean } | null = null;
vi.mock('@darkrideapp/plugin-sdk/react', () => ({
  useWebSocket: () => ({ sendRestApi: vi.fn().mockResolvedValue({ body: { data: [] } }) }),
  useDocumentTitle: () => {},
  useAuthOptional: () => mockAuth,
}));

vi.mock('../components/network/panes/TrafficPane', () => ({ TrafficPane: (p: any) => <div data-testid="pane-traffic">{JSON.stringify(p.scope)}</div> }));
vi.mock('../components/network/panes/InterceptPane', () => ({ InterceptPane: () => <div data-testid="pane-intercept" /> }));
vi.mock('../components/network/panes/RepeaterPane', () => ({ RepeaterPane: () => <div data-testid="pane-repeater" /> }));
vi.mock('../components/network/panes/CataloguePane', () => ({ CataloguePane: () => <div data-testid="pane-catalogue" /> }));
vi.mock('../components/network/panes/OutboundRequestsPane', () => ({ OutboundRequestsPane: () => <div data-testid="pane-outbound" /> }));

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <NetworkWorkspace />
    </MemoryRouter>
  );
}

describe('NetworkWorkspace', () => {
  beforeEach(() => { mockAuth = null; });

  it('renders the Traffic pane by default', () => {
    renderAt('/ui/network');
    expect(screen.getByTestId('pane-traffic')).toBeInTheDocument();
  });

  it('switches panes via the tabs', () => {
    renderAt('/ui/network');
    fireEvent.click(screen.getByTestId('network-tab-intercept'));
    expect(screen.getByTestId('pane-intercept')).toBeInTheDocument();
    expect(screen.queryByTestId('pane-traffic')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('network-tab-repeater'));
    expect(screen.getByTestId('pane-repeater')).toBeInTheDocument();
  });

  it('honors the ?pane= param', () => {
    renderAt('/ui/network?pane=catalogue');
    expect(screen.getByTestId('pane-catalogue')).toBeInTheDocument();
  });

  it('passes the parsed scope from ?scope= to the Traffic pane', () => {
    renderAt('/ui/network?scope=session:3');
    expect(screen.getByTestId('pane-traffic')).toHaveTextContent('"kind":"session"');
    expect(screen.getByTestId('pane-traffic')).toHaveTextContent('"sessionId":3');
  });

  // Repeater and Catalogue have no scope requirement server-side; Traffic,
  // Intercept and Outbound need core.traffic:read. A user without it keeps
  // the panes they could reach before the workspace existed.
  describe('without core.traffic:read', () => {
    beforeEach(() => { mockAuth = { hasScope: () => false }; });

    it('hides the traffic-gated tabs and defaults to Repeater', () => {
      renderAt('/ui/network');
      expect(screen.queryByTestId('network-tab-traffic')).not.toBeInTheDocument();
      expect(screen.queryByTestId('network-tab-intercept')).not.toBeInTheDocument();
      expect(screen.queryByTestId('network-tab-outbound')).not.toBeInTheDocument();
      expect(screen.getByTestId('network-tab-repeater')).toBeInTheDocument();
      expect(screen.getByTestId('network-tab-catalogue')).toBeInTheDocument();
      expect(screen.getByTestId('pane-repeater')).toBeInTheDocument();
      expect(screen.queryByTestId('pane-traffic')).not.toBeInTheDocument();
    });

    it('ignores a ?pane= deep link to a pane the user cannot see', () => {
      renderAt('/ui/network?pane=traffic');
      expect(screen.queryByTestId('pane-traffic')).not.toBeInTheDocument();
      expect(screen.getByTestId('pane-repeater')).toBeInTheDocument();
    });

    it('still honors ?pane=catalogue', () => {
      renderAt('/ui/network?pane=catalogue');
      expect(screen.getByTestId('pane-catalogue')).toBeInTheDocument();
    });
  });

  it('shows every tab when the user has core.traffic:read', () => {
    mockAuth = { hasScope: s => s === 'core.traffic:read' };
    renderAt('/ui/network');
    for (const k of ['traffic', 'intercept', 'repeater', 'catalogue', 'outbound']) {
      expect(screen.getByTestId(`network-tab-${k}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('pane-traffic')).toBeInTheDocument();
  });
});
