/**
 * In-memory store for interactive request/response interception ("breakpoints").
 *
 * This is separate from the rule-based Intercept feature (intercept-rules.ts).
 * A flow is "held" when the mitmproxy addon pauses it in-flight and long-polls
 * POST /v1/intercept/hold. Node keeps that HTTP response open until a user
 * resolves the flow (forward / drop, optionally with edits) or a server-side
 * timeout fires — the timeout is deliberately shorter than the addon's own
 * ceiling so the addon always receives a verdict instead of erroring out.
 *
 * Everything here is ephemeral: held flows never touch the database. On capture
 * stop the store is cleared and every pending flow is failed open to `forward`.
 */

import type { HeldFlow, InterceptArmedConfig } from '../../shared/types/websocket';

export type Phase = 'request' | 'response';

/** Fields the addon may apply back to a flow when a user forwards with edits. */
export interface HoldModified {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string | null;
  statusCode?: number | null;
}

/** The verdict returned to the addon for a held flow. */
export interface HoldResolution {
  action: 'forward' | 'drop';
  modified?: HoldModified;
}

/**
 * Server-side hold timeout. Kept comfortably below the addon's 300s ceiling so
 * Node always resolves first (returning `forward`) rather than the addon
 * timing out mid-request.
 */
export const DEFAULT_HOLD_TIMEOUT_MS = 280_000;

interface HeldEntry {
  flow: HeldFlow;
  phase: Phase;
  createdAt: number;
  resolve: (r: HoldResolution) => void;
  timer: ReturnType<typeof setTimeout>;
}

const heldFlows = new Map<string, HeldEntry>();

let armed: InterceptArmedConfig = {
  enabled: false,
  matchHostname: null,
  matchPath: null,
  matchMethod: null,
  phases: ['request', 'response'],
};

/**
 * Register a held flow and return a promise that settles with the resolution.
 * If the flow id is already held (duplicate hook), the previous holder is
 * failed open to `forward` so it never dangles.
 */
export function hold(
  flow: HeldFlow,
  opts: { timeoutMs?: number } = {},
): Promise<HoldResolution> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HOLD_TIMEOUT_MS;

  // Defensive: if this flow id is somehow already held, forward the old one.
  const existing = heldFlows.get(flow.flowId);
  if (existing) {
    clearTimeout(existing.timer);
    heldFlows.delete(flow.flowId);
    existing.resolve({ action: 'forward' });
  }

  return new Promise<HoldResolution>((resolve) => {
    const timer = setTimeout(() => {
      if (heldFlows.delete(flow.flowId)) {
        resolve({ action: 'forward' });
      }
    }, timeoutMs);
    // Don't keep the event loop alive on the hold timer alone.
    if (typeof timer.unref === 'function') timer.unref();

    heldFlows.set(flow.flowId, {
      flow,
      phase: flow.phase,
      createdAt: flow.createdAt,
      resolve,
      timer,
    });
  });
}

/**
 * Resolve a held flow. Returns false if the flow is unknown or already
 * resolved — this is how a second UI racing the same flow learns it lost.
 */
export function resolveHold(flowId: string, resolution: HoldResolution): boolean {
  const entry = heldFlows.get(flowId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  heldFlows.delete(flowId);
  entry.resolve(resolution);
  return true;
}

/** Snapshot of the currently-held flows (safe to serialise for a new client). */
export function listHeld(): HeldFlow[] {
  return Array.from(heldFlows.values()).map((e) => e.flow);
}

/** Forward every pending flow and clear the store (called on capture stop). */
export function dropAllHeld(): void {
  const entries = Array.from(heldFlows.values());
  heldFlows.clear();
  for (const entry of entries) {
    clearTimeout(entry.timer);
    entry.resolve({ action: 'forward' });
  }
}

export function getArmed(): InterceptArmedConfig {
  return armed;
}

/** Update the armed config. Missing `phases` defaults to both phases. */
export function setArmed(config: Partial<InterceptArmedConfig>): InterceptArmedConfig {
  const bothPhases: Phase[] = ['request', 'response'];
  const filtered = Array.isArray(config.phases)
    ? config.phases.filter((p): p is Phase => p === 'request' || p === 'response')
    : [];
  armed = {
    enabled: !!config.enabled,
    matchHostname: config.matchHostname ?? null,
    matchPath: config.matchPath ?? null,
    matchMethod: config.matchMethod ?? null,
    phases: filtered.length > 0 ? filtered : bothPhases,
  };
  return armed;
}

/** Convert a simple glob (`*` wildcard) to a full-match regex. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Decide whether a flow should be held given the current armed config. This is
 * a defensive server-side mirror of the addon's own local check — if a stale
 * addon posts a flow that no longer matches, Node forwards it immediately
 * instead of hanging the device's traffic.
 */
export function holdMatches(flow: HeldFlow, phase: Phase): boolean {
  if (!armed.enabled) return false;
  if (!armed.phases.includes(phase)) return false;

  let hostname = '';
  let pathname = '';
  try {
    const u = new URL(flow.url);
    hostname = u.hostname;
    pathname = u.pathname;
  } catch {
    // Non-URL (e.g. WireGuard IP-only) — hostname/path filters can't apply.
  }

  if (armed.matchHostname) {
    if (!hostname || !globToRegExp(armed.matchHostname).test(hostname)) return false;
  }
  if (armed.matchPath) {
    if (!pathname || !globToRegExp(armed.matchPath).test(pathname)) return false;
  }
  if (armed.matchMethod) {
    if ((flow.method || '').toUpperCase() !== armed.matchMethod.toUpperCase()) return false;
  }
  return true;
}

/** Test-only — reset all state between tests. */
export function resetHoldStore(): void {
  for (const entry of heldFlows.values()) {
    clearTimeout(entry.timer);
    entry.resolve({ action: 'forward' });
  }
  heldFlows.clear();
  armed = {
    enabled: false,
    matchHostname: null,
    matchPath: null,
    matchMethod: null,
    phases: ['request', 'response'],
  };
}
