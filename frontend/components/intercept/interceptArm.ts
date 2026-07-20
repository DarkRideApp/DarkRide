import type { InterceptArmedConfig, InterceptMatchRule } from '../../../shared/types/websocket';

export type InterceptPhase = 'request' | 'response';
export type { InterceptMatchRule };

interface Ws { sendRestApi: (method: string, path: string, body?: unknown) => Promise<unknown> }

function phaseWord(phases: InterceptPhase[]): string {
  if (phases.length >= 2) return 'requests & responses';
  return phases[0] === 'response' ? 'responses' : 'requests';
}

/** Compact one-line target for a single rule, e.g. "POST *.stripe.com/v1/*". */
export function describeRule(rule: InterceptMatchRule): string {
  const method = rule.method?.trim();
  const host = rule.hostname?.trim();
  const path = rule.path?.trim();
  const parts: string[] = [];
  if (method) parts.push(method.toUpperCase());
  if (host || path) parts.push(`${host ?? ''}${path ?? ''}`);
  return parts.length ? parts.join(' ') : 'anything';
}

/** Plain-English summary of what an armed config will pause. */
export function describeArmed(config: Pick<InterceptArmedConfig, 'rules' | 'phases'> & { enabled?: boolean }): string {
  const words = phaseWord(config.phases);
  const rules = config.rules ?? [];
  if (rules.length === 0) return `Pause all ${words}`;
  if (rules.length === 1) return `Pause ${words} matching ${describeRule(rules[0])}`;
  return `Pause ${words} matching ${rules.length} rules`;
}

/** Short label for the armed-scope chip, or null when disarmed. */
export function armedChipLabel(config: Partial<InterceptArmedConfig>): string | null {
  if (!config.enabled) return null;
  const rules = config.rules;
  if (Array.isArray(rules)) {
    if (rules.length === 0) return 'all';
    if (rules.length === 1) {
      const r = rules[0];
      return (r.hostname?.trim() || r.path?.trim() || r.method?.trim()?.toUpperCase() || 'custom');
    }
    return `${rules.length} rules`;
  }
  // legacy fallback
  return config.matchHostname?.trim() || config.matchPath?.trim() || config.matchMethod?.trim()?.toUpperCase() || 'all';
}

/** Arm interactive intercept with a rule list. The armed-changed broadcast reconciles every UI. */
export function armIntercept(ws: Ws, opts: { rules: InterceptMatchRule[]; phases: InterceptPhase[] }): Promise<unknown> {
  return ws.sendRestApi('POST', '/v1/intercept/armed', {
    enabled: true,
    rules: opts.rules,
    phases: opts.phases.length ? opts.phases : ['request', 'response'],
  });
}

export function disarmIntercept(ws: Ws): Promise<unknown> {
  return ws.sendRestApi('POST', '/v1/intercept/armed', { enabled: false, rules: [], phases: ['request', 'response'] });
}

/**
 * Point-and-intercept: arm (or add to the armed config) a rule for one host.
 * Reads the current config so this composes with any rules already armed, and
 * is idempotent for a host that's already covered by a host-only rule.
 */
export async function interceptHost(ws: Ws, hostname: string): Promise<unknown> {
  let cfg: Partial<InterceptArmedConfig> = {};
  try {
    const res = (await ws.sendRestApi('GET', '/v1/intercept/armed')) as { body?: { data?: InterceptArmedConfig } };
    cfg = res?.body?.data ?? {};
  } catch { /* start fresh */ }
  const existing = Array.isArray(cfg.rules) && cfg.enabled ? cfg.rules : [];
  const already = existing.some(r => (r.hostname ?? '') === hostname && !r.path && !r.method);
  const rules = already ? existing : [...existing, { hostname, path: null, method: null }];
  const phases = cfg.phases?.length ? cfg.phases as InterceptPhase[] : ['request', 'response'];
  return armIntercept(ws, { rules, phases });
}
