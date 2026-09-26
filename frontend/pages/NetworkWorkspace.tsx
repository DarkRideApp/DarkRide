import React, { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { useDocumentTitle, useAuthOptional } from '@darkrideapp/plugin-sdk/react';
import { Activity, ShieldAlert, Repeat, BookOpen, Send } from 'lucide-react';
import { NetworkScopeProvider, useNetworkScope } from '../components/network/NetworkScopeContext';
import { ScopeBar } from '../components/network/ScopeBar';
import { TrafficPane } from '../components/network/panes/TrafficPane';
import { InterceptPane } from '../components/network/panes/InterceptPane';
import { RepeaterPane } from '../components/network/panes/RepeaterPane';
import { CataloguePane } from '../components/network/panes/CataloguePane';
import { OutboundRequestsPane } from '../components/network/panes/OutboundRequestsPane';

type PaneKey = 'traffic' | 'intercept' | 'repeater' | 'catalogue' | 'outbound';
// requiredScope mirrors what each pane's backend routes enforce. Repeater and
// Catalogue have none, matching the old standalone nav entries.
const PANES: Array<{ key: PaneKey; label: string; icon: React.ReactNode; requiredScope?: string }> = [
  { key: 'traffic', label: 'Traffic', icon: <Activity size={14} />, requiredScope: 'core.traffic:read' },
  { key: 'intercept', label: 'Intercept', icon: <ShieldAlert size={14} />, requiredScope: 'core.traffic:read' },
  { key: 'repeater', label: 'Repeater', icon: <Repeat size={14} /> },
  { key: 'catalogue', label: 'Catalogue', icon: <BookOpen size={14} /> },
  { key: 'outbound', label: 'Outbound', icon: <Send size={14} />, requiredScope: 'core.traffic:read' },
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

  const auth = useAuthOptional();
  const panes = useMemo(
    () => PANES.filter(p => !p.requiredScope || (auth?.hasScope(p.requiredScope) ?? true)),
    [auth],
  );

  const paneParam = searchParams.get('pane');
  const pane: PaneKey = panes.find(p => p.key === paneParam)?.key ?? panes[0].key;

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
          {panes.map(p => (
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
        {pane === 'outbound' && <OutboundRequestsPane />}
      </div>
    </div>
  );
}
