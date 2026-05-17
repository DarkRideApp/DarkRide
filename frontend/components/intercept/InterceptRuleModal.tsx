import React, { useState, useEffect, useCallback } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { Modal } from '@darkrideapp/plugin-sdk/react';

interface InterceptRuleModalProps {
  rule?: any; // existing rule for edit mode, null for create
  onClose: () => void;
  onSaved: () => void;
}

type ActionType = 'json_patch' | 'set_header' | 'remove_header' | 'status_code' | 'delay' | 'replace_body' | 'rewrite_url';
type ValueType = 'string' | 'number' | 'boolean' | 'null';

interface ActionRow {
  id: string;
  type: ActionType;
  // json_patch fields
  jsonPath: string;
  value: string;
  valueType: ValueType;
  // set_header / remove_header fields
  headerName: string;
  headerValue: string;
  // status_code field
  statusCode: string;
  // delay field
  delayMs: string;
  // replace_body field
  body: string;
  // rewrite_url field
  url: string;
}

interface Device {
  id: string;
  name: string;
}

function newAction(): ActionRow {
  return {
    id: Math.random().toString(36).slice(2),
    type: 'json_patch',
    jsonPath: '',
    value: '',
    valueType: 'string',
    headerName: '',
    headerValue: '',
    statusCode: '',
    delayMs: '',
    body: '',
    url: '',
  };
}

