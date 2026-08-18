import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import { Copy, Check } from 'lucide-react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { ToolCallCard } from './ToolCallCard';
import { ShieldAlert } from 'lucide-react';
import type {
  AiTokenEvent,
  AiToolStartEvent,
  AiToolResultEvent,
  AiDoneEvent,
  AiErrorEvent,
  AiContextUsageEvent,
  AiToolConfirmEvent,
  AiMessage,
  AiTextBlock,
  AiToolUseBlock,
} from '../../../shared/types/ai-chat';

export interface ToolCall {
  toolUseId: string;
  toolName: string;
  input: Record<string, any>;
  output?: string;
  durationMs?: number;
  isRunning: boolean;
}

export interface MessageSegment {
  type: 'text' | 'tools';
  text?: string;
  tools?: ToolCall[];
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  segments?: MessageSegment[];
}

interface AiChatPanelProps {
  pageContext: string;
  contextId: string;
  onStreamingChange?: (streaming: boolean) => void;
}

const SUGGESTED_PROMPTS: Record<string, string[]> = {
  'session-timeline': [
    'Summarize what happened in this session',
    'Find any errors or failures',
    'What URLs were requested?',
  ],
  'traffic': [
    'What are the most common API endpoints?',
    'Find any failed requests',
    'Summarize the traffic patterns',
  ],
  'automations': [
    'List all automations and their status',
    'Which automations ran recently?',
  ],
  'dashboard': [
    'Give me a summary of the system',
    'What happened recently?',
  ],
  'apk-analysis': [
    'Summarize this APK and its security findings',
    'What URLs and secrets were found?',
    'Search the code for API keys or tokens',
  ],
};

/** Extract plain text from React children (handles nested highlight.js spans) */
function extractText(node: React.ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (React.isValidElement(node) && node.props) {
    return extractText((node.props as any).children);
  }
  return '';
}

function CodeBlock({ children, ...props }: React.HTMLAttributes<HTMLPreElement>) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    const text = extractText(children);
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }, [children]);

  return (
    <pre {...props}>
      <button
        className={`ai-code-copy-btn${copied ? ' copied' : ''}`}
        onClick={handleCopy}
        title="Copy code"
        type="button"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
      {children}
    </pre>
  );
}

const markdownComponents: Components = {
  pre: CodeBlock,
};

function ToolGroup({ tools, isLive }: { tools: ToolCall[]; isLive?: boolean }) {
  if (tools.length === 0) return null;
  return (
    <div className="ai-chat-tool-group" data-testid="ai-chat-tool-group">
      {tools.map(tc => (
        <div key={tc.toolUseId}>
          <div className="ai-chat-tool-label" data-testid="ai-chat-tool-label">
            {tc.isRunning ? `Calling ${tc.toolName}...` : `Called ${tc.toolName}`}
          </div>
          <ToolCallCard
            toolName={tc.toolName}
            input={tc.input}
            output={tc.output}
            durationMs={tc.durationMs}
            isRunning={tc.isRunning}
          />
        </div>
      ))}
    </div>
  );
}

function renderSegments(segments: MessageSegment[], isLive?: boolean) {
  return segments.map((seg, j) =>
    seg.type === 'text' && seg.text ? (
      <ReactMarkdown key={j} remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents}>
        {seg.text}
      </ReactMarkdown>
    ) : seg.type === 'tools' && seg.tools ? (
      <ToolGroup key={j} tools={seg.tools} isLive={isLive} />
    ) : null,
  );
}

function StatusIndicator({ isStreaming, segments }: {
  isStreaming: boolean;
  segments: MessageSegment[];
}) {
  if (!isStreaming) return null;

  const runningTool = segments
    .flatMap(s => s.tools || [])
    .find(t => t.isRunning);

  if (runningTool) {
    return (
      <div className="ai-chat-status" data-testid="ai-chat-status">
        <span className="spinner spinner-sm" />
        <span>Running <code>{runningTool.toolName}</code>...</span>
      </div>
    );
  }

  const hasText = segments.some(s => s.type === 'text' && s.text);

  if (hasText) {
    return (
      <div className="ai-chat-status" data-testid="ai-chat-status">
        <span className="ai-chat-status-dots">
          <span className="ai-chat-dot" />
          <span className="ai-chat-dot" />
          <span className="ai-chat-dot" />
        </span>
        <span>Writing...</span>
      </div>
    );
  }

  return (
    <div className="ai-chat-status" data-testid="ai-chat-status">
      <span className="ai-chat-status-dots">
        <span className="ai-chat-dot" />
        <span className="ai-chat-dot" />
        <span className="ai-chat-dot" />
      </span>
      <span>Thinking...</span>
    </div>
  );
}

