import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { clampToViewport } from './viewportClamp';

/**
 * Right-click-a-node menu: Delete, Duplicate, Disconnect. Cursor-positioned, closes on outside
 * click/Escape — same interaction shell as NodeKindPalette, one action list instead of a search.
 */
export function NodeContextMenu({ position, onDelete, onDuplicate, onDisconnect, onClose }: {
  position: { x: number; y: number };
  onDelete: () => void;
  onDuplicate: () => void;
  onDisconnect: () => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [renderPosition, setRenderPosition] = useState(position);

  useLayoutEffect(() => {
    if (!rootRef.current) return;
    const rect = rootRef.current.getBoundingClientRect();
    setRenderPosition(clampToViewport(position, { width: rect.width, height: rect.height }, { width: window.innerWidth, height: window.innerHeight }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position.x, position.y]);

  useEffect(() => {
    function onDocPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('pointerdown', onDocPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  function run(action: () => void) {
    action();
    onClose();
  }

  return (
    <div className="ai-jobs-node-picker-popover" ref={rootRef} style={{ position: 'fixed', left: renderPosition.x, top: renderPosition.y, zIndex: 50 }} role="menu">
      <button type="button" role="menuitem" className="ai-jobs-node-picker-item" onClick={() => run(onDuplicate)}>Duplicate</button>
      <button type="button" role="menuitem" className="ai-jobs-node-picker-item" onClick={() => run(onDisconnect)}>Disconnect</button>
      <button type="button" role="menuitem" className="ai-jobs-node-picker-item" onClick={() => run(onDelete)}>Delete</button>
    </div>
  );
}
