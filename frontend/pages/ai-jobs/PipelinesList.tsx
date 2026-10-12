import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWebSocket, PageHeader, useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import type { PipelineGraph } from '../../../backend/services/ai-jobs/types';

interface PipelineRow { id: number; name: string; graph: PipelineGraph | null }

export function PipelinesList() {
  useDocumentTitle('Pipelines');
  const { sendRestApi } = useWebSocket();
  const navigate = useNavigate();
  const [pipelines, setPipelines] = useState<PipelineRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    sendRestApi('GET', '/v1/ai-pipelines').then((res: any) => {
      if (cancelled) return;
      setPipelines(res.body?.data ?? []);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [sendRestApi]);

  const filtered = pipelines.filter(p => p.name.toLowerCase().includes(search.toLowerCase()));

  async function handleCreate() {
    const name = newName.trim();
    if (!name) {
      setError('Give the new pipeline a name first.');
      return;
    }
    const res: any = await sendRestApi('POST', '/v1/ai-pipelines', { name, graph: { nodes: [], edges: [] } });
    const id = res.body?.data?.id;
    if (id == null) {
      setError(res.body?.error ?? 'Could not create the pipeline.');
      return;
    }
    navigate(`/ui/pipelines/${id}`);
  }

  return (
    <div data-testid="pipelines-page">
      <PageHeader
        title="Pipelines"
        actions={!showNewForm && <button className="btn btn-primary" onClick={() => setShowNewForm(true)}>+ New Pipeline</button>}
      />

      {showNewForm && (
        <div className="filter-bar">
          <div className="form-group">
            <label>Name</label>
            <input className="form-input" aria-label="New pipeline name" value={newName} onChange={(e) => setNewName(e.target.value)} />
          </div>
          <button type="button" className="btn btn-primary" onClick={handleCreate}>Create</button>
          <button type="button" className="btn btn-ghost" onClick={() => { setShowNewForm(false); setError(null); }}>Cancel</button>
        </div>
      )}
      {error && <div className="form-error" role="alert">{error}</div>}

      <div className="filter-bar">
        <div className="form-group">
          <label>Search</label>
          <input className="form-input" type="text" placeholder="Filter by name..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {loading ? (
        <p>Loading…</p>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">🧩</div>
          <div>{pipelines.length === 0 ? 'No pipelines yet — create one above.' : 'No pipelines match your search.'}</div>
        </div>
      ) : (
        <div className="table-card"><table className="data-table" data-testid="pipelines-table">
          <thead>
            <tr>
              <th>Name</th>
              <th className="hide-mobile">Nodes</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(p => (
              <tr key={p.id} className="clickable-row" onClick={() => navigate(`/ui/pipelines/${p.id}`)}>
                <td><strong>{p.name}</strong></td>
                <td className="hide-mobile">{p.graph?.nodes.length ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </div>
  );
}