/**
 * Convert DB messages (AiMessage[]) to frontend ChatMessage[] with segments.
 * Groups assistant content blocks into ordered segments and attaches tool results.
 */
export function convertDbMessages(dbMessages: AiMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];

  for (const msg of dbMessages) {
    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      const blocks = msg.content as Array<AiTextBlock | AiToolUseBlock>;
      const segments: MessageSegment[] = [];
      const textParts: string[] = [];

      for (const block of blocks) {
        if (block.type === 'text') {
          // Accumulate into current text segment or create new one
          const last = segments[segments.length - 1];
          if (last?.type === 'text') {
            last.text = (last.text || '') + block.text;
          } else {
            segments.push({ type: 'text', text: block.text });
          }
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          const tool: ToolCall = {
            toolUseId: block.id,
            toolName: block.name,
            input: block.input,
            isRunning: false,
          };
          const last = segments[segments.length - 1];
          if (last?.type === 'tools') {
            last.tools = [...(last.tools || []), tool];
          } else {
            segments.push({ type: 'tools', tools: [tool] });
          }
        }
      }

      result.push({
        role: 'assistant',
        content: textParts.join(''),
        segments: segments.length > 0 ? segments : undefined,
      });
    } else if (msg.role === 'tool_result') {
      // Attach tool result to the matching tool in the last assistant message
      for (let i = result.length - 1; i >= 0; i--) {
        const prev = result[i];
        if (prev.role !== 'assistant' || !prev.segments) continue;
        let found = false;
        for (const seg of prev.segments) {
          if (seg.type !== 'tools' || !seg.tools) continue;
          for (let t = 0; t < seg.tools.length; t++) {
            if (seg.tools[t].toolUseId === msg.toolUseId) {
              seg.tools[t] = { ...seg.tools[t], output: msg.content };
              found = true;
              break;
            }
          }
          if (found) break;
        }
        if (found) break;
      }
    }
  }

  return result;
}

interface PendingConfirm {
  toolUseId: string;
  toolName: string;
  input: Record<string, any>;
}

