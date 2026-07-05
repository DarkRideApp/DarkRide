/**
 * Dispatched on `window` once a clipboard write from a shell terminal actually
 * succeeds (OSC 52 auto-copy or Ctrl/Cmd+C selection-copy) — so the app can
 * surface a "Copied to clipboard" toast and a clipboard change is never a
 * silent surprise. See createShellTerminal.ts (dispatch) and
 * ClipboardToastBridge.tsx (listener).
 */
export const CLIPBOARD_COPIED_EVENT = 'darkride:clipboard-copied';

export function notifyClipboardCopied(): void {
  window.dispatchEvent(new CustomEvent(CLIPBOARD_COPIED_EVENT));
}
