import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { ToolCallCard } from './ToolCallCard';
import { AiChatPanel, convertDbMessages } from './AiChatPanel';
import { WebSocketContext, type WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';

// The panel remembers the open conversation per page context in localStorage.
beforeEach(() => {
  localStorage.clear();
});

// ─── Existing ToolCallCard tests ────────────────────────────────────────────

describe('ToolCallCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders tool name', () => {
    render(
      <ToolCallCard
        toolName="query_database"
        input={{ sql: 'SELECT * FROM users' }}
        isRunning={false}
      />,
    );
    expect(screen.getByTestId('tool-call-card')).toBeInTheDocument();
    expect(screen.getByTestId('tool-call-name')).toHaveTextContent('query_database');
  });

  it('shows spinner when running', () => {
    render(
      <ToolCallCard
        toolName="fetch_data"
        input={{ url: '/api/test' }}
        isRunning={true}
      />,
    );
    expect(screen.getByTestId('tool-call-spinner')).toBeInTheDocument();
    expect(screen.queryByTestId('tool-call-check')).not.toBeInTheDocument();
  });

  it('shows gear icon when not running', () => {
    render(
      <ToolCallCard
        toolName="fetch_data"
        input={{ url: '/api/test' }}
        isRunning={false}
      />,
    );
    expect(screen.getByTestId('tool-call-check')).toBeInTheDocument();
    expect(screen.queryByTestId('tool-call-spinner')).not.toBeInTheDocument();
  });

  it('shows duration when provided', () => {
    render(
      <ToolCallCard
        toolName="query_database"
        input={{}}
        output="3 rows returned"
        durationMs={142}
        isRunning={false}
      />,
    );
    expect(screen.getByTestId('tool-call-duration')).toHaveTextContent('142ms');
  });

  it('does not show duration when not provided', () => {
    render(
      <ToolCallCard
        toolName="query_database"
        input={{}}
        isRunning={false}
      />,
    );
    expect(screen.queryByTestId('tool-call-duration')).not.toBeInTheDocument();
  });

  it('shows output preview when output exists and not expanded', () => {
    render(
      <ToolCallCard
        toolName="query_database"
        input={{}}
        output="Found 5 matching records in the database"
        durationMs={50}
        isRunning={false}
      />,
    );
    expect(screen.getByTestId('tool-call-preview')).toHaveTextContent(
      'Found 5 matching records in the database',
    );
  });

  it('truncates output preview to ~80 characters', () => {
    const longOutput = 'A'.repeat(100);
    render(
      <ToolCallCard
        toolName="query_database"
        input={{}}
        output={longOutput}
        isRunning={false}
      />,
    );
    const preview = screen.getByTestId('tool-call-preview');
    expect(preview.textContent).toBe('A'.repeat(80) + '...');
  });

  it('does not show preview when running', () => {
    render(
      <ToolCallCard
        toolName="query_database"
        input={{}}
        output="some output"
        isRunning={true}
      />,
    );
    expect(screen.queryByTestId('tool-call-preview')).not.toBeInTheDocument();
  });

  it('expands full output on header click when not running and output exists', () => {
    render(
      <ToolCallCard
        toolName="query_database"
        input={{}}
        output="Full output content here"
        durationMs={100}
        isRunning={false}
      />,
    );

    // Output should not be expanded initially
    expect(screen.queryByTestId('tool-call-output')).not.toBeInTheDocument();

    // Click to expand
    fireEvent.click(screen.getByTestId('tool-call-header'));
    expect(screen.getByTestId('tool-call-output')).toBeInTheDocument();
    expect(screen.getByTestId('tool-call-output')).toHaveTextContent('Full output content here');

    // Preview should be hidden when expanded
    expect(screen.queryByTestId('tool-call-preview')).not.toBeInTheDocument();
  });

  it('collapses output on second header click', () => {
    render(
      <ToolCallCard
        toolName="query_database"
        input={{}}
        output="Full output content here"
        isRunning={false}
      />,
    );

    // Click to expand
    fireEvent.click(screen.getByTestId('tool-call-header'));
    expect(screen.getByTestId('tool-call-output')).toBeInTheDocument();

    // Click to collapse
    fireEvent.click(screen.getByTestId('tool-call-header'));
    expect(screen.queryByTestId('tool-call-output')).not.toBeInTheDocument();
  });

  it('does not expand when running', () => {
    render(
      <ToolCallCard
        toolName="query_database"
        input={{}}
        output="some output"
        isRunning={true}
      />,
    );

    fireEvent.click(screen.getByTestId('tool-call-header'));
    expect(screen.queryByTestId('tool-call-output')).not.toBeInTheDocument();
  });

  it('does not expand when no output', () => {
    render(
      <ToolCallCard
        toolName="query_database"
        input={{}}
        isRunning={false}
      />,
    );

    fireEvent.click(screen.getByTestId('tool-call-header'));
    expect(screen.queryByTestId('tool-call-output')).not.toBeInTheDocument();
  });

  it('shows chevron indicator when expandable', () => {
    render(
      <ToolCallCard
        toolName="query_database"
        input={{}}
        output="some output"
        isRunning={false}
      />,
    );
    expect(screen.getByTestId('tool-call-chevron')).toBeInTheDocument();
  });

  it('does not show chevron when not expandable', () => {
    render(
      <ToolCallCard
        toolName="query_database"
        input={{}}
        isRunning={true}
      />,
    );
    expect(screen.queryByTestId('tool-call-chevron')).not.toBeInTheDocument();
  });

  it('header has cursor pointer style when expandable', () => {
    render(
      <ToolCallCard
        toolName="query_database"
        input={{}}
        output="some output"
        isRunning={false}
      />,
    );
    expect(screen.getByTestId('tool-call-header')).toHaveStyle({ cursor: 'pointer' });
  });

  // ─── New comprehensive ToolCallCard tests ───────────────────────────────

  it('should show full output if exactly 80 characters', () => {
    const output80 = 'X'.repeat(80);
    render(
      <ToolCallCard
        toolName="test_tool"
        input={{}}
        output={output80}
        isRunning={false}
      />,
    );
    const preview = screen.getByTestId('tool-call-preview');
    // Exactly 80 chars — no ellipsis
    expect(preview.textContent).toBe(output80);
    expect(preview.textContent).not.toContain('...');
  });

  it('should add ellipsis for output over 80 chars', () => {
    const output81 = 'Y'.repeat(81);
    render(
      <ToolCallCard
        toolName="test_tool"
        input={{}}
        output={output81}
        isRunning={false}
      />,
    );
    const preview = screen.getByTestId('tool-call-preview');
    expect(preview.textContent).toBe('Y'.repeat(80) + '...');
  });

  it('should not show preview for empty output', () => {
    render(
      <ToolCallCard
        toolName="test_tool"
        input={{}}
        output=""
        isRunning={false}
      />,
    );
    expect(screen.queryByTestId('tool-call-preview')).not.toBeInTheDocument();
  });

  it('should start collapsed', () => {
    render(
      <ToolCallCard
        toolName="test_tool"
        input={{}}
        output="Some output text"
        isRunning={false}
      />,
    );
    // The expanded output (pre tag) should not be visible initially
    expect(screen.queryByTestId('tool-call-output')).not.toBeInTheDocument();
  });

  it('should toggle expanded/collapsed on click', () => {
    render(
      <ToolCallCard
        toolName="test_tool"
        input={{}}
        output="Toggle me"
        isRunning={false}
      />,
    );

    const header = screen.getByTestId('tool-call-header');

    // Initially collapsed
    expect(screen.queryByTestId('tool-call-output')).not.toBeInTheDocument();

    // Click once: expanded
    fireEvent.click(header);
    expect(screen.getByTestId('tool-call-output')).toBeInTheDocument();

    // Click again: collapsed
    fireEvent.click(header);
    expect(screen.queryByTestId('tool-call-output')).not.toBeInTheDocument();
  });

  it('should not be clickable when running', () => {
    render(
      <ToolCallCard
        toolName="test_tool"
        input={{}}
        output="some output"
        isRunning={true}
      />,
    );

    // Clicking does nothing — no expand
    fireEvent.click(screen.getByTestId('tool-call-header'));
    expect(screen.queryByTestId('tool-call-output')).not.toBeInTheDocument();
  });

  it('should show spinner when running', () => {
    render(
      <ToolCallCard
        toolName="test_tool"
        input={{}}
        isRunning={true}
      />,
    );
    expect(screen.getByTestId('tool-call-spinner')).toBeInTheDocument();
  });

  it('should show gear icon when complete', () => {
    render(
      <ToolCallCard
        toolName="test_tool"
        input={{}}
        isRunning={false}
      />,
    );
    expect(screen.getByTestId('tool-call-check')).toBeInTheDocument();
  });

  it('should show 0ms for zero duration', () => {
    render(
      <ToolCallCard
        toolName="test_tool"
        input={{}}
        output="done"
        durationMs={0}
        isRunning={false}
      />,
    );
    expect(screen.getByTestId('tool-call-duration')).toHaveTextContent('0ms');
  });

  it('should not show duration when undefined', () => {
    render(
      <ToolCallCard
        toolName="test_tool"
        input={{}}
        output="done"
        durationMs={undefined}
        isRunning={false}
      />,
    );
    expect(screen.queryByTestId('tool-call-duration')).not.toBeInTheDocument();
  });

  it('should show chevron only when expandable', () => {
    // canExpand = !isRunning && !!output
    render(
      <ToolCallCard
        toolName="test_tool"
        input={{}}
        output="has output"
        isRunning={false}
      />,
    );
    expect(screen.getByTestId('tool-call-chevron')).toBeInTheDocument();
  });

  it('should handle output with special characters', () => {
    const specialOutput = 'Result: <div class="test">&amp; "quotes" & < > </div>';
    render(
      <ToolCallCard
        toolName="test_tool"
        input={{}}
        output={specialOutput}
        isRunning={false}
      />,
    );
    const preview = screen.getByTestId('tool-call-preview');
    // Text should be rendered safely (as text content, not parsed as HTML)
    expect(preview.textContent).toContain('<div');
    expect(preview.textContent).toContain('&amp;');
    expect(preview.textContent).toContain('<');
    expect(preview.textContent).toContain('>');

    // Expand and verify full output is also rendered safely in the pre tag
    fireEvent.click(screen.getByTestId('tool-call-header'));
    const output = screen.getByTestId('tool-call-output');
    expect(output.textContent).toBe(specialOutput);
    // Ensure it's in a <pre> tag, not parsed as HTML
    expect(output.tagName).toBe('PRE');
  });

  it('should handle very long tool name', () => {
    const longName = 'a'.repeat(100);
    render(
      <ToolCallCard
        toolName={longName}
        input={{}}
        isRunning={false}
      />,
    );
    const nameEl = screen.getByTestId('tool-call-name');
    expect(nameEl.textContent).toBe(longName);
    // Should render without throwing
    expect(screen.getByTestId('tool-call-card')).toBeInTheDocument();
  });

  it('should handle large output in expanded view', () => {
    const largeOutput = 'Z'.repeat(10000);
    render(
      <ToolCallCard
        toolName="test_tool"
        input={{}}
        output={largeOutput}
        isRunning={false}
      />,
    );

    // Expand
    fireEvent.click(screen.getByTestId('tool-call-header'));
    const outputEl = screen.getByTestId('tool-call-output');
    expect(outputEl.tagName).toBe('PRE');
    expect(outputEl.textContent).toBe(largeOutput);
  });
});

