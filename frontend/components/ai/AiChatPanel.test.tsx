import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ToolCallCard } from './ToolCallCard';
import { AiChatPanel, convertDbMessages } from './AiChatPanel';
import { WebSocketContext, type WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';

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

    expect(sendMessageMock).toHaveBeenCalledWith('ai:cancel', { conversationId: null });
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
    expect(sendMessageMock).toHaveBeenCalledWith('ai:cancel', { conversationId: 42 });
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

    // Should have 7 subscriptions (token, tool-start, tool-result, tool-confirm, done, error, context-usage)
    expect(subscribeMock).toHaveBeenCalledTimes(7);

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
