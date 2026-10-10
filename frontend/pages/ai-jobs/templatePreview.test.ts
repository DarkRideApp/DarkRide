import { describe, it, expect } from 'vitest';
import { resolvePreview } from './templatePreview';

describe('resolvePreview', () => {
  it('substitutes a resolvable path', () => {
    expect(resolvePreview('Analyze {{trigger.appName}}.', { trigger: { appName: 'Parc Astérix' } }))
      .toBe('Analyze Parc Astérix.');
  });

  it('substitutes a hyphenated source node id, matching the server regex (agent-overview, not just trigger)', () => {
    // Previously the first segment's character class had no hyphen, so this token never matched
    // at all — left untouched with no "(unresolved)" marker, while a real run would substitute it.
    expect(resolvePreview('{{agent-overview.text}}', { 'agent-overview': { text: 'hi' } })).toBe('hi');
  });

  it('still marks an unresolved hyphenated source', () => {
    expect(resolvePreview('{{agent-missing.text}}', {})).toBe('{{agent-missing.text}} (unresolved)');
  });

  it('marks an unresolved path inline instead of throwing — this is a preview, typing must never crash', () => {
    const result = resolvePreview('{{trigger.typoed}}', { trigger: { appName: 'x' } });
    expect(result).toContain('unresolved');
    expect(() => resolvePreview('{{trigger.typoed}}', { trigger: {} })).not.toThrow();
  });
});
