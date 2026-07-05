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
  clearSelection: vi.fn(),
};

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(() => mockTerminal),
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn(() => ({ name: 'web-links' })),
}));

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

import { createShellTerminal } from './createShellTerminal';
import { WebLinksAddon } from '@xterm/addon-web-links';

function keydown(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    type: 'keydown',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    key: 'c',
    code: 'KeyC',
    ...overrides,
  } as KeyboardEvent;
}

async function flushMicrotasksAndTimers() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
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

  describe('OSC 52 clipboard writes (auto-copy triggered by shell output itself)', () => {
    it('does NOT register an OSC 52 handler by default — shell output is untrusted unless opted in', () => {
      createShellTerminal();
      expect(mockTerminal.parser.registerOscHandler).not.toHaveBeenCalled();
    });

    it('registers an OSC 52 handler when allowOscClipboardWrite is true (e.g. the trusted host shell)', () => {
      createShellTerminal({ allowOscClipboardWrite: true });
      expect(mockTerminal.parser.registerOscHandler).toHaveBeenCalledWith(52, expect.any(Function));
    });

    it('writes decoded OSC 52 clipboard payloads to the browser clipboard', () => {
      createShellTerminal({ allowOscClipboardWrite: true });
      const payload = Buffer.from('https://claude.ai/login?code=abc123', 'utf-8').toString('base64');
      oscHandlers[52](`c;${payload}`);
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://claude.ai/login?code=abc123');
    });

    it('decodes multi-byte UTF-8 OSC 52 payloads correctly', () => {
      createShellTerminal({ allowOscClipboardWrite: true });
      const payload = Buffer.from('café ✅', 'utf-8').toString('base64');
      oscHandlers[52](`c;${payload}`);
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('café ✅');
    });

    it('ignores OSC 52 clipboard read requests ("?") without touching the clipboard', () => {
      createShellTerminal({ allowOscClipboardWrite: true });
      oscHandlers[52]('c;?');
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    });

    it('ignores malformed OSC 52 payloads instead of throwing', () => {
      createShellTerminal({ allowOscClipboardWrite: true });
      expect(() => oscHandlers[52]('c;not-valid-base64!!!')).not.toThrow();
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    });

    it('ignores oversized payloads instead of blindly writing them to the clipboard', () => {
      createShellTerminal({ allowOscClipboardWrite: true });
      const hugePayload = Buffer.from('a'.repeat(200_000), 'utf-8').toString('base64');
      oscHandlers[52](`c;${hugePayload}`);
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    });

    it('does not leave an unhandled promise rejection if the clipboard write is rejected', async () => {
      Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('NotAllowedError')) } });
      const onUnhandledRejection = vi.fn();
      process.on('unhandledRejection', onUnhandledRejection);
      try {
        createShellTerminal({ allowOscClipboardWrite: true });
        const payload = Buffer.from('hello', 'utf-8').toString('base64');
        expect(() => oscHandlers[52](`c;${payload}`)).not.toThrow();
        await flushMicrotasksAndTimers();
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
      }
      expect(onUnhandledRejection).not.toHaveBeenCalled();
    });
  });

  describe('Ctrl/Cmd+C selection copy (always available — requires an explicit user selection)', () => {
    it('copies the selection on Ctrl+C when text is selected, clears the selection, and swallows the key', () => {
      createShellTerminal();
      mockTerminal.hasSelection.mockReturnValue(true);
      mockTerminal.getSelection.mockReturnValue('selected text');

      const handled = keyEventHandler!(keydown({ ctrlKey: true }));

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('selected text');
      expect(mockTerminal.clearSelection).toHaveBeenCalledTimes(1);
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
      expect(mockTerminal.clearSelection).not.toHaveBeenCalled();
      expect(handled).toBe(true);
    });

    it('does not intercept unrelated key combos', () => {
      createShellTerminal();
      mockTerminal.hasSelection.mockReturnValue(true);

      const handled = keyEventHandler!(keydown({ ctrlKey: true, key: 'v', code: 'KeyV' }));

      expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
      expect(handled).toBe(true);
    });

    it('detects the copy combo by physical key code, not the layout-dependent key character (non-Latin keyboards)', () => {
      createShellTerminal();
      mockTerminal.hasSelection.mockReturnValue(true);
      mockTerminal.getSelection.mockReturnValue('selected text');

      // Cyrillic layout: physical C key reports event.key = 'с' (U+0441), not 'c'.
      const handled = keyEventHandler!(keydown({ ctrlKey: true, key: 'с', code: 'KeyC' }));

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('selected text');
      expect(handled).toBe(false);
    });

    it('does not treat AltGr+C (ctrlKey+altKey) as a copy combo', () => {
      createShellTerminal();
      mockTerminal.hasSelection.mockReturnValue(true);

      const handled = keyEventHandler!(keydown({ ctrlKey: true, altKey: true }));

      expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
      expect(handled).toBe(true);
    });

    it('does not swallow Ctrl+C when the clipboard API is unavailable (insecure context), even with a selection', () => {
      Object.assign(navigator, { clipboard: undefined });
      createShellTerminal();
      mockTerminal.hasSelection.mockReturnValue(true);
      mockTerminal.getSelection.mockReturnValue('selected text');

      const handled = keyEventHandler!(keydown({ ctrlKey: true }));

      expect(mockTerminal.clearSelection).not.toHaveBeenCalled();
      expect(handled).toBe(true);
    });

    it('does not leave an unhandled promise rejection if the copy write is rejected', async () => {
      Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('NotAllowedError')) } });
      const onUnhandledRejection = vi.fn();
      process.on('unhandledRejection', onUnhandledRejection);
      try {
        createShellTerminal();
        mockTerminal.hasSelection.mockReturnValue(true);
        mockTerminal.getSelection.mockReturnValue('selected text');

        expect(() => keyEventHandler!(keydown({ ctrlKey: true }))).not.toThrow();
        await flushMicrotasksAndTimers();
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
      }
      expect(onUnhandledRejection).not.toHaveBeenCalled();
    });
  });
});
