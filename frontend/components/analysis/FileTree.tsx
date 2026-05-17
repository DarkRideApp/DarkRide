import React, { useState, useMemo, useCallback } from 'react';

export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  language?: string;
  size?: number;
  children?: TreeNode[];
}

interface FileTreeProps {
  tree: TreeNode[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onDoubleClick?: (path: string) => void;
  filter: string;
}

/** Recursively filter nodes by search string, keeping parent dirs that have matching children */
function filterTree(nodes: TreeNode[], filter: string): TreeNode[] {
  if (!filter) return nodes;
  const lowerFilter = filter.toLowerCase();
  const result: TreeNode[] = [];
  for (const node of nodes) {
    if (node.type === 'file') {
      if (node.name.toLowerCase().includes(lowerFilter) || node.path.toLowerCase().includes(lowerFilter)) {
        result.push(node);
      }
    } else {
      const filteredChildren = filterTree(node.children || [], filter);
      if (filteredChildren.length > 0) {
        result.push({ ...node, children: filteredChildren });
      } else if (node.name.toLowerCase().includes(lowerFilter)) {
        result.push(node);
      }
    }
  }
  return result;
}

/** Count total files in a directory recursively (cached via Map) */
function buildCountCache(nodes: TreeNode[], cache: Map<string, number>): void {
  for (const node of nodes) {
    if (node.type === 'file') {
      cache.set(node.path, 1);
    } else {
      buildCountCache(node.children || [], cache);
      let count = 0;
      for (const child of node.children || []) {
        count += cache.get(child.path) || 0;
      }
      cache.set(node.path, count);
    }
  }
}

function TreeItem({
  node,
  selectedPath,
  onSelect,
  onDoubleClick,
  depth,
  expandedPaths,
  toggleExpanded,
  countCache,
}: {
  node: TreeNode;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onDoubleClick?: (path: string) => void;
  depth: number;
  expandedPaths: Set<string>;
  toggleExpanded: (path: string) => void;
  countCache: Map<string, number>;
}) {
  const isDir = node.type === 'dir';
  const isExpanded = expandedPaths.has(node.path);
  const isSelected = selectedPath === node.path;
  const fileCount = isDir ? (countCache.get(node.path) || 0) : 0;

  const handleClick = useCallback(() => {
    if (isDir) {
      toggleExpanded(node.path);
    } else {
      onSelect(node.path);
    }
  }, [isDir, node.path, onSelect, toggleExpanded]);

  const handleDoubleClick = useCallback(() => {
    if (!isDir && onDoubleClick) {
      onDoubleClick(node.path);
    }
  }, [isDir, node.path, onDoubleClick]);

  return (
    <>
      <div
        data-testid={isDir ? `tree-dir-${node.name}` : `tree-file-${node.name}`}
        className={`file-tree-item${isSelected ? ' file-tree-item-selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        role="treeitem"
        aria-selected={isSelected}
        aria-expanded={isDir ? isExpanded : undefined}
      >
        <span className="file-tree-icon" style={{ fontSize: 10, width: 14, textAlign: 'center', flexShrink: 0 }}>
          {isDir ? (isExpanded ? '\u25BE' : '\u25B8') : ''}
        </span>
        <span className="file-tree-name" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {node.name}
        </span>
        {isDir && (
          <span className="file-tree-count" style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0, marginLeft: 4 }}>
            {fileCount}
          </span>
        )}
      </div>
      {isDir && isExpanded && (node.children || []).map(child => (
        <TreeItem
          key={child.path}
          node={child}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onDoubleClick={onDoubleClick}
          depth={depth + 1}
          expandedPaths={expandedPaths}
          toggleExpanded={toggleExpanded}
          countCache={countCache}
        />
      ))}
    </>
  );
}

export function FileTree({ tree, selectedPath, onSelect, onDoubleClick, filter }: FileTreeProps) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());

  const toggleExpanded = useCallback((path: string) => {
    setExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const filteredTree = useMemo(() => filterTree(tree, filter), [tree, filter]);

  const countCache = useMemo(() => {
    const cache = new Map<string, number>();
    buildCountCache(filteredTree, cache);
    return cache;
  }, [filteredTree]);

  if (filteredTree.length === 0 && filter) {
    return (
      <div className="file-tree" data-testid="file-tree" role="tree">
        <div style={{ padding: 12, fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>
          No files matching "{filter}"
        </div>
      </div>
    );
  }

  return (
    <div className="file-tree" data-testid="file-tree" role="tree" style={{ overflow: 'auto', flex: 1 }}>
      {filteredTree.map(node => (
        <TreeItem
          key={node.path}
          node={node}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onDoubleClick={onDoubleClick}
          depth={0}
          expandedPaths={expandedPaths}
          toggleExpanded={toggleExpanded}
          countCache={countCache}
        />
      ))}
    </div>
  );
}
