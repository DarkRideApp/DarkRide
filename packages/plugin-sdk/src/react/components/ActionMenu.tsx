import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreVertical } from 'lucide-react';

export interface ActionMenuItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export type ActionMenuEntry = ActionMenuItem | 'divider';

export interface ActionMenuProps {
  items: ActionMenuEntry[];
  /** Accessible name for the trigger (e.g. "Version actions"). */
  label: string;
  'data-testid'?: string;
}

/**
 * Kebab (⋮) dropdown menu. Styling via host classes `.action-menu`,
 * `.action-menu-trigger`, `.action-menu-list`, `.action-menu-item`,
 * `.action-menu-item-danger`, `.action-menu-divider`.
 * Closes on selection, Escape, or click-outside. stopPropagation on the
 * trigger so it is safe inside clickable rows. Follows the ARIA menu
 * keyboard pattern: opening focuses the first enabled item, Arrow keys
 * cycle between enabled items, and Escape/selection return focus to the
 * trigger.
 *
 * The open list renders through a portal on `document.body` with `fixed`
 * positioning derived from the trigger's bounding rect, so ancestor
 * `overflow: hidden` containers (tables, cards) cannot clip it.
 */
export function ActionMenu({ items, label, 'data-testid': testId }: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Indices (into `items`) of enabled, selectable menu items — the focus ring.
  const enabledIndices = items.flatMap((item, idx) =>
    item !== 'divider' && !item.disabled ? [idx] : [],
  );

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      // The list lives in a portal, so it is NOT inside rootRef — treat a
      // click inside either the trigger root or the list as "inside".
      const inside =
        (rootRef.current?.contains(target) ?? false) ||
        (listRef.current?.contains(target) ?? false);
      if (!inside) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Position the portalled list under the trigger, right-aligned (matches the
  // old `right: 0` absolute layout). Track scrolling ancestors and resizes.
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    };
    update();
    window.addEventListener('scroll', update, { capture: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, { capture: true });
      window.removeEventListener('resize', update);
    };
  }, [open]);

  // Focus the first enabled item when the menu opens.
  useLayoutEffect(() => {
    if (open && enabledIndices.length > 0) {
      itemRefs.current[enabledIndices[0]]?.focus();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  const moveFocus = (delta: number) => {
    const active = document.activeElement;
    const current = enabledIndices.findIndex(i => itemRefs.current[i] === active);
    const nextPos = current === -1
      ? 0
      : (current + delta + enabledIndices.length) % enabledIndices.length;
    itemRefs.current[enabledIndices[nextPos]]?.focus();
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveFocus(-1); }
    else if (e.key === 'Tab') { close(false); }
  };

  return (
    <div className="action-menu" ref={rootRef} data-testid={testId}>
      <button
        ref={triggerRef}
        type="button"
        className="action-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open || undefined}
        aria-label={label}
        onClick={e => { e.stopPropagation(); setOpen(prev => !prev); }}
      >
        <MoreVertical size={15} />
      </button>
      {open && createPortal(
        <div
          className="action-menu-list"
          ref={listRef}
          role="menu"
          style={{ position: 'fixed', top: pos?.top ?? 0, right: pos?.right ?? 0, left: 'auto' }}
          onKeyDown={onMenuKeyDown}
          onClick={e => e.stopPropagation()}
        >
          {items.map((item, idx) =>
            item === 'divider' ? (
              <div key={`div-${idx}`} className="action-menu-divider" role="separator" />
            ) : (
              <button
                key={item.key}
                type="button"
                ref={el => { itemRefs.current[idx] = el; }}
                role="menuitem"
                tabIndex={idx === enabledIndices[0] ? 0 : -1}
                disabled={item.disabled}
                className={`action-menu-item${item.danger ? ' action-menu-item-danger' : ''}`}
                onClick={() => { close(true); item.onSelect(); }}
                data-testid={`menu-item-${item.key}`}
              >
                {item.icon}
                {item.label}
              </button>
            ),
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
