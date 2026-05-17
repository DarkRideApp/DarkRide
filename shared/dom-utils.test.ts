import { describe, it, expect } from 'vitest';
import { domUtils } from './dom-utils';
import type { DOMNode } from './types/automation';

function makeNode(overrides: Partial<DOMNode> = {}): DOMNode {
  return {
    className: 'android.view.View',
    text: '',
    resourceId: '',
    description: '',
    bounds: [0, 0, 100, 100] as [number, number, number, number],
    clickable: false,
    enabled: true,
    children: [],
    ...overrides,
  };
}

const tree: DOMNode = makeNode({
  text: 'root',
  bounds: [0, 0, 1080, 1920],
  children: [
    makeNode({
      text: 'header',
      resourceId: 'com.app:id/header',
      bounds: [0, 0, 1080, 200],
      children: [
        makeNode({ text: 'Title', bounds: [10, 10, 200, 50] }),
        makeNode({ text: '', description: 'Back button', clickable: true, bounds: [0, 10, 50, 50] }),
      ],
    }),
    makeNode({
      text: '',
      resourceId: 'com.app:id/calendar',
      bounds: [0, 200, 1080, 1920],
      children: [
        makeNode({ text: '', description: 'February 10, available', clickable: true, bounds: [0, 200, 360, 400] }),
        makeNode({ text: '', description: 'February 11, sold out', clickable: true, bounds: [360, 200, 720, 400] }),
        makeNode({ text: '', description: 'February 12, available', clickable: true, bounds: [720, 200, 1080, 400] }),
        makeNode({ text: 'Price: $99', enabled: false, bounds: [0, 400, 500, 500] }),
      ],
    }),
  ],
});

describe('domUtils', () => {
  describe('findAll', () => {
    it('returns all nodes matching a predicate', () => {
      const available = domUtils.findAll(tree, n => n.description.endsWith('available'));
      expect(available).toHaveLength(2);
      expect(available[0].description).toBe('February 10, available');
      expect(available[1].description).toBe('February 12, available');
    });

    it('returns empty array when nothing matches', () => {
      const result = domUtils.findAll(tree, n => n.text === 'nonexistent');
      expect(result).toHaveLength(0);
    });

    it('includes root if it matches', () => {
      const result = domUtils.findAll(tree, n => n.text === 'root');
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(tree);
    });

    it('finds clickable nodes', () => {
      const clickable = domUtils.findAll(tree, n => n.clickable);
      expect(clickable).toHaveLength(4); // back button + 3 calendar dates
    });
  });

  describe('find', () => {
    it('returns first matching node', () => {
      const match = domUtils.find(tree, n => n.description.includes('February'));
      expect(match).not.toBeNull();
      expect(match!.description).toBe('February 10, available');
    });

    it('returns null when nothing matches', () => {
      const match = domUtils.find(tree, n => n.text === 'nonexistent');
      expect(match).toBeNull();
    });

    it('returns root if it matches', () => {
      const match = domUtils.find(tree, n => n.text === 'root');
      expect(match).toBe(tree);
    });
  });

  describe('flatten', () => {
    it('returns all nodes in tree as flat array', () => {
      const flat = domUtils.flatten(tree);
      // root + header + Title + Back button + calendar + 3 dates + Price = 9
      expect(flat).toHaveLength(9);
    });

    it('includes root as first element', () => {
      const flat = domUtils.flatten(tree);
      expect(flat[0]).toBe(tree);
    });

    it('works on a leaf node', () => {
      const leaf = makeNode({ text: 'leaf' });
      const flat = domUtils.flatten(leaf);
      expect(flat).toHaveLength(1);
      expect(flat[0]).toBe(leaf);
    });
  });

  describe('filter', () => {
    it('filters a flat array by predicate', () => {
      const flat = domUtils.flatten(tree);
      const enabled = domUtils.filter(flat, n => n.enabled);
      // Price node has enabled=false, all others enabled=true (8 nodes)
      expect(enabled).toHaveLength(8);
    });

    it('returns empty array for no matches', () => {
      const flat = domUtils.flatten(tree);
      const result = domUtils.filter(flat, n => n.text === 'nonexistent');
      expect(result).toHaveLength(0);
    });
  });

  describe('getCenter', () => {
    it('calculates center point from bounds', () => {
      const node = makeNode({ bounds: [100, 200, 300, 400] });
      const center = domUtils.getCenter(node);
      expect(center).toEqual({ x: 200, y: 300 });
    });

    it('handles zero-origin bounds', () => {
      const node = makeNode({ bounds: [0, 0, 100, 100] });
      const center = domUtils.getCenter(node);
      expect(center).toEqual({ x: 50, y: 50 });
    });
  });

  describe('getSize', () => {
    it('calculates size from bounds', () => {
      const node = makeNode({ bounds: [100, 200, 400, 600] });
      const size = domUtils.getSize(node);
      expect(size).toEqual({ width: 300, height: 400 });
    });

    it('returns zero size for zero-area bounds', () => {
      const node = makeNode({ bounds: [50, 50, 50, 50] });
      const size = domUtils.getSize(node);
      expect(size).toEqual({ width: 0, height: 0 });
    });
  });

  describe('getAllText', () => {
    it('collects all non-empty text and description values', () => {
      const texts = domUtils.getAllText(tree);
      expect(texts).toContain('root');
      expect(texts).toContain('header');
      expect(texts).toContain('Title');
      expect(texts).toContain('Back button');
      expect(texts).toContain('February 10, available');
      expect(texts).toContain('February 11, sold out');
      expect(texts).toContain('February 12, available');
      expect(texts).toContain('Price: $99');
    });

    it('does not include empty strings', () => {
      const texts = domUtils.getAllText(tree);
      expect(texts.every(t => t.length > 0)).toBe(true);
    });

    it('returns empty array for node with no text or description', () => {
      const node = makeNode();
      const texts = domUtils.getAllText(node);
      expect(texts).toHaveLength(0);
    });

    it('collects both text and description from same node', () => {
      const node = makeNode({ text: 'hello', description: 'world' });
      const texts = domUtils.getAllText(node);
      expect(texts).toEqual(['hello', 'world']);
    });
  });
});
