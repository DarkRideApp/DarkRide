import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NetworkWorkspace } from './NetworkWorkspace';

vi.mock('@darkrideapp/plugin-sdk/react', () => ({
  useWebSocket: () => ({ sendRestApi: vi.fn().mockResolvedValue({ body: { data: [] } }) }),
  useDocumentTitle: () => {},
}));

vi.mock('../components/network/panes/TrafficPane', () => ({ TrafficPane: (p: any) => <div data-testid="pane-traffic">{JSON.stringify(p.scope)}</div> }));
vi.mock('../components/network/panes/InterceptPane', () => ({ InterceptPane: () => <div data-testid="pane-intercept" /> }));
vi.mock('../components/network/panes/RepeaterPane', () => ({ RepeaterPane: () => <div data-testid="pane-repeater" /> }));
vi.mock('../components/network/panes/CataloguePane', () => ({ CataloguePane: () => <div data-testid="pane-catalogue" /> }));

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <NetworkWorkspace />
    </MemoryRouter>
  );
}

describe('NetworkWorkspace', () => {
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
});