// ─── AiChatPanel tests ─────────────────────────────────────────────────────

// Mock react-markdown and plugins to avoid complex markdown rendering in tests
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: () => {} }));
vi.mock('rehype-highlight', () => ({ default: () => {} }));

function createMockWs(overrides: Partial<WebSocketContextValue> = {}): WebSocketContextValue {
  return {
    connected: true,
    serverReady: true,
    startupMessage: 'Ready',
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockResolvedValue({ id: '1', type: 'restapi', status: 200, body: {} }),
    subscribe: vi.fn().mockReturnValue(() => {}),
    subscribeBinary: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

function renderWithWs(
  ui: React.ReactElement,
  wsOverrides: Partial<WebSocketContextValue> = {},
) {
  const ws = createMockWs(wsOverrides);
  const utils = render(
    <WebSocketContext.Provider value={ws}>
      {ui}
    </WebSocketContext.Provider>,
  );
  return { ...utils, ws };
}

describe('AiChatPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom does not implement scrollIntoView
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('renders the chat panel with header, messages area, and input', () => {
    renderWithWs(<AiChatPanel pageContext="dashboard" contextId="main" />);
    expect(screen.getByTestId('ai-chat-panel')).toBeInTheDocument();
    expect(screen.getByTestId('ai-chat-header')).toBeInTheDocument();
    expect(screen.getByTestId('ai-chat-messages')).toBeInTheDocument();
    expect(screen.getByTestId('ai-chat-input-area')).toBeInTheDocument();
  });

  it('shows empty state with suggested prompts when no messages', () => {
    renderWithWs(<AiChatPanel pageContext="dashboard" contextId="main" />);
    expect(screen.getByTestId('ai-chat-empty')).toBeInTheDocument();
    expect(screen.getByTestId('ai-chat-suggestions')).toBeInTheDocument();
    expect(screen.getByTestId('ai-chat-suggestion-0')).toHaveTextContent(
      'Give me a summary of the system',
    );
  });

  it('shows empty state without suggestions for unknown context', () => {
    renderWithWs(<AiChatPanel pageContext="unknown-page" contextId="x" />);
    expect(screen.getByTestId('ai-chat-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-chat-suggestions')).not.toBeInTheDocument();
  });

  it('displays the page context label in the header', () => {
    renderWithWs(<AiChatPanel pageContext="traffic" contextId="t1" />);
    expect(screen.getByTestId('ai-chat-header')).toHaveTextContent('traffic');
  });

  it('has a New Chat button in the header', () => {
    renderWithWs(<AiChatPanel pageContext="dashboard" contextId="main" />);
    expect(screen.getByTestId('ai-chat-new-btn')).toBeInTheDocument();
    expect(screen.getByTestId('ai-chat-new-btn')).toHaveTextContent('New Chat');
  });

  it('subscribes to all expected WS event types on mount', () => {
    const subscribeMock = vi.fn().mockReturnValue(() => {});
    renderWithWs(<AiChatPanel pageContext="dashboard" contextId="main" />, {
      subscribe: subscribeMock,
    });
    const subscribedTypes = subscribeMock.mock.calls.map((c: any[]) => c[0]);
    expect(subscribedTypes).toContain('ai:token');
    expect(subscribedTypes).toContain('ai:tool-start');
    expect(subscribedTypes).toContain('ai:tool-result');
    expect(subscribedTypes).toContain('ai:done');
    expect(subscribedTypes).toContain('ai:error');
    expect(subscribedTypes).toContain('ai:context-usage');
  });

  it('sends a message when the Send button is clicked', () => {
    const sendMessageMock = vi.fn();
    renderWithWs(<AiChatPanel pageContext="dashboard" contextId="main" />, {
      sendMessage: sendMessageMock,
    });

    const input = screen.getByTestId('ai-chat-input');
    fireEvent.change(input, { target: { value: 'Hello AI' } });
    fireEvent.click(screen.getByTestId('ai-chat-send-btn'));

    expect(sendMessageMock).toHaveBeenCalledWith('ai:message', expect.objectContaining({
      message: 'Hello AI',
      pageContext: 'dashboard',
      contextId: 'main',
    }));
  });

  it('sends a message on Enter key (without Shift)', () => {
    const sendMessageMock = vi.fn();
    renderWithWs(<AiChatPanel pageContext="dashboard" contextId="main" />, {
      sendMessage: sendMessageMock,
    });

    const input = screen.getByTestId('ai-chat-input');
    fireEvent.change(input, { target: { value: 'Hello via Enter' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    expect(sendMessageMock).toHaveBeenCalledWith('ai:message', expect.objectContaining({
      message: 'Hello via Enter',
    }));
  });

  it('does not send on Shift+Enter (allows multiline)', () => {
    const sendMessageMock = vi.fn();
    renderWithWs(<AiChatPanel pageContext="dashboard" contextId="main" />, {
      sendMessage: sendMessageMock,
    });

    const input = screen.getByTestId('ai-chat-input');
    fireEvent.change(input, { target: { value: 'line1' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('does not send empty or whitespace-only messages', () => {
    const sendMessageMock = vi.fn();
    renderWithWs(<AiChatPanel pageContext="dashboard" contextId="main" />, {
      sendMessage: sendMessageMock,
    });

    const input = screen.getByTestId('ai-chat-input');
    // Empty
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByTestId('ai-chat-send-btn'));
    expect(sendMessageMock).not.toHaveBeenCalled();

    // Whitespace only
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('ai-chat-send-btn'));
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('Send button is disabled when input is empty', () => {
    renderWithWs(<AiChatPanel pageContext="dashboard" contextId="main" />);
    expect(screen.getByTestId('ai-chat-send-btn')).toBeDisabled();
  });

  it('adds a user message to the messages list after sending', () => {
    renderWithWs(<AiChatPanel pageContext="dashboard" contextId="main" />);

    const input = screen.getByTestId('ai-chat-input');
    fireEvent.change(input, { target: { value: 'Test message' } });
    fireEvent.click(screen.getByTestId('ai-chat-send-btn'));

    expect(screen.getByTestId('ai-chat-message-0')).toBeInTheDocument();
    expect(screen.getByTestId('ai-chat-message-0')).toHaveTextContent('Test message');
  });

  it('hides the empty state after sending the first message', () => {
    renderWithWs(<AiChatPanel pageContext="dashboard" contextId="main" />);

    expect(screen.getByTestId('ai-chat-empty')).toBeInTheDocument();

    const input = screen.getByTestId('ai-chat-input');
    fireEvent.change(input, { target: { value: 'First message' } });
    fireEvent.click(screen.getByTestId('ai-chat-send-btn'));

    expect(screen.queryByTestId('ai-chat-empty')).not.toBeInTheDocument();
  });

  it('shows streaming indicator (thinking) after sending a message', () => {
    renderWithWs(<AiChatPanel pageContext="dashboard" contextId="main" />);

    const input = screen.getByTestId('ai-chat-input');
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByTestId('ai-chat-send-btn'));

    expect(screen.getByTestId('ai-chat-streaming')).toBeInTheDocument();
    expect(screen.getByTestId('ai-chat-status')).toBeInTheDocument();
  });

  it('shows Cancel button while streaming and hides Send button', () => {
    renderWithWs(<AiChatPanel pageContext="dashboard" contextId="main" />);

    const input = screen.getByTestId('ai-chat-input');
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByTestId('ai-chat-send-btn'));

    expect(screen.getByTestId('ai-chat-cancel-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-chat-send-btn')).not.toBeInTheDocument();
  });

  it('disables the textarea while streaming', () => {
    renderWithWs(<AiChatPanel pageContext="dashboard" contextId="main" />);

    const input = screen.getByTestId('ai-chat-input');
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByTestId('ai-chat-send-btn'));

    expect(screen.getByTestId('ai-chat-input')).toBeDisabled();
  });

  it('sends cancel message for a new conversation', () => {
    const subscribeMock = vi.fn().mockReturnValue(() => {});
    const sendMessageMock = vi.fn();
    renderWithWs(<AiChatPanel pageContext="dashboard" contextId="main" />, {
      subscribe: subscribeMock,
      sendMessage: sendMessageMock,
    });

    fireEvent.change(screen.getByTestId('ai-chat-input'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByTestId('ai-chat-send-btn'));
    fireEvent.click(screen.getByTestId('ai-chat-cancel-btn'));

    expect(sendMessageMock).toHaveBeenCalledWith('ai:cancel', expect.objectContaining({ conversationId: null }));
  });

  it('sends cancel message when Cancel button is clicked', () => {
    const subscribeMock = vi.fn().mockReturnValue(() => {});
    const sendMessageMock = vi.fn();
    renderWithWs(<AiChatPanel pageContext="dashboard" contextId="main" />, {
      subscribe: subscribeMock,
      sendMessage: sendMessageMock,
    });

    // Simulate sending to enter streaming state
    const input = screen.getByTestId('ai-chat-input');
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByTestId('ai-chat-send-btn'));

    // Simulate receiving ai:done so conversationId gets set
    // Find the ai:done handler
    const doneHandler = subscribeMock.mock.calls.find((c: any[]) => c[0] === 'ai:done')?.[1];
    if (doneHandler) {
      act(() => {
        doneHandler({ type: 'ai:done', conversationId: 42 });
      });
    }

    // Send another message to re-enter streaming
    const input2 = screen.getByTestId('ai-chat-input');
    fireEvent.change(input2, { target: { value: 'Another question' } });
    fireEvent.click(screen.getByTestId('ai-chat-send-btn'));

    // Now click cancel
    fireEvent.click(screen.getByTestId('ai-chat-cancel-btn'));
    expect(sendMessageMock).toHaveBeenCalledWith('ai:cancel', expect.objectContaining({ conversationId: 42 }));
  });

  it('accumulates streamed text tokens into the streaming area', () => {
    const subscribeMock = vi.fn().mockReturnValue(() => {});
    renderWithWs(<AiChatPanel pageContext="dashboard" contextId="main" />, {
      subscribe: subscribeMock,
    });

    // Enter streaming mode
    const input = screen.getByTestId('ai-chat-input');
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByTestId('ai-chat-send-btn'));

    // Find the ai:token handler
    const tokenHandler = subscribeMock.mock.calls.find((c: any[]) => c[0] === 'ai:token')?.[1];
    expect(tokenHandler).toBeDefined();

    // Simulate token events
    act(() => {
      tokenHandler({ type: 'ai:token', conversationId: 1, text: 'Hello ' });
    });
    act(() => {
      tokenHandler({ type: 'ai:token', conversationId: 1, text: 'world' });
    });

    // The streaming area should contain the accumulated text
    const streaming = screen.getByTestId('ai-chat-streaming');
    expect(streaming.textContent).toContain('Hello world');
  });

  it('shows tool call cards during streaming when tools are active', () => {
    const subscribeMock = vi.fn().mockReturnValue(() => {});
    renderWithWs(<AiChatPanel pageContext="dashboard" contextId="main" />, {
      subscribe: subscribeMock,
    });

    // Enter streaming mode
    const input = screen.getByTestId('ai-chat-input');
    fireEvent.change(input, { target: { value: 'Run a query' } });
    fireEvent.click(screen.getByTestId('ai-chat-send-btn'));

    // Simulate tool start
    const toolStartHandler = subscribeMock.mock.calls.find((c: any[]) => c[0] === 'ai:tool-start')?.[1];
    expect(toolStartHandler).toBeDefined();

    act(() => {
      toolStartHandler({
        type: 'ai:tool-start',
        conversationId: 1,
        toolUseId: 'tool-1',
        toolName: 'query_database',
        input: { sql: 'SELECT 1' },
      });
    });

    // A ToolCallCard should appear within the streaming area
    expect(screen.getByTestId('tool-call-card')).toBeInTheDocument();
    expect(screen.getByTestId('tool-call-name')).toHaveTextContent('query_database');
    expect(screen.getByTestId('tool-call-spinner')).toBeInTheDocument();
  });

  it('completes tool calls when tool-result event arrives', () => {
    const subscribeMock = vi.fn().mockReturnValue(() => {});
    renderWithWs(<AiChatPanel pageContext="dashboard" contextId="main" />, {
      subscribe: subscribeMock,
    });

    // Enter streaming mode
    const input = screen.getByTestId('ai-chat-input');
    fireEvent.change(input, { target: { value: 'Run a query' } });
    fireEvent.click(screen.getByTestId('ai-chat-send-btn'));

    const toolStartHandler = subscribeMock.mock.calls.find((c: any[]) => c[0] === 'ai:tool-start')?.[1];
    const toolResultHandler = subscribeMock.mock.calls.find((c: any[]) => c[0] === 'ai:tool-result')?.[1];

    act(() => {
      toolStartHandler({
        type: 'ai:tool-start',
        conversationId: 1,
        toolUseId: 'tool-1',
        toolName: 'query_database',
        input: { sql: 'SELECT 1' },
      });
    });

    // Tool should be running
    expect(screen.getByTestId('tool-call-spinner')).toBeInTheDocument();

    act(() => {
      toolResultHandler({
        type: 'ai:tool-result',
        conversationId: 1,
        toolUseId: 'tool-1',
        result: '1 row returned',
      });
    });

    // Tool should now show gear (complete) instead of spinner
    expect(screen.queryByTestId('tool-call-spinner')).not.toBeInTheDocument();
    expect(screen.getByTestId('tool-call-check')).toBeInTheDocument();
  });

  it('finalizes assistant message on ai:done event', () => {
    const subscribeMock = vi.fn().mockReturnValue(() => {});
    renderWithWs(<AiChatPanel pageContext="dashboard" contextId="main" />, {
      subscribe: subscribeMock,
    });

    // Enter streaming mode
    const input = screen.getByTestId('ai-chat-input');
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByTestId('ai-chat-send-btn'));

    const tokenHandler = subscribeMock.mock.calls.find((c: any[]) => c[0] === 'ai:token')?.[1];
    const doneHandler = subscribeMock.mock.calls.find((c: any[]) => c[0] === 'ai:done')?.[1];

    act(() => {
      tokenHandler({ type: 'ai:token', conversationId: 1, text: 'Response text' });
    });

    act(() => {
      doneHandler({ type: 'ai:done', conversationId: 1 });
    });

    // Streaming indicator should be gone
    expect(screen.queryByTestId('ai-chat-streaming')).not.toBeInTheDocument();

    // User message (index 0) + assistant message (index 1)
    expect(screen.getByTestId('ai-chat-message-0')).toHaveTextContent('Hello');
    expect(screen.getByTestId('ai-chat-message-1')).toHaveTextContent('Response text');

    // Send button should be back
    expect(screen.getByTestId('ai-chat-send-btn')).toBeInTheDocument();
  });

  it('displays error message on ai:error event', () => {
    const subscribeMock = vi.fn().mockReturnValue(() => {});
    renderWithWs(<AiChatPanel pageContext="dashboard" contextId="main" />, {
      subscribe: subscribeMock,
    });

    // Enter streaming mode
    const input = screen.getByTestId('ai-chat-input');
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByTestId('ai-chat-send-btn'));

    const errorHandler = subscribeMock.mock.calls.find((c: any[]) => c[0] === 'ai:error')?.[1];
    const tokenHandler = subscribeMock.mock.calls.find((c: any[]) => c[0] === 'ai:token')?.[1];

    act(() => {
      tokenHandler({ type: 'ai:token', conversationId: 1, text: 'Partial answer' });
    });

    act(() => {
      errorHandler({
        type: 'ai:error',
        conversationId: 1,
        error: 'API rate limit exceeded',
      });
    });

    // Streaming should stop
    expect(screen.queryByTestId('ai-chat-streaming')).not.toBeInTheDocument();

    // Error message should be displayed as an assistant message
    expect(screen.getByTestId('ai-chat-message-1')).toHaveTextContent('Partial answer');
    expect(screen.getByTestId('ai-chat-message-1')).toHaveTextContent('API rate limit exceeded');
  });

  it('sends a suggested prompt when clicked', () => {
    const sendMessageMock = vi.fn();
    renderWithWs(<AiChatPanel pageContext="dashboard" contextId="main" />, {
      sendMessage: sendMessageMock,
    });

    fireEvent.click(screen.getByTestId('ai-chat-suggestion-0'));

    expect(sendMessageMock).toHaveBeenCalledWith('ai:message', expect.objectContaining({
      message: 'Give me a summary of the system',
    }));
  });

  it('resets state when New Chat button is clicked', () => {
    const subscribeMock = vi.fn().mockReturnValue(() => {});
    renderWithWs(<AiChatPanel pageContext="dashboard" contextId="main" />, {
      subscribe: subscribeMock,
    });

    // Send a message to have some state
    const input = screen.getByTestId('ai-chat-input');
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByTestId('ai-chat-send-btn'));

    // Simulate done so we have a completed conversation
    const tokenHandler = subscribeMock.mock.calls.find((c: any[]) => c[0] === 'ai:token')?.[1];
    const doneHandler = subscribeMock.mock.calls.find((c: any[]) => c[0] === 'ai:done')?.[1];

    act(() => {
      tokenHandler({ type: 'ai:token', conversationId: 1, text: 'Reply' });
    });
    act(() => {
      doneHandler({ type: 'ai:done', conversationId: 1 });
    });

    // Should have messages
    expect(screen.getByTestId('ai-chat-message-0')).toBeInTheDocument();

    // Click New Chat
    fireEvent.click(screen.getByTestId('ai-chat-new-btn'));

    // Messages should be cleared and empty state should be back
    expect(screen.queryByTestId('ai-chat-message-0')).not.toBeInTheDocument();
    expect(screen.getByTestId('ai-chat-empty')).toBeInTheDocument();
  });

  it('shows suggested prompts for session-timeline context', () => {
    renderWithWs(<AiChatPanel pageContext="session-timeline" contextId="s1" />);
    expect(screen.getByTestId('ai-chat-suggestion-0')).toHaveTextContent(
      'Summarize what happened in this session',
    );
    expect(screen.getByTestId('ai-chat-suggestion-1')).toHaveTextContent(
      'Find any errors or failures',
    );
    expect(screen.getByTestId('ai-chat-suggestion-2')).toHaveTextContent(
      'What URLs were requested?',
    );
  });

  it('shows suggested prompts for traffic context', () => {
    renderWithWs(<AiChatPanel pageContext="traffic" contextId="t1" />);
    expect(screen.getByTestId('ai-chat-suggestion-0')).toHaveTextContent(
      'What are the most common API endpoints?',
    );
  });

  it('unsubscribes from all WS events on unmount', () => {
    const unsubFns = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    let callIdx = 0;
    const subscribeMock = vi.fn().mockImplementation(() => {
      const fn = unsubFns[callIdx] || vi.fn();
      callIdx++;
      return fn;
    });

    const { unmount } = renderWithWs(<AiChatPanel pageContext="dashboard" contextId="main" />, {
      subscribe: subscribeMock,
    });

    // Should have 8 subscriptions (token, tool-start, tool-result, tool-confirm, done, error, context-usage, yolo-state)
    expect(subscribeMock).toHaveBeenCalledTimes(8);

    unmount();

    // All unsub functions should have been called
    for (const fn of unsubFns) {
      expect(fn).toHaveBeenCalled();
    }
  });

  it('loads the latest conversation on mount', async () => {
    const sendRestApi = vi.fn().mockResolvedValue({
      id: '1',
      type: 'restapi',
      status: 200,
      body: {
        data: {
          id: 99,
          messages: [
            { role: 'user', content: 'Previous question' },
            { role: 'assistant', content: [{ type: 'text', text: 'Previous answer' }] },
          ],
        },
      },
    });

    renderWithWs(<AiChatPanel pageContext="dashboard" contextId="main" />, { sendRestApi });

    // Should call the latest conversation endpoint
    expect(sendRestApi).toHaveBeenCalledWith(
      'GET',
      expect.stringContaining('/v1/ai/conversations/latest'),
    );

    // Wait for async restore
    await vi.waitFor(() => {
      expect(screen.getByTestId('ai-chat-message-0')).toHaveTextContent('Previous question');
    });
    expect(screen.getByTestId('ai-chat-message-1')).toHaveTextContent('Previous answer');
    // Empty state should not be shown
    expect(screen.queryByTestId('ai-chat-empty')).not.toBeInTheDocument();
  });

  it('shows empty state when no previous conversation exists', async () => {
    const sendRestApi = vi.fn().mockResolvedValue({
      id: '1',
      type: 'restapi',
      status: 200,
      body: { data: null },
    });

    renderWithWs(<AiChatPanel pageContext="dashboard" contextId="main" />, { sendRestApi });

    // Should still show empty state
    await vi.waitFor(() => {
      expect(screen.getByTestId('ai-chat-empty')).toBeInTheDocument();
    });
  });

  it('handles load error gracefully', async () => {
    const sendRestApi = vi.fn().mockRejectedValue(new Error('network error'));

    renderWithWs(<AiChatPanel pageContext="dashboard" contextId="main" />, { sendRestApi });

    // Should still show empty state (no crash)
    await vi.waitFor(() => {
      expect(screen.getByTestId('ai-chat-empty')).toBeInTheDocument();
    });
  });

  it('uses restored conversationId for subsequent messages', async () => {
    const sendRestApi = vi.fn().mockResolvedValue({
      id: '1',
      type: 'restapi',
      status: 200,
      body: {
        data: {
          id: 77,
          messages: [
            { role: 'user', content: 'Old message' },
            { role: 'assistant', content: [{ type: 'text', text: 'Old reply' }] },
          ],
        },
      },
    });
    const sendMessage = vi.fn();

    renderWithWs(<AiChatPanel pageContext="dashboard" contextId="main" />, {
      sendRestApi,
      sendMessage,
    });

    // Wait for restore
    await vi.waitFor(() => {
      expect(screen.getByTestId('ai-chat-message-0')).toHaveTextContent('Old message');
    });

    // Send a new message — should use the restored conversationId
    const input = screen.getByTestId('ai-chat-input');
    fireEvent.change(input, { target: { value: 'Follow-up' } });
    fireEvent.click(screen.getByTestId('ai-chat-send-btn'));

    expect(sendMessage).toHaveBeenCalledWith('ai:message', expect.objectContaining({
      conversationId: 77,
      message: 'Follow-up',
    }));
  });

  it('shows context usage percentage when ai:context-usage event received', () => {
    const subscribeMock = vi.fn().mockReturnValue(() => {});
    renderWithWs(<AiChatPanel pageContext="dashboard" contextId="main" />, {
      subscribe: subscribeMock,
    });

    expect(screen.queryByTestId('ai-chat-context-usage')).not.toBeInTheDocument();

    const contextUsageHandler = subscribeMock.mock.calls.find((c: any[]) => c[0] === 'ai:context-usage')?.[1];
    expect(contextUsageHandler).toBeDefined();

    act(() => {
      contextUsageHandler({ type: 'ai:context-usage', conversationId: null, percent: 45 });
    });

    expect(screen.getByTestId('ai-chat-context-usage')).toHaveTextContent('ctx 45%');
  });

  it('clears context usage on new conversation', () => {
    const subscribeMock = vi.fn().mockReturnValue(() => {});
    renderWithWs(<AiChatPanel pageContext="dashboard" contextId="main" />, {
      subscribe: subscribeMock,
    });

    const contextUsageHandler = subscribeMock.mock.calls.find((c: any[]) => c[0] === 'ai:context-usage')?.[1];
    act(() => {
      contextUsageHandler({ type: 'ai:context-usage', conversationId: null, percent: 70 });
    });
    expect(screen.getByTestId('ai-chat-context-usage')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ai-chat-new-btn'));
    expect(screen.queryByTestId('ai-chat-context-usage')).not.toBeInTheDocument();
  });
});

// ─── convertDbMessages tests ───────────────────────────────────────────────

describe('convertDbMessages', () => {
  it('converts user messages', () => {
    const result = convertDbMessages([
      { role: 'user', content: 'Hello' },
    ]);
    expect(result).toEqual([
      { role: 'user', content: 'Hello' },
    ]);
  });

  it('converts assistant text-only messages', () => {
    const result = convertDbMessages([
      { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('assistant');
    expect(result[0].content).toBe('Hi there!');
    expect(result[0].segments).toHaveLength(1);
    expect(result[0].segments![0]).toEqual({ type: 'text', text: 'Hi there!' });
  });

  it('converts assistant messages with tool calls', () => {
    const result = convertDbMessages([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 't1', name: 'query_db', input: { sql: 'SELECT 1' } },
        ],
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].segments).toHaveLength(2);
    expect(result[0].segments![0]).toEqual({ type: 'text', text: 'Let me check.' });
    expect(result[0].segments![1].type).toBe('tools');
    expect(result[0].segments![1].tools![0].toolName).toBe('query_db');
    expect(result[0].segments![1].tools![0].isRunning).toBe(false);
  });

  it('attaches tool results to matching tool calls', () => {
    const result = convertDbMessages([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'query_db', input: {} },
        ],
      },
      { role: 'tool_result', toolUseId: 't1', content: '3 rows' },
    ]);
    expect(result).toHaveLength(1); // tool_result doesn't create a new ChatMessage
    expect(result[0].segments![0].tools![0].output).toBe('3 rows');
  });

  it('handles interleaved text and tool segments', () => {
    const result = convertDbMessages([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'First text' },
          { type: 'tool_use', id: 't1', name: 'tool1', input: {} },
          { type: 'text', text: 'Second text' },
        ],
      },
    ]);
    expect(result[0].segments).toHaveLength(3);
    expect(result[0].segments![0]).toEqual({ type: 'text', text: 'First text' });
    expect(result[0].segments![1].type).toBe('tools');
    expect(result[0].segments![2]).toEqual({ type: 'text', text: 'Second text' });
  });

  it('handles full multi-turn conversation', () => {
    const result = convertDbMessages([
      { role: 'user', content: 'What data do we have?' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check the database.' },
          { type: 'tool_use', id: 't1', name: 'query_db', input: { sql: 'SELECT COUNT(*)' } },
        ],
      },
      { role: 'tool_result', toolUseId: 't1', content: '42 rows' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'There are 42 rows in the database.' },
        ],
      },
      { role: 'user', content: 'Thanks!' },
    ]);
    expect(result).toHaveLength(4); // user, assistant+tool, assistant, user
    expect(result[0]).toEqual({ role: 'user', content: 'What data do we have?' });
    expect(result[1].segments![1].tools![0].output).toBe('42 rows');
    expect(result[2].content).toBe('There are 42 rows in the database.');
    expect(result[3]).toEqual({ role: 'user', content: 'Thanks!' });
  });

  it('returns empty array for empty input', () => {
    expect(convertDbMessages([])).toEqual([]);
  });
});

