import React, { useEffect, useMemo, useState } from 'react';

interface Base64DecodeModalProps {
  encoded: string;
  onClose: () => void;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function isBinary(decoded: string): boolean {
  let controlCount = 0;
  for (let i = 0; i < decoded.length; i++) {
    const code = decoded.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      controlCount++;
    }
  }
  return decoded.length > 0 && controlCount / decoded.length > 0.1;
}

function toHexDump(decoded: string): string {
  const lines: string[] = [];
  for (let offset = 0; offset < decoded.length; offset += 16) {
    const hexParts: string[] = [];
    let ascii = '';
    for (let i = 0; i < 16; i++) {
      if (offset + i < decoded.length) {
        const byte = decoded.charCodeAt(offset + i);
        hexParts.push(byte.toString(16).padStart(2, '0'));
        ascii += byte >= 0x20 && byte < 0x7f ? decoded[offset + i] : '.';
      } else {
        hexParts.push('  ');
        ascii += ' ';
      }
    }
    const addr = offset.toString(16).padStart(8, '0');
    lines.push(`${addr}  ${hexParts.slice(0, 8).join(' ')}  ${hexParts.slice(8).join(' ')}  |${ascii}|`);
  }
  return lines.join('\n');
}

export function Base64DecodeModal({ encoded, onClose }: Base64DecodeModalProps) {
  const [copied, setCopied] = useState(false);

  const { decoded, error, binary } = useMemo(() => {
    try {
      const clean = stripQuotes(encoded);
      const result = atob(clean);
      return { decoded: result, error: null, binary: isBinary(result) };
    } catch {
      return { decoded: null, error: 'Invalid base64 encoding', binary: false };
    }
  }, [encoded]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleCopy = () => {
    if (!decoded) return;
    const text = binary ? toHexDump(decoded) : decoded;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div
      data-testid="base64-modal-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        data-testid="base64-modal"
        style={{
          background: 'var(--bg-primary)', borderRadius: 8,
          border: '1px solid var(--border-color)',
          maxWidth: 700, width: '100%', maxHeight: '80vh',
          display: 'flex', flexDirection: 'column',
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px', borderBottom: '1px solid var(--border-color)',
        }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            Decoded Base64
            {decoded && (
              <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 8 }}>
                {binary ? `${decoded.length} bytes (binary)` : `${decoded.length} chars (text)`}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {decoded && (
              <button
                data-testid="base64-copy-btn"
                className="btn btn-sm"
                onClick={handleCopy}
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            )}
            <button
              data-testid="base64-close-btn"
              className="btn btn-sm"
              onClick={onClose}
              style={{ minWidth: 28 }}
            >
              &times;
            </button>
          </div>
        </div>

        {/* Content */}
        <div style={{ padding: 16, overflow: 'auto', flex: 1 }}>
          {error ? (
            <div data-testid="base64-error" style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              {error}
            </div>
          ) : binary ? (
            <pre
              data-testid="base64-hex"
              style={{
                margin: 0, fontSize: 12, fontFamily: 'var(--font-mono)',
                whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                color: 'var(--text-primary)',
              }}
            >
              {toHexDump(decoded!)}
            </pre>
          ) : (
            <pre
              data-testid="base64-text"
              style={{
                margin: 0, fontSize: 12, fontFamily: 'var(--font-mono)',
                whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                color: 'var(--text-primary)',
              }}
            >
              {decoded}
            </pre>
          )}
        </div>

        {/* Encoded source */}
        <div style={{
          padding: '8px 16px', borderTop: '1px solid var(--border-color)',
          fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          Source: {encoded}
        </div>
      </div>
    </div>
  );
}
