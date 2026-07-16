import React, { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';

interface Blocked { id: number; domain: string }

interface BlocklistPanelProps {
  ws: { sendRestApi: (method: string, path: string) => Promise<any> };
  onClose: () => void;
}

/**
 * BlocklistPanel — an inline popover that lists blocked hostnames and lets you
 * unblock them. Backed by the existing blocklist CRUD
 * (GET /v1/blocklist/list, DELETE /v1/blocklist/remove/:id). "Block hostname"
 * was previously one-way with no visible list; this closes that loop.
 */
export function BlocklistPanel({ ws, onClose }: BlocklistPanelProps) {
  const [items, setItems] = useState<Blocked[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    ws.sendRestApi('GET', '/v1/blocklist/list')
      .then(res => setItems(res.body?.data ?? []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [ws]);

  useEffect(() => { load(); }, [load]);

  const unblock = useCallback((id: number) => {
    ws.sendRestApi('DELETE', `/v1/blocklist/remove/${id}`).then(load).catch(() => {});
  }, [ws, load]);

  return (
    <div className="blocklist-panel" data-testid="blocklist-panel">
      <div className="blocklist-panel-head">
        <span>Blocked hostnames</span>
        <button className="traffic-detail-close" onClick={onClose} aria-label="Close blocklist">
          <X size={14} />
        </button>
      </div>
      {loading ? (
        <div className="blocklist-empty">Loading…</div>
      ) : items.length === 0 ? (
        <div className="blocklist-empty">No blocked hostnames</div>
      ) : (
        <ul className="blocklist-list">
          {items.map(b => (
            <li key={b.id}>
              <span className="blocklist-domain">{b.domain}</span>
              <button
                className="btn btn-sm"
                aria-label={`Unblock ${b.domain}`}
                onClick={() => unblock(b.id)}
              >
                Unblock
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