// ─── Tool confirmation card ─────────────────────────────────────────────────

describe('AiChatPanel tool confirmation card', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  /** Render the panel, start a run, and have the server ask to confirm a tool. `on` reaches the panel's other server events. */
  function openConfirm(toolName = 'run_adb_command', input: Record<string, unknown> = { command: 'getprop' }) {
    const subscribe = vi.fn().mockReturnValue(() => {});
    const { ws } = renderWithWs(<AiChatPanel pageContext="devices" contextId="d1" />, { subscribe });
    const on = (type: string) => subscribe.mock.calls.find((c: any[]) => c[0] === type)?.[1];
    fireEvent.change(screen.getByTestId('ai-chat-input'), { target: { value: 'check the device' } });
    fireEvent.click(screen.getByTestId('ai-chat-send-btn'));
    act(() => {
      on('ai:tool-confirm')({ type: 'ai:tool-confirm', conversationId: null, toolUseId: 'tu-1', toolName, input });
    });
    return { ws, on };
  }

  const askToConfirm = (toolName?: string, input?: Record<string, unknown>) => openConfirm(toolName, input).ws;

  const confirmResponses = (ws: WebSocketContextValue) =>
    (ws.sendMessage as ReturnType<typeof vi.fn>).mock.calls.filter((c: any[]) => c[0] === 'ai:tool-confirm-response');

  it('names the tool and offers Deny, Allow and Allow for this conversation', () => {
    askToConfirm('update_setting', { key: 'ai.maxTurns' });

    expect(screen.getByTestId('ai-chat-confirm')).toHaveTextContent('update_setting');
    expect(screen.getByTestId('ai-chat-confirm-deny')).toHaveTextContent('Deny');
    expect(screen.getByTestId('ai-chat-confirm-allow')).toHaveTextContent('Allow');
    expect(screen.getByTestId('ai-chat-confirm-allow-conversation')).toHaveTextContent('Allow for this conversation');
  });

  it('Allow approves this one call only', () => {
    const ws = askToConfirm();

    fireEvent.click(screen.getByTestId('ai-chat-confirm-allow'));

    expect(confirmResponses(ws)).toEqual([['ai:tool-confirm-response', { toolUseId: 'tu-1', allowed: true, scope: 'once' }]]);
    expect(screen.queryByTestId('ai-chat-confirm')).not.toBeInTheDocument();
  });

  it('Allow for this conversation approves the tool for the rest of the conversation', () => {
    const ws = askToConfirm();

    fireEvent.click(screen.getByTestId('ai-chat-confirm-allow-conversation'));

    expect(confirmResponses(ws)).toEqual([['ai:tool-confirm-response', { toolUseId: 'tu-1', allowed: true, scope: 'conversation' }]]);
    expect(screen.queryByTestId('ai-chat-confirm')).not.toBeInTheDocument();
  });

  it('Deny refuses this call and does not ask the server to remember anything', () => {
    const ws = askToConfirm();

    fireEvent.click(screen.getByTestId('ai-chat-confirm-deny'));

    expect(confirmResponses(ws)).toEqual([['ai:tool-confirm-response', { toolUseId: 'tu-1', allowed: false, scope: 'once' }]]);
    expect(screen.queryByTestId('ai-chat-confirm')).not.toBeInTheDocument();
  });

  it('says the approval covers every call to the tool, whatever its arguments', () => {
    askToConfirm('run_adb_command', { command: 'getprop' });

    expect(screen.getByTestId('ai-chat-confirm-hint')).toHaveTextContent('run_adb_command');
    expect(screen.getByTestId('ai-chat-confirm-hint')).toHaveTextContent('whatever the arguments');
  });

  it('closes the card when the server settles the call without an answer', () => {
    const { on } = openConfirm();

    act(() => {
      on('ai:tool-result')({ type: 'ai:tool-result', conversationId: null, toolUseId: 'tu-1', result: 'Tool execution denied by user.', durationMs: 0 });
    });

    expect(screen.queryByTestId('ai-chat-confirm')).not.toBeInTheDocument();
  });

  it('keeps the card when a different call settles', () => {
    const { on } = openConfirm();

    act(() => {
      on('ai:tool-result')({ type: 'ai:tool-result', conversationId: null, toolUseId: 'tu-other', result: 'ok', durationMs: 1 });
    });

    expect(screen.getByTestId('ai-chat-confirm')).toBeInTheDocument();
  });

  it.each([
    ['finishes', 'ai:done', { type: 'ai:done', conversationId: 7 }],
    ['fails', 'ai:error', { type: 'ai:error', conversationId: 7, error: 'provider failed' }],
  ])('does not bring the card back on the next message when the run %s with it open', (_label, type, event) => {
    const { on } = openConfirm();
    act(() => {
      on(type)(event);
    });

    fireEvent.change(screen.getByTestId('ai-chat-input'), { target: { value: 'try again' } });
    fireEvent.click(screen.getByTestId('ai-chat-send-btn'));

    expect(screen.getByTestId('ai-chat-streaming')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-chat-confirm')).not.toBeInTheDocument();
  });
});

