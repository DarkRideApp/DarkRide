import type { InterceptArmedConfig } from '../../../shared/types/websocket';

export type InterceptPhase = 'request' | 'response';

export interface InterceptScope {
  matchHostname?: string | null;
  matchPath?: string | null;
  matchMethod?: string | null;
  phases: InterceptPhase[];
}

interface Ws { sendRestApi: (method: string, path: string, body?: unknown) => Promise<unknown> }

function phaseWord(phases: InterceptPhase[]): string {
  if (phases.length >= 2) return 'requests & responses';
  return phases[0] === 'response' ? 'responses' : 'requests';
}

/** Plain-English summary of what an armed scope will pause. */
export function describeScope(scope: InterceptScope): string {
  const host = scope.matchHostname?.trim();
  const path = scope.matchPath?.trim();
  const method = scope.matchMethod?.trim();
  const words = phaseWord(scope.phases);
  const methodPart = method ? `${method.toUpperCase()} ` : '';
  let target = '';
  if (host && path) target = ` to ${host}${path}`;
  else if (host) target = ` to ${host}`;
  else if (path) target = ` with path ${path}`;
  if (!host && !path && !method) return `Pause all ${words}`;
  return `Pause ${methodPart}${words}${target}`;
}

/** Short label for the armed-scope chip, or null when disarmed / unscoped. */
export function scopeChipLabel(config: Partial<InterceptArmedConfig>): string | null {
  if (!config.enabled) return null;
  if (config.matchHostname?.trim()) return config.matchHostname.trim();
  if (config.matchPath?.trim()) return config.matchPath.trim();
  if (config.matchMethod?.trim()) return config.matchMethod.trim().toUpperCase();
  return null;
}

/** Arm interactive intercept with a scope. The armed-changed broadcast reconciles every UI. */
export function armIntercept(ws: Ws, scope: InterceptScope): Promise<unknown> {
  return ws.sendRestApi('POST', '/v1/intercept/armed', {
    enabled: true,
    matchHostname: scope.matchHostname?.trim() || null,
    matchPath: scope.matchPath?.trim() || null,
    matchMethod: scope.matchMethod?.trim() || null,
    phases: scope.phases.length ? scope.phases : ['request', 'response'],
  });
}

export function disarmIntercept(ws: Ws): Promise<unknown> {
  return ws.sendRestApi('POST', '/v1/intercept/armed', { enabled: false, phases: ['request', 'response'] });
}
