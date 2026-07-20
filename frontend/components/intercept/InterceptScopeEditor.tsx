import React, { useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { InterceptArmedConfig } from '../../../shared/types/websocket';
import {
  armIntercept, disarmIntercept, describeArmed,
  type InterceptMatchRule, type InterceptPhase,
} from './interceptArm';

interface Ws { sendRestApi: (method: string, path: string, body?: unknown) => Promise<unknown> }

interface Props {
  ws: Ws;
  config: InterceptArmedConfig;
  onClose: () => void;
}

const METHODS = ['', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];

/** Normalize an editable rule to the wire shape (blank -> null). */
function toWire(r: InterceptMatchRule): InterceptMatchRule {
  return {
    hostname: (r.hostname ?? '').trim() || null,
    path: (r.path ?? '').trim() || null,
    method: (r.method ?? '').trim() || null,
  };
}
function hasAnyField(r: InterceptMatchRule): boolean {
  return !!(r.hostname?.trim() || r.path?.trim() || r.method?.trim());
}

/**
 * InterceptScopeEditor — define WHICH flows interactive intercept pauses: a list
 * of match rules (host glob / path glob / method), matched with OR. Arms the
 * config; the armed-changed broadcast reconciles every other UI.
 */
export function InterceptScopeEditor({ ws, config, onClose }: Props) {
  const [rules, setRules] = useState<InterceptMatchRule[]>(
    config.rules && config.rules.length ? config.rules.map(r => ({ ...r })) : [{}],
  );
  const [phases, setPhases] = useState<InterceptPhase[]>(
    config.phases?.length ? [...config.phases] : ['request', 'response'],
  );

  const updateRule = (i: number, patch: Partial<InterceptMatchRule>) =>
    setRules(prev => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRule = () => setRules(prev => [...prev, {}]);
  const removeRule = (i: number) => setRules(prev => (prev.length <= 1 ? [{}] : prev.filter((_, idx) => idx !== i)));
  const togglePhase = (p: InterceptPhase) =>
    setPhases(prev => (prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p]));

  const effectiveRules = useMemo(() => rules.filter(hasAnyField).map(toWire), [rules]);
  const summary = describeArmed({ enabled: true, rules: effectiveRules, phases });

  const arm = () => {
    armIntercept(ws, { rules: effectiveRules, phases: phases.length ? phases : ['request', 'response'] }).catch(() => {});
    onClose();
  };
  const disarm = () => { disarmIntercept(ws).catch(() => {}); onClose(); };

  return (
    <div className="intercept-scope-editor" data-testid="intercept-scope-editor">
      <div className="intercept-scope-head">
        <span className="intercept-scope-title">Intercept rules</span>
        <button className="traffic-detail-close" aria-label="Close" onClick={onClose}><X size={14} /></button>
      </div>

      <div className="intercept-rule-list">
        {rules.map((r, i) => (
          <div className="intercept-rule-row" data-testid={`intercept-rule-row-${i}`} key={i}>
            <select
              className="form-input intercept-rule-method"
              data-testid={`intercept-rule-method-${i}`}
              value={r.method ?? ''}
              onChange={e => updateRule(i, { method: e.target.value })}
            >
              {METHODS.map(m => <option key={m} value={m}>{m || 'Any'}</option>)}
            </select>
            <input
              className="form-input intercept-rule-host"
              data-testid={`intercept-rule-host-${i}`}
              placeholder="host glob e.g. *.stripe.com"
              value={r.hostname ?? ''}
              onChange={e => updateRule(i, { hostname: e.target.value })}
            />
            <input
              className="form-input intercept-rule-path"
              data-testid={`intercept-rule-path-${i}`}
              placeholder="path glob e.g. /v1/*"
              value={r.path ?? ''}
              onChange={e => updateRule(i, { path: e.target.value })}
            />
            <button className="intercept-rule-remove" aria-label={`Remove rule ${i + 1}`} onClick={() => removeRule(i)}>
              <X size={13} />
            </button>
          </div>
        ))}
        <button className="intercept-add-rule" data-testid="intercept-add-rule" onClick={addRule}>
          <Plus size={13} /> Add rule
        </button>
      </div>

      <div className="intercept-phase-row">
        <span className="intercept-phase-label">Pause on:</span>
        {(['request', 'response'] as InterceptPhase[]).map(p => (
          <label key={p} className="intercept-phase-toggle">
            <input type="checkbox" checked={phases.includes(p)} onChange={() => togglePhase(p)} data-testid={`intercept-phase-${p}`} />
            {p === 'request' ? 'Request' : 'Response'}
          </label>
        ))}
      </div>

      <div className="intercept-scope-summary" data-testid="intercept-scope-summary">{summary}</div>

      <div className="intercept-scope-actions">
        {config.enabled && (
          <button className="btn btn-sm" data-testid="intercept-disarm" onClick={disarm}>Disarm</button>
        )}
        <button
          className="btn btn-sm btn-primary"
          data-testid="intercept-arm-apply"
          disabled={phases.length === 0}
          onClick={arm}
        >
          {config.enabled ? 'Update' : 'Arm'}
        </button>
      </div>
    </div>
  );
}
