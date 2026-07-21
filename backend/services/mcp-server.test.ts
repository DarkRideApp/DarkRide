import { describe, it, expect } from 'vitest';
import { describeMcpRequest, toMcpToolContent, isImageToolResult } from './mcp-server';

describe('describeMcpRequest', () => {
  it('describes a tools/list request', () => {
    expect(describeMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toBe('method=tools/list');
  });

  it('describes a tools/call request with tool name and args preview', () => {
    const body = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'list_devices', arguments: { onlineOnly: true } },
    };
    expect(describeMcpRequest(body)).toBe('tools/call name=list_devices args={"onlineOnly":true}');
  });

  it('describes a tools/call with no arguments', () => {
    const body = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ping' } };
    expect(describeMcpRequest(body)).toBe('tools/call name=ping');
  });

  it('truncates very long argument JSON', () => {
    const longArg = 'x'.repeat(500);
    const body = {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'analyze', arguments: { sql: longArg } },
    };
    const out = describeMcpRequest(body);
    expect(out.startsWith('tools/call name=analyze args=')).toBe(true);
    expect(out.length).toBeLessThan(300);
    expect(out.endsWith('…')).toBe(true);
  });

  it('handles batched JSON-RPC arrays', () => {
    const batch = [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'foo' } },
    ];
    expect(describeMcpRequest(batch)).toBe('method=tools/list, tools/call name=foo');
  });

  it('handles missing or malformed bodies gracefully', () => {
    expect(describeMcpRequest(null)).toBe('method=<missing>');
    expect(describeMcpRequest(undefined)).toBe('method=<missing>');
    expect(describeMcpRequest({})).toBe('method=<no-method>');
    expect(describeMcpRequest('not an object')).toBe('method=<malformed>');
  });
});

describe('isImageToolResult', () => {
  it('returns true for a well-formed image result', () => {
    expect(isImageToolResult({ _mcpImage: true, data: 'AAAA', mimeType: 'image/png' })).toBe(true);
  });

  it('returns false for null/undefined', () => {
    expect(isImageToolResult(null)).toBe(false);
    expect(isImageToolResult(undefined)).toBe(false);
  });

  it('returns false for strings and numbers', () => {
    expect(isImageToolResult('AAAA')).toBe(false);
    expect(isImageToolResult(42)).toBe(false);
  });

  it('returns false for partial/mistyped objects', () => {
    expect(isImageToolResult({ _mcpImage: true })).toBe(false);
    expect(isImageToolResult({ _mcpImage: true, data: 'AAAA' })).toBe(false);
    expect(isImageToolResult({ _mcpImage: false, data: 'AAAA', mimeType: 'image/png' })).toBe(false);
    expect(isImageToolResult({ data: 'AAAA', mimeType: 'image/png' })).toBe(false);
    expect(isImageToolResult({ _mcpImage: true, data: 123, mimeType: 'image/png' })).toBe(false);
  });
});

describe('toMcpToolContent', () => {
  it('wraps a string result in a single text block', () => {
    expect(toMcpToolContent('hello world')).toEqual([{ type: 'text', text: 'hello world' }]);
  });

  it('serialises an object result to JSON in a single text block', () => {
    const result = { a: 1, b: 'two' };
    expect(toMcpToolContent(result)).toEqual([
      { type: 'text', text: JSON.stringify(result, null, 2) },
    ]);
  });

  it('emits a single image block for an image result', () => {
    const result = { _mcpImage: true as const, data: 'AAAA', mimeType: 'image/png' };
    expect(toMcpToolContent(result)).toEqual([
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ]);
  });
});