function parseActionsFromRule(rule: any): ActionRow[] {
  if (!rule?.actions) return [];
  let parsed: any[];
  try {
    parsed = typeof rule.actions === 'string' ? JSON.parse(rule.actions) : rule.actions;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.map((a: any) => {
    const row = newAction();
    row.type = a.type as ActionType;
    if (a.type === 'json_patch') {
      row.jsonPath = a.path || '';
      const val = a.value;
      if (val === null) {
        row.value = 'null';
        row.valueType = 'null';
      } else if (typeof val === 'boolean') {
        row.value = String(val);
        row.valueType = 'boolean';
      } else if (typeof val === 'number') {
        row.value = String(val);
        row.valueType = 'number';
      } else {
        row.value = String(val ?? '');
        row.valueType = 'string';
      }
    } else if (a.type === 'set_header') {
      row.headerName = a.name || '';
      row.headerValue = a.value || '';
    } else if (a.type === 'remove_header') {
      row.headerName = a.name || '';
    } else if (a.type === 'status_code') {
      row.statusCode = String(a.code ?? '');
    } else if (a.type === 'delay') {
      row.delayMs = String(a.ms ?? '');
    } else if (a.type === 'replace_body') {
      row.body = a.body || '';
    } else if (a.type === 'rewrite_url') {
      row.url = a.url || '';
    }
    return row;
  });
}

function buildActionsJson(rows: ActionRow[]): any[] {
  return rows.map((row) => {
    if (row.type === 'json_patch') {
      let value: any;
      if (row.valueType === 'null') {
        value = null;
      } else if (row.valueType === 'boolean') {
        value = row.value === 'true';
      } else if (row.valueType === 'number') {
        value = parseFloat(row.value);
      } else {
        value = row.value;
      }
      return { type: 'json_patch', path: row.jsonPath, value };
    } else if (row.type === 'set_header') {
      return { type: 'set_header', name: row.headerName, value: row.headerValue };
    } else if (row.type === 'remove_header') {
      return { type: 'remove_header', name: row.headerName };
    } else if (row.type === 'status_code') {
      return { type: 'status_code', code: parseInt(row.statusCode, 10) };
    } else if (row.type === 'delay') {
      return { type: 'delay', ms: parseInt(row.delayMs, 10) };
    } else if (row.type === 'replace_body') {
      return { type: 'replace_body', body: row.body };
    } else if (row.type === 'rewrite_url') {
      return { type: 'rewrite_url', url: row.url };
    }
    return null;
  }).filter(Boolean);
}

export function InterceptRuleModal({ rule, onClose, onSaved }: InterceptRuleModalProps) {
  const ws = useWebSocket();
  const isEdit = Boolean(rule);

  const [name, setName] = useState(rule?.name || '');
  const [matchHostname, setMatchHostname] = useState(rule?.matchHostname || '');
  const [matchPath, setMatchPath] = useState(rule?.matchPath || '');
  const [matchMethod, setMatchMethod] = useState(rule?.matchMethod || '');
  const [matchStatusCode, setMatchStatusCode] = useState(rule?.matchStatusCode || '');
  const [matchHeader, setMatchHeader] = useState(rule?.matchHeader || '');
  const [matchBody, setMatchBody] = useState(rule?.matchBody || '');
  const [phase, setPhase] = useState<'request' | 'response'>(rule?.phase === 'request' ? 'request' : 'response');
  const [deviceId, setDeviceId] = useState(rule?.deviceId || '');
  const [priority, setPriority] = useState<number>(rule?.priority ?? 0);
  const [actions, setActions] = useState<ActionRow[]>(() => parseActionsFromRule(rule));
  const [devices, setDevices] = useState<Device[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDevices = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/device/list');
      setDevices(res.body?.data || []);
    } catch {
      // ignore
    }
  }, [ws]);

  useEffect(() => {
    if (ws.connected) {
      fetchDevices();
    }
  }, [ws.connected, fetchDevices]);

  const addAction = () => {
    setActions((prev) => [...prev, newAction()]);
  };

  const removeAction = (id: string) => {
    setActions((prev) => prev.filter((a) => a.id !== id));
  };

  const updateAction = (id: string, patch: Partial<ActionRow>) => {
    setActions((prev) =>
      prev.map((a) => (a.id === id ? { ...a, ...patch } : a))
    );
  };

  const handleSave = async () => {
    setError(null);

    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    if (!matchHostname.trim()) {
      setError('Match Hostname is required');
      return;
    }

    const body: Record<string, any> = {
      name: name.trim(),
      matchHostname: matchHostname.trim(),
      matchPath: matchPath.trim() || null,
      matchMethod: matchMethod || null,
      matchStatusCode: matchStatusCode.trim() || null,
      matchHeader: matchHeader.trim() || null,
      matchBody: matchBody.trim() || null,
      phase,
      deviceId: deviceId || null,
      priority,
      actions: buildActionsJson(actions),
    };

    setSaving(true);
    try {
      if (isEdit) {
        await ws.sendRestApi('PUT', `/v1/intercept/rules/${rule.id}`, body);
      } else {
        await ws.sendRestApi('POST', '/v1/intercept/rules', body);
      }
      onSaved();
    } catch (err: any) {
      setError(err?.message || 'Failed to save rule');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={isEdit ? 'Edit Intercept Rule' : 'Create Intercept Rule'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Rule'}
          </button>
        </>
      }
    >
      {error && (
        <div className="alert alert-danger" style={{ marginBottom: 12 }}>{error}</div>
      )}

      <div className="form-group">
        <label>Name *</label>
        <input
          className="form-input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Intercept Rule"
        />
      </div>

      <div className="form-group">
        <label>Match Hostname *</label>
        <input
          className="form-input"
          type="text"
          value={matchHostname}
          onChange={(e) => setMatchHostname(e.target.value)}
          placeholder="*.example.com"
        />
      </div>

      <div className="form-group">
        <label>Match Path</label>
        <input
          className="form-input"
          type="text"
          value={matchPath}
          onChange={(e) => setMatchPath(e.target.value)}
          placeholder="/v2/user/*"
        />
      </div>

      <div className="form-group">
        <label>Match Method</label>
        <select
          className="form-input"
          value={matchMethod}
          onChange={(e) => setMatchMethod(e.target.value)}
        >
          <option value="">Any</option>
          <option value="GET">GET</option>
          <option value="POST">POST</option>
          <option value="PUT">PUT</option>
          <option value="PATCH">PATCH</option>
          <option value="DELETE">DELETE</option>
        </select>
      </div>

      <div className="form-group">
        <label>Match Status Code</label>
        <input
          className="form-input"
          type="text"
          value={matchStatusCode}
          onChange={(e) => setMatchStatusCode(e.target.value)}
          placeholder="200, 404, etc. (response phase)"
        />
      </div>

      <div className="form-group">
        <label>Match Header</label>
        <input
          className="form-input"
          type="text"
          value={matchHeader}
          onChange={(e) => setMatchHeader(e.target.value)}
          placeholder="X-Custom: value* or Header-Name"
        />
      </div>

      <div className="form-group">
        <label>Match Body Content</label>
        <input
          className="form-input"
          type="text"
          value={matchBody}
          onChange={(e) => setMatchBody(e.target.value)}
          placeholder="substring to match in body"
        />
      </div>

      <div className="form-group">
        <label>Phase</label>
        <div style={{ display: 'flex', gap: 16 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="radio"
              name="phase"
              value="request"
              checked={phase === 'request'}
              onChange={() => setPhase('request')}
            />
            Request
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="radio"
              name="phase"
              value="response"
              checked={phase === 'response'}
              onChange={() => setPhase('response')}
            />
            Response
          </label>
        </div>
      </div>

      <div className="form-group">
        <label>Device</label>
        <select
          className="form-input"
          value={deviceId}
          onChange={(e) => setDeviceId(e.target.value)}
        >
          <option value="">All Devices</option>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name || d.id}
            </option>
          ))}
        </select>
      </div>

      <div className="form-group">
        <label>Priority</label>
        <input
          className="form-input"
          type="number"
          value={priority}
          onChange={(e) => setPriority(parseInt(e.target.value, 10) || 0)}
        />
      </div>

      <div className="form-group">
        <label>Actions</label>
        {actions.map((action) => (
          <ActionRowEditor
            key={action.id}
            action={action}
            onChange={(patch) => updateAction(action.id, patch)}
            onRemove={() => removeAction(action.id)}
          />
        ))}
        <button type="button" className="add-action-btn" onClick={addAction}>
          + Add Action
        </button>
      </div>
    </Modal>
  );
}