// ─── Streaming events that land in one batch ────────────────────────────────

describe('AiChatPanel streamed events that arrive together', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  function startRun() {
    const subscribe = vi.fn().mockReturnValue(() => {});
    renderWithWs(<AiChatPanel pageContext="devices" contextId="d1" />, { subscribe });
    fireEvent.change(screen.getByTestId('ai-chat-input'), { target: { value: 'check the device' } });
    fireEvent.click(screen.getByTestId('ai-chat-send-btn'));
    return (type: string) => subscribe.mock.calls.find((c: any[]) => c[0] === type)?.[1];
  }

  it('keeps the closing reply when its tokens and the done event land in the same batch', () => {
    const on = startRun();

    act(() => {
      on('ai:tool-start')({ type: 'ai:tool-start', conversationId: null, toolUseId: 't1', toolName: 'list_devices', input: {}, toolUseCount: 1, turnsRemaining: 5 });
      on('ai:tool-result')({ type: 'ai:tool-result', conversationId: null, toolUseId: 't1', result: '2 devices', durationMs: 1 });
      on('ai:token')({ type: 'ai:token', conversationId: null, text: 'There are ' });
      on('ai:token')({ type: 'ai:token', conversationId: null, text: 'two devices.' });
      on('ai:done')({ type: 'ai:done', conversationId: 7 });
    });

    const reply = screen.getByTestId('ai-chat-message-1');
    expect(reply).toHaveTextContent('There are two devices.');
    expect(reply).toHaveTextContent('2 devices');
  });

  it('keeps the tool output when the result and the done event land in the same batch', () => {
    const on = startRun();

    act(() => {
      on('ai:tool-start')({ type: 'ai:tool-start', conversationId: null, toolUseId: 't1', toolName: 'list_devices', input: {}, toolUseCount: 1, turnsRemaining: 5 });
      on('ai:tool-result')({ type: 'ai:tool-result', conversationId: null, toolUseId: 't1', result: '2 devices', durationMs: 1 });
      on('ai:done')({ type: 'ai:done', conversationId: 7 });
    });

    expect(screen.getByTestId('ai-chat-message-1')).toHaveTextContent('2 devices');
  });
});

