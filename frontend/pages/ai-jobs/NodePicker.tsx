import React, { useEffect, useRef, useState } from 'react';
import { nodeKindLabel, NODE_KIND_DESCRIPTIONS } from './nodeKindLabels';
import type { NodeKind } from '../../../backend/services/ai-jobs/types';

const NODE_KINDS: NodeKind[] = ['Trigger', 'AgentCall', 'Transform', 'Branch', 'Report', 'ForEach', 'Sink'];

/** Searchable popover for adding a node, replacing a flat native <select> with results you can filter and read a description for before picking. */
export function NodePicker({ onPick }: { onPick: (kind: NodeKind) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const q = query.trim().toLowerCase();
  const filtered = q === '' ? NODE_KINDS : NODE_KINDS.filter(k =>
    nodeKindLabel(k).toLowerCase().includes(q) || NODE_KIND_DESCRIPTIONS[k].toLowerCase().includes(q));

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDocPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    }
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [open]);

  function close() {
    setOpen(false);
    setQuery('');
  }

  function pick(kind: NodeKind) {
    onPick(kind);
    close();
  }

  return (
    <div className="ai-jobs-node-picker" ref={rootRef}>
      <button type="button" className="btn btn-ghost btn-sm" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        + Add node
      </button>
      {open && (
        <div className="ai-jobs-node-picker-popover">
          <input
            ref={inputRef}
            className="form-input"
            aria-label="Search node kinds"
            placeholder="Search node kinds…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close();
              else if (e.key === 'Enter' && filtered.length > 0) pick(filtered[0]);
            }}
          />
          <div role="listbox" aria-label="Node kinds" className="ai-jobs-node-picker-list">
            {filtered.length === 0 && <div className="ai-jobs-node-picker-empty">No matching node kinds</div>}
            {filtered.map(k => (
              <button key={k} type="button" role="option" className="ai-jobs-node-picker-item" onClick={() => pick(k)}>
                <span className="ai-jobs-node-picker-item-name">{nodeKindLabel(k)}</span>
                <span className="ai-jobs-node-picker-item-desc">{NODE_KIND_DESCRIPTIONS[k]}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
