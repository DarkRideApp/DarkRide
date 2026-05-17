import { useEffect, useSyncExternalStore, useContext } from 'react';
import { WebSocketContext, type WebSocketContextValue } from '../contexts/WebSocketContext';

interface RestartRequiredState {
  required: boolean;
  reason: string | null;
  since: Date | null;
}

interface InternalState {
  state: RestartRequiredState;
}

const INITIAL: InternalState = {
  state: { required: false, reason: null, since: null },
};

// Shared singleton store. Multiple hook callers share one fetch + subscription.
let store: InternalState = INITIAL;
const subscribers = new Set<() => void>();

function notify() { for (const s of subscribers) s(); }

function setState(next: RestartRequiredState) {
  store = { state: next };
  notify();
}

let initStarted = false;
let initWsContext: WebSocketContextValue | null = null;
let unsubscribes: Array<() => void> = [];

function ensureInit(ws: WebSocketContextValue) {
  if (initStarted && initWsContext === ws) return;
  // Tear down any prior subscriptions if the WS context object changed
  // (e.g. tests resetting context between renders).
  for (const u of unsubscribes) u();
  unsubscribes = [];
  initStarted = true;
  initWsContext = ws;

  // Initial fetch
  ws.sendRestApi('GET', '/v1/system/status').then((res: any) => {
    if (res?.body?.success && res.body.restartRequired) {
      setState({
        required: true,
        reason: res.body.restartRequired.reason,
        since: new Date(res.body.restartRequired.since * 1000),
      });
    } else {
      setState({ required: false, reason: null, since: null });
    }
  }).catch(() => {
    // Fail closed: keep required:false rather than show a misleading banner.
    setState({ required: false, reason: null, since: null });
  });

  unsubscribes.push(
    ws.subscribe('system:restart-required', (msg: any) => {
      setState({
        required: true,
        reason: msg?.reason ?? 'Server restart required',
        since: msg?.since ? new Date(msg.since * 1000) : null,
      });
    })
  );
  unsubscribes.push(
    ws.subscribe('system:restart-cleared', () => {
      setState({ required: false, reason: null, since: null });
    })
  );
}

// Test helper — resets the singleton between tests.
export function __resetRestartRequiredStore() {
  store = INITIAL;
  for (const u of unsubscribes) u();
  unsubscribes = [];
  initStarted = false;
  initWsContext = null;
  subscribers.clear();
}

export function useRestartRequired(): RestartRequiredState {
  const ws = useContext(WebSocketContext);

  useEffect(() => {
    if (ws) ensureInit(ws);
  }, [ws]);

  return useSyncExternalStore(
    (cb) => { subscribers.add(cb); return () => subscribers.delete(cb); },
    () => store.state,
    () => store.state,
  );
}
