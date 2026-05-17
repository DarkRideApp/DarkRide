import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { SkeletonTable } from '@darkrideapp/plugin-sdk/react';
import { DataTable } from '@darkrideapp/plugin-sdk/react';
import type { Column } from '@darkrideapp/plugin-sdk/react';
import { ConfirmDialog } from '@darkrideapp/plugin-sdk/react';
import { InterceptRuleModal } from './InterceptRuleModal';

interface InterceptRule {
  id: number;
  name: string;
  matchHostname: string;
  matchPath: string | null;
  matchMethod: string | null;
  matchStatusCode: string | null;
  matchHeader: string | null;
  matchBody: string | null;
  phase: string;
  priority: number;
  enabled: number;
  actions: string;
  deviceId: string | null;
}

export function InterceptRulesTab() {
  const ws = useWebSocket();
  const [rules, setRules] = useState<InterceptRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<InterceptRule | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<InterceptRule | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchRules = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/intercept/rules');
      setRules(res.body?.data || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [ws]);

  useEffect(() => {
    if (ws.connected) {
      fetchRules();
    }
  }, [ws.connected, fetchRules]);

  useEffect(() => {
    return ws.subscribe('intercept-rules-changed', () => {
      fetchRules();
    });
  }, [ws, fetchRules]);

  const handleToggle = useCallback(async (rule: InterceptRule) => {
    try {
      await ws.sendRestApi('PATCH', `/v1/intercept/rules/${rule.id}/toggle`);
      fetchRules();
    } catch {
      // ignore
    }
  }, [ws, fetchRules]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await ws.sendRestApi('DELETE', `/v1/intercept/rules/${deleteTarget.id}`);
      fetchRules();
    } catch {
      // ignore
    } finally {
      setDeleteTarget(null);
    }
  }, [ws, fetchRules, deleteTarget]);

  const handleExport = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/intercept/rules/export');
      const data = res.body?.data;
      if (!data) return;
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'intercept-rules.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }, [ws]);

  const handleImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const importRules = data.rules || data;
      if (!Array.isArray(importRules)) return;
      await ws.sendRestApi('POST', '/v1/intercept/rules/import', { rules: importRules });
      fetchRules();
    } catch {
      // ignore
    }
    // Reset file input
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [ws, fetchRules]);

  const columns: Column<InterceptRule>[] = [
    {
      key: 'name',
      header: 'Name',
      sortable: true,
      render: (rule) => <strong>{rule.name}</strong>,
    },
    {
      key: 'matchHostname',
      header: 'Hostname',
      sortable: true,
    },
    {
      key: 'matchPath',
      header: 'Path',
      render: (rule) => rule.matchPath || '-',
    },
    {
      key: 'phase',
      header: 'Phase',
      render: (rule) => (
        <span className={`badge ${rule.phase === 'request' ? 'badge-running' : 'badge-warning'}`}>
          {rule.phase === 'request' ? 'Request' : 'Response'}
        </span>
      ),
    },
    {
      key: 'priority',
      header: 'Priority',
      sortable: true,
    },
    {
      key: 'enabled',
      header: 'Enabled',
      render: (rule) => (
        <label className="toggle-switch" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={Boolean(rule.enabled)}
            onChange={() => handleToggle(rule)}
          />
          <span className="toggle-slider" />
        </label>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (rule) => (
        <div style={{ display: 'flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
          <button
            className="btn btn-sm"
            onClick={() => {
              setEditingRule(rule);
              setModalOpen(true);
            }}
          >
            Edit
          </button>
          <button
            className="btn btn-sm btn-danger"
            onClick={() => setDeleteTarget(rule)}
          >
            Delete
          </button>
        </div>
      ),
    },
  ];

  if (loading) {
    return <div className="table-card"><SkeletonTable rows={5} columns={6} /></div>;
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 12 }}>
        <button className="btn" onClick={handleExport}>
          Export Rules
        </button>
        <button className="btn" onClick={() => fileInputRef.current?.click()}>
          Import Rules
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          style={{ display: 'none' }}
          onChange={handleImport}
        />
        <button
          className="btn btn-primary"
          onClick={() => {
            setEditingRule(null);
            setModalOpen(true);
          }}
        >
          Add Rule
        </button>
      </div>

      <div className="table-card">
        <DataTable
          columns={columns}
          data={rules}
          keyField="id"
          tableId="intercept-rules"
          emptyMessage="No intercept rules created"
          testId="intercept-rules-table"
        />
      </div>

      {modalOpen && (
        <InterceptRuleModal
          rule={editingRule}
          onClose={() => {
            setModalOpen(false);
            setEditingRule(null);
          }}
          onSaved={() => {
            setModalOpen(false);
            setEditingRule(null);
            fetchRules();
          }}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete Rule"
          message={`Are you sure you want to delete the rule "${deleteTarget.name}"?`}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
