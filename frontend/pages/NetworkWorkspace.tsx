import React, { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { Activity, ShieldAlert, Repeat, BookOpen } from 'lucide-react';
import { NetworkScopeProvider, useNetworkScope } from '../components/network/NetworkScopeContext';
import { ScopeBar } from '../components/network/ScopeBar';
import { TrafficPane } from '../components/network/panes/TrafficPane';
import { InterceptPane } from '../components/network/panes/InterceptPane';
import { RepeaterPane } from '../components/network/panes/RepeaterPane';
import { CataloguePane } from '../components/network/panes/CataloguePane';

type PaneKey = 'traffic' | 'intercept' | 'repeater' | 'catalogue';
const PANES: Array<{ key: PaneKey; label: string; icon: React.ReactNode }> = [
  { key: 'traffic', label: 'Traffic', icon: <Activity size={14} /> },
  { key: 'intercept', label: 'Intercept', icon: <ShieldAlert size={14} /> },
  { key: 'repeater', label: 'Repeater', icon: <Repeat size={14} /> },
  { key: 'catalogue', label: 'Catalogue', icon: <BookOpen size={14} /> },
];

/**
 * NetworkWorkspace — one home for the capture -> inspect -> intercept -> replay
 * -> catalogue workflow. A scope bar (all / device / capture session) drives a
 * set of panes, replacing the four separate Network nav entries.
 */
export function NetworkWorkspace() {
  useDocumentTitle('Network');
  return (
    <NetworkScopeProvider>
      <NetworkWorkspaceInner />
    </NetworkScopeProvider>
  );
}

function NetworkWorkspaceInner() {
  const ws = useWebSocket();
  const { scope, setScope } = useNetworkScope();
  const [searchParams, setSearchParams] = useSearchParams();

  const paneParam = searchParams.get('pane');
  const pane: PaneKey = PANES.some(p => p.key === paneParam) ? (paneParam as PaneKey) : 'traffic';

  const setPane = useCallback((next: PaneKey) => {
    setSearchParams(prev => {
      const p = new URLSearchParams(prev);
      p.set('pane', next);
      return p;
    }, { replace: false });
  }, [setSearchParams]);

  return (
    <div data-testid="network-workspace" className="network-workspace page-full-bleed">
      <div className="network-topbar">
        <ScopeBar ws={ws} scope={scope} onScopeChange={setScope} />
        <div className="network-pane-tabs" role="tablist">
          {PANES.map(p => (
            <button
              key={p.key}
              role="tab"
              aria-selected={pane === p.key}
              data-testid={`network-tab-${p.key}`}
              className={`network-pane-tab${pane === p.key ? ' active' : ''}`}
              onClick={() => setPane(p.key)}
            >
              {p.icon}
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div className="network-pane-body">
        {pane === 'traffic' && <TrafficPane scope={scope} />}
        {pane === 'intercept' && <InterceptPane />}
        {pane === 'repeater' && <RepeaterPane />}
        {pane === 'catalogue' && <CataloguePane />}
      </div>
    </div>
  );
}
