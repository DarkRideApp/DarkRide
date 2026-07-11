import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import type { HeldFlow, InterceptArmedConfig } from '../../../shared/types/websocket';

// Interactive intercept ("breakpoints"). Separate from the rule-based Intercept
// feature under Automations > Intercept — this pauses a live flow in-flight so
// it can be inspected, edited, and forwarded/dropped by hand.

type HeaderRow = { key: string; value: string };

function headersToRows(headers: Record<string, string>): HeaderRow[] {
  return Object.entries(headers || {}).map(([key, value]) => ({ key, value: String(value ?? '') }));
}

function rowsToHeaders(rows: HeaderRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (r.key.trim() === '') continue;
    out[r.key] = r.value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Arm / disarm control + held-count badge (rendered in the Traffic subheader).
// Additive to the existing subheader actions — touches nothing else.
// ---------------------------------------------------------------------------

export function InterceptArmControl(): React.ReactElement {
  const ws = useWebSocket();
  const [armed, setArmed] = useState(false);
  const [heldCount, setHeldCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    ws.sendRestApi('GET', '/v1/intercept/armed')
      .then((res) => { if (!cancelled) setArmed(!!res.body?.data?.enabled); })
      .catch(() => {});
    ws.sendRestApi('GET', '/v1/intercept/held')
      .then((res) => { if (!cancelled) setHeldCount((res.body?.data || []).length); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [ws]);

  useEffect(() => {
    const unsubArmed = ws.subscribe('intercept-armed-changed', (msg: { config: InterceptArmedConfig }) => {
      setArmed(!!msg.config?.enabled);
    });
    const unsubHeld = ws.subscribe('intercept-held', () => setHeldCount((c) => c + 1));
    const unsubResolved = ws.subscribe('intercept-resolved', () => setHeldCount((c) => Math.max(0, c - 1)));
    return () => { unsubArmed(); unsubHeld(); unsubResolved(); };
  }, [ws]);

  const toggle = useCallback(() => {
    const next = !armed;
    setArmed(next); // optimistic; the broadcast reconciles every UI
    ws.sendRestApi('POST', '/v1/intercept/armed', { enabled: next, phases: ['request', 'response'] })
      .catch(() => setArmed(!next));
  }, [ws, armed]);

  return (
    <button
      className={`traffic-action-btn${armed ? ' intercept-arm-btn-active' : ''}`}
      data-testid="intercept-arm-toggle"
      onClick={toggle}
      title={armed
        ? 'Interactive intercept is armed — matching flows pause for a manual verdict. Click to disarm.'
        : 'Arm interactive intercept — pause live requests/responses to inspect and edit them before they continue.'}
    >
      <span className={`intercept-arm-dot${armed ? ' intercept-arm-dot-on' : ''}`} />
      {armed ? 'Intercept: On' : 'Intercept: Off'}
      {heldCount > 0 && <span className="intercept-held-badge" data-testid="intercept-held-count">{heldCount}</span>}
    </button>
  );
}

// ---------------------------------------------------------------------------
// The hold panel — a queue of paused flows with an inline editor for the
// active one. Renders nothing when no flow is held.
// ---------------------------------------------------------------------------

export function InterceptHoldPanel(): React.ReactElement | null {
  const ws = useWebSocket();
  const [queue, setQueue] = useState<HeldFlow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Editable fields for the active flow.
  const [method, setMethod] = useState('');
  const [url, setUrl] = useState('');
  const [statusCode, setStatusCode] = useState('');
  const [headers, setHeaders] = useState<HeaderRow[]>([]);
  const [body, setBody] = useState('');

  const active = queue.find((f) => f.flowId === activeId) || null;
  // Which flow the editor fields are currently primed for — so we prime exactly
  // once per flow (when it becomes active/available) and never clobber edits
  // when another flow arrives or the queue re-renders.
  const primedRef = useRef<string | null>(null);

  // Hydrate on mount — a UI that connects mid-hold still sees the queue.
  useEffect(() => {
    let cancelled = false;
    ws.sendRestApi('GET', '/v1/intercept/held')
      .then((res) => {
        if (cancelled) return;
        const held: HeldFlow[] = res.body?.data || [];
        setQueue(held);
        if (held.length > 0) setActiveId((cur) => cur ?? held[0].flowId);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [ws]);

  useEffect(() => {
    const unsubHeld = ws.subscribe('intercept-held', (msg: { flow: HeldFlow }) => {
      const flow = msg.flow;
      setQueue((prev) => (prev.some((f) => f.flowId === flow.flowId) ? prev : [...prev, flow]));
      setActiveId((cur) => cur ?? flow.flowId);
    });
    const unsubResolved = ws.subscribe('intercept-resolved', (msg: { flowId: string }) => {
      setQueue((prev) => prev.filter((f) => f.flowId !== msg.flowId));
      setActiveId((cur) => (cur === msg.flowId ? null : cur));
    });
    return () => { unsubHeld(); unsubResolved(); };
  }, [ws]);

  // Prime the editor from the flow the moment it becomes active. Done during
  // render (the supported "adjust state when input changes" pattern) rather than
  // in an effect, so the fields are populated synchronously — a late-flushing
  // effect can never clobber edits the user has already started making.
  if (active && primedRef.current !== active.flowId) {
    primedRef.current = active.flowId;
    setMethod(active.method || '');
    setUrl(active.url || '');
    setStatusCode(active.statusCode != null ? String(active.statusCode) : '');
    setHeaders(headersToRows(active.headers || {}));
    setBody(active.body ?? '');
  }

  // If the active flow was cleared but others remain, advance to the next.
  useEffect(() => {
    if (activeId === null && queue.length > 0) setActiveId(queue[0].flowId);
  }, [activeId, queue]);

  const resolve = useCallback((action: 'forward' | 'drop', modified?: Record<string, any>) => {
    if (!active) return;
    const flowId = active.flowId;
    // Optimistically drop from the queue; the intercept-resolved broadcast confirms.
    setQueue((prev) => prev.filter((f) => f.flowId !== flowId));
    setActiveId((cur) => (cur === flowId ? null : cur));
    ws.sendRestApi('POST', '/v1/intercept/resolve', { flowId, action, ...(modified ? { modified } : {}) })
      .catch(() => {});
  }, [ws, active]);

  const forward = useCallback(() => resolve('forward'), [resolve]);
  const drop = useCallback(() => resolve('drop'), [resolve]);
  const forwardModified = useCallback(() => {
    if (!active) return;
    const modified: Record<string, any> = { headers: rowsToHeaders(headers), body };
    if (active.phase === 'request') {
      modified.method = method;
      modified.url = url;
    } else {
      const code = parseInt(statusCode, 10);
      if (!Number.isNaN(code)) modified.statusCode = code;
    }
    resolve('forward', modified);
  }, [active, headers, body, method, url, statusCode, resolve]);

  const updateHeader = useCallback((i: number, field: 'key' | 'value', val: string) => {
    setHeaders((prev) => prev.map((h, idx) => (idx === i ? { ...h, [field]: val } : h)));
  }, []);
  const addHeader = useCallback(() => setHeaders((prev) => [...prev, { key: '', value: '' }]), []);
  const removeHeader = useCallback((i: number) => setHeaders((prev) => prev.filter((_, idx) => idx !== i)), []);

  if (!active) return null;

  return (
    <div className="intercept-hold-overlay" data-testid="intercept-hold-panel">
      <div className="intercept-hold-modal">
        <div className="intercept-hold-header">
          <div className="intercept-hold-title">
            <span className="intercept-hold-phase" data-testid="intercept-hold-phase">
              {active.phase === 'request' ? 'Request paused' : 'Response paused'}
            </span>
            <span className="intercept-hold-url" title={active.url}>{active.url}</span>
          </div>
          {queue.length > 1 && (
            <div className="intercept-hold-queue" data-testid="intercept-hold-queue">
              {queue.length} held
              <div className="intercept-hold-queue-tabs">
                {queue.map((f) => (
                  <button
                    key={f.flowId}
                    className={`intercept-hold-queue-tab${f.flowId === activeId ? ' active' : ''}`}
                    onClick={() => setActiveId(f.flowId)}
                    title={f.url}
                  >
                    {f.method}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="intercept-hold-body">
          {active.phase === 'request' ? (
            <div className="intercept-hold-row">
              <label className="intercept-hold-label">Method</label>
              <input
                className="form-input"
                data-testid="intercept-edit-method"
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                style={{ maxWidth: 120 }}
              />
              <label className="intercept-hold-label">URL</label>
              <input
                className="form-input"
                data-testid="intercept-edit-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                style={{ flex: 1 }}
              />
            </div>
          ) : (
            <div className="intercept-hold-row">
              <label className="intercept-hold-label">Status</label>
              <input
                className="form-input"
                data-testid="intercept-edit-status"
                value={statusCode}
                onChange={(e) => setStatusCode(e.target.value)}
                style={{ maxWidth: 120 }}
              />
              <span className="intercept-hold-url" style={{ flex: 1 }}>{active.method} {active.url}</span>
            </div>
          )}

          <div className="intercept-hold-section">
            <div className="intercept-hold-section-head">
              <h4>Headers</h4>
              <button className="btn btn-sm" onClick={addHeader}>+ Add</button>
            </div>
            {headers.length === 0 ? (
              <div className="intercept-hold-empty">No headers</div>
            ) : (
              <div className="intercept-hold-header-rows">
                {headers.map((h, i) => (
                  <div key={i} className="intercept-hold-header-row">
                    <input
                      className="form-input"
                      value={h.key}
                      onChange={(e) => updateHeader(i, 'key', e.target.value)}
                      placeholder="Header name"
                      style={{ flex: 1 }}
                    />
                    <input
                      className="form-input"
                      value={h.value}
                      onChange={(e) => updateHeader(i, 'value', e.target.value)}
                      placeholder="Value"
                      style={{ flex: 2 }}
                    />
                    <button className="btn btn-sm" onClick={() => removeHeader(i)} title="Remove header">x</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="intercept-hold-section">
            <div className="intercept-hold-section-head">
              <h4>Body</h4>
            </div>
            <textarea
              className="form-input"
              data-testid="intercept-edit-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="(empty)"
              rows={8}
              style={{ width: '100%', fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}
            />
          </div>
        </div>

        <div className="intercept-hold-actions">
          <button className="btn btn-danger" data-testid="intercept-drop" onClick={drop}>Drop</button>
          <div style={{ flex: 1 }} />
          <button className="btn" data-testid="intercept-forward" onClick={forward}>Forward</button>
          <button className="btn btn-primary" data-testid="intercept-forward-modified" onClick={forwardModified}>
            Forward Modified
          </button>
        </div>
      </div>
    </div>
  );
}
