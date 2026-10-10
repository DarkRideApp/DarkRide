import { describe, it, expect } from 'vitest';
import { resolveTemplate, TemplateResolutionError } from './template';

describe('resolveTemplate', () => {
  it('substitutes a dotted path from scope', () => {
    const scope = { trigger: { appName: 'Parc Astérix' } };
    expect(resolveTemplate('Analyze {{trigger.appName}}.', scope)).toBe('Analyze Parc Astérix.');
  });

  it('substitutes multiple placeholders, including from a non-trigger source', () => {
    const scope = { trigger: { versionName: '6.10.1' }, 'agent-overview': { summary: 'React Native app' } };
    expect(resolveTemplate('{{agent-overview.summary}} (v{{trigger.versionName}})', scope))
      .toBe('React Native app (v6.10.1)');
  });

  it('throws on an unresolved path instead of leaving literal braces', () => {
    const scope = { trigger: { appName: 'Parc Astérix' } };
    expect(() => resolveTemplate('{{trigger.appNmae}}', scope)).toThrow(TemplateResolutionError);
  });

  it('throws when the source key exists but the field does not', () => {
    const scope = { trigger: { appName: 'Parc Astérix' } };
    expect(() => resolveTemplate('{{trigger.versionCode}}', scope)).toThrow(TemplateResolutionError);
  });

  it('throws referencing a node that is inactive this run, same as an unknown path', () => {
    // inactive nodes are simply absent from scope — the executor never adds them
    const scope = { trigger: { appName: 'Parc Astérix' } };
    expect(() => resolveTemplate('{{agent-diff.summary}}', scope)).toThrow(TemplateResolutionError);
  });

  it('does not evaluate expressions — a non-identifier path is a literal miss, not an error about syntax', () => {
    const scope = { trigger: { fileSizeBytes: 150088871 } };
    expect(() => resolveTemplate('{{trigger.fileSizeBytes / 1024}}', scope)).toThrow(TemplateResolutionError);
  });

  it('passes through text with no placeholders unchanged', () => {
    expect(resolveTemplate('No variables here.', {})).toBe('No variables here.');
  });
});
