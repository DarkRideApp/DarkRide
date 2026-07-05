import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

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

// Above this, a clipboard-write attempt is refused rather than blindly honored —
// bounds how much an untrusted shell can shove into the OS clipboard in one write.
const MAX_OSC52_PAYLOAD_LENGTH = 65_536;

function decodeOscBase64(payload: string): string {
  const binary = atob(payload);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export interface CreateShellTerminalOptions {
  /**
   * Honor OSC 52 clipboard-write sequences emitted by the shell's own output
   * (e.g. the Claude Code CLI's "press c to copy" flow). This reacts to ANY
   * byte the PTY prints, so it must stay off for shells whose output DarkRide
   * doesn't control — e.g. a connected Android device's ADB shell — otherwise
   * a malicious/compromised device could silently overwrite the operator's OS
   * clipboard. Manual Ctrl/Cmd+C-copies-selection below is unaffected by this
   * flag: it requires the operator to have deliberately selected the text.
   * Defaults to false (safest for untrusted shells).
   */
  allowOscClipboardWrite?: boolean;
}

/**
 * Creates an xterm.js Terminal wired up the way every DarkRide shell (host
 * terminal, ADB shell) needs, since the backend is a bare PTY passthrough with
 * no GUI/browser of its own:
 *  - URLs printed by the shell (e.g. `claude login`) become clickable, opening
 *    in the browser tab hosting DarkRide instead of failing to launch server-side.
 *  - OSC 52 sequences — how CLIs like the Claude Code CLI write to the clipboard
 *    (its "press c to copy" prompt) — are decoded and written to the browser
 *    clipboard, since xterm.js does not handle OSC 52 by default. Opt-in only;
 *    see allowOscClipboardWrite.
 *  - Ctrl/Cmd+C copies the active selection instead of being swallowed as
 *    SIGINT input, for shells that don't use OSC 52.
 */
export function createShellTerminal(options: CreateShellTerminalOptions = {}): Terminal {
  const { allowOscClipboardWrite = false } = options;
  const terminal = new Terminal(DEFAULT_OPTIONS);

  terminal.loadAddon(new WebLinksAddon());

  if (allowOscClipboardWrite) {
    terminal.parser.registerOscHandler(52, (data: string) => {
      const separatorIndex = data.indexOf(';');
      const payload = separatorIndex === -1 ? '' : data.slice(separatorIndex + 1);
      if (!payload || payload === '?' || payload.length > MAX_OSC52_PAYLOAD_LENGTH) return true;
      try {
        void navigator.clipboard?.writeText(decodeOscBase64(payload)).catch(() => {});
      } catch {
        // Malformed OSC 52 payload — ignore rather than break the terminal.
      }
      return true;
    });
  }

  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    const isCopyCombo = (event.ctrlKey || event.metaKey) && !event.altKey && event.code === 'KeyC';
    if (isCopyCombo && terminal.hasSelection() && navigator.clipboard) {
      navigator.clipboard.writeText(terminal.getSelection()).catch(() => {});
      terminal.clearSelection();
      return false;
    }
    return true;
  });

  return terminal;
}
