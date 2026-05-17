import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '@darkrideapp/plugin-sdk/react';
import { useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import type { Selector, DOMNode } from '../../shared/types/automation';
import type { ExecutionLogEntry } from '../../shared/types/automation';
import type { Screenshot } from '../../shared/types/api';

/** Convert a uiautomator XML <node> element to a DOMNode */
function xmlElementToDomNode(el: Element): DOMNode {
  const boundsStr = el.getAttribute('bounds') || '[0,0][0,0]';
  const m = boundsStr.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  const bounds: [number, number, number, number] = m
    ? [parseInt(m[1]), parseInt(m[2]), parseInt(m[3]), parseInt(m[4])]
    : [0, 0, 0, 0];

  const children: DOMNode[] = [];
  for (const child of el.children) {
    if (child.tagName === 'node') children.push(xmlElementToDomNode(child));
  }

  return {
    className: el.getAttribute('class') || '',
    text: el.getAttribute('text') || '',
    resourceId: el.getAttribute('resource-id') || '',
    description: el.getAttribute('content-desc') || '',
    bounds,
    clickable: el.getAttribute('clickable') === 'true',
    enabled: el.getAttribute('enabled') === 'true',
    children,
  };
}

/** Try to parse as JSON first, then as uiautomator XML */
function parseDOMString(domStr: string): DOMNode | null {
  // Try JSON
  try {
    return JSON.parse(domStr) as DOMNode;
  } catch { /* not JSON */ }

  // Try uiautomator XML
  try {
    const doc = new DOMParser().parseFromString(domStr, 'text/xml');
    const firstNode = doc.querySelector('node');
    if (firstNode) return xmlElementToDomNode(firstNode);
  } catch { /* not valid XML */ }

  return null;
}

function matchesSelector(node: DOMNode, selector: Selector): boolean {
  if (selector.text !== undefined && node.text !== selector.text) return false;
  if (selector.textContains !== undefined && !node.text.includes(selector.textContains)) return false;
  if (selector.textStartsWith !== undefined && !node.text.startsWith(selector.textStartsWith)) return false;
  if (selector.textMatches !== undefined) {
    try { if (!new RegExp(selector.textMatches).test(node.text)) return false; } catch { return false; }
  }
  if (selector.resourceId !== undefined && node.resourceId !== selector.resourceId) return false;
  if (selector.resourceIdMatches !== undefined) {
    try { if (!new RegExp(selector.resourceIdMatches).test(node.resourceId)) return false; } catch { return false; }
  }
  if (selector.className !== undefined && node.className !== selector.className) return false;
  if (selector.classNameMatches !== undefined) {
    try { if (!new RegExp(selector.classNameMatches).test(node.className)) return false; } catch { return false; }
  }
  if (selector.description !== undefined && node.description !== selector.description) return false;
  if (selector.descriptionMatches !== undefined) {
    try { if (!new RegExp(selector.descriptionMatches).test(node.description)) return false; } catch { return false; }
  }
  if (selector.clickable !== undefined && node.clickable !== selector.clickable) return false;
  if (selector.enabled !== undefined && node.enabled !== selector.enabled) return false;
  return true;
}

function findMatches(node: DOMNode, selector: Selector, results: DOMNode[] = []): DOMNode[] {
  if (matchesSelector(node, selector)) {
    results.push(node);
  }
  for (const child of node.children || []) {
    findMatches(child, selector, results);
  }
  return results;
}

function isSelectorEmpty(selector: Selector): boolean {
  return Object.values(selector).every(v => v === undefined || v === '');
}

interface FlatNode {
  node: DOMNode;
  index: number;
  depth: number;
}

/** Flatten DOMNode tree into sequential list via depth-first traversal */
function flattenTree(node: DOMNode, depth: number, list: FlatNode[]): void {
  const index = list.length;
  list.push({ node, index, depth });
  for (const child of node.children || []) {
    flattenTree(child, depth + 1, list);
  }
}

interface XmlLine {
  text: string;
  nodeIndex: number;
}

/** Convert DOMNode to indented XML lines, each mapped to a node index */
function domNodeToXmlLines(node: DOMNode, depth: number, counter: { value: number }): XmlLine[] {
  const lines: XmlLine[] = [];
  const indent = '  '.repeat(depth);
  const nodeIndex = counter.value++;

  const attrs: string[] = [];
  attrs.push(`class="${node.className}"`);
  if (node.text) attrs.push(`text="${node.text}"`);
  if (node.resourceId) attrs.push(`resource-id="${node.resourceId}"`);
  if (node.description) attrs.push(`content-desc="${node.description}"`);
  attrs.push(`bounds="[${node.bounds[0]},${node.bounds[1]}][${node.bounds[2]},${node.bounds[3]}]"`);
  attrs.push(`clickable="${node.clickable}"`);
  attrs.push(`enabled="${node.enabled}"`);

  const attrStr = attrs.join(' ');

  if (!node.children || node.children.length === 0) {
    lines.push({ text: `${indent}<node ${attrStr} />`, nodeIndex });
  } else {
    lines.push({ text: `${indent}<node ${attrStr}>`, nodeIndex });
    for (const child of node.children) {
      lines.push(...domNodeToXmlLines(child, depth + 1, counter));
    }
    lines.push({ text: `${indent}</node>`, nodeIndex });
  }

  return lines;
}

/** Build a minimal JSON selector string from the current selector state */
function buildSelectorJson(selector: Selector): string {
  const obj: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(selector)) {
    if (value !== undefined && value !== '') {
      obj[key] = value;
    }
  }
  return JSON.stringify(obj, null, 2);
}

