import React, { useRef } from 'react';

export interface TabItem {
  key: string;
  label: string;
  /** Numeric badge (e.g. findings count). Omit to hide. */
  count?: number;
  /** Small attention dot (e.g. notes exist). */
  dot?: boolean;
  icon?: React.ReactNode;
}

export interface TabsProps {
  items: TabItem[];
  active: string;
  onChange: (key: string) => void;
  /** Right-aligned extra content inside the strip (filters etc.) */
  trailing?: React.ReactNode;
  'data-testid'?: string;
}

/**
 * Accessible tab strip. Styling via host classes `.tabs`, `.tab`,
 * `.tab-active`, `.tab-count`, `.tab-dot` (frontend/styles.css).
 * Arrow keys move selection (wrapping); Home/End jump.
 */
export function Tabs({ items, active, onChange, trailing, 'data-testid': testId }: TabsProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  // Drop refs for tabs that no longer exist so detached nodes can be GC'd.
  refs.current.length = items.length;

  const select = (idx: number) => {
    const item = items[(idx + items.length) % items.length];
    onChange(item.key);
    refs.current[(idx + items.length) % items.length]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent, idx: number) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); select(idx + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); select(idx - 1); }
    else if (e.key === 'Home') { e.preventDefault(); select(0); }
    else if (e.key === 'End') { e.preventDefault(); select(items.length - 1); }
  };

  // Defensive no-op for an empty item list (avoids modulo-by-zero in select()).
  if (items.length === 0) {
    return <div className="tabs" role="tablist" data-testid={testId}>{trailing && <div className="tabs-trailing">{trailing}</div>}</div>;
  }

  return (
    <div className="tabs" role="tablist" data-testid={testId}>
      {items.map((item, idx) => {
        const isActive = item.key === active;
        return (
          <button
            key={item.key}
            type="button"
            ref={el => { refs.current[idx] = el; }}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            className={`tab${isActive ? ' tab-active' : ''}`}
            onClick={() => onChange(item.key)}
            onKeyDown={e => onKeyDown(e, idx)}
            data-testid={`tab-${item.key}`}
          >
            {item.icon}
            {item.label}
            {item.count != null && <span className="tab-count">{item.count}</span>}
            {item.dot && <span className="tab-dot" data-testid={`tab-dot-${item.key}`} aria-label="has content" />}
          </button>
        );
      })}
      {trailing && <div className="tabs-trailing">{trailing}</div>}
    </div>
  );
}
