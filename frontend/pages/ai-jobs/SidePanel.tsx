import React, { useEffect, useRef, useState } from 'react';
import { resolvePreview } from './templatePreview';
import { nodeKindLabel } from './nodeKindLabels';
import { runStatusMessage, displayRunStatus } from './runStatus';
import { KnownOptionPicker } from './KnownOptionPicker';
import type { PipelineGraph } from '../../../backend/services/ai-jobs/types';

interface SchemaField { field: string; type: string; description: string }
interface NodeLike { id: string; label?: string; config: Record<string, any> & { kind: string } }
interface RecentVersion { id: number; appName: string | null; packageName: string; versionName: string | null }

function nodeDisplayName(graph: PipelineGraph, nodeId: string): string {
  const n = graph.nodes.find(x => x.id === nodeId);
  return n?.label ?? nodeId;
}

/** Read-only confirmation of what a pin is wired from — wiring itself happens by dragging on the canvas, not here. */
function WiredFrom({ graph, from }: { graph: PipelineGraph; from?: string }) {
  return (
    <div className="form-help ai-jobs-wired-from">
      {from ? <>Wired from <strong>{nodeDisplayName(graph, from)}</strong></> : 'Not wired yet — drag a connection onto this pin on the canvas.'}
    </div>
  );
}

/**
 * Surfaces why the most recent run left this node in the state its canvas outline already shows
 * (Canvas.tsx's STATUS_COLOR) — without this, the color was the only signal, and a failed node's
 * real error text (already returned by GET /v1/ai-pipelines/runs/:runId) never reached the user.
 */
function LastRunStatus({ runStatus }: { runStatus?: { status: string; wasMemoized?: boolean; error?: string } }) {
  if (!runStatus) return null;
  const status = displayRunStatus(runStatus);
  return (
    <div className={`ai-jobs-run-status ai-jobs-run-status-${status}`} data-testid="node-run-status">
      <strong>Last run:</strong> {runStatusMessage(status, runStatus.error)}
    </div>
  );
}

