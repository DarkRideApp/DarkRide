import { describe, it, expect } from 'vitest';
import { resolvePreview } from './templatePreview';

describe('resolvePreview', () => {
  it('substitutes a resolvable path', () => {
    expect(resolvePreview('Analyze {{trigger.appName}}.', { trigger: { appName: 'Parc Astérix' } }))
      .toBe('Analyze Parc Astérix.');
  });

  it('marks an unresolved path inline instead of throwing — this is a preview, typing must never crash', () => {
    const result = resolvePreview('{{trigger.typoed}}', { trigger: { appName: 'x' } });
    expect(result).toContain('unresolved');
    expect(() => resolvePreview('{{trigger.typoed}}', { trigger: {} })).not.toThrow();
  });
});