// ─── YOLO mode ──────────────────────────────────────────────────────────────

describe('AiChatPanel YOLO mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  function openPanel(wsOverrides: Partial<WebSocketContextValue> = {}) {
    const subscribe = vi.fn().mockReturnValue(() => {});
    const utils = renderWithWs(<AiChatPanel pageContext="devices" contextId="d1" />, { subscribe, ...wsOverrides });
    const on = (type: string) => subscribe.mock.calls.find((c: any[]) => c[0] === type)?.[1];
    return { ...utils, on };
  }

  const sentTo = (ws: WebSocketContextValue, action: string): any[] =>
    (ws.sendMessage as ReturnType<typeof vi.fn>).mock.calls.filter((c: any[]) => c[0] === action).map((c: any[]) => c[1]);
  /** `ai:yolo` messages that change something; the ones without `enabled` are questions. */
  const yoloChanges = (ws: WebSocketContextValue) => sentTo(ws, 'ai:yolo').filter((m) => m.enabled !== undefined);

  const typeAndSend = (text = 'check the device') => {
    fireEvent.change(screen.getByTestId('ai-chat-input'), { target: { value: text } });
    fireEvent.click(screen.getByTestId('ai-chat-send-btn'));
  };

  /** Run one message to its end so the panel has a conversation with this id. */
  const haveConversation = (on: (type: string) => any, id = 7) => {
    typeAndSend('hello');
    act(() => {
      on('ai:done')({ type: 'ai:done', conversationId: id });
    });
  };

  const switchOn = () => {
    fireEvent.click(screen.getByTestId('ai-chat-yolo-toggle'));
    fireEvent.click(screen.getByTestId('ai-chat-yolo-confirm'));
  };

  it('offers a YOLO toggle that starts off, with no banner', () => {
    openPanel();

    expect(screen.getByTestId('ai-chat-yolo-toggle')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('ai-chat-yolo-badge')).not.toBeInTheDocument();
  });

  it('asks before switching on, and the dialog names what it unlocks', () => {
    openPanel();

    fireEvent.click(screen.getByTestId('ai-chat-yolo-toggle'));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('ADB shell');
    expect(dialog).toHaveTextContent('Frida');
    expect(dialog).toHaveTextContent('settings');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('Cancel, and the Escape key, leave it off and tell the server nothing', () => {
    const { ws } = openPanel();

    fireEvent.click(screen.getByTestId('ai-chat-yolo-toggle'));
    fireEvent.click(screen.getByTestId('ai-chat-yolo-cancel'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ai-chat-yolo-toggle'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    expect(screen.queryByTestId('ai-chat-yolo-badge')).not.toBeInTheDocument();
    expect(yoloChanges(ws)).toEqual([]);
  });

  it('keeps Escape in the dialog from reaching the window, where the drawer closes itself on Escape', () => {
    const onWindowKey = vi.fn();
    window.addEventListener('keydown', onWindowKey);
    try {
      openPanel();
      fireEvent.click(screen.getByTestId('ai-chat-yolo-toggle'));

      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

      expect(onWindowKey).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    } finally {
      window.removeEventListener('keydown', onWindowKey);
    }
  });

  it('puts the safe choice first in the dialog', () => {
    openPanel();

    fireEvent.click(screen.getByTestId('ai-chat-yolo-toggle'));

    expect(screen.getByTestId('ai-chat-yolo-cancel')).toHaveFocus();
  });

  it('shows the banner once on, and tells the server for an existing conversation', () => {
    const { ws, on } = openPanel();
    haveConversation(on, 7);

    switchOn();

    expect(screen.getByTestId('ai-chat-yolo-badge')).toBeInTheDocument();
    expect(screen.getByTestId('ai-chat-yolo-toggle')).toHaveAttribute('aria-pressed', 'true');
    expect(yoloChanges(ws)).toEqual([{ conversationId: 7, enabled: true }]);
  });

  it('arms a new chat in the browser and sends the flag with its first message', () => {
    const { ws } = openPanel();

    switchOn();
    expect(yoloChanges(ws)).toEqual([]);
    typeAndSend();

    expect(sentTo(ws, 'ai:message')[0]).toMatchObject({ yolo: true });
  });

  it('does not send the flag on a message to an existing conversation', () => {
    const { ws, on } = openPanel();
    haveConversation(on, 7);
    switchOn();

    typeAndSend('again');

    expect(sentTo(ws, 'ai:message')[1]).not.toHaveProperty('yolo');
  });

  it('switches a new chat on for its conversation once the first run has an id', () => {
    const { ws, on } = openPanel();
    switchOn();
    typeAndSend();

    act(() => {
      on('ai:done')({ type: 'ai:done', conversationId: 9 });
    });

    expect(yoloChanges(ws)).toEqual([{ conversationId: 9, enabled: true }]);
  });

  it('switches off without a dialog and tells the server', () => {
    const { ws, on } = openPanel();
    haveConversation(on, 7);
    switchOn();

    fireEvent.click(screen.getByTestId('ai-chat-yolo-toggle'));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-chat-yolo-badge')).not.toBeInTheDocument();
    expect(yoloChanges(ws)).toEqual([{ conversationId: 7, enabled: true }, { conversationId: 7, enabled: false }]);
  });

  it('switches off during a new chat first run by request id, and does not switch the new conversation on', () => {
    const { ws, on } = openPanel();
    switchOn();
    typeAndSend();
    const { requestId } = sentTo(ws, 'ai:message')[0];

    fireEvent.click(screen.getByTestId('ai-chat-yolo-toggle'));
    act(() => {
      on('ai:done')({ type: 'ai:done', conversationId: 9 });
    });

    expect(yoloChanges(ws)).toEqual([{ requestId, enabled: false }]);
  });

  it('New Chat turns it off and tells the server for the conversation it leaves', () => {
    const { ws, on } = openPanel();
    haveConversation(on, 7);
    switchOn();

    fireEvent.click(screen.getByTestId('ai-chat-new-btn'));

    expect(screen.queryByTestId('ai-chat-yolo-badge')).not.toBeInTheDocument();
    expect(yoloChanges(ws)).toEqual([{ conversationId: 7, enabled: true }, { conversationId: 7, enabled: false }]);
  });

  it('shows what the server says about the open conversation, and ignores other conversations', () => {
    const { on } = openPanel();
    haveConversation(on, 7);

    act(() => {
      on('ai:yolo-state')({ type: 'ai:yolo-state', conversationId: 8, enabled: true });
    });
    expect(screen.queryByTestId('ai-chat-yolo-badge')).not.toBeInTheDocument();

    act(() => {
      on('ai:yolo-state')({ type: 'ai:yolo-state', conversationId: 7, enabled: true });
    });
    expect(screen.getByTestId('ai-chat-yolo-badge')).toBeInTheDocument();

    act(() => {
      on('ai:yolo-state')({ type: 'ai:yolo-state', conversationId: 7, enabled: false });
    });
    expect(screen.queryByTestId('ai-chat-yolo-badge')).not.toBeInTheDocument();
  });

  it('asks the server about a conversation it opens', () => {
    const { ws, on } = openPanel();

    haveConversation(on, 7);

    expect(sentTo(ws, 'ai:yolo')).toContainEqual({ conversationId: 7 });
  });

  it('asks again after a reconnect, so a restarted server cannot leave a stale banner', () => {
    const subscribe = vi.fn().mockReturnValue(() => {});
    const ws = createMockWs({ subscribe, connected: true });
    const tree = (value: WebSocketContextValue) => (
      <WebSocketContext.Provider value={value}>
        <AiChatPanel pageContext="devices" contextId="d1" />
      </WebSocketContext.Provider>
    );
    const { rerender } = render(tree(ws));
    const on = (type: string) => subscribe.mock.calls.find((c: any[]) => c[0] === type)?.[1];
    haveConversation(on, 7);
    (ws.sendMessage as ReturnType<typeof vi.fn>).mockClear();

    rerender(tree({ ...ws, connected: false }));
    rerender(tree({ ...ws, connected: true }));

    expect(sentTo(ws, 'ai:yolo')).toContainEqual({ conversationId: 7 });
  });

  it('does not let a late restore of an old conversation replace a YOLO chosen in the meantime', async () => {
    let resolveRestore!: (value: unknown) => void;
    const sendRestApi = vi.fn().mockReturnValue(new Promise((resolve) => { resolveRestore = resolve; }));
    const { ws } = openPanel({ sendRestApi });

    switchOn();
    await act(async () => {
      resolveRestore({ id: '1', type: 'restapi', status: 200, body: { data: { id: 99, messages: [{ role: 'user', content: 'old' }] } } });
    });

    expect(screen.getByTestId('ai-chat-yolo-badge')).toBeInTheDocument();
    expect(sentTo(ws, 'ai:yolo')).not.toContainEqual({ conversationId: 99 });
  });
});

// ─── Chat history, remembered conversation, origin ──────────────────────────

const OPEN_KEY = 'darkride:ai-chat:open:devices:d1';

const restOk = (data: unknown) => ({ id: '1', type: 'restapi', status: 200, body: { success: true, data } });
const restStatus = (status: number) => ({ id: '1', type: 'restapi', status, body: { success: false, error: 'x' } });

function savedConversation(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    pageContext: 'devices',
    contextId: 'd1',
    title: `Chat ${id}`,
    originPath: '/ui/devices',
    createdAt: Date.now() - 4 * 3_600_000,
    updatedAt: Date.now() - 3 * 3_600_000,
    unfinished: false,
    messages: [
      { role: 'user', content: `Question ${id}` },
      { role: 'assistant', content: [{ type: 'text', text: `Answer ${id}` }] },
    ],
    ...over,
  };
}

function savedSummary(id: number, over: Record<string, unknown> = {}) {
  const { messages: _messages, ...summary } = savedConversation(id, over);
  return summary;
}

type Route = (method: string, url: string) => unknown;
const isLatest = (url: string) => url.startsWith('/v1/ai/conversations/latest');
const isList = (url: string) => url.startsWith('/v1/ai/conversations?');
const idOf = (url: string) => /^\/v1\/ai\/conversations\/(\d+)$/.exec(url)?.[1];

/** A server holding chats 7 and 8, where `latest` finds nothing. */
const library: Route = (method, url) => {
  if (isList(url)) return restOk({ conversations: [savedSummary(7), savedSummary(8)], hasMore: false });
  const id = idOf(url);
  if (id && method === 'GET') return restOk(savedConversation(Number(id)));
  return restOk(null);
};

function openHistoryPanel(route: Route = library, props: Partial<React.ComponentProps<typeof AiChatPanel>> = {}) {
  const subscribe = vi.fn().mockReturnValue(() => {});
  const sendRestApi = vi.fn((method: string, url: string) => Promise.resolve(route(method, url)));
  const ws = createMockWs({ subscribe, sendRestApi: sendRestApi as unknown as WebSocketContextValue['sendRestApi'] });
  const tree = (extra: Partial<React.ComponentProps<typeof AiChatPanel>> = {}) => (
    <WebSocketContext.Provider value={ws}>
      <AiChatPanel pageContext="devices" contextId="d1" {...props} {...extra} />
    </WebSocketContext.Provider>
  );
  const utils = render(tree());
  const on = (type: string) => subscribe.mock.calls.find((c: any[]) => c[0] === type)?.[1];
  return { ...utils, ws, sendRestApi, on, rerenderWith: (extra: Partial<React.ComponentProps<typeof AiChatPanel>>) => utils.rerender(tree(extra)) };
}

const sentOf = (ws: WebSocketContextValue, action: string): any[] =>
  (ws.sendMessage as ReturnType<typeof vi.fn>).mock.calls.filter((c: any[]) => c[0] === action).map((c: any[]) => c[1]);

const typeAndSend = (text = 'hello') => {
  fireEvent.change(screen.getByTestId('ai-chat-input'), { target: { value: text } });
  fireEvent.click(screen.getByTestId('ai-chat-send-btn'));
};

/** Run one message to its end so the panel holds a conversation with this id. */
const finishConversation = (on: (type: string) => any, id = 7) => {
  typeAndSend('hello');
  act(() => {
    on('ai:done')({ type: 'ai:done', conversationId: id });
  });
};

const toggleHistory = () => fireEvent.click(screen.getByTestId('ai-chat-history-toggle'));

describe('AiChatPanel history view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('swaps the conversation and composer for the saved chats, and back', async () => {
    openHistoryPanel();
    const toggle = screen.getByTestId('ai-chat-history-toggle');
    expect(toggle).toHaveAttribute('aria-label', 'Chat history');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(toggle);

    expect(await screen.findByTestId('ai-chat-history-item-7')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-chat-messages')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-chat-input-area')).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(toggle);

    expect(screen.getByTestId('ai-chat-messages')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-chat-history')).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  it('closes on Escape without closing the drawer', async () => {
    const windowKeydown = vi.fn();
    window.addEventListener('keydown', windowKeydown);
    openHistoryPanel();
    toggleHistory();
    await screen.findByTestId('ai-chat-history-item-7');

    fireEvent.keyDown(screen.getByTestId('ai-chat-history-search'), { key: 'Escape' });
    window.removeEventListener('keydown', windowKeydown);

    expect(screen.queryByTestId('ai-chat-history')).not.toBeInTheDocument();
    expect(windowKeydown).not.toHaveBeenCalled();
  });

  it('opens a chat from the list, shows it, and carries on in that conversation', async () => {
    const { ws } = openHistoryPanel();
    toggleHistory();

    fireEvent.click(await screen.findByTestId('ai-chat-history-item-8'));

    await waitFor(() => expect(screen.getByTestId('ai-chat-message-0')).toHaveTextContent('Question 8'));
    expect(screen.getByTestId('ai-chat-message-1')).toHaveTextContent('Answer 8');
    expect(screen.queryByTestId('ai-chat-history')).not.toBeInTheDocument();
    expect(screen.getByTestId('ai-chat-history-toggle')).toHaveAttribute('aria-pressed', 'false');
    expect(sentOf(ws, 'ai:yolo')).toContainEqual({ conversationId: 8 });
    expect(localStorage.getItem(OPEN_KEY)).toBe('8');

    typeAndSend('and then?');

    expect(sentOf(ws, 'ai:message')).toEqual([expect.objectContaining({ conversationId: 8, message: 'and then?' })]);
  });

  it('shows the YOLO state of the chat it switches to, not the one it left', async () => {
    const { on } = openHistoryPanel();
    finishConversation(on, 7);
    fireEvent.click(screen.getByTestId('ai-chat-yolo-toggle'));
    fireEvent.click(screen.getByTestId('ai-chat-yolo-confirm'));
    expect(screen.getByTestId('ai-chat-yolo-badge')).toBeInTheDocument();

    toggleHistory();
    fireEvent.click(await screen.findByTestId('ai-chat-history-item-8'));

    await waitFor(() => expect(screen.getByTestId('ai-chat-message-0')).toHaveTextContent('Question 8'));
    expect(screen.queryByTestId('ai-chat-yolo-badge')).not.toBeInTheDocument();
  });

  it('highlights the chat that is open when the list is shown again', async () => {
    openHistoryPanel();
    toggleHistory();
    fireEvent.click(await screen.findByTestId('ai-chat-history-item-8'));
    await screen.findByTestId('ai-chat-message-0');

    toggleHistory();

    expect(await screen.findByTestId('ai-chat-history-item-8')).toHaveAttribute('aria-current', 'true');
  });

  it('cannot open or delete a chat while a reply is streaming', async () => {
    openHistoryPanel();
    typeAndSend('working on it');

    toggleHistory();
    const row = await screen.findByTestId('ai-chat-history-item-7');

    expect(row).toBeDisabled();
    expect(screen.getByTestId('ai-chat-history-delete-7')).toBeDisabled();
  });

  it('returns to the conversation when a tool needs confirmation', async () => {
    const { on } = openHistoryPanel();
    typeAndSend('run it');
    toggleHistory();
    await screen.findByTestId('ai-chat-history');

    act(() => {
      on('ai:tool-confirm')({ type: 'ai:tool-confirm', conversationId: null, toolUseId: 't1', toolName: 'run_adb_command', input: {} });
    });

    expect(screen.queryByTestId('ai-chat-history')).not.toBeInTheDocument();
    expect(screen.getByTestId('ai-chat-confirm')).toBeInTheDocument();
  });

  it('New Chat leaves the list and starts a blank conversation', async () => {
    openHistoryPanel();
    toggleHistory();
    await screen.findByTestId('ai-chat-history-item-7');

    fireEvent.click(screen.getByTestId('ai-chat-new-btn'));

    expect(screen.queryByTestId('ai-chat-history')).not.toBeInTheDocument();
    expect(screen.getByTestId('ai-chat-empty')).toBeInTheDocument();
  });

  describe('deleting', () => {
    const withChat7Open: Route = (method, url) => {
      if (method === 'DELETE') return restOk(null);
      return library(method, url);
    };

    const deleteFromList = async (id: number) => {
      toggleHistory();
      await screen.findByTestId(`ai-chat-history-item-${id}`);
      fireEvent.click(screen.getByTestId(`ai-chat-history-delete-${id}`));
      fireEvent.click(screen.getByTestId('ai-chat-history-delete-confirm'));
      await waitFor(() => expect(screen.queryByTestId(`ai-chat-history-item-${id}`)).not.toBeInTheDocument());
    };

    it('resets the panel like New Chat when the open chat is deleted', async () => {
      localStorage.setItem(OPEN_KEY, '7');
      const { ws } = openHistoryPanel(withChat7Open);
      await waitFor(() => expect(screen.getByTestId('ai-chat-message-0')).toHaveTextContent('Question 7'));
      fireEvent.click(screen.getByTestId('ai-chat-yolo-toggle'));
      fireEvent.click(screen.getByTestId('ai-chat-yolo-confirm'));
      expect(screen.getByTestId('ai-chat-yolo-badge')).toBeInTheDocument();

      await deleteFromList(7);
      toggleHistory();

      expect(screen.getByTestId('ai-chat-empty')).toBeInTheDocument();
      expect(screen.queryByTestId('ai-chat-yolo-badge')).not.toBeInTheDocument();
      expect(localStorage.getItem(OPEN_KEY)).toBeNull();
      expect(sentOf(ws, 'ai:yolo')).toContainEqual({ conversationId: 7, enabled: false });
      typeAndSend('fresh start');
      expect(sentOf(ws, 'ai:message')[0].conversationId).toBeUndefined();
    });

    it('leaves the open chat alone when another one is deleted', async () => {
      localStorage.setItem(OPEN_KEY, '7');
      openHistoryPanel(withChat7Open);
      await waitFor(() => expect(screen.getByTestId('ai-chat-message-0')).toHaveTextContent('Question 7'));

      await deleteFromList(8);
      toggleHistory();

      expect(screen.getByTestId('ai-chat-message-0')).toHaveTextContent('Question 7');
      expect(localStorage.getItem(OPEN_KEY)).toBe('7');
    });
  });
});

