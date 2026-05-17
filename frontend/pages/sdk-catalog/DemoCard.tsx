import React, { useEffect, useRef, useState } from 'react';
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import 'highlight.js/styles/github-dark.css';

hljs.registerLanguage('tsx', typescript);
hljs.registerLanguage('typescript', typescript);

interface DemoCardProps {
  /** The raw source of the demo file, imported via Vite's `?raw` suffix. */
  code: string;
  /** The live render — a single demo component. */
  children: React.ReactNode;
}

/**
 * Wraps a catalog demo with a collapsible code block. Pattern: render at the
 * top, "Show code" toggle below. Default-collapsed keeps the long catalog
 * page scannable.
 *
 * The `code` prop must be the raw source of the demo file imported via
 * Vite's `?raw` suffix:
 *
 *   import buttonSrc from './demos/Button.tsx?raw';
 *   <DemoCard code={buttonSrc}><ButtonDemo /></DemoCard>
 *
 * The "code IS the demo" — there's no parallel string to keep in sync with
 * the JSX. If a demo file changes, the catalog snippet updates automatically.
 */
export function DemoCard({ code, children }: DemoCardProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (open && codeRef.current && !codeRef.current.dataset.highlighted) {
      hljs.highlightElement(codeRef.current);
      codeRef.current.dataset.highlighted = 'true';
    }
  }, [open]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <div className="demo-card" style={{ marginTop: '0.75rem' }}>
      <div
        style={{
          padding: '1.25rem',
          border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius)',
          background: 'var(--bg-secondary)',
        }}
      >
        {children}
      </div>
      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setOpen(o => !o)}
        >
          {open ? 'Hide code' : 'Show code'}
        </button>
        {open && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onCopy}
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        )}
      </div>
      {open && (
        <pre
          style={{
            marginTop: '0.5rem',
            padding: '1rem',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius)',
            background: '#0d1117',
            overflow: 'auto',
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          <code ref={codeRef} className="language-tsx">{code}</code>
        </pre>
      )}
    </div>
  );
}
