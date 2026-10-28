import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within, waitFor } from '@testing-library/react';
import { WebSocketContext, type WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import { AiChatHistory, describeContext, type AiChatHistoryProps } from './AiChatHistory';
import type { AiConversation, AiConversationSummary } from '../../../shared/types/ai-chat';

const HOUR = 3_600_000;

function summary(id: number, over: Partial<AiConversationSummary> = {}): AiConversationSummary {
  return {
    id,
    title: `Chat ${id}`,
    pageContext: 'devices',
    contextId: '',
    originPath: '/ui/devices',
    createdAt: Date.now() - 4 * HOUR,
    updatedAt: Date.now() - 3 * HOUR,
    unfinished: false,
    ...over,
  };
}

function fullConversation(id: number, over: Partial<AiConversation> = {}): AiConversation {
  return { ...summary(id), messages: [{ role: 'user', content: `Question ${id}` }], ...over };
}

const ok = (data: unknown) => ({ id: '1', type: 'restapi', status: 200, body: { success: true, data } });
const failed = (status: number) => ({ id: '1', type: 'restapi', status, body: { success: false, error: 'nope' } });
const page = (conversations: AiConversationSummary[], hasMore = false) => ok({ conversations, hasMore });

type Handler = (method: string, url: string) => unknown;

function renderHistory(handler: Handler, props: Partial<AiChatHistoryProps> = {}) {
  const sendRestApi = vi.fn((method: string, url: string) => Promise.resolve(handler(method, url)));
  const ws: WebSocketContextValue = {
    connected: true,
    serverReady: true,
    startupMessage: 'Ready',
    sendMessage: vi.fn(),
    sendRestApi: sendRestApi as unknown as WebSocketContextValue['sendRestApi'],
    subscribe: vi.fn().mockReturnValue(() => {}),
    subscribeBinary: vi.fn().mockReturnValue(() => {}),
  };
  const callbacks = { onOpen: vi.fn(), onDeleted: vi.fn(), onClose: vi.fn() };
  const utils = render(
    <WebSocketContext.Provider value={ws}>
      <AiChatHistory
        pageContext="devices"
        contextId=""
        openConversationId={null}
        busy={false}
        {...callbacks}
        {...props}
      />
    </WebSocketContext.Provider>,
  );
  const listQueries = () => sendRestApi.mock.calls
    .filter(([method, url]) => method === 'GET' && url.startsWith('/v1/ai/conversations?'))
    .map(([, url]) => new URLSearchParams(url.split('?')[1]));
  return { ...utils, sendRestApi, listQueries, ...callbacks };
}

const isList = (url: string) => url.startsWith('/v1/ai/conversations?');

describe('describeContext', () => {
  it('names the known page contexts', () => {
    expect(describeContext('automations', '')).toBe('Automations');
    expect(describeContext('devices', '')).toBe('Devices');
    expect(describeContext('dashboard', '')).toBe('Dashboard');
    expect(describeContext('session-timeline', '')).toBe('Session timeline');
    expect(describeContext('apk-diff', '')).toBe('APK diff');
  });

  it('appends the context id when there is one', () => {
    expect(describeContext('apk-analysis', '12')).toBe('APK analysis #12');
    expect(describeContext('automations', null)).toBe('Automations');
  });

  it('makes a readable name for a context it does not know', () => {
    expect(describeContext('kitchen_sink', '')).toBe('Kitchen sink');
    expect(describeContext('my-plugin', 'abc')).toBe('My plugin #abc');
  });

  it('shortens a very long context id', () => {
    expect(describeContext('devices', 'x'.repeat(60))).toBe(`Devices #${'x'.repeat(23)}…`);
  });
});

describe('AiChatHistory list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a loading state, then the first page of chats from every page', async () => {
    const { listQueries } = renderHistory((_m, url) => (isList(url) ? page([summary(1), summary(2)]) : ok(null)));

    expect(screen.getByTestId('ai-chat-history-loading')).toBeInTheDocument();
    await screen.findByTestId('ai-chat-history-item-1');

    expect(screen.queryByTestId('ai-chat-history-loading')).not.toBeInTheDocument();
    expect(screen.getByTestId('ai-chat-history-item-2')).toBeInTheDocument();
    const [first] = listQueries();
    expect(first.get('limit')).toBe('30');
    expect(first.get('offset')).toBe('0');
    expect(first.has('q')).toBe(false);
    expect(first.has('pageContext')).toBe(false);
    expect(first.has('contextId')).toBe(false);
  });

  it('shows the title, where the chat started and when it was last used', async () => {
    renderHistory(() => page([summary(1, { title: 'Why did the login fail', pageContext: 'apk-analysis', contextId: '12' })]));

    const row = await screen.findByTestId('ai-chat-history-item-1');

    expect(row).toHaveTextContent('Why did the login fail');
    expect(row).toHaveTextContent('APK analysis #12');
    expect(row).toHaveTextContent('3h ago');
  });

  it('calls a chat without a title Untitled chat', async () => {
    renderHistory(() => page([summary(1, { title: null })]));

    expect(await screen.findByTestId('ai-chat-history-item-1')).toHaveTextContent('Untitled chat');
  });

  it('marks only the chats whose last reply did not finish', async () => {
    renderHistory(() => page([summary(1, { unfinished: true }), summary(2)]));

    const unfinishedRow = await screen.findByTestId('ai-chat-history-item-1');
    expect(within(unfinishedRow).getByText('Unfinished')).toBeInTheDocument();
    expect(within(screen.getByTestId('ai-chat-history-item-2')).queryByText('Unfinished')).not.toBeInTheDocument();
  });

  it('highlights the chat that is open', async () => {
    renderHistory(() => page([summary(1), summary(2)]), { openConversationId: 2 });

    await screen.findByTestId('ai-chat-history-item-1');

    expect(screen.getByTestId('ai-chat-history-item-2')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('ai-chat-history-item-1')).not.toHaveAttribute('aria-current');
  });

  it('says so when nothing has been saved', async () => {
    renderHistory(() => page([]));

    expect(await screen.findByTestId('ai-chat-history-empty')).toHaveTextContent('No saved chats yet');
  });

  it('shows an error with a Retry that loads the list again', async () => {
    let attempts = 0;
    const { sendRestApi } = renderHistory(() => (++attempts === 1 ? failed(500) : page([summary(1)])));

    const retry = await screen.findByTestId('ai-chat-history-retry');
    expect(screen.getByTestId('ai-chat-history-error')).toBeInTheDocument();

    fireEvent.click(retry);

    await screen.findByTestId('ai-chat-history-item-1');
    expect(screen.queryByTestId('ai-chat-history-error')).not.toBeInTheDocument();
    expect(sendRestApi).toHaveBeenCalledTimes(2);
  });

  it('treats a rejected request as an error too', async () => {
    renderHistory(() => { throw new Error('socket closed'); });

    expect(await screen.findByTestId('ai-chat-history-error')).toBeInTheDocument();
  });

  it('focuses the search box', async () => {
    renderHistory(() => page([]));

    await screen.findByTestId('ai-chat-history-empty');

    expect(screen.getByTestId('ai-chat-history-search')).toHaveFocus();
  });
});

