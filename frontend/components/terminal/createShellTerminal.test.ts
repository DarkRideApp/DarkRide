import { describe, it, expect, vi, beforeEach } from 'vitest';

const oscHandlers: Record<number, (data: string) => boolean> = {};
let keyEventHandler: ((event: KeyboardEvent) => boolean) | null = null;

const mockTerminal = {
  loadAddon: vi.fn(),
  attachCustomKeyEventHandler: vi.fn((handler: (event: KeyboardEvent) => boolean) => {
    keyEventHandler = handler;
  }),
  parser: {
    registerOscHandler: vi.fn((ident: number, handler: (data: string) => boolean) => {
      oscHandlers[ident] = handler;
    }),
  },
  hasSelection: vi.fn(),
  getSelection: vi.fn(),
};

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(() => mockTerminal),
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn(() => ({ name: 'web-links' })),
}));

import { createShellTerminal } from './createShellTerminal';
import { WebLinksAddon } from '@xterm/addon-web-links';

function keydown(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    type: 'keydown',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    key: 'c',
    ...overrides,
  } as KeyboardEvent;
}

describe('createShellTerminal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete oscHandlers[52];
    keyEventHandler = null;
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it('loads the web links addon so URLs printed by a shell become clickable', () => {
    createShellTerminal();
    expect(WebLinksAddon).toHaveBeenCalledTimes(1);
    expect(mockTerminal.loadAddon).toHaveBeenCalledWith(expect.objectContaining({ name: 'web-links' }));
  });

  it('registers an OSC 52 handler', () => {
    createShellTerminal();
    expect(mockTerminal.parser.registerOscHandler).toHaveBeenCalledWith(52, expect.any(Function));
  });

  it('writes decoded OSC 52 clipboard payloads to the browser clipboard', () => {
    createShellTerminal();
    const payload = Buffer.from('https://claude.ai/login?code=abc123', 'utf-8').toString('base64');
    oscHandlers[52](`c;${payload}`);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://claude.ai/login?code=abc123');
  });

  it('decodes multi-byte UTF-8 OSC 52 payloads correctly', () => {
    createShellTerminal();
    const payload = Buffer.from('café ✅', 'utf-8').toString('base64');
    oscHandlers[52](`c;${payload}`);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('café ✅');
  });

  it('ignores OSC 52 clipboard read requests ("?") without touching the clipboard', () => {
    createShellTerminal();
    oscHandlers[52]('c;?');
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('ignores malformed OSC 52 payloads instead of throwing', () => {
    createShellTerminal();
    expect(() => oscHandlers[52]('c;not-valid-base64!!!')).not.toThrow();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('copies the selection on Ctrl+C when text is selected, and swallows the key', () => {
    createShellTerminal();
    mockTerminal.hasSelection.mockReturnValue(true);
    mockTerminal.getSelection.mockReturnValue('selected text');

    const handled = keyEventHandler!(keydown({ ctrlKey: true }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('selected text');
    expect(handled).toBe(false);
  });

  it('copies the selection on Cmd+C (metaKey) when text is selected', () => {
    createShellTerminal();
    mockTerminal.hasSelection.mockReturnValue(true);
    mockTerminal.getSelection.mockReturnValue('selected text');

    const handled = keyEventHandler!(keydown({ metaKey: true }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('selected text');
    expect(handled).toBe(false);
  });

  it('leaves Ctrl+C alone (sends SIGINT) when nothing is selected', () => {
    createShellTerminal();
    mockTerminal.hasSelection.mockReturnValue(false);

    const handled = keyEventHandler!(keydown({ ctrlKey: true }));

    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(handled).toBe(true);
  });

  it('does not intercept unrelated key combos', () => {
    createShellTerminal();
    mockTerminal.hasSelection.mockReturnValue(true);

    const handled = keyEventHandler!(keydown({ ctrlKey: true, key: 'v' }));

    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(handled).toBe(true);
  });
});