export function SidePanel({ node, graph, triggerSchema, onClose, onSave, onDeleteNode, onRename, recentVersions, onRun, runStatus, hookCatalog }: {
  node: NodeLike;
  graph: PipelineGraph;
  triggerSchema: SchemaField[];
  onClose: () => void;
  onSave: (nodeId: string, patch: Record<string, unknown>) => void;
  onDeleteNode?: (nodeId: string) => void;
  onRename?: (nodeId: string, label: string) => void;
  recentVersions?: RecentVersion[];
  onRun?: (input: Record<string, unknown>, reuseUnchanged: boolean) => Promise<unknown>;
  runStatus?: { status: string; wasMemoized?: boolean; error?: string };
  hookCatalog?: Array<{ name: string; schema: SchemaField[]; description: string }>;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [name, setName] = useState(node.label ?? nodeKindLabel(node.config.kind));

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
        <div className="ai-jobs-side-panel-title">
          <input
            className="form-input ai-jobs-node-name-input"
            aria-label="Node name"
            value={name}
            onChange={(e) => { setName(e.target.value); onRename?.(node.id, e.target.value); }}
          />
          <span className="ai-jobs-side-panel-kind">{nodeKindLabel(node.config.kind)} · {node.id}</span>
        </div>
        <div className="ai-jobs-side-panel-actions">
          {onDeleteNode && (
            <button type="button" className="btn btn-danger-ghost btn-sm" aria-label="Delete node" onClick={() => onDeleteNode(node.id)}>Delete</button>
          )}
          <button ref={closeRef} type="button" className="btn btn-ghost btn-sm" aria-label="Close details" onClick={onClose}>×</button>
        </div>
      </div>
      <LastRunStatus runStatus={runStatus} />
      {node.config.kind === 'AgentCall' ? (
        <AgentCallBody node={node} triggerSchema={triggerSchema} onSave={onSave} />
      ) : node.config.kind === 'Trigger' ? (
        <TriggerBody node={node} onSave={onSave} recentVersions={recentVersions ?? []} onRun={onRun} hookCatalog={hookCatalog ?? []} />
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
        aria-label="Instruction template"
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

interface TypeOption { value: string; label: string }

const CUSTOM_TYPE = '__custom_type__';
/** Purely descriptive — nothing reads this to decide behavior, so a plain closed set is enough. */
const OUTPUT_FIELD_TYPES: TypeOption[] = [
  { value: 'string', label: 'string' },
  { value: 'number', label: 'number' },
  { value: 'boolean', label: 'boolean' },
];
/** Drives which control the Run form renders (SchemaFieldInput below) — 'apk-version' is the one
 *  example of a "rich" type today; a job kind can register more without the frontend knowing
 *  about them ahead of time (Custom still renders as plain text, same as any unrecognized type). */
const RUN_PARAM_TYPES: TypeOption[] = [
  { value: 'string', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Yes/No' },
  { value: 'apk-version', label: 'APK version (picker)' },
];

// Duplicated from backend/services/ai-jobs/nodes/trigger.ts's TRIGGER_DESCRIPTIONS/TRIGGER_SCHEMAS
// — the frontend can't import that module at runtime (it pulls in better-sqlite3). inputSchema/
// outputSchema here are the function's REAL contract, not a suggestion: picking this function
// fills a node's Run Parameters/Output Schema from these, so the editor can never again show a
// Trigger with no indication of what it actually requires.
const KNOWN_TRIGGER_EXPAND_FNS: Array<{ value: string; description: string; inputSchema: SchemaField[]; outputSchema: SchemaField[] }> = [
  {
    value: 'apk-analysis/apk-context',
    description: 'Looks up a tracked APK version by id and expands it into app name, package, version, size, and source fields.',
    inputSchema: [
      { field: 'versionId', type: 'apk-version', description: 'Which analyzed APK version to run against' },
    ],
    outputSchema: [
      { field: 'appName', type: 'string', description: 'Display name' },
      { field: 'packageName', type: 'string', description: 'Reverse-DNS package name' },
      { field: 'versionName', type: 'string', description: 'Human version string' },
      { field: 'versionCode', type: 'number', description: 'Numeric version code' },
      { field: 'fileSizeBytes', type: 'number', description: 'APK file size in bytes' },
      { field: 'downloadedAt', type: 'string', description: 'ISO timestamp' },
      { field: 'source', type: 'string', description: "'device' | 'playstore' | 'qq' | 'upload'" },
    ],
  },
];

function SchemaFieldListEditor({ label, fieldNoun, help, fields, typeOptions, onChange, testId }: {
  label: string; fieldNoun: string; help: string; fields: SchemaField[]; typeOptions: TypeOption[];
  onChange: (next: SchemaField[]) => void; testId: string;
}) {
  return (
    <div className="form-group">
      <label>{label}</label>
      {fields.map((f, i) => {
        const isKnownType = typeOptions.some(t => t.value === f.type);
        return (
          <div key={i} className="ai-jobs-list-row" data-testid={testId}>
            <input className="form-input" placeholder="name" value={f.field} onChange={(e) => onChange(fields.map((s, j) => j === i ? { ...s, field: e.target.value } : s))} />
            <select className="form-select" aria-label={`${fieldNoun} type`} value={isKnownType ? f.type : CUSTOM_TYPE}
              onChange={(e) => onChange(fields.map((s, j) => j === i ? { ...s, type: e.target.value === CUSTOM_TYPE ? '' : e.target.value } : s))}>
              {typeOptions.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              <option value={CUSTOM_TYPE}>Custom…</option>
            </select>
            {!isKnownType && (
              <input className="form-input" placeholder="custom type" value={f.type}
                onChange={(e) => onChange(fields.map((s, j) => j === i ? { ...s, type: e.target.value } : s))} />
            )}
            <input className="form-input" placeholder="description" value={f.description} onChange={(e) => onChange(fields.map((s, j) => j === i ? { ...s, description: e.target.value } : s))} />
            <button type="button" className="btn btn-danger-ghost btn-sm" aria-label={`Remove ${fieldNoun}`} onClick={() => onChange(fields.filter((_, j) => j !== i))}>×</button>
          </div>
        );
      })}
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange([...fields, { field: '', type: typeOptions[0].value, description: '' }])}>+ Add {fieldNoun}</button>
      <div className="form-help">{help}</div>
    </div>
  );
}

function TriggerBody({ node, onSave, recentVersions, onRun, hookCatalog }: {
  node: NodeLike; onSave: (nodeId: string, patch: Record<string, unknown>) => void;
  recentVersions: RecentVersion[]; onRun?: (input: Record<string, unknown>, reuseUnchanged: boolean) => Promise<unknown>;
  hookCatalog: Array<{ name: string; schema: SchemaField[]; description: string }>;
}) {
  const source: 'function' | 'event' = node.config.source ?? 'function';
  const expandFn: string = node.config.expandFn ?? '';
  const eventName: string = node.config.eventName ?? '';
  const inputSchema: SchemaField[] = node.config.inputSchema ?? [];
  const outputSchema: SchemaField[] = node.config.outputSchema;

  const functionOptions = KNOWN_TRIGGER_EXPAND_FNS.map(f => ({ value: f.value, description: f.description }));
  const eventOptions = hookCatalog.map(h => ({ value: h.name, description: h.description }));
  // One combined <select> covering both groups — KnownOptionPicker doesn't natively support
  // <optgroup>, so this renders its own two-section select directly rather than stretching the
  // shared component's contract for one caller's grouping need.
  const pickedValue = source === 'event' ? eventName : expandFn;
  const known = functionOptions.find(f => f.value === pickedValue) ?? eventOptions.find(e => e.value === pickedValue);
  const [forceCustom, setForceCustom] = useState(false);
  const isKnown = !forceCustom && (pickedValue === '' || known !== undefined);

  function pickFunction(value: string) {
    setForceCustom(false);
    if (value === '') { onSave(node.id, { source: 'function', expandFn: '', eventName: undefined }); return; }
    const fn = KNOWN_TRIGGER_EXPAND_FNS.find(f => f.value === value)!;
    onSave(node.id, { source: 'function', expandFn: fn.value, eventName: undefined, inputSchema: fn.inputSchema, outputSchema: fn.outputSchema });
  }

  function pickEvent(value: string) {
    setForceCustom(false);
    const hook = hookCatalog.find(h => h.name === value)!;
    onSave(node.id, { source: 'event', eventName: hook.name, expandFn: undefined, inputSchema: undefined, outputSchema: hook.schema });
  }

  return (
    <>
      <div className="form-group">
        <label htmlFor="trigger-expand-fn">Starts from</label>
        <select id="trigger-expand-fn" className="form-select" value={isKnown ? pickedValue : '__custom__'}
          onChange={(e) => {
            const v = e.target.value;
            if (v === '__custom__') { setForceCustom(true); onSave(node.id, { source: 'function', expandFn: '', eventName: undefined }); return; }
            if (functionOptions.some(f => f.value === v)) { pickFunction(v); return; }
            pickEvent(v);
          }}>
          <option value="">— choose —</option>
          <optgroup label="Starts manually from:">
            {functionOptions.map(f => <option key={f.value} value={f.value}>{f.value}</option>)}
          </optgroup>
          <optgroup label="Fires automatically on:">
            {eventOptions.map(e => <option key={e.value} value={e.value}>{e.value}</option>)}
          </optgroup>
          <option value="__custom__">Custom (registered in code)…</option>
        </select>
        {!isKnown && (
          <input className="form-input" value={expandFn} placeholder="custom expand function name"
            onChange={(e) => onSave(node.id, { source: 'function', expandFn: e.target.value, eventName: undefined })} />
        )}
        <div className="form-help">
          {known ? known.description : 'A registered function (see nodes/trigger.ts) or a typed event this Trigger fires on.'}
        </div>
      </div>
      <SchemaFieldListEditor
        label="Run parameters" fieldNoun="parameter" testId="trigger-input-field-row" typeOptions={RUN_PARAM_TYPES}
        help="A Trigger has no incoming wire on the canvas — these are the values the Run form below asks for each time someone runs it, not data from another node."
        fields={inputSchema} onChange={(next) => onSave(node.id, { inputSchema: next })}
      />
      <SchemaFieldListEditor
        label="Output schema" fieldNoun="output field" testId="schema-field-row" typeOptions={OUTPUT_FIELD_TYPES}
        help="What this Trigger hands downstream nodes, as {{trigger.field}}."
        fields={outputSchema} onChange={(next) => onSave(node.id, { outputSchema: next })}
      />
      {source === 'event' ? (
        <div className="form-group ai-jobs-run-section">
          <label>Run</label>
          <div className="form-help">Fires automatically when "{eventName}" happens — no manual Run needed.</div>
        </div>
      ) : (
        onRun && <TriggerRunSection inputSchema={inputSchema} recentVersions={recentVersions} onRun={onRun} />
      )}
    </>
  );
}

function SchemaFieldInput({ field, value, onChange, recentVersions }: {
  field: SchemaField; value: unknown; onChange: (next: unknown) => void; recentVersions: RecentVersion[];
}) {
  if (field.type === 'apk-version') {
    return (
      <select className="form-select" aria-label={field.field} value={value == null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}>
        <option value="">{recentVersions.length === 0 ? 'No analyzed APK versions yet' : '— choose —'}</option>
        {recentVersions.map(v => (
          <option key={v.id} value={v.id}>{v.appName ?? v.packageName} v{v.versionName ?? '?'} (#{v.id})</option>
        ))}
      </select>
    );
  }
  if (field.type === 'boolean') {
    return <input type="checkbox" aria-label={field.field} checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />;
  }
  if (field.type === 'number') {
    return <input type="number" className="form-input" aria-label={field.field} value={value == null ? '' : String(value)}
      onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />;
  }
  return <input type="text" className="form-input" aria-label={field.field} value={value == null ? '' : String(value)}
    onChange={(e) => onChange(e.target.value)} />;
}

/** Run form for one Trigger, built from its own declared inputSchema — no job-kind-specific UI here. */
function TriggerRunSection({ inputSchema, recentVersions, onRun }: {
  inputSchema: SchemaField[]; recentVersions: RecentVersion[]; onRun: (input: Record<string, unknown>, reuseUnchanged: boolean) => Promise<unknown>;
}) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [reuseUnchanged, setReuseUnchanged] = useState(false);
  const [running, setRunning] = useState(false);

  function setField(field: string, value: unknown) {
    setValues(v => ({ ...v, [field]: value }));
  }

  async function handleRun() {
    setRunning(true);
    try {
      await onRun(values, reuseUnchanged);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="form-group ai-jobs-run-section">
      <label>Run</label>
      {inputSchema.length === 0 ? (
        <div className="form-help">This Trigger declares no input fields — Run will start it with an empty input.</div>
      ) : (
        inputSchema.map(f => (
          <div key={f.field} className="form-group">
            <label htmlFor={`run-input-${f.field}`}>{f.field}</label>
            <SchemaFieldInput field={f} value={values[f.field]} onChange={(v) => setField(f.field, v)} recentVersions={recentVersions} />
            {f.description && <div className="form-help">{f.description}</div>}
          </div>
        ))
      )}
      <label className="form-checkbox-label">
        <input type="checkbox" aria-label="Reuse unchanged nodes" checked={reuseUnchanged} onChange={(e) => setReuseUnchanged(e.target.checked)} />
        Reuse unchanged nodes
      </label>
      <button type="button" className="btn btn-primary btn-sm" onClick={handleRun} disabled={running}>{running ? 'Running…' : 'Run'}</button>
    </div>
  );
}

// Duplicated from backend/services/ai-jobs/nodes/sink.ts's SINK_DESCRIPTIONS/SINK_USES_SECTION —
// the frontend can't import that module at runtime (it pulls in better-sqlite3).
const KNOWN_SINK_WRITE_FNS: Array<{ value: string; description: string; usesSection: boolean }> = [
  { value: 'apk-analysis/write-full-document', usesSection: false,
    description: "Writes every section from the connected Report into this APK version's analysis notes." },
  { value: 'apk-analysis/write-section', usesSection: true,
    description: "Writes the connected step's output into one named section of this APK version's analysis notes." },
];

function SinkBody({ node, graph, onSave }: { node: NodeLike; graph: PipelineGraph; onSave: (nodeId: string, patch: Record<string, unknown>) => void }) {
  const writeFn: string = node.config.writeFn;
  const from: string | undefined = node.config.from;
  const section: string = node.config.section ?? '';
  const known = KNOWN_SINK_WRITE_FNS.find(f => f.value === writeFn);

  return (
    <>
      <KnownOptionPicker
        id="sink-write-fn" label="Write function"
        options={KNOWN_SINK_WRITE_FNS}
        value={writeFn}
        onPick={(picked) => onSave(node.id, { writeFn: picked })}
        onCustomType={(typed) => onSave(node.id, { writeFn: typed })}
        help="Name of a function registered in backend/services/ai-jobs/nodes/sink.ts."
        customPlaceholder="custom writeFn name"
      />
      <div className="form-group">
        <label>Input</label>
        <WiredFrom graph={graph} from={from} />
      </div>
      {known?.usesSection && (
        <div className="form-group">
          <label htmlFor="sink-section">Section title</label>
          <input id="sink-section" className="form-input" value={section} onChange={(e) => onSave(node.id, { section: e.target.value })} />
        </div>
      )}
    </>
  );
}

function ReportBody({ node, graph, onSave }: { node: NodeLike; graph: PipelineGraph; onSave: (nodeId: string, patch: Record<string, unknown>) => void }) {
  const sections: Array<{ title: string; from: string }> = node.config.sections;

  function save(next: Array<{ title: string; from: string }>) {
    onSave(node.id, { sections: next });
  }

  return (
    <div className="ai-jobs-report-sections">
      {sections.map((s, i) => (
        <div key={i} data-testid="report-section-row">
          <div className="ai-jobs-list-row">
            <span className="ai-jobs-list-row-index">{i + 1}.</span>
            <input className="form-input" placeholder="Section title" value={s.title}
              onChange={(e) => save(sections.map((row, j) => j === i ? { ...row, title: e.target.value } : row))} />
            <button type="button" className="btn btn-danger-ghost btn-sm" aria-label="Remove section" onClick={() => save(sections.filter((_, j) => j !== i))}>×</button>
          </div>
          <WiredFrom graph={graph} from={s.from || undefined} />
        </div>
      ))}
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => save([...sections, { title: '', from: '' }])}>+ Add section</button>
    </div>
  );
}

// Duplicated from backend/services/ai-jobs/nodes/transform.ts's TRANSFORM_DESCRIPTIONS/TRANSFORM_SCHEMAS
// — the frontend can't import that module at runtime. Empty until a real Transform function is
// registered in code; the picker then shows only the Custom escape hatch, same as before this task.
const KNOWN_TRANSFORM_FNS: Array<{ value: string; description: string; inputSchema: SchemaField[]; outputSchema: SchemaField[] }> = [];

function TransformBody({ node, onSave }: { node: NodeLike; onSave: (nodeId: string, patch: Record<string, unknown>) => void }) {
  const fn: string = node.config.fn;
  return (
    <KnownOptionPicker
      id="transform-fn" label="Transform function"
      options={KNOWN_TRANSFORM_FNS.map(f => ({ value: f.value, description: f.description }))}
      value={fn}
      onPick={(picked) => {
        if (picked === '') { onSave(node.id, { fn: '' }); return; }
        const chosen = KNOWN_TRANSFORM_FNS.find(f => f.value === picked)!;
        onSave(node.id, { fn: chosen.value });
      }}
      onCustomType={(typed) => onSave(node.id, { fn: typed })}
      help="No Transform functions are registered in this codebase yet — see backend/services/ai-jobs/nodes/transform.ts. A run through this node fails with &quot;Unknown transform&quot; until one is registered in code."
      customPlaceholder="e.g. my-plugin/my-transform"
    />
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
      <input className="form-input" aria-label="Per-item function" value={node.config.itemFn} placeholder="e.g. my-plugin/my-item-fn"
        onChange={(e) => onSave(node.id, { itemFn: e.target.value })} />
      <div className="form-help">No ForEach item functions are registered in this codebase yet — see backend/services/ai-jobs/nodes/foreach.ts. A run through this node fails with "Unknown itemFn" until one is registered in code.</div>
    </div>
  );
}