describe('AiChatHistory search and scope', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits 250 ms after the last keystroke, then searches from the first page', async () => {
    vi.useFakeTimers();
    const { listQueries } = renderHistory(() => page([]));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(listQueries()).toHaveLength(1);

    const search = screen.getByTestId('ai-chat-history-search');
    fireEvent.change(search, { target: { value: 'log' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    fireEvent.change(search, { target: { value: 'login' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(249); });
    expect(listQueries()).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    expect(listQueries()).toHaveLength(2);
    expect(listQueries()[1].get('q')).toBe('login');
    expect(listQueries()[1].get('offset')).toBe('0');
  });

  it('says nothing matched when a search finds no chats', async () => {
    const { listQueries } = renderHistory((_m, url) => (url.includes('q=zzz') ? page([]) : page([summary(1)])));
    await screen.findByTestId('ai-chat-history-item-1');

    fireEvent.change(screen.getByTestId('ai-chat-history-search'), { target: { value: 'zzz' } });

    expect(await screen.findByTestId('ai-chat-history-empty')).toHaveTextContent('No chats match your search');
    expect(listQueries().at(-1)!.get('q')).toBe('zzz');
  });

  it('keeps the answer to the newest search when an older one finishes last', async () => {
    const pending: Record<string, (value: unknown) => void> = {};
    renderHistory((_m, url) => {
      const q = new URLSearchParams(url.split('?')[1]).get('q');
      if (q === null) return page([summary(1)]);
      return new Promise((resolve) => { pending[q] = resolve; });
    });
    await screen.findByTestId('ai-chat-history-item-1');

    const search = screen.getByTestId('ai-chat-history-search');
    fireEvent.change(search, { target: { value: 'a' } });
    await waitFor(() => expect(pending.a).toBeDefined());
    fireEvent.change(search, { target: { value: 'ab' } });
    await waitFor(() => expect(pending.ab).toBeDefined());

    await act(async () => { pending.ab(page([summary(22, { title: 'Newest answer' })])); });
    await act(async () => { pending.a(page([summary(11, { title: 'Stale answer' })])); });

    expect(screen.getByTestId('ai-chat-history-item-22')).toHaveTextContent('Newest answer');
    expect(screen.queryByTestId('ai-chat-history-item-11')).not.toBeInTheDocument();
  });

  it('offers All pages (the default) and This page, and narrows the list to the current page', async () => {
    const { listQueries } = renderHistory(() => page([summary(1)]), { pageContext: 'apk-analysis', contextId: '12' });
    await screen.findByTestId('ai-chat-history-item-1');
    expect(screen.getByTestId('ai-chat-history-scope-all')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('ai-chat-history-scope-page')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByTestId('ai-chat-history-scope-page'));

    await waitFor(() => expect(listQueries()).toHaveLength(2));
    expect(listQueries()[1].get('pageContext')).toBe('apk-analysis');
    expect(listQueries()[1].get('contextId')).toBe('12');
    expect(screen.getByTestId('ai-chat-history-scope-page')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByTestId('ai-chat-history-scope-all'));

    await waitFor(() => expect(listQueries()).toHaveLength(3));
    expect(listQueries()[2].has('pageContext')).toBe(false);
  });

  it('asks for a page context with no id by an empty contextId', async () => {
    const { listQueries } = renderHistory(() => page([]), { pageContext: 'devices', contextId: '' });
    await screen.findByTestId('ai-chat-history-empty');

    fireEvent.click(screen.getByTestId('ai-chat-history-scope-page'));

    await waitFor(() => expect(listQueries()).toHaveLength(2));
    expect(listQueries()[1].get('contextId')).toBe('');
  });

  it('says there is nothing on this page when the page has no saved chats', async () => {
    renderHistory((_m, url) => (url.includes('pageContext=') ? page([]) : page([summary(1)])));
    await screen.findByTestId('ai-chat-history-item-1');

    fireEvent.click(screen.getByTestId('ai-chat-history-scope-page'));

    expect(await screen.findByTestId('ai-chat-history-empty')).toHaveTextContent('No saved chats on this page');
  });
});

describe('AiChatHistory paging', () => {
  it('loads the next page on request, appends it and drops duplicates', async () => {
    const { listQueries } = renderHistory((_m, url) => {
      const offset = new URLSearchParams(url.split('?')[1]).get('offset');
      return offset === '0' ? page([summary(1), summary(2)], true) : page([summary(2), summary(3)], false);
    });
    await screen.findByTestId('ai-chat-history-item-1');

    fireEvent.click(screen.getByTestId('ai-chat-history-more'));

    await screen.findByTestId('ai-chat-history-item-3');
    expect(listQueries()[1].get('offset')).toBe('2');
    expect(screen.getAllByTestId(/^ai-chat-history-item-\d+$/)).toHaveLength(3);
    expect(screen.queryByTestId('ai-chat-history-more')).not.toBeInTheDocument();
  });

  it('has no Load more when the list is complete', async () => {
    renderHistory(() => page([summary(1)], false));

    await screen.findByTestId('ai-chat-history-item-1');

    expect(screen.queryByTestId('ai-chat-history-more')).not.toBeInTheDocument();
  });

  it('keeps the chats and offers another try when the next page fails', async () => {
    renderHistory((_m, url) => (new URLSearchParams(url.split('?')[1]).get('offset') === '0' ? page([summary(1)], true) : failed(500)));
    await screen.findByTestId('ai-chat-history-item-1');

    fireEvent.click(screen.getByTestId('ai-chat-history-more'));

    expect(await screen.findByTestId('ai-chat-history-more-error')).toBeInTheDocument();
    expect(screen.getByTestId('ai-chat-history-item-1')).toBeInTheDocument();
    expect(screen.getByTestId('ai-chat-history-more')).toBeInTheDocument();
  });

  it('ignores a next page that arrives after a new search', async () => {
    let releaseMore!: (value: unknown) => void;
    renderHistory((_m, url) => {
      const query = new URLSearchParams(url.split('?')[1]);
      if (query.get('offset') === '1') return new Promise((resolve) => { releaseMore = resolve; });
      if (query.get('q') === 'fresh') return page([summary(9, { title: 'Fresh result' })]);
      return page([summary(1)], true);
    });
    await screen.findByTestId('ai-chat-history-item-1');

    fireEvent.click(screen.getByTestId('ai-chat-history-more'));
    await waitFor(() => expect(releaseMore).toBeDefined());
    fireEvent.change(screen.getByTestId('ai-chat-history-search'), { target: { value: 'fresh' } });
    await screen.findByTestId('ai-chat-history-item-9');

    await act(async () => { releaseMore(page([summary(5, { title: 'Late page' })])); });

    expect(screen.queryByTestId('ai-chat-history-item-5')).not.toBeInTheDocument();
    expect(screen.getByTestId('ai-chat-history-item-9')).toBeInTheDocument();
  });
});

describe('AiChatHistory opening a chat', () => {
  it('fetches the whole conversation and hands it over', async () => {
    const conversation = fullConversation(7);
    const { sendRestApi, onOpen } = renderHistory((_m, url) => (isList(url) ? page([summary(7)]) : ok(conversation)));

    fireEvent.click(await screen.findByTestId('ai-chat-history-item-7'));

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(conversation));
    expect(sendRestApi).toHaveBeenCalledWith('GET', '/v1/ai/conversations/7');
  });

  it('stays on the list with a message when the chat cannot be fetched', async () => {
    const { onOpen } = renderHistory((_m, url) => (isList(url) ? page([summary(7)]) : failed(500)));

    fireEvent.click(await screen.findByTestId('ai-chat-history-item-7'));

    expect(await screen.findByTestId('ai-chat-history-action-error')).toHaveTextContent('Could not open that chat');
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByTestId('ai-chat-history-item-7')).toBeInTheDocument();
  });

  it('treats an empty answer as a failure to open', async () => {
    const { onOpen } = renderHistory((_m, url) => (isList(url) ? page([summary(7)]) : ok(null)));

    fireEvent.click(await screen.findByTestId('ai-chat-history-item-7'));

    expect(await screen.findByTestId('ai-chat-history-action-error')).toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('drops a row whose chat no longer exists', async () => {
    renderHistory((_m, url) => (isList(url) ? page([summary(7), summary(8)]) : failed(404)));

    fireEvent.click(await screen.findByTestId('ai-chat-history-item-7'));

    expect(await screen.findByTestId('ai-chat-history-action-error')).toHaveTextContent('no longer exists');
    expect(screen.queryByTestId('ai-chat-history-item-7')).not.toBeInTheDocument();
    expect(screen.getByTestId('ai-chat-history-item-8')).toBeInTheDocument();
  });

  it('does not open or delete anything while a reply is streaming', async () => {
    const { sendRestApi, onOpen } = renderHistory(() => page([summary(7)]), { busy: true });
    const row = await screen.findByTestId('ai-chat-history-item-7');

    expect(row).toBeDisabled();
    expect(row).toHaveAttribute('title', expect.stringMatching(/reply to finish/i));
    expect(screen.getByTestId('ai-chat-history-delete-7')).toBeDisabled();

    fireEvent.click(row);

    expect(onOpen).not.toHaveBeenCalled();
    expect(sendRestApi).toHaveBeenCalledTimes(1);
  });
});

describe('AiChatHistory deleting a chat', () => {
  it('names the chat it is about to delete', async () => {
    renderHistory(() => page([summary(7, { title: 'Pinning hooks on the Pixel' }), summary(8)]));
    await screen.findByTestId('ai-chat-history-item-7');

    fireEvent.click(screen.getByTestId('ai-chat-history-delete-7'));

    expect(screen.getByTestId('ai-chat-history-confirm-text')).toHaveTextContent('Delete “Pinning hooks on the Pixel”?');
  });

  it('names an untitled chat as untitled', async () => {
    renderHistory(() => page([summary(7, { title: null })]));
    await screen.findByTestId('ai-chat-history-item-7');

    fireEvent.click(screen.getByTestId('ai-chat-history-delete-7'));

    expect(screen.getByTestId('ai-chat-history-confirm-text')).toHaveTextContent('Delete “Untitled chat”?');
  });

  it('asks first, and Cancel leaves the chat alone', async () => {
    const { sendRestApi } = renderHistory(() => page([summary(7)]));
    await screen.findByTestId('ai-chat-history-item-7');

    fireEvent.click(screen.getByTestId('ai-chat-history-delete-7'));
    expect(screen.getByTestId('ai-chat-history-delete-confirm')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ai-chat-history-delete-cancel'));

    expect(screen.queryByTestId('ai-chat-history-delete-confirm')).not.toBeInTheDocument();
    expect(screen.getByTestId('ai-chat-history-item-7')).toBeInTheDocument();
    expect(sendRestApi.mock.calls.some(([method]) => method === 'DELETE')).toBe(false);
  });

  it('deletes the chat once confirmed, removes the row and says so', async () => {
    const { sendRestApi, onDeleted } = renderHistory((method, url) => (
      method === 'DELETE' ? ok(null) : isList(url) ? page([summary(7), summary(8)]) : ok(null)
    ));
    await screen.findByTestId('ai-chat-history-item-7');

    fireEvent.click(screen.getByTestId('ai-chat-history-delete-7'));
    fireEvent.click(screen.getByTestId('ai-chat-history-delete-confirm'));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(7));
    expect(sendRestApi).toHaveBeenCalledWith('DELETE', '/v1/ai/conversations/7');
    expect(screen.queryByTestId('ai-chat-history-item-7')).not.toBeInTheDocument();
    expect(screen.getByTestId('ai-chat-history-item-8')).toBeInTheDocument();
  });

  it('keeps the row and shows an error when the delete fails', async () => {
    const { onDeleted } = renderHistory((method, url) => (
      method === 'DELETE' ? failed(500) : isList(url) ? page([summary(7)]) : ok(null)
    ));
    await screen.findByTestId('ai-chat-history-item-7');

    fireEvent.click(screen.getByTestId('ai-chat-history-delete-7'));
    fireEvent.click(screen.getByTestId('ai-chat-history-delete-confirm'));

    expect(await screen.findByTestId('ai-chat-history-action-error')).toHaveTextContent('Could not delete');
    expect(screen.getByTestId('ai-chat-history-item-7')).toBeInTheDocument();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('counts a chat that is already gone as deleted', async () => {
    const { onDeleted } = renderHistory((method, url) => (
      method === 'DELETE' ? failed(404) : isList(url) ? page([summary(7)]) : ok(null)
    ));
    await screen.findByTestId('ai-chat-history-item-7');

    fireEvent.click(screen.getByTestId('ai-chat-history-delete-7'));
    fireEvent.click(screen.getByTestId('ai-chat-history-delete-confirm'));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(7));
    expect(screen.queryByTestId('ai-chat-history-item-7')).not.toBeInTheDocument();
  });
});

describe('AiChatHistory Escape key', () => {
  it('closes the view and does not reach the window, where the drawer listens', async () => {
    const windowKeydown = vi.fn();
    window.addEventListener('keydown', windowKeydown);
    const { onClose } = renderHistory(() => page([summary(1)]));
    await screen.findByTestId('ai-chat-history-item-1');

    fireEvent.keyDown(screen.getByTestId('ai-chat-history-search'), { key: 'Escape' });
    window.removeEventListener('keydown', windowKeydown);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(windowKeydown).not.toHaveBeenCalled();
  });

  it('first backs out of a delete question', async () => {
    const { onClose } = renderHistory(() => page([summary(1)]));
    await screen.findByTestId('ai-chat-history-item-1');
    fireEvent.click(screen.getByTestId('ai-chat-history-delete-1'));

    fireEvent.keyDown(screen.getByTestId('ai-chat-history-delete-confirm'), { key: 'Escape' });

    expect(screen.queryByTestId('ai-chat-history-delete-confirm')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