describe('AiChatPanel origin bar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  const restoring = (over: Record<string, unknown>): Route => (_method, url) => (
    isLatest(url) ? restOk(savedConversation(7, over)) : restOk(null)
  );

  it('says where a chat started and offers a way back when you are on another page', async () => {
    const onNavigate = vi.fn();
    openHistoryPanel(restoring({ pageContext: 'automations', contextId: '', originPath: '/ui/automations?tab=runs' }), {
      originPath: '/ui/devices',
      onNavigate,
    });

    const bar = await screen.findByTestId('ai-chat-origin-bar');
    expect(bar).toHaveTextContent('Started on Automations');

    fireEvent.click(screen.getByTestId('ai-chat-origin-go'));

    expect(onNavigate).toHaveBeenCalledWith('/ui/automations?tab=runs');
  });

  it('stays hidden on the page the chat started on, whatever the query string says', async () => {
    openHistoryPanel(restoring({ originPath: '/ui/devices?filter=old' }), { originPath: '/ui/devices?filter=new', onNavigate: vi.fn() });

    await screen.findByTestId('ai-chat-message-0');

    expect(screen.queryByTestId('ai-chat-origin-bar')).not.toBeInTheDocument();
  });

  it('stays hidden for a chat saved before origins were kept', async () => {
    openHistoryPanel(restoring({ originPath: null }), { originPath: '/ui/devices', onNavigate: vi.fn() });

    await screen.findByTestId('ai-chat-message-0');

    expect(screen.queryByTestId('ai-chat-origin-bar')).not.toBeInTheDocument();
  });

  it('stays hidden when the panel does not know where it is', async () => {
    openHistoryPanel(restoring({ originPath: '/ui/automations' }));

    await screen.findByTestId('ai-chat-message-0');

    expect(screen.queryByTestId('ai-chat-origin-bar')).not.toBeInTheDocument();
  });

  it('goes away once you are on the page the chat started on', async () => {
    const { rerenderWith } = openHistoryPanel(restoring({ originPath: '/ui/automations' }), { originPath: '/ui/devices', onNavigate: vi.fn() });
    await screen.findByTestId('ai-chat-origin-bar');

    rerenderWith({ originPath: '/ui/automations' });

    expect(screen.queryByTestId('ai-chat-origin-bar')).not.toBeInTheDocument();
  });

  it('appears for a chat you started here once you move to another page', async () => {
    const { on, rerenderWith } = openHistoryPanel(library, { originPath: '/ui/devices', onNavigate: vi.fn() });
    finishConversation(on, 7);
    expect(screen.queryByTestId('ai-chat-origin-bar')).not.toBeInTheDocument();

    rerenderWith({ originPath: '/ui/traffic' });

    expect(screen.getByTestId('ai-chat-origin-bar')).toHaveTextContent('Started on Devices #d1');
  });

  it('shows the bar for a chat opened from the list', async () => {
    openHistoryPanel(library, { originPath: '/ui/traffic', onNavigate: vi.fn() });
    toggleHistory();

    fireEvent.click(await screen.findByTestId('ai-chat-history-item-8'));

    expect(await screen.findByTestId('ai-chat-origin-bar')).toHaveTextContent('Started on Devices #d1');
  });

  it('sends the origin with the first message of a new chat only', () => {
    const { ws, on } = openHistoryPanel(library, { originPath: '/ui/devices?x=1' });

    typeAndSend('first');
    act(() => { on('ai:done')({ type: 'ai:done', conversationId: 7 }); });
    typeAndSend('second');

    const [first, second] = sentOf(ws, 'ai:message');
    expect(first.originPath).toBe('/ui/devices?x=1');
    expect(second.conversationId).toBe(7);
    expect(second).not.toHaveProperty('originPath');
  });

  it('sends no origin when the panel does not know where it is', () => {
    const { ws } = openHistoryPanel(library);

    typeAndSend('first');

    expect(sentOf(ws, 'ai:message')[0]).not.toHaveProperty('originPath');
  });
});

