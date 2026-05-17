import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { WebSocketMessageEntry } from '../../../shared/types/api';
import { RuleAttribution } from './RuleAttribution';
import { detectProtocol } from '../../lib/protocol-decoders';
import type { DecodedMessage, RawFrame } from '../../lib/protocol-decoders';
import { isGoogleMapsBpbUrl, decodeGoogleMapsBpb } from '../../lib/url-decoders/google-maps-bpb';
import type { BpbDecodedInfo } from '../../lib/url-decoders/google-maps-bpb';
import { detectGraphQL, formatGraphQLQuery } from '../../../shared/lib/graphql-detect';
import type { GraphQLInfo } from '../../../shared/lib/graphql-detect';
import { detectProtobuf, decodeProtobufSchemaless, formatProtobufTree } from '../../../shared/lib/protobuf-detect';
import type { ProtobufInfo, DecodedProtobufField } from '../../../shared/lib/protobuf-detect';
import { parseHeadersObject, isBodyTruncated, generateCurl, generateFetch } from './trafficUtils';

// Inject keyframes for pending pulse animation once
if (typeof document !== 'undefined' && !document.getElementById('darkride-pending-pulse-style')) {
  const style = document.createElement('style');
  style.id = 'darkride-pending-pulse-style';
  style.textContent = `@keyframes darkride-pending-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }`;
  document.head.appendChild(style);
}

export interface TrafficEntry {
  id: number;
  sessionId: number | null;
  deviceId: string | null;
  requestMethod: string;
  requestUrl: string;
  requestHeaders: string | null;
  requestBody: string | null;
  responseStatus: number | null;
  responseHeaders: string | null;
  responseBody: string | null;
  type?: string;
  wsCloseCode?: number | null;
  wsCloseReason?: string | null;
  wsMessageCount?: number | null;
  capturedAt: string;
  flowId?: string;
  pending?: boolean;
  matchedRules?: Array<{ id: number; name: string; phase: string; actionsApplied: string[] }> | null;
  responseContentType?: string | null;
  hasImage?: boolean;
}

interface TrafficEntryRowProps {
  entry: TrafficEntry;
  expanded: boolean;
  onExpand: (id: number) => void;
  onLoadFullBody?: (id: number) => void;
  onHideHostname?: (hostname: string) => void;
  onBlockHostname?: (hostname: string) => void;
  onReplay?: (entry: TrafficEntry) => void;
  wsFrames?: WebSocketMessageEntry[];
  onLoadWsFrames?: (id: number) => void;
}

const METHOD_COLORS: Record<string, { bg: string; color: string }> = {
  GET: { bg: 'rgba(96, 165, 250, 0.1)', color: '#60a5fa' },
  POST: { bg: 'rgba(74, 222, 128, 0.1)', color: '#4ade80' },
  PUT: { bg: 'rgba(255, 185, 95, 0.1)', color: '#ffb95f' },
  DELETE: { bg: 'rgba(248, 113, 113, 0.1)', color: '#fca5a5' },
  CONNECT: { bg: 'rgba(139, 149, 176, 0.1)', color: '#8b95b0' },
};

const PROTOCOL_COLORS: Record<string, { bg: string; color: string }> = {
  WS: { bg: 'rgba(168, 85, 247, 0.1)', color: '#a855f7' },
  GQL: { bg: 'rgba(229, 53, 171, 0.1)', color: '#e535ab' },
  PROTO: { bg: 'rgba(6, 182, 212, 0.1)', color: '#06b6d4' },
  gRPC: { bg: 'rgba(6, 182, 212, 0.1)', color: '#06b6d4' },
};

function getMethodStyle(method: string): { bg: string; color: string } {
  return METHOD_COLORS[method.toUpperCase()] || { bg: 'rgba(139, 149, 176, 0.1)', color: '#8b95b0' };
}

function getStatusColor(status: number | null): string {
  if (status == null) return '#5a6478';
  if (status === 0) return '#fca5a5'; // TLS handshake failure
  if (status >= 200 && status < 300) return '#4ade80';
  if (status >= 300 && status < 400) return '#60a5fa';
  if (status >= 400 && status < 500) return '#ffb95f';
  if (status >= 500) return '#fca5a5';
  return '#5a6478';
}

function parseUrlPath(fullUrl: string): string {
  try {
    const url = new URL(fullUrl);
    return url.pathname + url.search;
  } catch {
    return fullUrl;
  }
}

