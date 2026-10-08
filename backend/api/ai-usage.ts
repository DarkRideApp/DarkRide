import { registerEndpoint } from './api-service';
import type { AppDatabase } from '../db/index';
import { buildUsageReport } from '../services/ai-usage-report';

const DAYS = { name: 'days', min: 1, max: 90, fallback: 30 };
const LIMIT = { name: 'limit', min: 1, max: 200, fallback: 50 };

/**
 * Reads an optional whole-number query parameter. Absent means the default; anything else that is not a
 * plain integer inside the range (including an empty value) is an error. A repeated parameter is an error
 * over HTTP, where Express parses it into an array; the WebSocket REST adapter keeps only the last value,
 * so there it is validated like a single value.
 */
function intParam(
  raw: unknown,
  spec: { name: string; min: number; max: number; fallback: number },
): { ok: true; value: number } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: spec.fallback };
  const error = `${spec.name} must be an integer from ${spec.min} to ${spec.max}`;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return { ok: false, error };
  const value = Number(raw);
  if (value < spec.min || value > spec.max) return { ok: false, error };
  return { ok: true, value };
}

export function registerAiUsageEndpoints(db: AppDatabase): void {
  // GET /v1/ai/usage/report: token, cache and estimated cost totals for recorded agent runs.
  // GET /v1/ai/usage itself is the older per-conversation token summary in ai-chat.ts.
  registerEndpoint('GET', '/v1/ai/usage/report', (req, res) => {
    const days = intParam(req.query.days, DAYS);
    if (!days.ok) {
      res.status(400).json({ success: false, error: days.error });
      return;
    }
    const limit = intParam(req.query.limit, LIMIT);
    if (!limit.ok) {
      res.status(400).json({ success: false, error: limit.error });
      return;
    }
    const data = buildUsageReport(db, { days: days.value, limit: limit.value, now: new Date() });
    res.json({ success: true, data });
  }, { requires: ['core.settings:read'] });
}
