import React, { useEffect, useRef, useState } from 'react';
import { resolvePreview } from './templatePreview';
import type { PipelineGraph } from '../../../backend/services/ai-jobs/types';

interface SchemaField { field: string; type: string; description: string }
interface NodeLike { id: string; config: Record<string, any> & { kind: string } }

function predecessorsOf(graph: PipelineGraph, nodeId: string): string[] {
  return graph.edges.filter(e => e.to === nodeId).map(e => e.from);
}

export function SidePanel({ node, graph, triggerSchema, onClose, onSave, onDeleteNode }: {
  node: NodeLike;
  graph: PipelineGraph;
  triggerSchema: SchemaField[];
  onClose: () => void;
  onSave: (nodeId: string, patch: Record<string, unknown>) => void;
  onDeleteNode?: (nodeId: string) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Move focus into the panel on open, hand it back to whatever opened it on close.
  // Verbatim pattern from frontend/pages/plugins/PluginDrawer.tsx:105-113.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => {
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  // Escape closes the panel, unless a modal above it already took the key.
  // Verbatim pattern from frontend/pages/plugins/PluginDrawer.tsx:116-122.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside className="ai-jobs-side-panel" role="dialog" aria-label={`${node.id} details`}>
      <div className="ai-jobs-side-panel-header">
        <span className="ai-jobs-side-panel-title">{node.config.kind}: {node.id}</span>
        <div className="ai-jobs-side-panel-actions">
          {onDeleteNode && (
            <button type="button" className="btn btn-danger-ghost btn-sm" aria-label="Delete node" onClick={() => onDeleteNode(node.id)}>Delete</button>
          )}
          <button ref={closeRef} type="button" className="btn btn-ghost btn-sm" aria-label="Close details" onClick={onClose}>×</button>
        </div>
      </div>
      {node.config.kind === 'AgentCall' ? (
        <AgentCallBody node={node} triggerSchema={triggerSchema} onSave={onSave} />
      ) : node.config.kind === 'Trigger' ? (
        <TriggerBody node={node} onSave={onSave} />
      ) : node.config.kind === 'Sink' ? (
        <SinkBody node={node} graph={graph} onSave={onSave} />
      ) : node.config.kind === 'Report' ? (
        <ReportBody node={node} graph={graph} onSave={onSave} />
      ) : node.config.kind === 'Transform' ? (
        <TransformBody node={node} onSave={onSave} />
      ) : node.config.kind === 'Branch' ? (
        <BranchBody node={node} onSave={onSave} />
      ) : node.config.kind === 'ForEach' ? (
        <ForEachBody node={node} onSave={onSave} />
      ) : (
        <dl className="ai-jobs-facts">{Object.entries(node.config).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{JSON.stringify(v)}</dd></div>)}</dl>
      )}
    </aside>
  );
}

function AgentCallBody({ node, triggerSchema, onSave }: {
  node: NodeLike; triggerSchema: SchemaField[]; onSave: (nodeId: string, patch: Record<string, unknown>) => void;
}) {
  const [template, setTemplate] = useState<string>(node.config.instructionTemplate);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const sampleScope = { trigger: Object.fromEntries(triggerSchema.map(f => [f.field, `<${f.field}>`])) };

  function insertVar(field: string) {
    const ta = taRef.current;
    const token = `{{trigger.${field}}}`;
    // An unfocused <textarea>'s selectionStart/End is 0, not null/undefined — `??` alone does
    // not detect "no real cursor position." Only trust the selection when the textarea actually
    // has focus; otherwise append at the end.
    const hasFocus = ta !== null && document.activeElement === ta;
    const start = hasFocus ? ta.selectionStart ?? template.length : template.length;
    const end = hasFocus ? ta.selectionEnd ?? template.length : template.length;
    const next = template.slice(0, start) + token + template.slice(end);
    setTemplate(next);
    onSave(node.id, { instructionTemplate: next });
  }

  return (
    <>
      <textarea
        ref={taRef}
        className="form-textarea"
        value={template}
        onChange={(e) => { setTemplate(e.target.value); onSave(node.id, { instructionTemplate: e.target.value }); }}
      />
      <div className="ai-jobs-chip-row">
        {triggerSchema.map(f => (
          <button key={f.field} type="button" className="btn btn-ghost btn-sm" onClick={() => insertVar(f.field)}>+ trigger.{f.field}</button>
        ))}
      </div>
      <div className="ai-jobs-preview" data-testid="prompt-preview">{resolvePreview(template, sampleScope)}</div>
    </>
  );
}

