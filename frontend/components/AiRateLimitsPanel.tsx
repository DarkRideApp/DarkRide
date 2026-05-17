import React, { useEffect, useState, useCallback } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import type { AiRateLimitInfo } from '../../shared/types/ai-models';

const POLL_INTERVAL = 30_000;

export function AiRateLimitsPanel() {
  const ws = useWebSocket();
  const [limits, setLimits] = useState<AiRateLimitInfo[]>([]);

  const fetchLimits = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/ai/rate-limits');
      if (res.body?.success) {
        // Defensive: if `data` is missing or null, fall back to []. Prior
        // code did `setLimits(res.body.data)`, which made limits undefined
        // and crashed the next render at `limits.length`. The crash
        // bubbled up and prevented downstream sections (tier cards, model
        // rows) from rendering — see the 2026-05-13 AI Settings regression.
        setLimits(Array.isArray(res.body.data) ? res.body.data : []);
      }
    } catch {}
  }, [ws]);

  useEffect(() => {
    if (!ws.connected) return;
    fetchLimits();
    const interval = setInterval(fetchLimits, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [ws.connected, fetchLimits]);

  if (limits.length === 0) return null;

  return (
    <div style={{ marginTop: 16 }}>
      <h4 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: 'var(--text-primary)' }}>
        Rate Limits
      </h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {limits.map((l) => (
          <RateLimitRow key={l.modelId} limit={l} />
        ))}
      </div>
    </div>
  );
}

function RateLimitRow({ limit }: { limit: AiRateLimitInfo }) {
  const hasData = limit.requestsLimit !== null || limit.tokensLimit !== null;

  return (
    <div
      style={{
        padding: '8px 12px',
        borderRadius: 6,
        background: 'var(--bg-secondary)',
        fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: hasData ? 6 : 0 }}>
        <span style={{ fontWeight: 500 }}>{limit.modelName}</span>
        {limit.inCooldown && (
          <CooldownBadge endsAt={limit.cooldownEndsAt} />
        )}
      </div>

      {hasData ? (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {limit.requestsLimit !== null && (
            <ProgressBar
              label="Requests"
              remaining={limit.requestsRemaining ?? 0}
              limit={limit.requestsLimit}
              reset={limit.requestsReset}
            />
          )}
          {limit.tokensLimit !== null && (
            <ProgressBar
              label="Tokens"
              remaining={limit.tokensRemaining ?? 0}
              limit={limit.tokensLimit}
              reset={limit.tokensReset}
            />
          )}
        </div>
      ) : (
        <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>No rate limit data</span>
      )}
    </div>
  );
}

function ProgressBar({ label, remaining, limit, reset }: {
  label: string;
  remaining: number;
  limit: number;
  reset: string | null;
}) {
  const pct = limit > 0 ? Math.round((remaining / limit) * 100) : 0;
  const color = pct > 50 ? 'var(--status-online, #22c55e)' : pct > 20 ? 'var(--status-warning, #f59e0b)' : 'var(--status-error, #ef4444)';

  return (
    <div style={{ flex: '1 1 120px', minWidth: 120 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
        <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{label}</span>
        <span style={{ fontSize: 11 }}>
          {remaining.toLocaleString()} / {limit.toLocaleString()}
        </span>
      </div>
      <div style={{ height: 4, borderRadius: 2, background: 'var(--border-color)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 2, transition: 'width 0.3s' }} />
      </div>
      {reset && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>
          Resets: {formatReset(reset)}
        </div>
      )}
    </div>
  );
}

function CooldownBadge({ endsAt }: { endsAt: number | null }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(interval);
  }, []);

  if (!endsAt) return <span style={{ fontSize: 11, color: 'var(--status-warning, #f59e0b)' }}>Cooldown</span>;

  const minsLeft = Math.max(0, Math.ceil((endsAt - Date.now()) / 60000));
  return (
    <span style={{
      fontSize: 11,
      fontWeight: 500,
      padding: '1px 6px',
      borderRadius: 8,
      background: 'rgba(245,158,11,0.12)',
      color: 'var(--status-warning, #f59e0b)',
    }}>
      Cooldown {minsLeft}m
    </span>
  );
}

function formatReset(reset: string): string {
  try {
    const date = new Date(reset);
    if (isNaN(date.getTime())) return reset;
    return date.toLocaleTimeString();
  } catch {
    return reset;
  }
}
