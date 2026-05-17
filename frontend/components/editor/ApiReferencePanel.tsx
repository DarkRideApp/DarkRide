import React, { useState, useMemo } from 'react';
import { API_REFERENCE, CATEGORY_LABELS, CATEGORY_ORDER } from '../../../shared/api-reference';
import type { ApiEntry } from '../../../shared/api-reference';

interface ApiReferencePanelProps {
  onInsertSnippet?: (code: string) => void;
}

function EntryCard({ entry, onInsert }: { entry: ApiEntry; onInsert?: (code: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const fullName = `${entry.object}.${entry.name}`;

  return (
    <div
      className="api-entry"
      style={{
        padding: '6px 8px',
        borderBottom: '1px solid var(--border-color)',
        cursor: 'pointer',
      }}
      onClick={() => setExpanded(!expanded)}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <code style={{ fontSize: 12, fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
          {fullName}
        </code>
        <span style={{ fontSize: 10, opacity: 0.5 }}>{expanded ? '\u25B2' : '\u25BC'}</span>
      </div>
      <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>{entry.description}</div>
      {expanded && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 2 }}>Signature</div>
          <pre style={{
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            background: 'var(--bg-secondary)',
            padding: '4px 6px',
            borderRadius: 4,
            overflowX: 'auto',
            whiteSpace: 'pre-wrap',
            margin: 0,
          }}>
            {entry.signature}
          </pre>
          <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 2, marginTop: 8 }}>Example</div>
          <pre style={{
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            background: 'var(--bg-secondary)',
            padding: '4px 6px',
            borderRadius: 4,
            overflowX: 'auto',
            whiteSpace: 'pre-wrap',
            margin: 0,
          }}>
            {entry.example}
          </pre>
          {onInsert && (
            <button
              className="btn"
              style={{ fontSize: 11, padding: '2px 8px', marginTop: 6 }}
              onClick={(e) => {
                e.stopPropagation();
                onInsert(entry.example);
              }}
            >
              Insert
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ApiReferencePanel({ onInsertSnippet }: ApiReferencePanelProps) {
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    if (!search.trim()) return API_REFERENCE;
    const q = search.toLowerCase();
    return API_REFERENCE.filter(e =>
      e.name.toLowerCase().includes(q) ||
      e.object.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.category.toLowerCase().includes(q) ||
      (CATEGORY_LABELS[e.category] || '').toLowerCase().includes(q)
    );
  }, [search]);

  const grouped = useMemo(() => {
    const groups: Record<string, ApiEntry[]> = {};
    for (const entry of filtered) {
      if (!groups[entry.category]) groups[entry.category] = [];
      groups[entry.category].push(entry);
    }
    return groups;
  }, [filtered]);

  return (
    <div data-testid="api-reference-panel" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <input
        className="form-input"
        placeholder="Search API..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{ marginBottom: 8, fontSize: 12 }}
        data-testid="api-search"
      />
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {CATEGORY_ORDER.filter(cat => grouped[cat]).map(cat => (
          <div key={cat}>
            <div style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              padding: '8px 8px 4px',
              opacity: 0.5,
            }}>
              {CATEGORY_LABELS[cat]}
            </div>
            {grouped[cat].map(entry => (
              <EntryCard
                key={`${entry.object}.${entry.name}`}
                entry={entry}
                onInsert={onInsertSnippet}
              />
            ))}
          </div>
        ))}
        {filtered.length === 0 && (
          <div style={{ padding: 16, textAlign: 'center', opacity: 0.5, fontSize: 13 }}>
            No matching API functions
          </div>
        )}
      </div>
    </div>
  );
}