describe('AiChatPanel remembered conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  const remembering = (id: number, remembered: unknown): Route => (_method, url) => {
    if (idOf(url) === String(id)) return remembered;
    if (isLatest(url)) return restOk(savedConversation(99));
    return restOk(null);
  };

  it('reopens the conversation remembered for this page instead of the latest one', async () => {
    localStorage.setItem(OPEN_KEY, '12');
    const { sendRestApi } = openHistoryPanel(remembering(12, restOk(savedConversation(12))));

    await waitFor(() => expect(screen.getByTestId('ai-chat-message-0')).toHaveTextContent('Question 12'));

    expect(sendRestApi.mock.calls.some(([, url]) => isLatest(url))).toBe(false);
  });

  it('falls back to the latest conversation, and forgets the id, when the remembered one is gone', async () => {
    localStorage.setItem(OPEN_KEY, '12');
    openHistoryPanel(remembering(12, restStatus(404)));

    await waitFor(() => expect(screen.getByTestId('ai-chat-message-0')).toHaveTextContent('Question 99'));

    expect(localStorage.getItem(OPEN_KEY)).toBeNull();
  });

  it('falls back to the latest conversation when the remembered one cannot be fetched', async () => {
    localStorage.setItem(OPEN_KEY, '12');
    const route: Route = (method, url) => {
      if (idOf(url) === '12') return Promise.reject(new Error('socket closed'));
      return remembering(12, null)(method, url);
    };
    openHistoryPanel(route);

    await waitFor(() => expect(screen.getByTestId('ai-chat-message-0')).toHaveTextContent('Question 99'));
  });

  it('falls back to the latest conversation when the remembered one has no messages', async () => {
    localStorage.setItem(OPEN_KEY, '12');
    openHistoryPanel(remembering(12, restOk(savedConversation(12, { messages: [] }))));

    await waitFor(() => expect(screen.getByTestId('ai-chat-message-0')).toHaveTextContent('Question 99'));
  });

  it('uses the latest conversation when nothing is remembered', async () => {
    openHistoryPanel(remembering(12, restOk(savedConversation(12))));

    await waitFor(() => expect(screen.getByTestId('ai-chat-message-0')).toHaveTextContent('Question 99'));
  });

  it('keeps a separate memory for each page context', async () => {
    localStorage.setItem(OPEN_KEY, '12');
    openHistoryPanel(remembering(12, restOk(savedConversation(12))), { contextId: 'd2' });

    await waitFor(() => expect(screen.getByTestId('ai-chat-message-0')).toHaveTextContent('Question 99'));
  });

  it('still works when storage cannot be read or written', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    try {
      const { on } = openHistoryPanel(remembering(12, restOk(savedConversation(12))));
      await waitFor(() => expect(screen.getByTestId('ai-chat-message-0')).toHaveTextContent('Question 99'));

      finishConversation(on, 5);

      expect(screen.getByTestId('ai-chat-message-2')).toBeInTheDocument();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('remembers the id a new chat gets, and forgets it on New Chat', () => {
    const { on } = openHistoryPanel(library);

    finishConversation(on, 7);
    expect(localStorage.getItem(OPEN_KEY)).toBe('7');

    fireEvent.click(screen.getByTestId('ai-chat-new-btn'));
    expect(localStorage.getItem(OPEN_KEY)).toBeNull();
  });

  it('does not let a late remembered chat replace what the user did in the meantime', async () => {
    localStorage.setItem(OPEN_KEY, '12');
    let resolveRemembered!: (value: unknown) => void;
    const route: Route = (method, url) => (
      idOf(url) === '12' ? new Promise((resolve) => { resolveRemembered = resolve; }) : library(method, url)
    );
    const { ws } = openHistoryPanel(route);

    typeAndSend('typed meanwhile');
    await act(async () => { resolveRemembered(restOk(savedConversation(12))); });

    expect(screen.queryByText('Question 12')).not.toBeInTheDocument();
    expect(screen.getByTestId('ai-chat-message-0')).toHaveTextContent('typed meanwhile');
    expect(sentOf(ws, 'ai:yolo')).not.toContainEqual({ conversationId: 12 });
  });

  it('does not let a late fallback to the latest chat replace what the user did in the meantime', async () => {
    localStorage.setItem(OPEN_KEY, '12');
    let resolveLatest!: (value: unknown) => void;
    const route: Route = (method, url) => {
      if (idOf(url) === '12') return restStatus(404);
      if (isLatest(url)) return new Promise((resolve) => { resolveLatest = resolve; });
      return library(method, url);
    };
    openHistoryPanel(route);
    await waitFor(() => expect(resolveLatest).toBeDefined());

    typeAndSend('typed meanwhile');
    await act(async () => { resolveLatest(restOk(savedConversation(99))); });

    expect(screen.queryByText('Question 99')).not.toBeInTheDocument();
    expect(screen.getByTestId('ai-chat-message-0')).toHaveTextContent('typed meanwhile');
  });
});

