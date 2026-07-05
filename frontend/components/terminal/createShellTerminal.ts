import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import { WebLinksAddon } from '@xterm/addon-web-links';

const DEFAULT_OPTIONS: ITerminalOptions = {
  cursorBlink: true,
  fontSize: 13,
  fontFamily: "'Menlo', 'Consolas', 'DejaVu Sans Mono', monospace",
  theme: {
    background: '#1e293b',
    foreground: '#e2e8f0',
    cursor: '#e2e8f0',
  },
};

function decodeOscBase64(payload: string): string {
  const binary = atob(payload);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Creates an xterm.js Terminal wired up the way every DarkRide shell (host
 * terminal, ADB shell) needs, since the backend is a bare PTY passthrough with
 * no GUI/browser of its own:
 *  - URLs printed by the shell (e.g. `claude login`) become clickable, opening
 *    in the browser tab hosting DarkRide instead of failing to launch server-side.
 *  - OSC 52 sequences — how CLIs like the Claude Code CLI write to the clipboard
 *    (its "press c to copy" prompt) — are decoded and written to the browser
 *    clipboard, since xterm.js does not handle OSC 52 by default.
 *  - Ctrl/Cmd+C copies the active selection instead of being swallowed as
 *    SIGINT input, for shells that don't use OSC 52.
 */
export function createShellTerminal(): Terminal {
  const terminal = new Terminal(DEFAULT_OPTIONS);

  terminal.loadAddon(new WebLinksAddon());

  terminal.parser.registerOscHandler(52, (data: string) => {
    const separatorIndex = data.indexOf(';');
    const payload = separatorIndex === -1 ? '' : data.slice(separatorIndex + 1);
    if (!payload || payload === '?') return true;
    try {
      void navigator.clipboard?.writeText(decodeOscBase64(payload));
    } catch {
      // Malformed OSC 52 payload — ignore rather than break the terminal.
    }
    return true;
  });

  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    const isCopyCombo = (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'c';
    if (isCopyCombo && terminal.hasSelection()) {
      void navigator.clipboard?.writeText(terminal.getSelection());
      return false;
    }
    return true;
  });

  return terminal;
}