/** Auto-format raw DOM string: pretty-print JSON if parseable */
function formatDomInput(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

export function SelectorDebugger() {
  useDocumentTitle('Selector Debugger');
  const [searchParams] = useSearchParams();
  const ws = useWebSocket();

  const [domText, setDomText] = useState('');
  const [selector, setSelector] = useState<Selector>({});
  const [hoveredNodeIndex, setHoveredNodeIndex] = useState<number | null>(null);
  const [selectedNodeIndex, setSelectedNodeIndex] = useState<number | null>(null);
  const [editMode, setEditMode] = useState(true);
  const [copied, setCopied] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const xmlLineRefs = useRef<Map<number, HTMLSpanElement>>(new Map());

  // Pre-populate from URL params or sessionStorage.
  //
  // Two newer ?session=<id>&{screenshot|log}=<n> modes were added to fix
  // task #521 — passing the whole DOM snapshot via ?dom= was hitting HTTP
  // 431 for large UI hierarchies. These modes fetch the session via WS,
  // pull the matching snapshot, and populate the debugger from the result.
  // The original ?dom=… inline mode and ?fromStorage=1 paths are preserved
  // for small DOMs and the AutomationEditor scratch flow.
  useEffect(() => {
    const sessionId = searchParams.get('session');
    const screenshotId = searchParams.get('screenshot');
    const logIndex = searchParams.get('log');

    if (sessionId && (screenshotId || logIndex)) {
      if (!ws.connected) return;
      setLoadError(null);
      ws.sendRestApi('GET', `/v1/automation/session/${encodeURIComponent(sessionId)}`).then(res => {
        if (!res?.body?.success) {
          setLoadError(res?.body?.error || 'Could not load session');
          return;
        }
        const session = res.body.data as { screenshots?: Screenshot[]; logs?: string };
        if (screenshotId) {
          const id = Number(screenshotId);
          const shot = session.screenshots?.find(s => s.id === id);
          if (!shot?.domSnapshot) {
            setLoadError(`Screenshot ${id} has no DOM snapshot`);
            return;
          }
          setDomText(formatDomInput(shot.domSnapshot));
          setEditMode(false);
          return;
        }
        if (logIndex && session.logs) {
          const idx = Number(logIndex);
          try {
            const parsed = JSON.parse(session.logs) as ExecutionLogEntry[];
            const entry = parsed[idx];
            if (!entry?.domSnapshot) {
              setLoadError(`Log entry ${idx} has no DOM snapshot`);
              return;
            }
            setDomText(formatDomInput(entry.domSnapshot));
            setEditMode(false);
            if (entry.selector) {
              setSelector(prev => ({ ...prev, ...entry.selector }));
            }
          } catch (e: any) {
            setLoadError(`Could not parse session logs: ${e?.message ?? e}`);
          }
        }
      }).catch(err => {
        setLoadError(err?.message || 'Could not load session');
      });
      return;
    }

    const dom = searchParams.get('dom');
    if (dom) {
      const formatted = formatDomInput(dom);
      setDomText(formatted);
      setEditMode(false);
    } else if (searchParams.get('fromStorage') === '1') {
      const stored = sessionStorage.getItem('darkride_dom');
      if (stored) {
        const formatted = formatDomInput(stored);
        setDomText(formatted);
        setEditMode(false);
      }
    }

    const text = searchParams.get('text');
    const textContains = searchParams.get('textContains');
    const textStartsWith = searchParams.get('textStartsWith');
    const resourceId = searchParams.get('resourceId');
    const className = searchParams.get('className');
    const description = searchParams.get('description');
    if (text || textContains || textStartsWith || resourceId || className || description) {
      setSelector(prev => ({
        ...prev,
        ...(text ? { text } : {}),
        ...(textContains ? { textContains } : {}),
        ...(textStartsWith ? { textStartsWith } : {}),
        ...(resourceId ? { resourceId } : {}),
        ...(className ? { className } : {}),
        ...(description ? { description } : {}),
      }));
    }
  }, [searchParams, ws.connected, ws]);

  const domTree = useMemo(() => parseDOMString(domText), [domText]);

  const flatNodes = useMemo(() => {
    if (!domTree) return [];
    const list: FlatNode[] = [];
    flattenTree(domTree, 0, list);
    return list;
  }, [domTree]);

  const xmlLines = useMemo(() => {
    if (!domTree) return [];
    return domNodeToXmlLines(domTree, 0, { value: 0 });
  }, [domTree]);

  const matches = useMemo(() => {
    if (!domTree || isSelectorEmpty(selector)) return [];
    return findMatches(domTree, selector);
  }, [domTree, selector]);

  const matchedNodeIndices = useMemo(() => {
    const set = new Set<number>();
    for (const fn of flatNodes) {
      if (matches.includes(fn.node)) {
        set.add(fn.index);
      }
    }
    return set;
  }, [flatNodes, matches]);

  const selectorJson = useMemo(() => {
    if (isSelectorEmpty(selector)) return null;
    return buildSelectorJson(selector);
  }, [selector]);

  const updateSelector = (field: keyof Selector, value: string) => {
    setSelector(prev => ({
      ...prev,
      [field]: value === '' ? undefined : value,
    }));
  };

  const updateSelectorBool = (field: keyof Selector, value: string) => {
    setSelector(prev => ({
      ...prev,
      [field]: value === '' ? undefined : value === 'true',
    }));
  };

  const handleCopyJson = useCallback(async () => {
    if (!selectorJson) return;
    try {
      await navigator.clipboard.writeText(selectorJson);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard not available */ }
  }, [selectorJson]);

  // Compute visual preview dimensions from root bounds
  const rootBounds = domTree?.bounds;
  const deviceWidth = rootBounds ? rootBounds[2] - rootBounds[0] : 0;
  const deviceHeight = rootBounds ? rootBounds[3] - rootBounds[1] : 0;
  const previewContainerWidth = 280;
  const scaleFactor = deviceWidth > 0 ? previewContainerWidth / deviceWidth : 1;
  const previewHeight = deviceHeight * scaleFactor;

  const showVisualPreview = !!domTree && deviceWidth > 0 && deviceHeight > 0;

  const handleNodeSelect = useCallback((nodeIndex: number) => {
    setSelectedNodeIndex(nodeIndex);
    setHoveredNodeIndex(nodeIndex);
    const fn = flatNodes[nodeIndex];
    if (!fn) return;
    const node = fn.node;
    const obj: Record<string, unknown> = {};
    if (node.text) obj.text = node.text;
    if (node.resourceId) obj.resourceId = node.resourceId;
    if (node.className) obj.className = node.className;
    if (node.description) obj.description = node.description;
    if (node.clickable) obj.clickable = node.clickable;
    if (node.enabled === false) obj.enabled = node.enabled;
    try {
      navigator.clipboard.writeText(JSON.stringify(obj, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard not available */ }
  }, [flatNodes]);

  const handleClearSelection = useCallback(() => {
    setSelectedNodeIndex(null);
  }, []);

  const deviceFrameRef = useRef<HTMLDivElement>(null);

  const handleDeviceFrameMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (selectedNodeIndex !== null) return;
    const frame = deviceFrameRef.current;
    if (!frame || !rootBounds) return;
    const rect = frame.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    // Convert to device coordinates
    const devX = mouseX / scaleFactor + rootBounds[0];
    const devY = mouseY / scaleFactor + rootBounds[1];
    // Find deepest node containing cursor
    let bestIndex: number | null = null;
    let bestDepth = -1;
    for (const { node, index, depth } of flatNodes) {
      const [x1, y1, x2, y2] = node.bounds;
      if (devX >= x1 && devX <= x2 && devY >= y1 && devY <= y2) {
        if (depth > bestDepth) {
          bestDepth = depth;
          bestIndex = index;
        }
      }
    }
    setHoveredNodeIndex(bestIndex);
  }, [selectedNodeIndex, flatNodes, scaleFactor, rootBounds]);

  const handleDeviceFrameMouseLeave = useCallback(() => {
    if (selectedNodeIndex !== null) return;
    setHoveredNodeIndex(null);
  }, [selectedNodeIndex]);

  // Scroll XML line into view when hovered from visual preview
  useEffect(() => {
    if (hoveredNodeIndex !== null && !editMode) {
      const el = xmlLineRefs.current.get(hoveredNodeIndex);
      if (el && el.scrollIntoView) {
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }, [hoveredNodeIndex, editMode]);

  return (
    <div data-testid="selector-debugger">
      <PageHeader title="Selector Debugger" actions={
        matches.length > 0 ? <span className="badge badge-success">{matches.length} match{matches.length !== 1 ? 'es' : ''}</span> : undefined
      } />

      {loadError && (
        <div
          data-testid="selector-load-error"
          style={{
            margin: '12px 16px',
            padding: '10px 12px',
            borderRadius: 6,
            background: 'color-mix(in srgb, var(--danger, #ef4444) 12%, transparent)',
            border: '1px solid color-mix(in srgb, var(--danger, #ef4444) 40%, transparent)',
            color: 'var(--text-primary)',
            fontSize: 13,
          }}
        >
          {loadError}. Paste a DOM snapshot below or pick a different timeline entry.
        </div>
      )}

      <div className={`selector-debugger ${showVisualPreview ? 'has-preview' : ''}`}>
        <div className="selector-form">
          <div className="card">
            <h3 style={{ marginBottom: 12, fontSize: 15 }}>Selector Query</h3>
            <div className="form-group">
              <label>text</label>
              <input className="form-input" value={selector.text || ''} onChange={e => updateSelector('text', e.target.value)} placeholder="Exact text match" data-testid="selector-text" />
            </div>
            <div className="form-group">
              <label>textContains</label>
              <input className="form-input" value={selector.textContains || ''} onChange={e => updateSelector('textContains', e.target.value)} placeholder="Partial text match" data-testid="selector-textContains" />
            </div>
            <div className="form-group">
              <label>textStartsWith</label>
              <input className="form-input" value={selector.textStartsWith || ''} onChange={e => updateSelector('textStartsWith', e.target.value)} placeholder="Text starts with" />
            </div>
            <div className="form-group">
              <label>textMatches</label>
              <input className="form-input" value={selector.textMatches || ''} onChange={e => updateSelector('textMatches', e.target.value)} placeholder="Regex pattern e.g. \d+\.\d+" data-testid="selector-textMatches" style={{ fontFamily: 'var(--font-mono)' }} />
            </div>
            <div className="form-group">
              <label>resourceId</label>
              <input className="form-input" value={selector.resourceId || ''} onChange={e => updateSelector('resourceId', e.target.value)} placeholder="com.app:id/button" data-testid="selector-resourceId" />
            </div>
            <div className="form-group">
              <label>resourceIdMatches</label>
              <input className="form-input" value={selector.resourceIdMatches || ''} onChange={e => updateSelector('resourceIdMatches', e.target.value)} placeholder="Regex pattern" data-testid="selector-resourceIdMatches" style={{ fontFamily: 'var(--font-mono)' }} />
            </div>
            <div className="form-group">
              <label>className</label>
              <input className="form-input" value={selector.className || ''} onChange={e => updateSelector('className', e.target.value)} placeholder="android.widget.Button" />
            </div>
            <div className="form-group">
              <label>classNameMatches</label>
              <input className="form-input" value={selector.classNameMatches || ''} onChange={e => updateSelector('classNameMatches', e.target.value)} placeholder="Regex pattern" style={{ fontFamily: 'var(--font-mono)' }} />
            </div>
            <div className="form-group">
              <label>description</label>
              <input className="form-input" value={selector.description || ''} onChange={e => updateSelector('description', e.target.value)} placeholder="Content description" />
            </div>
            <div className="form-group">
              <label>descriptionMatches</label>
              <input className="form-input" value={selector.descriptionMatches || ''} onChange={e => updateSelector('descriptionMatches', e.target.value)} placeholder="Regex pattern" style={{ fontFamily: 'var(--font-mono)' }} />
            </div>
            <div className="form-group">
              <label>clickable</label>
              <select className="form-select" value={selector.clickable === undefined ? '' : String(selector.clickable)} onChange={e => updateSelectorBool('clickable', e.target.value)}>
                <option value="">Any</option>
                <option value="true">True</option>
                <option value="false">False</option>
              </select>
            </div>
            <div className="form-group">
              <label>enabled</label>
              <select className="form-select" value={selector.enabled === undefined ? '' : String(selector.enabled)} onChange={e => updateSelectorBool('enabled', e.target.value)}>
                <option value="">Any</option>
                <option value="true">True</option>
                <option value="false">False</option>
              </select>
            </div>
          </div>
        </div>

        <div className="dom-viewer">
          <div className="dom-viewer-header">
            <label>DOM {editMode ? 'Input' : 'View'}</label>
            <button
              className="btn btn-small"
              onClick={() => setEditMode(!editMode)}
              data-testid="toggle-edit-mode"
            >
              {editMode ? 'Format' : 'Edit'}
            </button>
          </div>
          {editMode || !domTree ? (
            <textarea
              className="form-textarea dom-textarea"
              value={domText}
              onChange={e => { setDomText(e.target.value); setEditMode(true); }}
              placeholder='Paste DOM JSON here, e.g. {"className":"FrameLayout","text":"","resourceId":"","description":"","bounds":[0,0,1080,1920],"clickable":false,"enabled":true,"children":[...]}'
              data-testid="dom-input"
            />
          ) : (
            <pre className="dom-xml-view" data-testid="dom-xml-view">
              {xmlLines.map((line, i) => {
                const isHovered = hoveredNodeIndex === line.nodeIndex;
                const isSelected = selectedNodeIndex === line.nodeIndex;
                const isMatched = matchedNodeIndices.has(line.nodeIndex);
                let cls = 'xml-line';
                if (isSelected) cls += ' xml-line-selected';
                else if (isHovered) cls += ' xml-line-highlight';
                if (isMatched) cls += ' xml-line-match';
                return (
                  <span
                    key={i}
                    ref={el => {
                      if (el) xmlLineRefs.current.set(line.nodeIndex, el);
                    }}
                    className={cls}
                    onMouseEnter={() => { if (selectedNodeIndex === null) setHoveredNodeIndex(line.nodeIndex); }}
                    onMouseLeave={() => { if (selectedNodeIndex === null) setHoveredNodeIndex(null); }}
                    onClick={() => handleNodeSelect(line.nodeIndex)}
                  >
                    {line.text}
                    {'\n'}
                  </span>
                );
              })}
            </pre>
          )}
        </div>

        {showVisualPreview && (
          <div className="dom-visual-preview" data-testid="dom-visual-preview">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <label style={{ fontWeight: 600, fontSize: 13 }}>Visual Preview</label>
              {selectedNodeIndex !== null && (
                <button className="btn btn-sm" onClick={handleClearSelection} data-testid="clear-selection">Clear selection</button>
              )}
              {copied && <span style={{ fontSize: 12, color: 'var(--success)' }}>Copied!</span>}
            </div>
            <div
              ref={deviceFrameRef}
              className="device-frame"
              style={{ width: previewContainerWidth, height: previewHeight }}
              onMouseMove={handleDeviceFrameMouseMove}
              onMouseLeave={handleDeviceFrameMouseLeave}
            >
              {flatNodes.map(({ node, index }) => {
                const [x1, y1, x2, y2] = node.bounds;
                const w = x2 - x1;
                const h = y2 - y1;
                if (w <= 0 || h <= 0) return null;

                const isLeaf = !node.children || node.children.length === 0;
                const isMatched = matchedNodeIndices.has(index);
                const isHovered = hoveredNodeIndex === index;
                const isSelected = selectedNodeIndex === index;

                let boxClass = 'dom-box';
                if (isLeaf) boxClass += ' dom-box-leaf';
                if (isMatched) boxClass += ' dom-box-match';
                if (isSelected) boxClass += ' dom-box-selected';
                else if (isHovered) boxClass += ' dom-box-hover';

                return (
                  <div
                    key={index}
                    className={boxClass}
                    data-testid={`dom-box-${index}`}
                    style={{
                      left: (x1 - (rootBounds![0])) * scaleFactor,
                      top: (y1 - (rootBounds![1])) * scaleFactor,
                      width: w * scaleFactor,
                      height: h * scaleFactor,
                    }}
                    onClick={() => handleNodeSelect(index)}
                  >
                    {isLeaf && node.text && (
                      <span className="node-label">{node.text}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="selector-results-row">
          {selectorJson && (
            <div className="selector-json-card card" data-testid="selector-json">
              <div className="selector-json-header">
                <h3 style={{ margin: 0, fontSize: 14 }}>Selector JSON</h3>
                <button className="btn btn-small copy-btn" onClick={handleCopyJson} data-testid="copy-selector-json">
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <pre className="selector-json-pre">{selectorJson}</pre>
            </div>
          )}

          <div className="card matched-elements" data-testid="match-results">
            <h3 style={{ marginBottom: 8, fontSize: 15 }}>
              Results {matches.length > 0 && `(${matches.length})`}
            </h3>
            {domText && !domTree && (
              <div style={{ color: 'var(--error)', fontSize: 13 }}>Invalid DOM JSON</div>
            )}
            {matches.length === 0 && domTree && !isSelectorEmpty(selector) && (
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No matches found</div>
            )}
            {matches.map((m, i) => (
              <div key={i} className="matched-element highlighted" data-testid={`match-${i}`}>
                <div><strong>{m.className}</strong></div>
                {m.text && <div>text: "{m.text}"</div>}
                {m.resourceId && <div>resourceId: {m.resourceId}</div>}
                {m.description && <div>description: "{m.description}"</div>}
                <div>bounds: [{m.bounds.join(', ')}]</div>
                <div>clickable: {String(m.clickable)} | enabled: {String(m.enabled)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
