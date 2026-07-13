import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { Copy, X, Repeat, Link, Terminal, Code, FileText, Download, EyeOff, ShieldBan, Image as ImageIcon } from 'lucide-react';
import type { TrafficEntry } from './TrafficEntryRow';
import { parseHostname } from './TrafficEntryRow';
import { detectGraphQL, formatGraphQLQuery } from '../../../shared/lib/graphql-detect';
import { detectProtobuf, decodeProtobufSchemaless, formatProtobufTree } from '../../../shared/lib/protobuf-detect';
import { detectProtocol } from '../../lib/protocol-decoders';
import type { RawFrame } from '../../lib/protocol-decoders';
import type { WebSocketMessageEntry } from '../../../shared/types/api';
import {
  parseHeadersObject,
  isBodyTruncated,
  generateCurl,
  generateFetch,
  formatDuration,
  getDurationColor,
  normalizeTimings,
  TIMING_SEGMENTS,
} from './trafficUtils';

type InspectorTab = 'headers' | 'payload' | 'preview' | 'cookies' | 'frames';

interface TrafficDetailPanelProps {
  entry: TrafficEntry;
  onClose: () => void;
  onReplay?: (entry: TrafficEntry) => void;
  onLoadFullBody?: (id: number) => void;
  wsFrames?: WebSocketMessageEntry[];
  onLoadWsFrames?: (id: number) => void;
  onBlockHostname?: (hostname: string) => void;
  onHideHostname?: (hostname: string) => void;
}

