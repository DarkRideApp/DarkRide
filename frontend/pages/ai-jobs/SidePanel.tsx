import React, { useEffect, useRef, useState } from 'react';
import { resolvePreview } from './templatePreview';

interface SchemaField { field: string; type: string; description: string }
interface NodeLike { id: string; config: Record<string, any> & { kind: string } }

export function SidePanel({ node, triggerSchema, onClose, onSave }: {
  node: NodeLike;
  triggerSchema: SchemaField[];
  onClose: () => void;
  onSave: (nodeId: string, patch: Record<string, unknown>) => void;
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
    <aside role="dialog" aria-label={`${node.id} details`}>
      <button ref={closeRef} type="button" aria-label="Close details" onClick={onClose}>×</button>
      {node.config.kind === 'AgentCall' ? (
        <AgentCallBody node={node} triggerSchema={triggerSchema} onSave={onSave} />
      ) : node.config.kind === 'Report' ? (
        <ReportBody node={node} />
      ) : (
        <dl>{Object.entries(node.config).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{JSON.stringify(v)}</dd></div>)}</dl>
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
    const start = ta?.selectionStart ?? template.length;
    const end = ta?.selectionEnd ?? template.length;
    const next = template.slice(0, start) + token + template.slice(end);
    setTemplate(next);
    onSave(node.id, { instructionTemplate: next });
  }

  return (
    <>
      <textarea
        ref={taRef}
        value={template}
        onChange={(e) => { setTemplate(e.target.value); onSave(node.id, { instructionTemplate: e.target.value }); }}
      />
      {triggerSchema.map(f => (
        <button key={f.field} onClick={() => insertVar(f.field)}>+ trigger.{f.field}</button>
      ))}
      <div data-testid="prompt-preview">{resolvePreview(template, sampleScope)}</div>
    </>
  );
}

function ReportBody({ node }: { node: NodeLike }) {
  const sections = node.config.sections as Array<{ title: string; from: string }>;
  return (
    <ol>
      {sections.map((s, i) => (
        <li key={s.from} data-testid="report-section-row">{i + 1}. {s.title} ← {s.from}</li>
      ))}
    </ol>
  );
}
