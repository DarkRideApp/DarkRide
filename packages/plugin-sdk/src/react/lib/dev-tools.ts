import React from 'react';

const STORAGE_KEY = 'darkride:devtools:slotInspector';
const CHANGE_EVENT = 'darkride:devtools-changed';

export function isSlotInspectorEnabled(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
}

export function setSlotInspectorEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* private-browsing — setting is ephemeral this session */ }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { slotInspector: on } }));
}

export function useSlotInspectorEnabled(): boolean {
  const [on, setOn] = React.useState<boolean>(() => isSlotInspectorEnabled());
  React.useEffect(() => {
    const refresh = () => setOn(isSlotInspectorEnabled());
    window.addEventListener(CHANGE_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(CHANGE_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  return on;
}

/**
 * Install a global keydown listener that toggles the slot inspector on
 * Shift+Alt+S. Returns an uninstall function.
 */
export function installSlotInspectorShortcut(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.shiftKey && e.altKey && (e.key === 'S' || e.key === 's')) {
      e.preventDefault();
      setSlotInspectorEnabled(!isSlotInspectorEnabled());
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