export function AiChatPanel({ pageContext, contextId, onStreamingChange }: AiChatPanelProps) {
  const ws = useWebSocket();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [streamingSegments, setStreamingSegments] = useState<MessageSegment[]>([]);
  const [turnLimitReached, setTurnLimitReached] = useState(false);
  const [contextPercent, setContextPercent] = useState<number | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const streamingSegmentsRef = useRef<MessageSegment[]>([]);
  const staleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-scroll to bottom when messages change or streaming updates
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingSegments]);

  // Notify parent of streaming state changes
  useEffect(() => {
    onStreamingChange?.(isStreaming);
  }, [isStreaming, onStreamingChange]);

  // Clean up stale timer on unmount
  useEffect(() => {
    return () => {
      if (staleTimerRef.current) clearTimeout(staleTimerRef.current);
    };
  }, []);

  // Load latest conversation for this context on mount
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ pageContext, contextId });
    ws.sendRestApi('GET', `/v1/ai/conversations/latest?${params}`)
      .then(res => {
        if (cancelled) return;
        if (res.status === 200 && res.body?.data) {
          const conv = res.body.data;
          const restored = convertDbMessages(conv.messages);
          if (restored.length > 0) {
            setMessages(restored);
            setConversationId(conv.id);
          }
        }
      })
      .catch(() => { /* ignore load errors */ });
    return () => { cancelled = true; };
  }, [ws, pageContext, contextId]);

  const resetStaleTimer = useCallback(() => {
    if (staleTimerRef.current) clearTimeout(staleTimerRef.current);
    staleTimerRef.current = setTimeout(() => {
      // No events for 2 minutes — assume stream is dead
      const segments = streamingSegmentsRef.current;
      const content = segments
        .filter(s => s.type === 'text')
        .map(s => s.text || '')
        .join('');
      const errorMsg: ChatMessage = {
        role: 'assistant',
        content: content || 'Error: Response timed out',
        segments: [
          ...(segments.length > 0 ? segments : []),
          { type: 'text', text: '\n\n*Response timed out*' },
        ],
      };
      setMessages(prev => [...prev, errorMsg]);
      setStreamingSegments([]);
      setIsStreaming(false);
      streamingSegmentsRef.current = [];
    }, 120_000);
  }, []);

  const clearStaleTimer = useCallback(() => {
    if (staleTimerRef.current) {
      clearTimeout(staleTimerRef.current);
      staleTimerRef.current = null;
    }
  }, []);

  // WebSocket subscriptions
  useEffect(() => {
    const unsubs: (() => void)[] = [];

    unsubs.push(ws.subscribe('ai:token', (msg: AiTokenEvent) => {
      resetStaleTimer();
      setStreamingSegments(prev => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.type === 'text') {
          next[next.length - 1] = { ...last, text: (last.text || '') + msg.text };
        } else {
          next.push({ type: 'text', text: msg.text });
        }
        streamingSegmentsRef.current = next;
        return next;
      });
    }));

    unsubs.push(ws.subscribe('ai:tool-start', (msg: AiToolStartEvent) => {
      resetStaleTimer();
      setStreamingSegments(prev => {
        const next = [...prev];
        const last = next[next.length - 1];
        const newTool: ToolCall = {
          toolUseId: msg.toolUseId,
          toolName: msg.toolName,
          input: msg.input,
          isRunning: true,
        };
        if (last?.type === 'tools') {
          next[next.length - 1] = { ...last, tools: [...(last.tools || []), newTool] };
        } else {
          next.push({ type: 'tools', tools: [newTool] });
        }
        streamingSegmentsRef.current = next;
        return next;
      });
    }));

    unsubs.push(ws.subscribe('ai:tool-result', (msg: AiToolResultEvent) => {
      resetStaleTimer();
      setStreamingSegments(prev => {
        const next = prev.map(seg => {
          if (seg.type !== 'tools') return seg;
          const updatedTools = seg.tools?.map(t =>
            t.toolUseId === msg.toolUseId
              ? { ...t, output: msg.result, durationMs: msg.durationMs, isRunning: false }
              : t,
          );
          return { ...seg, tools: updatedTools };
        });
        streamingSegmentsRef.current = next;
        return next;
      });
    }));

    unsubs.push(ws.subscribe('ai:context-usage', (msg: AiContextUsageEvent) => {
      setContextPercent(msg.percent);
    }));

    unsubs.push(ws.subscribe('ai:done', (msg: AiDoneEvent) => {
      clearStaleTimer();
      const segments = streamingSegmentsRef.current;
      const content = segments
        .filter(s => s.type === 'text')
        .map(s => s.text || '')
        .join('');

      const finalSegments = [...segments];
      if (msg.error && content) {
        finalSegments.push({ type: 'text', text: `\n\n*${msg.error}*` });
      }

      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: msg.error && !content ? `Error: ${msg.error}` : content,
        segments: finalSegments.length > 0 ? finalSegments : undefined,
      };
      setMessages(prev => [...prev, assistantMessage]);
      setStreamingSegments([]);
      setIsStreaming(false);
      setConversationId(msg.conversationId);
      setTurnLimitReached(!!msg.turnLimitReached);
      streamingSegmentsRef.current = [];
    }));

    unsubs.push(ws.subscribe('ai:tool-confirm', (msg: AiToolConfirmEvent) => {
      resetStaleTimer();
      setPendingConfirm({
        toolUseId: msg.toolUseId,
        toolName: msg.toolName,
        input: msg.input,
      });
    }));

    unsubs.push(ws.subscribe('ai:error', (msg: AiErrorEvent) => {
      clearStaleTimer();
      const segments = streamingSegmentsRef.current;
      const content = segments
        .filter(s => s.type === 'text')
        .map(s => s.text || '')
        .join('');
      const finalSegments = segments.length > 0
        ? [...segments, { type: 'text' as const, text: '\n\n*' + msg.error + '*' }]
        : undefined;
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: content || 'Error: ' + msg.error,
        segments: finalSegments,
      }]);
      setIsStreaming(false);
      setStreamingSegments([]);
      setContextPercent(null);
      streamingSegmentsRef.current = [];
    }));

    return () => unsubs.forEach(fn => fn());
  }, [ws, resetStaleTimer, clearStaleTimer]);

  const sendMessage = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;

    setMessages(prev => [...prev, { role: 'user', content: trimmed }]);
    setInput('');
    setIsStreaming(true);
    setStreamingSegments([]);
    setTurnLimitReached(false);
    streamingSegmentsRef.current = [];
    resetStaleTimer();

    ws.sendMessage('ai:message', {
      conversationId: conversationId ?? undefined,
      message: trimmed,
      pageContext,
      contextId,
    });
  }, [ws, conversationId, pageContext, contextId, isStreaming, resetStaleTimer]);

  const respondToConfirm = useCallback((allowed: boolean) => {
    if (!pendingConfirm) return;
    ws.sendMessage('ai:tool-confirm-response', {
      toolUseId: pendingConfirm.toolUseId,
      allowed,
    });
    setPendingConfirm(null);
    resetStaleTimer();
  }, [ws, pendingConfirm, resetStaleTimer]);

  const cancelRequest = useCallback(() => {
    ws.sendMessage('ai:cancel', { conversationId });
  }, [ws, conversationId]);

  const newConversation = useCallback(() => {
    clearStaleTimer();
    setMessages([]);
    setInput('');
    setIsStreaming(false);
    setConversationId(null);
    setStreamingSegments([]);
    setTurnLimitReached(false);
    setContextPercent(null);
    streamingSegmentsRef.current = [];
  }, [clearStaleTimer]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  }, [input, sendMessage]);

  const suggestedPrompts = SUGGESTED_PROMPTS[pageContext] || [];
  const isEmpty = messages.length === 0 && !isStreaming;

  return (
    <div className="ai-chat-panel" data-testid="ai-chat-panel">
      <div className="ai-chat-header" data-testid="ai-chat-header">
        <span className="ai-chat-context-label">{pageContext}</span>
        {contextPercent !== null && (
          <span
            className={`ai-chat-context-usage${contextPercent >= 80 ? ' ai-chat-context-usage-warn' : ''}`}
            title="Context window usage"
            data-testid="ai-chat-context-usage"
          >
            ctx {contextPercent}%
          </span>
        )}
        <button
          className="btn btn-sm"
          onClick={newConversation}
          data-testid="ai-chat-new-btn"
        >
          New Chat
        </button>
      </div>

      <div className="ai-chat-messages" data-testid="ai-chat-messages">
        {isEmpty && (
          <div className="ai-chat-empty" data-testid="ai-chat-empty">
            <p className="ai-chat-empty-text">Ask a question about this page's data</p>
            {suggestedPrompts.length > 0 && (
              <div className="ai-chat-suggestions" data-testid="ai-chat-suggestions">
                {suggestedPrompts.map((prompt, i) => (
                  <button
                    key={i}
                    className="ai-chat-suggestion-btn"
                    onClick={() => sendMessage(prompt)}
                    data-testid={`ai-chat-suggestion-${i}`}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`ai-chat-message ai-chat-message-${msg.role}`}
            data-testid={`ai-chat-message-${i}`}
          >
            {msg.role === 'user' ? (
              <div className="ai-chat-user-text">{msg.content}</div>
            ) : (
              <div className="ai-chat-assistant-text">
                {msg.segments ? (
                  renderSegments(msg.segments)
                ) : msg.content ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents}>
                    {msg.content}
                  </ReactMarkdown>
                ) : null}
              </div>
            )}
          </div>
        ))}

        {isStreaming && (
          <div className="ai-chat-message ai-chat-message-assistant ai-chat-streaming" data-testid="ai-chat-streaming">
            <div className="ai-chat-assistant-text">
              {renderSegments(streamingSegments, true)}
              {pendingConfirm ? (
                <div className="ai-chat-confirm" data-testid="ai-chat-confirm">
                  <div className="ai-chat-confirm-header">
                    <ShieldAlert size={16} />
                    <span>Confirmation Required</span>
                  </div>
                  <div className="ai-chat-confirm-body">
                    <code>{pendingConfirm.toolName}</code>
                    {pendingConfirm.input && Object.keys(pendingConfirm.input).length > 0 && (
                      <pre className="ai-chat-confirm-params">
                        {JSON.stringify(pendingConfirm.input, null, 2)}
                      </pre>
                    )}
                  </div>
                  <div className="ai-chat-confirm-actions">
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => respondToConfirm(false)}
                      data-testid="ai-chat-confirm-deny"
                    >
                      Deny
                    </button>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => respondToConfirm(true)}
                      data-testid="ai-chat-confirm-allow"
                    >
                      Allow
                    </button>
                  </div>
                </div>
              ) : (
                <StatusIndicator
                  isStreaming={isStreaming}
                  segments={streamingSegments}
                />
              )}
            </div>
          </div>
        )}

        {turnLimitReached && !isStreaming && (
          <div className="ai-chat-turn-limit" data-testid="ai-chat-turn-limit">
            <p>The AI ran out of turns and stopped.</p>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => sendMessage('Continue where you left off.')}
              data-testid="ai-chat-continue-btn"
            >
              Continue
            </button>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="ai-chat-input-area" data-testid="ai-chat-input-area">
        <textarea
          ref={textareaRef}
          className="ai-chat-input"
          data-testid="ai-chat-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask a question..."
          rows={1}
          disabled={isStreaming}
        />
        {isStreaming ? (
          <button
            className="btn btn-danger btn-sm"
            onClick={cancelRequest}
            data-testid="ai-chat-cancel-btn"
          >
            Cancel
          </button>
        ) : (
          <button
            className="btn btn-primary btn-sm"
            onClick={() => sendMessage(input)}
            disabled={!input.trim()}
            data-testid="ai-chat-send-btn"
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
