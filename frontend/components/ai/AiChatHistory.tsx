import React, { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { formatDateRelative } from '../../utils/format';
import type { AiConversation, AiConversationListResponse, AiConversationSummary } from '../../../shared/types/ai-chat';

const PAGE_SIZE = 30;
const SEARCH_DEBOUNCE_MS = 250;
const MAX_CONTEXT_ID_LENGTH = 24;

const CONTEXT_NAMES: Record<string, string> = {
  'session-timeline': 'Session timeline',
  automations: 'Automations',
  traffic: 'Traffic',
  devices: 'Devices',
  credentials: 'Credentials',
  proxies: 'Proxies',
  'apk-analysis': 'APK analysis',
  'apk-diff': 'APK diff',
  frida: 'Frida',
  'api-catalogue': 'API catalogue',
  dashboard: 'Dashboard',
};

/** A readable name for where a chat started, such as "APK analysis #12". */
export function describeContext(pageContext: string, contextId: string | null): string {
  const words = pageContext.replace(/[-_]+/g, ' ').trim();
  const name = CONTEXT_NAMES[pageContext] ?? words.charAt(0).toUpperCase() + words.slice(1);
  if (!contextId) return name;
  const id = contextId.length > MAX_CONTEXT_ID_LENGTH ? `${contextId.slice(0, MAX_CONTEXT_ID_LENGTH - 1)}…` : contextId;
  return `${name} #${id}`;
}

export interface AiChatHistoryProps {
  pageContext: string;
  contextId: string;
  openConversationId: number | null;
  /** A reply is streaming, so opening or deleting a chat would pull the conversation out from under it. */
  busy: boolean;
  onOpen: (conversation: AiConversation) => void;
  onDeleted: (id: number) => void;
  onClose: () => void;
}

type Scope = 'all' | 'page';

export function AiChatHistory({ pageContext, contextId, openConversationId, busy, onOpen, onDeleted, onClose }: AiChatHistoryProps) {
  const ws = useWebSocket();
  const wsRef = useRef(ws);
  wsRef.current = ws;

  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  const [items, setItems] = useState<AiConversationSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [moreStatus, setMoreStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [workingId, setWorkingId] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const requestSeq = useRef(0);
  const serverOffset = useRef(0);

  const request = async (offset: number): Promise<AiConversationListResponse | null> => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (search) params.set('q', search);
    if (scope === 'page') {
      params.set('pageContext', pageContext);
      params.set('contextId', contextId);
    }
    try {
      const res = await wsRef.current.sendRestApi('GET', `/v1/ai/conversations?${params}`);
      const data = res.body?.data;
      return res.status === 200 && data && Array.isArray(data.conversations) ? data : null;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === search) return;
    const timer = setTimeout(() => setSearch(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, search]);

  // Only the newest request may write; a slower earlier one is dropped.
  useEffect(() => {
    const seq = ++requestSeq.current;
    setStatus('loading');
    setMoreStatus('idle');
    setConfirmId(null);
    void request(0).then(data => {
      if (seq !== requestSeq.current) return;
      if (!data) {
        setStatus('error');
        return;
      }
      serverOffset.current = data.conversations.length;
      setItems(data.conversations);
      setHasMore(data.hasMore);
      setStatus('ready');
    });
  }, [search, scope, pageContext, contextId, reloadKey]);

  const loadMore = async () => {
    const seq = requestSeq.current;
    setMoreStatus('loading');
    const data = await request(serverOffset.current);
    if (seq !== requestSeq.current) return;
    if (!data) {
      setMoreStatus('error');
      return;
    }
    serverOffset.current += data.conversations.length;
    setItems(prev => {
      const known = new Set(prev.map(c => c.id));
      return [...prev, ...data.conversations.filter(c => !known.has(c.id))];
    });
    setHasMore(data.hasMore);
    setMoreStatus('idle');
  };

  const removeRow = (id: number) => {
    serverOffset.current = Math.max(0, serverOffset.current - 1);
    setItems(prev => prev.filter(c => c.id !== id));
  };

  const openRow = async (id: number) => {
    setActionError(null);
    setWorkingId(id);
    try {
      const res = await wsRef.current.sendRestApi('GET', `/v1/ai/conversations/${id}`);
      if (res.status === 404) {
        removeRow(id);
        setActionError('That chat no longer exists.');
      } else if (res.status !== 200 || !res.body?.data) {
        setActionError('Could not open that chat.');
      } else {
        onOpen(res.body.data as AiConversation);
      }
    } catch {
      setActionError('Could not open that chat.');
    } finally {
      setWorkingId(null);
    }
  };

  const deleteRow = async (id: number) => {
    setActionError(null);
    setWorkingId(id);
    try {
      const res = await wsRef.current.sendRestApi('DELETE', `/v1/ai/conversations/${id}`);
      if (res.status === 200 || res.status === 404) {
        removeRow(id);
        onDeleted(id);
      } else {
        setActionError('Could not delete that chat.');
      }
    } catch {
      setActionError('Could not delete that chat.');
    } finally {
      setConfirmId(null);
      setWorkingId(null);
    }
  };

  const locked = busy || workingId !== null;
  const emptyText = search
    ? 'No chats match your search'
    : scope === 'page'
      ? 'No saved chats on this page yet'
      : 'No saved chats yet';

  return (
    <div
      className="ai-chat-history"
      data-testid="ai-chat-history"
      onKeyDown={e => {
        if (e.key !== 'Escape') return;
        e.stopPropagation(); // the drawer closes itself on a window-level Escape
        if (confirmId !== null) setConfirmId(null);
        else onClose();
      }}
    >
      <div className="ai-chat-history-controls">
        <input
          type="search"
          className="ai-chat-history-search"
          data-testid="ai-chat-history-search"
          placeholder="Search chats"
          aria-label="Search chats"
          value={query}
          onChange={e => setQuery(e.target.value)}
          autoFocus
        />
        <div className="ai-chat-history-scope" role="group" aria-label="Show chats from">
          <button
            type="button"
            className={`ai-chat-history-chip${scope === 'page' ? ' ai-chat-history-chip-on' : ''}`}
            aria-pressed={scope === 'page'}
            onClick={() => setScope('page')}
            data-testid="ai-chat-history-scope-page"
          >
            This page
          </button>
          <button
            type="button"
            className={`ai-chat-history-chip${scope === 'all' ? ' ai-chat-history-chip-on' : ''}`}
            aria-pressed={scope === 'all'}
            onClick={() => setScope('all')}
            data-testid="ai-chat-history-scope-all"
          >
            All pages
          </button>
        </div>
      </div>

      {actionError && (
        <div className="ai-chat-history-action-error" role="alert" data-testid="ai-chat-history-action-error">
          {actionError}
        </div>
      )}

      <div className="ai-chat-history-body">
        {status === 'error' ? (
          <div className="ai-chat-history-state" data-testid="ai-chat-history-error">
            <p>Could not load your chats.</p>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setReloadKey(k => k + 1)}
              data-testid="ai-chat-history-retry"
            >
              Retry
            </button>
          </div>
        ) : items.length === 0 ? (
          status === 'loading' ? (
            <div className="ai-chat-history-state" data-testid="ai-chat-history-loading">
              <span className="spinner spinner-sm" />
              <span>Loading chats...</span>
            </div>
          ) : (
            <div className="ai-chat-history-state" data-testid="ai-chat-history-empty">
              <p>{emptyText}</p>
            </div>
          )
        ) : (
          <>
            <ul className="ai-chat-history-list">
              {items.map(item => {
                const active = item.id === openConversationId;
                return (
                  <li key={item.id} className={`ai-chat-history-row${active ? ' ai-chat-history-row-active' : ''}`}>
                    {confirmId === item.id ? (
                      <div className="ai-chat-history-confirm">
                        <span className="ai-chat-history-confirm-text" data-testid="ai-chat-history-confirm-text">
                          Delete “{item.title || 'Untitled chat'}”?
                        </span>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          autoFocus
                          onClick={() => setConfirmId(null)}
                          data-testid="ai-chat-history-delete-cancel"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          disabled={workingId === item.id}
                          onClick={() => void deleteRow(item.id)}
                          data-testid="ai-chat-history-delete-confirm"
                        >
                          Delete
                        </button>
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="ai-chat-history-open"
                          disabled={locked}
                          title={busy ? 'Wait for the reply to finish' : undefined}
                          aria-current={active ? 'true' : undefined}
                          onClick={() => void openRow(item.id)}
                          data-testid={`ai-chat-history-item-${item.id}`}
                        >
                          <span className="ai-chat-history-title">{item.title || 'Untitled chat'}</span>
                          <span className="ai-chat-history-meta">
                            {describeContext(item.pageContext, item.contextId)}
                            {' · '}
                            {formatDateRelative(new Date(item.updatedAt).toISOString())}
                            {item.unfinished && <span className="ai-chat-history-badge">Unfinished</span>}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="ai-chat-history-delete"
                          aria-label="Delete chat"
                          disabled={locked}
                          title={busy ? 'Wait for the reply to finish' : 'Delete chat'}
                          onClick={() => setConfirmId(item.id)}
                          data-testid={`ai-chat-history-delete-${item.id}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
            {moreStatus === 'error' && (
              <p className="ai-chat-history-action-error" data-testid="ai-chat-history-more-error">
                Could not load more chats.
              </p>
            )}
            {hasMore && (
              <button
                type="button"
                className="btn btn-secondary btn-sm ai-chat-history-more"
                disabled={moreStatus === 'loading'}
                onClick={() => void loadMore()}
                data-testid="ai-chat-history-more"
              >
                {moreStatus === 'loading' ? 'Loading...' : 'Load more'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