export function parseHostname(fullUrl: string): string {
  try {
    return new URL(fullUrl).hostname;
  } catch {
    return '';
  }
}

const REPLAY_STORAGE_KEY = 'darkride-replay-request';

/** Stash a traffic entry into sessionStorage and return the builder URL. */
export function stashReplayRequest(entry: TrafficEntry): string {
  sessionStorage.setItem(REPLAY_STORAGE_KEY, JSON.stringify({
    method: entry.requestMethod,
    url: entry.requestUrl,
    headers: entry.requestHeaders,
    body: entry.requestBody,
  }));
  return '/ui/request-builder?replay=1';
}

/** Pop the stashed replay request (returns null if none). */
export function popReplayRequest(): { method: string; url: string; headers: string | null; body: string | null } | null {
  const raw = sessionStorage.getItem(REPLAY_STORAGE_KEY);
  if (!raw) return null;
  sessionStorage.removeItem(REPLAY_STORAGE_KEY);
  try { return JSON.parse(raw); } catch { return null; }
}

/** React hook that returns a replay handler for traffic entries. */
export function useTrafficReplay(): (entry: TrafficEntry) => void {
  const navigate = useNavigate();
  return (entry: TrafficEntry) => navigate(stashReplayRequest(entry));
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '...';
}

function formatTime(capturedAt: string): string {
  try {
    const d = new Date(capturedAt);
    return d.toLocaleTimeString('en-US', { hour12: false });
  } catch {
    return capturedAt;
  }
}

