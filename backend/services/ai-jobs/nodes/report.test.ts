import { describe, it, expect } from 'vitest';
import { runReport } from './report';
import type { Envelope, ReportConfig } from '../types';

describe('runReport', () => {
  const config: ReportConfig = {
    sections: [
      { title: 'Overview', from: 'agent-overview' },
      { title: 'Wait Times', from: 'agent-wait-times' },
      { title: 'Bypass Script', from: 'agent-bypass' },
    ],
  };

  it('assembles every ok section in declared order', () => {
    const envelopes: Record<string, Envelope<{ text: string }>> = {
      'agent-overview': { status: 'ok', output: { text: 'A React Native app.' } },
      'agent-wait-times': { status: 'ok', output: { text: 'No wait-time endpoints found.' } },
      'agent-bypass': { status: 'ok', output: { text: 'Frida script here.' } },
    };
    const result = runReport(config, envelopes);
    const overviewIdx = result.markdown.indexOf('## Overview');
    const waitIdx = result.markdown.indexOf('## Wait Times');
    const bypassIdx = result.markdown.indexOf('## Bypass Script');
    expect(overviewIdx).toBeGreaterThanOrEqual(0);
    expect(waitIdx).toBeGreaterThan(overviewIdx);
    expect(bypassIdx).toBeGreaterThan(waitIdx);
    expect(result.markdown).toContain('A React Native app.');
  });

  it('also returns the per-section breakdown, in declared order, with placeholders for unavailable sources', () => {
    const result = runReport(config, {
      'agent-overview': { status: 'ok', output: { text: 'A React Native app.\n' } },
      'agent-wait-times': { status: 'failed', error: 'boom' },
    });
    expect(result.sections).toEqual([
      { title: 'Overview', body: 'A React Native app.' },
      { title: 'Wait Times', body: '— Wait Times unavailable this run. Its source node did not complete.' },
      { title: 'Bypass Script', body: '— Bypass Script unavailable this run. Its source node did not complete.' },
    ]);
  });

  it('substitutes an explicit placeholder for a failed section, never throws, never silently omits it', () => {
    const envelopes: Record<string, Envelope<{ text: string }>> = {
      'agent-overview': { status: 'ok', output: { text: 'A React Native app.' } },
      'agent-wait-times': { status: 'ok', output: { text: 'No wait-time endpoints found.' } },
      'agent-bypass': { status: 'failed', error: 'ModelRefusedError: cyber' },
    };
    const result = runReport(config, envelopes);
    expect(result.markdown).toContain('## Bypass Script');
    expect(result.markdown).toContain('unavailable this run');
    expect(result.markdown).not.toContain('ModelRefusedError'); // the placeholder is honest, not a raw error dump into the doc
  });

  it('substitutes the same placeholder for a skipped or inactive section', () => {
    const envelopes: Record<string, Envelope<{ text: string }>> = {
      'agent-overview': { status: 'ok', output: { text: 'x' } },
      'agent-wait-times': { status: 'skipped' },
      'agent-bypass': { status: 'inactive' },
    };
    const result = runReport(config, envelopes);
    expect(result.markdown).toContain('## Wait Times');
    expect(result.markdown).toContain('## Bypass Script');
    expect((result.markdown.match(/unavailable this run/g) || []).length).toBe(2);
  });

  it('substitutes the placeholder when a source envelope is absent from the map entirely', () => {
    const envelopes: Record<string, Envelope<{ text: string }>> = {
      'agent-overview': { status: 'ok', output: { text: 'x' } },
    };
    const result = runReport(config, envelopes);
    expect(result.markdown).toContain('## Wait Times');
    expect((result.markdown.match(/unavailable this run/g) || []).length).toBe(2);
  });

  it('substitutes the placeholder for an ok section whose output has no string text, never throws, keeps the other sections', () => {
    // A Branch node's raw output is {chosenEdge}, not {text}. A Report section wired to it
    // must degrade to the placeholder, not crash the whole report on .trimEnd().
    const envelopes: Record<string, Envelope<{ text: string }>> = {
      'agent-overview': { status: 'ok', output: { text: 'A React Native app.' } },
      'agent-wait-times': { status: 'ok', output: { chosenEdge: 'primary' } as any },
      'agent-bypass': { status: 'ok', output: { text: 'Frida script here.' } },
    };
    let result: { markdown: string; sections: Array<{ title: string; body: string }> } | undefined;
    expect(() => {
      result = runReport(config, envelopes);
    }).not.toThrow();
    expect(result!.markdown).toContain('A React Native app.');
    expect(result!.markdown).toContain('Frida script here.');
    expect(result!.markdown).toContain('## Wait Times\n— Wait Times unavailable this run. Its source node did not complete.');
    expect(result!.markdown).not.toContain('undefined');
  });

  it('treats an inherited Object.prototype key as an unregistered assembler rather than resolving it', () => {
    const envelopes: Record<string, Envelope<{ text: string }>> = {
      'agent-overview': { status: 'ok', output: { text: 'x' } },
    };
    expect(() => runReport(config, envelopes, 'constructor')).toThrow(/Unknown report assembler "constructor"/);
  });
});
