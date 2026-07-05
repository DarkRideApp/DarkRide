import { useEffect } from 'react';
import { useToast } from '@darkrideapp/plugin-sdk/react';
import { CLIPBOARD_COPIED_EVENT } from './clipboardEvents';

/**
 * Surfaces a toast whenever a shell terminal writes to the OS clipboard
 * (OSC 52 auto-copy or a manual Ctrl/Cmd+C selection-copy), so a clipboard
 * change made on the operator's behalf is never silent or surprising.
 */
export function ClipboardToastBridge() {
  const toast = useToast();

  useEffect(() => {
    const handleCopy = () => toast.success('Copied to clipboard');
    window.addEventListener(CLIPBOARD_COPIED_EVENT, handleCopy);
    return () => window.removeEventListener(CLIPBOARD_COPIED_EVENT, handleCopy);
  }, [toast]);

  return null;
}