describe('AiChatPanel unfinished notice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  const restoring = (over: Record<string, unknown>): Route => (_method, url) => (
    isLatest(url) ? restOk(savedConversation(7, over)) : restOk(null)
  );

  it('tells you a restored chat was cut off, until you send the next message', async () => {
    openHistoryPanel(restoring({ unfinished: true }));

    const notice = await screen.findByTestId('ai-chat-unfinished-notice');
    expect(notice).toHaveTextContent('The last reply was cut off');
    expect(notice).toHaveTextContent('continue');

    typeAndSend('continue');

    expect(screen.queryByTestId('ai-chat-unfinished-notice')).not.toBeInTheDocument();
  });

  it('says nothing about a chat that finished', async () => {
    openHistoryPanel(restoring({ unfinished: false }));

    await screen.findByTestId('ai-chat-message-0');

    expect(screen.queryByTestId('ai-chat-unfinished-notice')).not.toBeInTheDocument();
  });

  it('tells you about a cut-off chat opened from the list', async () => {
    const route: Route = (method, url) => (
      idOf(url) === '8' ? restOk(savedConversation(8, { unfinished: true })) : library(method, url)
    );
    openHistoryPanel(route);
    toggleHistory();

    fireEvent.click(await screen.findByTestId('ai-chat-history-item-8'));

    expect(await screen.findByTestId('ai-chat-unfinished-notice')).toBeInTheDocument();
  });

  it('goes away on New Chat', async () => {
    openHistoryPanel(restoring({ unfinished: true }));
    await screen.findByTestId('ai-chat-unfinished-notice');

    fireEvent.click(screen.getByTestId('ai-chat-new-btn'));

    expect(screen.queryByTestId('ai-chat-unfinished-notice')).not.toBeInTheDocument();
  });
});
