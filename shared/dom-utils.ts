import type { DOMNode } from './types/automation';

export interface DOMUtils {
  findAll(root: DOMNode, predicate: (node: DOMNode) => boolean): DOMNode[];
  find(root: DOMNode, predicate: (node: DOMNode) => boolean): DOMNode | null;
  flatten(root: DOMNode): DOMNode[];
  filter(nodes: DOMNode[], predicate: (node: DOMNode) => boolean): DOMNode[];
  getCenter(node: DOMNode): { x: number; y: number };
  getSize(node: DOMNode): { width: number; height: number };
  getAllText(root: DOMNode): string[];
}

function findAll(root: DOMNode, predicate: (node: DOMNode) => boolean): DOMNode[] {
  const results: DOMNode[] = [];
  if (predicate(root)) results.push(root);
  for (const child of root.children) {
    results.push(...findAll(child, predicate));
  }
  return results;
}

function find(root: DOMNode, predicate: (node: DOMNode) => boolean): DOMNode | null {
  if (predicate(root)) return root;
  for (const child of root.children) {
    const match = find(child, predicate);
    if (match) return match;
  }
  return null;
}

function flatten(root: DOMNode): DOMNode[] {
  const results: DOMNode[] = [root];
  for (const child of root.children) {
    results.push(...flatten(child));
  }
  return results;
}

function filter(nodes: DOMNode[], predicate: (node: DOMNode) => boolean): DOMNode[] {
  return nodes.filter(predicate);
}

function getCenter(node: DOMNode): { x: number; y: number } {
  const [x1, y1, x2, y2] = node.bounds;
  return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
}

function getSize(node: DOMNode): { width: number; height: number } {
  const [x1, y1, x2, y2] = node.bounds;
  return { width: x2 - x1, height: y2 - y1 };
}

function getAllText(root: DOMNode): string[] {
  const texts: string[] = [];
  if (root.text) texts.push(root.text);
  if (root.description) texts.push(root.description);
  for (const child of root.children) {
    texts.push(...getAllText(child));
  }
  return texts;
}

export const domUtils: DOMUtils = {
  findAll,
  find,
  flatten,
  filter,
  getCenter,
  getSize,
  getAllText,
};