function tryPrettyJson(str: string): string {
  try { return JSON.stringify(JSON.parse(str), null, 2); } catch { return str; }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// Small sub-components
// ---------------------------------------------------------------------------

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="detail-panel-copy-btn"
      onClick={() => {
        navigator.clipboard.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      title={label || 'Copy'}
    >
      <Copy size={12} />
      {copied && <span className="detail-panel-copied">Copied</span>}
    </button>
  );
}

function HeaderDisplay({ headers, title, titleColor }: { headers: Record<string, string>; title: string; titleColor?: string }) {
  if (Object.keys(headers).length === 0) return null;
  const text = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n');
  return (
    <div className="detail-panel-section">
      <div className="detail-panel-section-header">
        <h3 className="detail-panel-section-title" style={titleColor ? { color: titleColor } : undefined}>
          {title}
        </h3>
        <CopyButton text={text} />
      </div>
      <div className="detail-panel-code-block">
        {Object.entries(headers).map(([key, value], i) => (
          <div key={i} className="header-line">
            <span className="header-key">{key}:</span>{' '}
            <span className="header-value">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function parseCookies(headers: Record<string, string>, direction: 'request' | 'response'): Array<{ name: string; value: string; attrs?: string }> {
  const cookies: Array<{ name: string; value: string; attrs?: string }> = [];
  if (direction === 'request') {
    const cookieHeader = Object.entries(headers).find(([k]) => k.toLowerCase() === 'cookie');
    if (cookieHeader) {
      cookieHeader[1].split(';').forEach(pair => {
        const eq = pair.indexOf('=');
        if (eq > 0) {
          cookies.push({ name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() });
        }
      });
    }
  } else {
    Object.entries(headers).forEach(([k, v]) => {
      if (k.toLowerCase() === 'set-cookie') {
        const parts = v.split(';');
        const main = parts[0];
        const eq = main.indexOf('=');
        if (eq > 0) {
          cookies.push({
            name: main.slice(0, eq).trim(),
            value: main.slice(eq + 1).trim(),
            attrs: parts.slice(1).map(s => s.trim()).join('; '),
          });
        }
      }
    });
  }
  return cookies;
}

// ---------------------------------------------------------------------------
// Action button with copy feedback
// ---------------------------------------------------------------------------

function ActionButton({
  icon,
  label,
  copiedLabel,
  onClick,
  variant,
}: {
  icon: React.ReactNode;
  label: string;
  copiedLabel?: string;
  onClick: () => void;
  variant?: 'primary' | 'danger';
}) {
  const [feedback, setFeedback] = useState(false);
  const handleClick = () => {
    onClick();
    if (copiedLabel) {
      setFeedback(true);
      setTimeout(() => setFeedback(false), 1500);
    }
  };
  return (
    <button
      className={`detail-action-btn${variant ? ` detail-action-btn--${variant}` : ''}`}
      onClick={handleClick}
    >
      {icon}
      <span>{feedback ? copiedLabel : label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Timing waterfall — compact segmented bar (dns/connect/tls/ttfb/download)
// ---------------------------------------------------------------------------

function TimingWaterfall({ entry }: { entry: TrafficEntry }) {
  const timings = useMemo(() => normalizeTimings(entry.timings), [entry.timings]);
  const durationMs = entry.durationMs;

  // Nothing to show at all — no total and no breakdown.
  if ((durationMs == null || durationMs < 0) && !timings) return null;

  const segments = timings
    ? TIMING_SEGMENTS
        .map(s => ({ ...s, value: timings[s.key] }))
        .filter(s => s.value != null && (s.value as number) >= 0)
    : [];
  const knownTotal = segments.reduce((sum, s) => sum + (s.value as number), 0);

  return (
    <div className="timing-waterfall" data-testid="timing-waterfall">
      <div className="timing-waterfall-header">
        <span className="detail-panel-section-title">Timing</span>
        <span
          className="timing-waterfall-total"
          style={{ color: getDurationColor(durationMs) }}
          data-testid="timing-waterfall-total"
        >
          {formatDuration(durationMs)}
        </span>
      </div>

      {segments.length > 0 && knownTotal > 0 ? (
        <>
          <div className="timing-waterfall-bar" data-testid="timing-waterfall-bar">
            {segments.map(s => (
              <div
                key={s.key}
                className="timing-waterfall-seg"
                style={{
                  width: `${((s.value as number) / knownTotal) * 100}%`,
                  background: s.color,
                }}
                title={`${s.label}: ${formatDuration(s.value as number)}`}
                data-testid={`timing-seg-${s.key}`}
              />
            ))}
          </div>
          <div className="timing-waterfall-legend">
            {segments.map(s => (
              <span key={s.key} className="timing-waterfall-legend-item">
                <span className="timing-waterfall-dot" style={{ background: s.color }} />
                {s.label}
                <span className="timing-waterfall-legend-ms">{formatDuration(s.value as number)}</span>
              </span>
            ))}
          </div>
        </>
      ) : (
        <div className="timing-waterfall-total-only" data-testid="timing-waterfall-total-only">
          Total latency (no per-segment breakdown available)
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function TrafficDetailPanel({
  entry,
  onClose,
  onReplay,
  onLoadFullBody,
  wsFrames,
  onLoadWsFrames,
  onBlockHostname,
  onHideHostname,
}: TrafficDetailPanelProps) {
  const isWs = entry.type === 'websocket';
  const hostname = parseHostname(entry.requestUrl);
  const [activeTab, setActiveTab] = useState<InspectorTab>('headers');

  const requestHeaders = useMemo(() => parseHeadersObject(entry.requestHeaders), [entry.requestHeaders]);
  const responseHeaders = useMemo(() => parseHeadersObject(entry.responseHeaders), [entry.responseHeaders]);
  const gqlInfo = useMemo(() => detectGraphQL(entry.requestMethod, entry.requestUrl, entry.requestBody), [entry.requestMethod, entry.requestUrl, entry.requestBody]);
  const protoInfo = useMemo(() => detectProtobuf(entry.requestHeaders, entry.responseHeaders), [entry.requestHeaders, entry.responseHeaders]);
  const truncatedResponse = isBodyTruncated(entry.responseBody);

  // Decode protobuf if detected
  const decodedProtoResponse = useMemo(() => {
    if (!protoInfo?.isResponse || !entry.responseBody) return null;
    return decodeProtobufSchemaless(entry.responseBody, protoInfo?.isGrpc);
  }, [protoInfo, entry.responseBody]);

  // Auto-request WS frames when switching to frames tab
  useEffect(() => {
    if (activeTab === 'frames' && isWs && onLoadWsFrames && (!wsFrames || wsFrames.length === 0) && (entry.wsMessageCount ?? 0) > 0) {
      onLoadWsFrames(entry.id);
    }
  }, [activeTab, isWs, entry.id, entry.wsMessageCount, onLoadWsFrames, wsFrames]);

  // Build tab list — include "Frames" only for WebSocket entries
  const tabs: { id: InspectorTab; label: string }[] = useMemo(() => {
    const base: { id: InspectorTab; label: string }[] = [
      { id: 'headers', label: 'Headers' },
      { id: 'payload', label: 'Payload' },
      { id: 'preview', label: 'Preview' },
      { id: 'cookies', label: 'Cookies' },
    ];
    if (isWs) {
      base.push({ id: 'frames', label: `Frames${entry.wsMessageCount ? ` (${entry.wsMessageCount})` : ''}` });
    }
    return base;
  }, [isWs, entry.wsMessageCount]);

  // Copy helpers
  const copyToClipboard = useCallback((text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
  }, []);

  return (
    <div className="traffic-detail-panel">
      {/* Tab bar */}
      <div className="traffic-detail-tabs">
        {tabs.map(tab => (
          <button
            key={tab.id}
            className={`traffic-detail-tab${activeTab === tab.id ? ' active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
        <div className="traffic-detail-tab-spacer" />
        <span className="traffic-detail-id">ID: {entry.id}</span>
        <button className="traffic-detail-close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>

      {/* Action bar */}
      <div className="detail-action-bar">
        <ActionButton
          icon={<Link size={12} />}
          label="Copy URL"
          copiedLabel="Copied!"
          onClick={() => copyToClipboard(entry.requestUrl)}
        />
        {!isWs && (
          <>
            <ActionButton
              icon={<Terminal size={12} />}
              label="cURL"
              copiedLabel="Copied!"
              onClick={() => copyToClipboard(generateCurl(entry))}
            />
            <ActionButton
              icon={<Code size={12} />}
              label="Fetch"
              copiedLabel="Copied!"
              onClick={() => copyToClipboard(generateFetch(entry))}
            />
            {entry.responseBody != null && (
              <ActionButton
                icon={<FileText size={12} />}
                label="Copy Response"
                copiedLabel="Copied!"
                onClick={() => copyToClipboard(entry.responseBody!)}
              />
            )}
            {entry.requestBody != null && (
              <ActionButton
                icon={<FileText size={12} />}
                label="Copy Request Body"
                copiedLabel="Copied!"
                onClick={() => copyToClipboard(entry.requestBody!)}
              />
            )}
          </>
        )}
        {truncatedResponse && onLoadFullBody && (
          <ActionButton
            icon={<Download size={12} />}
            label="Load Full Body"
            onClick={() => onLoadFullBody(entry.id)}
          />
        )}
        {onReplay && !isWs && (
          <ActionButton
            icon={<Repeat size={12} />}
            label="Replay"
            onClick={() => onReplay(entry)}
            variant="primary"
          />
        )}
        {hostname && onHideHostname && (
          <ActionButton
            icon={<EyeOff size={12} />}
            label={`Hide ${hostname}`}
            onClick={() => onHideHostname(hostname)}
          />
        )}
        {hostname && onBlockHostname && (
          <ActionButton
            icon={<ShieldBan size={12} />}
            label={`Block ${hostname}`}
            onClick={() => onBlockHostname(hostname)}
            variant="danger"
          />
        )}
      </div>

      {/* Tab content */}
      <div className="traffic-detail-content">
        {activeTab === 'headers' && (
          <>
            {!isWs && <TimingWaterfall entry={entry} />}
            <div className="traffic-detail-headers-grid">
              <HeaderDisplay headers={requestHeaders} title="Request Headers" titleColor="var(--accent)" />
              <HeaderDisplay headers={responseHeaders} title="Response Headers" titleColor="var(--warning)" />
            </div>
          </>
        )}

        {activeTab === 'payload' && (
          <div className="traffic-detail-payload">
            {gqlInfo ? (
              <>
                <div className="detail-panel-section">
                  <div className="detail-panel-section-header">
                    <h3 className="detail-panel-section-title" style={{ color: '#e535ab' }}>
                      GraphQL {gqlInfo.operationType}{gqlInfo.operationName ? `: ${gqlInfo.operationName}` : ''}
                    </h3>
                    <CopyButton text={gqlInfo.query} />
                  </div>
                  <pre className="detail-panel-code-block">{formatGraphQLQuery(gqlInfo.query)}</pre>
                </div>
                {gqlInfo.variables && Object.keys(gqlInfo.variables).length > 0 && (
                  <div className="detail-panel-section">
                    <h3 className="detail-panel-section-title">Variables</h3>
                    <pre className="detail-panel-code-block">{JSON.stringify(gqlInfo.variables, null, 2)}</pre>
                  </div>
                )}
              </>
            ) : entry.requestBody ? (
              <div className="detail-panel-section">
                <div className="detail-panel-section-header">
                  <h3 className="detail-panel-section-title">Request Body</h3>
                  <CopyButton text={entry.requestBody} />
                </div>
                <pre className="detail-panel-code-block">{tryPrettyJson(entry.requestBody)}</pre>
              </div>
            ) : null}

            {decodedProtoResponse ? (
              <div className="detail-panel-section">
                <div className="detail-panel-section-header">
                  <h3 className="detail-panel-section-title" style={{ color: '#06b6d4' }}>
                    {protoInfo?.isGrpc ? 'gRPC' : 'Protobuf'} Response
                  </h3>
                  <CopyButton text={formatProtobufTree(decodedProtoResponse)} />
                </div>
                <pre className="detail-panel-code-block">{formatProtobufTree(decodedProtoResponse)}</pre>
              </div>
            ) : entry.responseBody != null ? (
              <div className="detail-panel-section">
                <div className="detail-panel-section-header">
                  <h3 className="detail-panel-section-title">Response Body</h3>
                  <CopyButton text={entry.responseBody} />
                </div>
                <pre className="detail-panel-code-block">{tryPrettyJson(entry.responseBody)}</pre>
              </div>
            ) : null}

            {!entry.requestBody && entry.responseBody == null && (
              <div className="traffic-detail-empty">No payload data available</div>
            )}
          </div>
        )}

        {activeTab === 'preview' && (
          <div className="traffic-detail-preview">
            {(() => {
              const ct = responseHeaders['content-type'] || responseHeaders['Content-Type'] || entry.responseContentType || '';
              const isImage = ct.includes('image/') || entry.hasImage;

              if (isImage && entry.hasImage) {
                return <ImagePreview entryId={entry.id} contentType={ct} />;
              }

              if (!entry.responseBody) {
                return <div className="traffic-detail-empty">No response body to preview</div>;
              }

              if (ct.includes('json')) {
                return <pre className="detail-panel-code-block json-preview">{tryPrettyJson(entry.responseBody)}</pre>;
              }
              if (ct.includes('html')) {
                return (
                  <div className="detail-panel-section">
                    <h3 className="detail-panel-section-title">HTML Preview</h3>
                    <pre className="detail-panel-code-block">{entry.responseBody}</pre>
                  </div>
                );
              }
              if (isImage) {
                // Image content-type detected but no binary data stored
                return (
                  <div className="detail-panel-section">
                    <h3 className="detail-panel-section-title">Image</h3>
                    <div className="traffic-detail-empty">Binary image data - preview not available (captured before image storage was enabled)</div>
                  </div>
                );
              }
              return <pre className="detail-panel-code-block">{entry.responseBody}</pre>;
            })()}
          </div>
        )}

        {activeTab === 'cookies' && (
          <div className="traffic-detail-cookies">
            {(() => {
              const reqCookies = parseCookies(requestHeaders, 'request');
              const resCookies = parseCookies(responseHeaders, 'response');
              if (reqCookies.length === 0 && resCookies.length === 0) {
                return <div className="traffic-detail-empty">No cookies found in this request</div>;
              }
              return (
                <div className="traffic-detail-headers-grid">
                  {reqCookies.length > 0 && (
                    <div className="detail-panel-section">
                      <h3 className="detail-panel-section-title" style={{ color: 'var(--accent)' }}>Request Cookies</h3>
                      <div className="detail-panel-code-block">
                        {reqCookies.map((c, i) => (
                          <div key={i} className="header-line">
                            <span className="header-key">{c.name}</span>{' = '}
                            <span className="header-value">{c.value}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {resCookies.length > 0 && (
                    <div className="detail-panel-section">
                      <h3 className="detail-panel-section-title" style={{ color: 'var(--warning)' }}>Response Cookies (Set-Cookie)</h3>
                      <div className="detail-panel-code-block">
                        {resCookies.map((c, i) => (
                          <div key={i} className="header-line">
                            <span className="header-key">{c.name}</span>{' = '}
                            <span className="header-value">{c.value}</span>
                            {c.attrs && <span className="header-attrs"> ; {c.attrs}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}

        {activeTab === 'frames' && isWs && (
          <WsFramesPanel
            entry={entry}
            frames={wsFrames || []}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Image preview component
// ---------------------------------------------------------------------------

function ImagePreview({ entryId, contentType }: { entryId: number; contentType: string }) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [dimensions, setDimensions] = useState<{ w: number; h: number } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const src = `/v1/traffic/${entryId}/image`;

  const handleLoad = useCallback(() => {
    setStatus('loaded');
    if (imgRef.current) {
      setDimensions({ w: imgRef.current.naturalWidth, h: imgRef.current.naturalHeight });
    }
  }, []);

  const handleError = useCallback(() => {
    setStatus('error');
  }, []);

  const handleDownload = useCallback(() => {
    const a = document.createElement('a');
    a.href = src;
    // Derive extension from content-type
    const ext = contentType.split('/').pop()?.split(';')[0] || 'bin';
    a.download = `traffic-${entryId}.${ext}`;
    a.click();
  }, [src, entryId, contentType]);

  if (status === 'error') {
    return (
      <div className="detail-panel-section">
        <h3 className="detail-panel-section-title">Image Preview</h3>
        <div className="traffic-detail-empty">Failed to load image preview</div>
      </div>
    );
  }

  return (
    <div className="detail-panel-section">
      <div className="detail-panel-section-header">
        <h3 className="detail-panel-section-title">
          <ImageIcon size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} />
          Image Preview
          {dimensions && (
            <span className="image-preview-dimensions">
              {dimensions.w} x {dimensions.h}
            </span>
          )}
        </h3>
        <button className="detail-action-btn" onClick={handleDownload} title="Download image">
          <Download size={12} />
          <span>Download</span>
        </button>
      </div>
      <div className="image-preview-container">
        {status === 'loading' && (
          <div className="image-preview-loading">Loading image...</div>
        )}
        <img
          ref={imgRef}
          src={src}
          alt={`Response image for traffic entry ${entryId}`}
          className="image-preview-img"
          onLoad={handleLoad}
          onError={handleError}
          style={status === 'loading' ? { opacity: 0 } : undefined}
        />
      </div>
      {contentType && (
        <div className="image-preview-meta">
          {contentType}
          {dimensions && ` \u2022 ${dimensions.w}\u00D7${dimensions.h}`}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WebSocket Frames panel (simplified for the detail panel context)
// ---------------------------------------------------------------------------

function WsFramesPanel({ entry, frames }: { entry: TrafficEntry; frames: WebSocketMessageEntry[] }) {
  const [dirFilter, setDirFilter] = useState<string>('All');
  const [expandedMsg, setExpandedMsg] = useState<number | null>(null);

  // Look up a plugin-registered ProtocolDecoder (e.g. BLIP) matching this
  // connection's handshake headers. Falls back to the raw frame list below
  // when no decoder is registered or none matches.
  const decoder = useMemo(() => detectProtocol(entry.requestHeaders), [entry.requestHeaders]);
  const [viewMode, setViewMode] = useState<'decoded' | 'raw'>(decoder ? 'decoded' : 'raw');

  const decodedMessages = useMemo(() => {
    if (!decoder || viewMode !== 'decoded' || frames.length === 0) return null;
    const rawFrames: RawFrame[] = frames.map(f => ({
      id: f.id,
      direction: f.direction,
      opcode: f.opcode,
      payload: f.payload,
      isBinary: f.isBinary,
      payloadSize: f.payloadSize,
      timestamp: f.timestamp,
    }));
    return decoder.decodeFrames(rawFrames);
  }, [decoder, frames, viewMode]);

  const filtered = useMemo(() => {
    if (dirFilter === 'All') return frames;
    return frames.filter(f => f.direction === dirFilter);
  }, [frames, dirFilter]);

  if (frames.length === 0 && (entry.wsMessageCount ?? 0) === 0) {
    return <div className="traffic-detail-empty">No frames captured</div>;
  }

  if (frames.length === 0) {
    return <div className="traffic-detail-empty">Loading frames...</div>;
  }

  return (
    <div className="detail-panel-section">
      <div className="detail-ws-toolbar">
        <span className="detail-panel-section-title">
          {viewMode === 'decoded' && decodedMessages ? `Messages (${decodedMessages.length})` : `Frames (${frames.length})`}
        </span>
        {decoder && (
          <>
            <span className="detail-ws-protocol-badge">{decoder.name}</span>
            <div className="detail-ws-view-toggle">
              <button
                className={`detail-ws-view-btn${viewMode === 'decoded' ? ' active' : ''}`}
                onClick={() => setViewMode('decoded')}
              >
                Decoded
              </button>
              <button
                className={`detail-ws-view-btn${viewMode === 'raw' ? ' active' : ''}`}
                onClick={() => setViewMode('raw')}
              >
                Raw Frames
              </button>
            </div>
          </>
        )}
        {viewMode === 'raw' && (
          <div className="detail-ws-dir-filters">
            {(['All', 'send', 'receive'] as const).map(d => (
              <button
                key={d}
                className={`detail-ws-dir-btn${dirFilter === d ? ' active' : ''}`}
                onClick={() => setDirFilter(d)}
              >
                {d === 'send' ? '\u2191 Sent' : d === 'receive' ? '\u2193 Received' : 'All'}
              </button>
            ))}
            {dirFilter !== 'All' && (
              <span className="detail-ws-count">{filtered.length} / {frames.length}</span>
            )}
          </div>
        )}
      </div>

      {viewMode === 'decoded' && decodedMessages ? (
        <div className="detail-ws-message-list">
          {decodedMessages.map((m, i) => {
            const profile = m.properties.Profile || m.properties.profile;
            const errorInfo = m.properties['Error-Code'] || m.properties['Error-Domain'];
            const isExpanded = expandedMsg === i;
            return (
              <div key={i} className="detail-ws-message">
                <div className="detail-ws-message-header" onClick={() => setExpandedMsg(isExpanded ? null : i)}>
                  <span className={`detail-ws-dir ${m.direction === 'send' ? 'send' : 'receive'}`}>
                    {m.direction === 'send' ? '\u2191' : '\u2193'}
                  </span>
                  <span className={`detail-ws-message-type type-${m.typeLabel.toLowerCase()}`}>{m.typeLabel}</span>
                  <span className="detail-ws-message-num">#{m.messageNumber}</span>
                  {profile && <span className="detail-ws-message-profile">{profile}</span>}
                  {errorInfo && (
                    <span className="detail-ws-message-error">
                      Error: {m.properties['Error-Code']} {m.properties['Error-Domain'] || ''}
                    </span>
                  )}
                  <span className="detail-ws-message-preview">
                    {m.body && !m.body.startsWith('[') ? (m.body.length > 80 ? m.body.slice(0, 80) + '\u2026' : m.body) : ''}
                  </span>
                  {m.bodySize > 0 && <span className="detail-ws-size">{formatBytes(m.bodySize)}</span>}
                  <span className="detail-ws-time">{new Date(m.timestamp).toLocaleTimeString()}</span>
                </div>
                {isExpanded && (
                  <div className="detail-ws-message-detail">
                    {Object.keys(m.properties).length > 0 && (
                      <div className="detail-ws-message-detail-section">
                        <strong>Properties:</strong>
                        <pre>{Object.entries(m.properties).map(([k, v]) => `${k}: ${v}`).join('\n')}</pre>
                      </div>
                    )}
                    {m.body && (
                      <div className="detail-ws-message-detail-section">
                        <strong>Body:</strong>
                        <pre>{tryPrettyJson(m.body)}</pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="detail-ws-frame-list">
          {filtered.length === 0 ? (
            <div className="traffic-detail-empty">No frames match filter</div>
          ) : (
            filtered.map((f, i) => (
              <div key={f.id || i} className="detail-ws-frame-row">
                <span className={`detail-ws-dir ${f.direction === 'send' ? 'send' : 'receive'}`}>
                  {f.direction === 'send' ? '\u2191' : '\u2193'}
                </span>
                {f.isBinary && (
                  <span className="detail-ws-binary-tag">binary</span>
                )}
                <span className="detail-ws-payload">
                  {f.payload ? (f.payload.length > 200 ? f.payload.slice(0, 200) + '\u2026' : f.payload) : '(empty)'}
                </span>
                <span className="detail-ws-size">{formatBytes(f.payloadSize)}</span>
                <span className="detail-ws-time">{new Date(f.timestamp).toLocaleTimeString()}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