interface ActionRowEditorProps {
  action: ActionRow;
  onChange: (patch: Partial<ActionRow>) => void;
  onRemove: () => void;
}

function ActionRowEditor({ action, onChange, onRemove }: ActionRowEditorProps) {
  return (
    <div className="action-row">
      <div className="form-group" style={{ flex: '0 0 150px', minWidth: 0 }}>
        <label>Type</label>
        <select
          className="form-input"
          value={action.type}
          onChange={(e) => onChange({ type: e.target.value as ActionType })}
        >
          <option value="json_patch">JSON Patch</option>
          <option value="set_header">Set Header</option>
          <option value="remove_header">Remove Header</option>
          <option value="status_code">Status Code</option>
          <option value="delay">Delay</option>
          <option value="replace_body">Replace Body</option>
          <option value="rewrite_url">Rewrite URL</option>
        </select>
      </div>

      {action.type === 'json_patch' && (
        <>
          <div className="form-group">
            <label>JSONPath</label>
            <input
              className="form-input"
              type="text"
              value={action.jsonPath}
              onChange={(e) => onChange({ jsonPath: e.target.value })}
              placeholder="$.data.isAdmin"
            />
          </div>
          <div className="form-group">
            <label>Value</label>
            <input
              className="form-input"
              type="text"
              value={action.value}
              onChange={(e) => onChange({ value: e.target.value })}
              placeholder="value"
            />
          </div>
          <div className="form-group" style={{ flex: '0 0 110px', minWidth: 0 }}>
            <label>Type</label>
            <select
              className="form-input"
              value={action.valueType}
              onChange={(e) => onChange({ valueType: e.target.value as ValueType })}
            >
              <option value="string">String</option>
              <option value="number">Number</option>
              <option value="boolean">Boolean</option>
              <option value="null">Null</option>
            </select>
          </div>
        </>
      )}

      {action.type === 'set_header' && (
        <>
          <div className="form-group">
            <label>Header Name</label>
            <input
              className="form-input"
              type="text"
              value={action.headerName}
              onChange={(e) => onChange({ headerName: e.target.value })}
              placeholder="X-Custom-Header"
            />
          </div>
          <div className="form-group">
            <label>Header Value</label>
            <input
              className="form-input"
              type="text"
              value={action.headerValue}
              onChange={(e) => onChange({ headerValue: e.target.value })}
              placeholder="value"
            />
          </div>
        </>
      )}

      {action.type === 'remove_header' && (
        <div className="form-group">
          <label>Header Name</label>
          <input
            className="form-input"
            type="text"
            value={action.headerName}
            onChange={(e) => onChange({ headerName: e.target.value })}
            placeholder="X-Custom-Header"
          />
        </div>
      )}

      {action.type === 'status_code' && (
        <div className="form-group">
          <label>Status Code</label>
          <input
            className="form-input"
            type="number"
            value={action.statusCode}
            onChange={(e) => onChange({ statusCode: e.target.value })}
            placeholder="200"
          />
        </div>
      )}

      {action.type === 'delay' && (
        <div className="form-group">
          <label>Milliseconds</label>
          <input
            className="form-input"
            type="number"
            value={action.delayMs}
            onChange={(e) => onChange({ delayMs: e.target.value })}
            placeholder="1000"
          />
        </div>
      )}

      {action.type === 'replace_body' && (
        <div className="form-group" style={{ flex: 1 }}>
          <label>Body</label>
          <textarea
            className="form-input"
            value={action.body}
            onChange={(e) => onChange({ body: e.target.value })}
            placeholder='{"key": "value"}'
            rows={3}
            style={{ fontFamily: 'monospace', fontSize: 12 }}
          />
        </div>
      )}

      {action.type === 'rewrite_url' && (
        <div className="form-group" style={{ flex: 1 }}>
          <label>New URL</label>
          <input
            className="form-input"
            type="text"
            value={action.url}
            onChange={(e) => onChange({ url: e.target.value })}
            placeholder="https://example.com/new-path"
          />
        </div>
      )}

      <button
        type="button"
        className="action-row-remove"
        onClick={onRemove}
        title="Remove action"
      >
        &times;
      </button>
    </div>
  );
}
