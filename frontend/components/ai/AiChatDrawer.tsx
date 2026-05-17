import React, { useState, useEffect, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { Sparkles, X } from 'lucide-react';
import { AiChatPanel } from './AiChatPanel';
import { type PluginToolContext, getPageContext } from './page-context';

export function AiChatDrawer() {
  const [open, setOpen] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [pluginContexts, setPluginContexts] = useState<PluginToolContext[]>([]);
  const location = useLocation();

  useEffect(() => {
    fetch('/v1/plugins/registry')
      .then(res => res.json())
      .then((json: any) => {
        if (json.success && Array.isArray(json.data)) {
          const contexts = json.data.flatMap((p: any) =>
            (p.toolContexts || []).filter((tc: any) => tc.urlPattern)
          );
          setPluginContexts(contexts);
        }
      })
      .catch(() => {});
  }, []);

  const { pageContext, contextId } = getPageContext(location.pathname, pluginContexts);

  const handleOpen = useCallback(() => {
    setOpen(true);
    window.dispatchEvent(new CustomEvent('ai-drawer-toggle', { detail: { open: true } }));
  }, []);
  const handleClose = useCallback(() => {
    setOpen(false);
    window.dispatchEvent(new CustomEvent('ai-drawer-toggle', { detail: { open: false } }));
  }, []);

  // Listen for programmatic open requests
  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener('livelog:open-ai', handler);
    return () => window.removeEventListener('livelog:open-ai', handler);
  }, []);

  // Close on Escape key — must use handleClose (not setOpen directly)
  // so the ai-drawer-toggle event fires and the layout recalculates width
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, handleClose]);

  return (
    <>
      {!open && (
        <button
          className={`ai-chat-fab${isStreaming ? ' ai-chat-fab-streaming' : ''}`}
          onClick={handleOpen}
          aria-label="Open AI Chat"
          data-testid="ai-chat-fab"
        >
          <Sparkles size={20} />
        </button>
      )}

      {open && (
        <>
          <div className="ai-chat-drawer-overlay" onClick={handleClose} data-testid="ai-chat-drawer-overlay" />
          <div className="ai-chat-drawer" data-testid="ai-chat-drawer">
            <div className="ai-chat-drawer-header">
              <div className="ai-chat-drawer-title">
                <Sparkles size={16} />
                <span>AI Chat</span>
              </div>
              <button
                className="ai-chat-drawer-close"
                onClick={handleClose}
                aria-label="Close AI Chat"
                data-testid="ai-chat-drawer-close"
              >
                <X size={18} />
              </button>
            </div>
            <AiChatPanel
              pageContext={pageContext}
              contextId={contextId}
              onStreamingChange={setIsStreaming}
            />
          </div>
        </>
      )}
    </>
  );
}
