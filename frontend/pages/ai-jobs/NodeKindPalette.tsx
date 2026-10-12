import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { nodeKindLabel, NODE_KIND_DESCRIPTIONS } from './nodeKindLabels';
import { clampToViewport } from './viewportClamp';
import type { NodeKind } from '../../../backend/services/ai-jobs/types';

const NODE_KINDS: NodeKind[] = ['Trigger', 'AgentCall', 'Transform', 'Branch', 'Report', 'ForEach', 'Sink'];

/**
 * Searchable, filterable node-kind list — cursor-positioned, always open while mounted. The
 * Blueprint-style editor's one entry point for adding a node: right-click on empty canvas, or
 * drag a connection out to empty space and release, both open this at the event's position.
 * Replaces the old toolbar "+ Add node" button, which this component's list/filter/keyboard
 * logic is carried over from unchanged.
 */
export function NodeKindPalette({ position, onPick, onClose }: {
  position: { x: number; y: number };
  onPick: (kind: NodeKind) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [renderPosition, setRenderPosition] = useState(position);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const q = query.trim().toLowerCase();
  const filtered = q === '' ? NODE_KINDS : NODE_KINDS.filter(k =>
    nodeKindLabel(k).toLowerCase().includes(q) || NODE_KIND_DESCRIPTIONS[k].toLowerCase().includes(q));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Runs after the real popover has its real size — a right-click (or a drag-release) near the
  // window's right/bottom edge must not render a menu whose lower options are off-screen.
  useLayoutEffect(() => {
    if (!rootRef.current) return;
    const rect = rootRef.current.getBoundingClientRect();
    setRenderPosition(clampToViewport(position, { width: rect.width, height: rect.height }, { width: window.innerWidth, height: window.innerHeight }));
    // Only re-clamp when the requested drop point changes — not on every list-filter re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position.x, position.y]);

  useEffect(() => {
    function onDocPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [onClose]);

  return (
    <div className="ai-jobs-node-picker-popover" ref={rootRef} style={{ position: 'fixed', left: renderPosition.x, top: renderPosition.y, zIndex: 50 }}>
      <input
        ref={inputRef}
        className="form-input"
        aria-label="Search node kinds"
        placeholder="Search node kinds…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          else if (e.key === 'Enter' && filtered.length > 0) onPick(filtered[0]);
        }}
      />
      <div role="listbox" aria-label="Node kinds" className="ai-jobs-node-picker-list">
        {filtered.length === 0 && <div className="ai-jobs-node-picker-empty">No matching node kinds</div>}
        {filtered.map(k => (
          <button key={k} type="button" role="option" className="ai-jobs-node-picker-item" onClick={() => onPick(k)}>
            <span className="ai-jobs-node-picker-item-name">{nodeKindLabel(k)}</span>
            <span className="ai-jobs-node-picker-item-desc">{NODE_KIND_DESCRIPTIONS[k]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