function tryPrettyJson(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

function formatHeaders(headersJson: string | null): string {
  if (!headersJson) return '';
  try {
    const parsed = JSON.parse(headersJson);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return headersJson;
  }
}

// parseHeadersObject, isBodyTruncated, generateCurl, generateFetch
// are now imported from trafficUtils.ts

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function TrafficEntryRow({ entry, expanded, onExpand, onLoadFullBody, onHideHostname, onBlockHostname, onReplay, wsFrames, onLoadWsFrames }: TrafficEntryRowProps) {
  const isWs = entry.type === 'websocket';
  const isPending = entry.pending === true;
  const urlPath = parseUrlPath(entry.requestUrl);
  const truncatedPath = truncate(urlPath, 60);
  const hostname = parseHostname(entry.requestUrl);
  const truncatedResponse = isBodyTruncated(entry.responseBody);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedCurl, setCopiedCurl] = useState(false);
  const [copiedFetch, setCopiedFetch] = useState(false);
  const [copiedResponse, setCopiedResponse] = useState(false);
  const [copiedRequestBody, setCopiedRequestBody] = useState(false);

  const gqlInfo: GraphQLInfo | null = useMemo(() =>
    detectGraphQL(entry.requestMethod, entry.requestUrl, entry.requestBody),
  [entry.requestMethod, entry.requestUrl, entry.requestBody]);

  const protoInfo: ProtobufInfo | null = useMemo(() =>
    detectProtobuf(entry.requestHeaders, entry.responseHeaders),
  [entry.requestHeaders, entry.responseHeaders]);

  const decodedProtoRequest = useMemo(() => {
    if (!protoInfo?.isRequest || !entry.requestBody) return null;
    return decodeProtobufSchemaless(entry.requestBody, protoInfo?.isGrpc);
  }, [protoInfo, entry.requestBody]);

  const decodedProtoResponse = useMemo(() => {
    if (!protoInfo?.isResponse || !entry.responseBody) return null;
    return decodeProtobufSchemaless(entry.responseBody, protoInfo?.isGrpc);
  }, [protoInfo, entry.responseBody]);

  const decodedUrl = useMemo(() => {
    if (!isGoogleMapsBpbUrl(entry.requestUrl)) return null;
    return decodeGoogleMapsBpb(entry.requestUrl);
  }, [entry.requestUrl]);

  const handleCopyUrl = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(entry.requestUrl);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 1500);
  };

  const handleCopyCurl = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(generateCurl(entry));
    setCopiedCurl(true);
    setTimeout(() => setCopiedCurl(false), 1500);
  };

  const handleCopyFetch = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(generateFetch(entry));
    setCopiedFetch(true);
    setTimeout(() => setCopiedFetch(false), 1500);
  };

  const handleCopyResponse = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(entry.responseBody || '');
    setCopiedResponse(true);
    setTimeout(() => setCopiedResponse(false), 1500);
  };

  const handleCopyRequestBody = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(entry.requestBody || '');
    setCopiedRequestBody(true);
    setTimeout(() => setCopiedRequestBody(false), 1500);
  };

  return (
    <div data-testid={`traffic-row-${entry.id}`}>
      <div
        onClick={() => onExpand(entry.id)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 16px',
          cursor: 'pointer',
          borderBottom: '1px solid var(--border-color, #333)',
          background: expanded ? 'var(--bg-secondary, #1e1e2e)' : 'transparent',
          fontSize: 12,
          fontFamily: 'var(--font-mono, monospace)',
          transition: 'background 0.1s',
        }}
        data-testid={`traffic-row-compact-${entry.id}`}
      >
        <span
          style={(() => {
            const label = isWs ? 'WS' : gqlInfo ? 'GQL' : protoInfo ? (protoInfo.isGrpc ? 'gRPC' : 'PROTO') : entry.requestMethod;
            const proto = PROTOCOL_COLORS[label];
            const style = proto || getMethodStyle(entry.requestMethod);
            return {
              display: 'inline-block',
              padding: '2px 8px',
              borderRadius: 4,
              fontSize: 10,
              fontWeight: 700,
              color: style.color,
              background: style.bg,
              minWidth: 48,
              textAlign: 'center' as const,
            };
          })()}
        >
          {isWs ? 'WS' : gqlInfo ? 'GQL' : protoInfo ? (protoInfo.isGrpc ? 'gRPC' : 'PROTO') : entry.requestMethod}
        </span>
        <span style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {gqlInfo ? (
              <>
                <span style={{ color: gqlInfo.operationType === 'mutation' ? '#f97316' : '#e535ab', fontWeight: 600, marginRight: 4, fontSize: 10 }}>
                  {gqlInfo.operationType.toUpperCase()}
                </span>
                {gqlInfo.operationName || truncatedPath}
              </>
            ) : (
              <>
                {hostname && <span style={{ opacity: 0.4 }}>{hostname}</span>}
                {truncatedPath}
              </>
            )}
          </span>
          {hostname && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span
                style={{ fontSize: 11, color: 'var(--text-muted, #888)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                data-testid={`traffic-row-hostname-${entry.id}`}
              >
                {hostname}
              </span>
              {onBlockHostname && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onBlockHostname(hostname);
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#ef4444',
                    cursor: 'pointer',
                    padding: '0 2px',
                    fontSize: 10,
                    lineHeight: 1,
                    opacity: 0.6,
                    flexShrink: 0,
                  }}
                  title={`Block ${hostname} globally`}
                  data-testid={`block-hostname-${entry.id}`}
                >
                  &#9940;
                </button>
              )}
              {onHideHostname && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onHideHostname(hostname);
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-muted, #888)',
                    cursor: 'pointer',
                    padding: '0 2px',
                    fontSize: 10,
                    lineHeight: 1,
                    opacity: 0.6,
                    flexShrink: 0,
                  }}
                  title={`Hide ${hostname}`}
                  data-testid={`hide-hostname-${entry.id}`}
                >
                  &#10005;
                </button>
              )}
            </span>
          )}
        </span>
        {entry.matchedRules && entry.matchedRules.length > 0 && (
          <RuleAttribution rules={entry.matchedRules} />
        )}
        <span
          style={{
            color: isPending ? '#f59e0b' : isWs ? '#805ad5' : getStatusColor(entry.responseStatus),
            fontWeight: 600,
            minWidth: 32,
            textAlign: 'right',
            fontSize: isPending ? 11 : isWs ? 11 : undefined,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
          data-testid={isPending ? `traffic-row-pending-${entry.id}` : undefined}
        >
          {isPending ? (
            <>
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: '#f59e0b',
                  animation: 'darkride-pending-pulse 1.5s ease-in-out infinite',
                }}
              />
              Pending
            </>
          ) : isWs ? `${entry.wsMessageCount ?? 0} frames` : entry.responseStatus === 0 ? 'TLS \u2717' : (entry.responseStatus ?? '---')}
        </span>
        <span style={{ color: 'var(--text-muted, #888)', fontSize: 11, minWidth: 64, textAlign: 'right' }}>
          {formatTime(entry.capturedAt)}
        </span>
      </div>

      {expanded && (
        <div
          style={{
            padding: '8px 16px 12px',
            background: 'var(--bg-secondary, #1e1e2e)',
            borderBottom: '1px solid var(--border-color, #333)',
            fontSize: 12,
            fontFamily: 'var(--font-mono, monospace)',
          }}
          data-testid={`traffic-row-expanded-${entry.id}`}
        >
          <div style={{ marginBottom: 8 }}>
            <strong style={{ color: 'var(--text-muted, #888)' }}>URL:</strong>{' '}
            <span style={{ wordBreak: 'break-all' }}>{entry.requestUrl}</span>
          </div>

          {decodedUrl && <BpbDecodedSection info={decodedUrl} />}

          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <button
              className="btn btn-sm"
              onClick={handleCopyUrl}
              style={{ fontSize: 11, padding: '2px 8px' }}
              data-testid={`copy-url-${entry.id}`}
            >
              {copiedUrl ? 'Copied!' : 'Copy URL'}
            </button>
            {!isWs && (
              <>
                <button
                  className="btn btn-sm"
                  onClick={handleCopyCurl}
                  style={{ fontSize: 11, padding: '2px 8px' }}
                  data-testid={`copy-curl-${entry.id}`}
                >
                  {copiedCurl ? 'Copied!' : 'Copy as cURL'}
                </button>
                <button
                  className="btn btn-sm"
                  onClick={handleCopyFetch}
                  style={{ fontSize: 11, padding: '2px 8px' }}
                  data-testid={`copy-fetch-${entry.id}`}
                >
                  {copiedFetch ? 'Copied!' : 'Copy as Fetch'}
                </button>
                {entry.responseBody != null && (
                  <button
                    className="btn btn-sm"
                    onClick={handleCopyResponse}
                    style={{ fontSize: 11, padding: '2px 8px' }}
                    data-testid={`copy-response-${entry.id}`}
                  >
                    {copiedResponse ? 'Copied!' : 'Copy Response'}
                  </button>
                )}
                {entry.requestBody != null && (
                  <button
                    className="btn btn-sm"
                    onClick={handleCopyRequestBody}
                    style={{ fontSize: 11, padding: '2px 8px' }}
                    data-testid={`copy-request-body-${entry.id}`}
                  >
                    {copiedRequestBody ? 'Copied!' : 'Copy Request Body'}
                  </button>
                )}
                {onReplay && (
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={(e) => { e.stopPropagation(); onReplay(entry); }}
                    style={{ fontSize: 11, padding: '2px 8px' }}
                    data-testid={`replay-${entry.id}`}
                  >
                    Replay
                  </button>
                )}
              </>
            )}
          </div>

          {entry.requestHeaders && (
            <div style={{ marginBottom: 8 }}>
              <strong style={{ color: 'var(--text-muted, #888)' }}>{isWs ? 'Upgrade Headers:' : 'Request Headers:'}</strong>
              <pre style={{
                margin: '4px 0 0',
                padding: 8,
                background: 'var(--bg-primary, #121220)',
                borderRadius: 4,
                overflow: 'auto',
                maxHeight: 200,
                fontSize: 11,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}>
                {formatHeaders(entry.requestHeaders)}
              </pre>
            </div>
          )}

          {!isWs && entry.requestBody && (
            gqlInfo ? (
              <>
                <div style={{ marginBottom: 8 }}>
                  <strong style={{ color: '#e535ab' }}>GraphQL {gqlInfo.operationType}{gqlInfo.operationName ? `: ${gqlInfo.operationName}` : ''}:</strong>
                  <pre style={{
                    margin: '4px 0 0',
                    padding: 8,
                    background: 'var(--bg-primary, #121220)',
                    borderRadius: 4,
                    overflow: 'auto',
                    maxHeight: 250,
                    fontSize: 11,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  }}>
                    {formatGraphQLQuery(gqlInfo.query)}
                  </pre>
                </div>
                {gqlInfo.variables && Object.keys(gqlInfo.variables).length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <strong style={{ color: 'var(--text-muted, #888)' }}>Variables:</strong>
                    <pre style={{
                      margin: '4px 0 0',
                      padding: 8,
                      background: 'var(--bg-primary, #121220)',
                      borderRadius: 4,
                      overflow: 'auto',
                      maxHeight: 150,
                      fontSize: 11,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                    }}>
                      {JSON.stringify(gqlInfo.variables, null, 2)}
                    </pre>
                  </div>
                )}
              </>
            ) : decodedProtoRequest ? (
              <ProtobufDecodedSection label="Request" fields={decodedProtoRequest} isGrpc={protoInfo?.isGrpc ?? false} />
            ) : (
              <div style={{ marginBottom: 8 }}>
                <strong style={{ color: 'var(--text-muted, #888)' }}>Request Body:</strong>
                <pre style={{
                  margin: '4px 0 0',
                  padding: 8,
                  background: 'var(--bg-primary, #121220)',
                  borderRadius: 4,
                  overflow: 'auto',
                  maxHeight: 200,
                  fontSize: 11,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}>
                  {tryPrettyJson(entry.requestBody)}
                </pre>
              </div>
            )
          )}

          {isWs && entry.wsCloseCode != null && (
            <div style={{ marginBottom: 8 }}>
              <strong style={{ color: 'var(--text-muted, #888)' }}>Close:</strong>{' '}
              <span>{entry.wsCloseCode} {entry.wsCloseReason || ''}</span>
            </div>
          )}

          {isWs && (
            <WsFrameSection
              entry={entry}
              frames={wsFrames || []}
              onLoadFrames={onLoadWsFrames}
            />
          )}

          {!isWs && entry.responseHeaders && (
            <div style={{ marginBottom: 8 }}>
              <strong style={{ color: 'var(--text-muted, #888)' }}>Response Headers:</strong>
              <pre style={{
                margin: '4px 0 0',
                padding: 8,
                background: 'var(--bg-primary, #121220)',
                borderRadius: 4,
                overflow: 'auto',
                maxHeight: 200,
                fontSize: 11,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}>
                {formatHeaders(entry.responseHeaders)}
              </pre>
            </div>
          )}

          {!isWs && decodedProtoResponse && (
            <ProtobufDecodedSection label="Response" fields={decodedProtoResponse} isGrpc={protoInfo?.isGrpc ?? false} />
          )}

          {!isWs && entry.responseBody != null && !decodedProtoResponse && (
            <div style={{ marginBottom: 0 }}>
              <strong style={{ color: 'var(--text-muted, #888)' }}>Response Body:</strong>
              {truncatedResponse && onLoadFullBody && (
                <button
                  className="btn btn-sm"
                  style={{ marginLeft: 8, fontSize: 11, padding: '1px 6px' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onLoadFullBody(entry.id);
                  }}
                  data-testid={`load-full-body-${entry.id}`}
                >
                  Load Full Body
                </button>
              )}
              <pre style={{
                margin: '4px 0 0',
                padding: 8,
                background: 'var(--bg-primary, #121220)',
                borderRadius: 4,
                overflow: 'auto',
                maxHeight: 300,
                fontSize: 11,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}>
                {tryPrettyJson(entry.responseBody)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProtobufDecodedSection({ label, fields, isGrpc }: { label: string; fields: DecodedProtobufField[]; isGrpc: boolean }) {
  return (
    <div
      style={{
        marginBottom: 8,
        padding: 8,
        background: 'var(--bg-primary, #121220)',
        borderRadius: 4,
        border: '1px solid var(--border-color, #333)',
      }}
      data-testid={`protobuf-decoded-${label.toLowerCase()}`}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{
          background: '#06b6d4',
          color: '#fff',
          borderRadius: 4,
          padding: '1px 8px',
          fontSize: 11,
          fontWeight: 600,
        }}>
          {isGrpc ? 'gRPC' : 'Protobuf'} {label}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted, #888)' }}>{fields.length} field{fields.length !== 1 ? 's' : ''}</span>
      </div>
      <pre style={{
        margin: 0,
        fontSize: 11,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        color: '#e2e8f0',
        maxHeight: 300,
        overflow: 'auto',
      }}>
        {formatProtobufTree(fields)}
      </pre>
    </div>
  );
}

function BpbDecodedSection({ info }: { info: BpbDecodedInfo }) {
  const kvStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    gap: '2px 12px',
    fontSize: 11,
  };
  const labelStyle: React.CSSProperties = { color: 'var(--text-muted, #888)', whiteSpace: 'nowrap' };
  const valueStyle: React.CSSProperties = { color: '#e2e8f0' };

  return (
    <div
      style={{
        marginBottom: 8,
        padding: 8,
        background: 'var(--bg-primary, #121220)',
        borderRadius: 4,
        border: '1px solid var(--border-color, #333)',
      }}
      data-testid="bpb-decoded-section"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{
          background: '#2563eb',
          color: '#fff',
          borderRadius: 4,
          padding: '1px 8px',
          fontSize: 11,
          fontWeight: 600,
        }}>
          Google Maps Protobuf
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted, #888)' }}>{info.label}</span>
      </div>
      <div style={kvStyle}>
        {info.tiles.map((tile, i) => (
          <React.Fragment key={i}>
            <span style={labelStyle}>{info.tiles.length > 1 ? `Tile ${i + 1}:` : 'Tile:'}</span>
            <span style={valueStyle}>
              z={tile.z} x={tile.x} y={tile.y}
            </span>
          </React.Fragment>
        ))}
        {info.locale && (
          <>
            <span style={labelStyle}>Locale:</span>
            <span style={valueStyle}>{info.locale}</span>
          </>
        )}
        {info.country && (
          <>
            <span style={labelStyle}>Country:</span>
            <span style={valueStyle}>{info.country}</span>
          </>
        )}
        {info.style && (
          <>
            <span style={labelStyle}>Style:</span>
            <span style={valueStyle}>{info.style}</span>
          </>
        )}
        {info.scaleFactor && (
          <>
            <span style={labelStyle}>Scale:</span>
            <span style={valueStyle}>{info.scaleFactor}x</span>
          </>
        )}
        {Object.keys(info.styleFlags).length > 0 && (
          <>
            <span style={labelStyle}>Flags:</span>
            <span style={valueStyle}>
              {Object.entries(info.styleFlags).map(([k, v]) => `${k}=${v}`).join(', ')}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

const TYPE_COLORS: Record<string, string> = {
  REQ: '#38a169',
  RPY: '#3182ce',
  ERR: '#e53e3e',
  ACK: '#888',
  TXT: '#d69e2e',
  '???': '#888',
};

function WsFrameSection({ entry, frames, onLoadFrames }: {
  entry: TrafficEntry;
  frames: WebSocketMessageEntry[];
  onLoadFrames?: (id: number) => void;
}) {
  const [dirFilter, setDirFilter] = useState<string>('All');
  const [expandedMsg, setExpandedMsg] = useState<number | null>(null);

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

  // Request frames on first render if not loaded
  React.useEffect(() => {
    if (frames.length === 0 && onLoadFrames && (entry.wsMessageCount ?? 0) > 0) {
      onLoadFrames(entry.id);
    }
  }, [entry.id]);

  const filtered = useMemo(() => {
    if (dirFilter === 'All') return frames;
    return frames.filter(f => f.direction === dirFilter);
  }, [frames, dirFilter]);

  if (frames.length === 0 && (entry.wsMessageCount ?? 0) === 0) {
    return <div style={{ color: 'var(--text-muted, #888)', fontStyle: 'italic', padding: '4px 0' }}>No frames captured</div>;
  }

  if (frames.length === 0) {
    return <div style={{ color: 'var(--text-muted, #888)', fontStyle: 'italic', padding: '4px 0' }}>Loading frames...</div>;
  }

  return (
    <div>
      {decoder && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <span style={{ background: '#805ad5', color: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: 12, fontWeight: 'bold' }}>
            Protocol: {decoder.name}
          </span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className={`btn btn-sm${viewMode === 'decoded' ? ' btn-primary' : ''}`} onClick={() => setViewMode('decoded')}>Decoded</button>
            <button className={`btn btn-sm${viewMode === 'raw' ? ' btn-primary' : ''}`} onClick={() => setViewMode('raw')}>Raw Frames</button>
          </div>
        </div>
      )}

      {viewMode === 'decoded' && decodedMessages ? (
        <>
          <strong style={{ color: 'var(--text-muted, #888)' }}>Messages ({decodedMessages.length}):</strong>
          <div style={{ maxHeight: 400, overflow: 'auto', border: '1px solid var(--border-color, #333)', borderRadius: 4, marginTop: 4 }}>
            {decodedMessages.map((m, i) => {
              const profile = m.properties.Profile || m.properties.profile;
              const errorInfo = m.properties['Error-Code'] || m.properties['Error-Domain'];
              const isExpanded = expandedMsg === i;
              return (
                <div key={i} style={{ borderBottom: '1px solid #222' }}>
                  <div
                    style={{ padding: '4px 8px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
                    onClick={() => setExpandedMsg(isExpanded ? null : i)}
                  >
                    <span style={{ color: m.direction === 'send' ? '#38a169' : '#3182ce', fontWeight: 'bold', minWidth: 14 }}>
                      {m.direction === 'send' ? '\u2191' : '\u2193'}
                    </span>
                    <span style={{ background: TYPE_COLORS[m.typeLabel] || '#888', color: '#fff', borderRadius: 3, padding: '0 5px', fontSize: 10, fontWeight: 'bold', minWidth: 28, textAlign: 'center' }}>
                      {m.typeLabel}
                    </span>
                    <span style={{ color: '#aaa', minWidth: 30 }}>#{m.messageNumber}</span>
                    {profile && <span style={{ color: '#e2e8f0', fontWeight: 'bold' }}>{profile}</span>}
                    {errorInfo && <span style={{ color: '#fc8181' }}>Error: {m.properties['Error-Code']} {m.properties['Error-Domain'] || ''}</span>}
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#a0aec0' }}>
                      {m.body && !m.body.startsWith('[') ? (m.body.length > 80 ? m.body.slice(0, 80) + '\u2026' : m.body) : ''}
                    </span>
                    {m.bodySize > 0 && <span style={{ color: '#888', whiteSpace: 'nowrap', fontSize: 11 }}>{formatBytes(m.bodySize)}</span>}
                    <span style={{ color: '#888', whiteSpace: 'nowrap', fontSize: 11 }}>{new Date(m.timestamp).toLocaleTimeString()}</span>
                  </div>
                  {isExpanded && (
                    <div style={{ padding: '4px 8px 8px 36px', fontSize: 12, borderTop: '1px solid #2d3748' }}>
                      {Object.keys(m.properties).length > 0 && (
                        <div style={{ marginBottom: 4 }}>
                          <strong style={{ color: '#a0aec0' }}>Properties:</strong>
                          <pre style={{ margin: '2px 0', fontSize: 11, color: '#cbd5e0' }}>
                            {Object.entries(m.properties).map(([k, v]) => `${k}: ${v}`).join('\n')}
                          </pre>
                        </div>
                      )}
                      {m.body && (
                        <div>
                          <strong style={{ color: '#a0aec0' }}>Body:</strong>
                          <pre style={{ margin: '2px 0', fontSize: 11, color: '#cbd5e0', maxHeight: 200, overflow: 'auto' }}>
                            {tryPrettyJson(m.body)}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
            <strong style={{ color: 'var(--text-muted, #888)' }}>Frames ({frames.length}):</strong>
            {(['All', 'send', 'receive'] as const).map(d => (
              <button
                key={d}
                className={`btn btn-sm${dirFilter === d ? ' btn-primary' : ''}`}
                onClick={() => setDirFilter(d)}
                style={{ fontSize: 11, padding: '1px 6px' }}
              >
                {d === 'send' ? '\u2191 Sent' : d === 'receive' ? '\u2193 Received' : 'All'}
              </button>
            ))}
            {dirFilter !== 'All' && (
              <span style={{ fontSize: 11, color: '#888' }}>{filtered.length} / {frames.length}</span>
            )}
          </div>
          <div style={{ maxHeight: 400, overflow: 'auto', border: '1px solid var(--border-color, #333)', borderRadius: 4 }}>
            {filtered.length === 0 ? (
              <div style={{ padding: 12, color: '#888' }}>No frames match filter</div>
            ) : (
              filtered.map((f, i) => (
                <div
                  key={f.id || i}
                  style={{ padding: '4px 8px', borderBottom: '1px solid #222', fontSize: 12, display: 'flex', alignItems: 'flex-start', gap: 8 }}
                >
                  <span style={{ color: f.direction === 'send' ? '#38a169' : '#3182ce', fontWeight: 'bold', minWidth: 14 }}>
                    {f.direction === 'send' ? '\u2191' : '\u2193'}
                  </span>
                  {f.isBinary && (
                    <span style={{ background: '#4a5568', color: '#fff', borderRadius: 3, padding: '0 4px', fontSize: 10 }}>binary</span>
                  )}
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {f.payload ? (f.payload.length > 200 ? f.payload.slice(0, 200) + '\u2026' : f.payload) : '(empty)'}
                  </span>
                  <span style={{ color: '#888', whiteSpace: 'nowrap' }}>{formatBytes(f.payloadSize)}</span>
                  <span style={{ color: '#888', whiteSpace: 'nowrap', fontSize: 11 }}>{new Date(f.timestamp).toLocaleTimeString()}</span>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