function TriggerBody({ node, onSave }: { node: NodeLike; onSave: (nodeId: string, patch: Record<string, unknown>) => void }) {
  const expandFn: string = node.config.expandFn;
  const outputSchema: SchemaField[] = node.config.outputSchema;

  function save(nextExpandFn: string, nextSchema: SchemaField[]) {
    onSave(node.id, { expandFn: nextExpandFn, outputSchema: nextSchema });
  }

  return (
    <>
      <div className="form-group">
        <label>Expand function</label>
        <input className="form-input" value={expandFn} onChange={(e) => save(e.target.value, outputSchema)} />
        <div className="form-help">Name of a function registered in backend/services/ai-jobs/nodes/trigger.ts.</div>
      </div>
      <div className="form-group">
        <label>Output schema</label>
        {outputSchema.map((f, i) => (
          <div key={i} className="ai-jobs-list-row" data-testid="schema-field-row">
            <input className="form-input" placeholder="field" value={f.field} onChange={(e) => save(expandFn, outputSchema.map((s, j) => j === i ? { ...s, field: e.target.value } : s))} />
            <input className="form-input" placeholder="type" value={f.type} onChange={(e) => save(expandFn, outputSchema.map((s, j) => j === i ? { ...s, type: e.target.value } : s))} />
            <input className="form-input" placeholder="description" value={f.description} onChange={(e) => save(expandFn, outputSchema.map((s, j) => j === i ? { ...s, description: e.target.value } : s))} />
            <button type="button" className="btn btn-danger-ghost btn-sm" aria-label="Remove field" onClick={() => save(expandFn, outputSchema.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => save(expandFn, [...outputSchema, { field: '', type: '', description: '' }])}>+ Add field</button>
      </div>
    </>
  );
}

const KNOWN_SINK_WRITE_FNS = ['apk-analysis/write-full-document', 'apk-analysis/write-section'];

function SinkBody({ node, graph, onSave }: { node: NodeLike; graph: PipelineGraph; onSave: (nodeId: string, patch: Record<string, unknown>) => void }) {
  const writeFn: string = node.config.writeFn;
  const from: string = node.config.from ?? '';
  const section: string = node.config.section ?? '';
  const predecessors = predecessorsOf(graph, node.id);
  const isKnownFn = writeFn === '' || KNOWN_SINK_WRITE_FNS.includes(writeFn);

  return (
    <>
      <div className="form-group">
        <label htmlFor="sink-write-fn">Write function</label>
        <select id="sink-write-fn" aria-label="Write function" className="form-select" value={isKnownFn ? writeFn : '__custom__'}
          onChange={(e) => onSave(node.id, { writeFn: e.target.value === '__custom__' ? '' : e.target.value })}>
          <option value="">— choose —</option>
          {KNOWN_SINK_WRITE_FNS.map(fn => <option key={fn} value={fn}>{fn}</option>)}
          <option value="__custom__">Custom (registered in code)…</option>
        </select>
        {!isKnownFn && (
          <input className="form-input" value={writeFn} placeholder="custom writeFn name"
            onChange={(e) => onSave(node.id, { writeFn: e.target.value })} />
        )}
        <div className="form-help">Name of a function registered in backend/services/ai-jobs/nodes/sink.ts.</div>
      </div>
      <div className="form-group">
        <label htmlFor="sink-from">From (predecessor)</label>
        <select id="sink-from" aria-label="From (predecessor)" className="form-select" value={from}
          onChange={(e) => onSave(node.id, { from: e.target.value || undefined })}>
          <option value="">— none —</option>
          {predecessors.map(id => <option key={id} value={id}>{id}</option>)}
        </select>
      </div>
      <div className="form-group">
        <label>Section title</label>
        <input className="form-input" value={section} onChange={(e) => onSave(node.id, { section: e.target.value })} />
        <div className="form-help">Only read by the "write-section" write function.</div>
      </div>
    </>
  );
}

function ReportBody({ node, graph, onSave }: { node: NodeLike; graph: PipelineGraph; onSave: (nodeId: string, patch: Record<string, unknown>) => void }) {
  const sections: Array<{ title: string; from: string }> = node.config.sections;
  const predecessors = predecessorsOf(graph, node.id);

  function save(next: Array<{ title: string; from: string }>) {
    onSave(node.id, { sections: next });
  }

  return (
    <div className="ai-jobs-report-sections">
      {sections.map((s, i) => (
        <div key={i} className="ai-jobs-list-row" data-testid="report-section-row">
          <span className="ai-jobs-list-row-index">{i + 1}.</span>
          <input className="form-input" placeholder="Section title" value={s.title}
            onChange={(e) => save(sections.map((row, j) => j === i ? { ...row, title: e.target.value } : row))} />
          <select className="form-select" aria-label={`Section ${i + 1} source`} value={s.from}
            onChange={(e) => save(sections.map((row, j) => j === i ? { ...row, from: e.target.value } : row))}>
            {predecessors.map(id => <option key={id} value={id}>{id}</option>)}
          </select>
          <button type="button" className="btn btn-danger-ghost btn-sm" aria-label="Remove section" onClick={() => save(sections.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => save([...sections, { title: '', from: predecessors[0] ?? '' }])}>+ Add section</button>
    </div>
  );
}

function TransformBody({ node, onSave }: { node: NodeLike; onSave: (nodeId: string, patch: Record<string, unknown>) => void }) {
  return (
    <div className="form-group">
      <label>Transform function</label>
      <input className="form-input" value={node.config.fn} placeholder="e.g. my-plugin/my-transform"
        onChange={(e) => onSave(node.id, { fn: e.target.value })} />
      <div className="form-help">No Transform functions are registered in this codebase yet — see backend/services/ai-jobs/nodes/transform.ts. A run through this node fails with "Unknown transform" until one is registered in code.</div>
    </div>
  );
}

function BranchBody({ node, onSave }: { node: NodeLike; onSave: (nodeId: string, patch: Record<string, unknown>) => void }) {
  const edges: string[] = node.config.edges;
  return (
    <>
      <div className="form-group">
        <label>Branch predicate</label>
        <input className="form-input" value={node.config.predicate} placeholder="e.g. my-plugin/my-predicate"
          onChange={(e) => onSave(node.id, { predicate: e.target.value })} />
        <div className="form-help">No Branch predicates are registered in this codebase yet — see backend/services/ai-jobs/nodes/branch.ts.</div>
      </div>
      <div className="form-group">
        <label>Outgoing edge labels (comma-separated)</label>
        <input className="form-input" value={edges.join(', ')}
          onChange={(e) => onSave(node.id, { edges: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} />
        <div className="form-help">Must match the label on each outgoing edge drawn from this node.</div>
      </div>
    </>
  );
}

function ForEachBody({ node, onSave }: { node: NodeLike; onSave: (nodeId: string, patch: Record<string, unknown>) => void }) {
  return (
    <div className="form-group">
      <label>Per-item function</label>
      <input className="form-input" value={node.config.itemFn} placeholder="e.g. my-plugin/my-item-fn"
        onChange={(e) => onSave(node.id, { itemFn: e.target.value })} />
      <div className="form-help">No ForEach item functions are registered in this codebase yet — see backend/services/ai-jobs/nodes/foreach.ts. A run through this node fails with "Unknown itemFn" until one is registered in code.</div>
    </div>
  );
}
