import { describe, it, expect } from 'vitest';
import { NODE_KIND_LABELS, NODE_KIND_DESCRIPTIONS, nodeKindLabel } from './nodeKindLabels';

describe('nodeKindLabel', () => {
  it('maps every known kind to its display label', () => {
    expect(nodeKindLabel('Sink')).toBe('Output');
    expect(nodeKindLabel('AgentCall')).toBe('Agent Call');
    expect(nodeKindLabel('ForEach')).toBe('For Each');
    expect(nodeKindLabel('Trigger')).toBe('Trigger');
  });

  it('falls back to the raw string for an unknown kind', () => {
    expect(nodeKindLabel('SomethingNew')).toBe('SomethingNew');
  });

  it('declares a label for every NodeKind', () => {
    const kinds: Array<keyof typeof NODE_KIND_LABELS> = ['Trigger', 'AgentCall', 'Transform', 'Branch', 'Report', 'ForEach', 'Sink'];
    for (const kind of kinds) expect(NODE_KIND_LABELS[kind]).toBeTruthy();
  });

  it('declares a one-line description for every NodeKind', () => {
    const kinds: Array<keyof typeof NODE_KIND_DESCRIPTIONS> = ['Trigger', 'AgentCall', 'Transform', 'Branch', 'Report', 'ForEach', 'Sink'];
    for (const kind of kinds) expect(NODE_KIND_DESCRIPTIONS[kind]).toBeTruthy();
  });
});
