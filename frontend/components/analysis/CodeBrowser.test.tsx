import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import { CodeBrowser, buildTree } from './CodeBrowser';
import { FileTree } from './FileTree';
import type { TreeNode } from './FileTree';

// jsdom doesn't implement matchMedia — stub it so Monaco init doesn't throw
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock monaco-editor — it cannot run in jsdom
const { mockEditor } = vi.hoisted(() => {
  const mockEditor = {
    getValue: vi.fn().mockReturnValue(''),
    setValue: vi.fn(),
    getModel: vi.fn().mockReturnValue({
      getLanguageId: vi.fn().mockReturnValue('plaintext'),
      getValueInRange: vi.fn().mockReturnValue(''),
      getWordAtPosition: vi.fn().mockReturnValue(null),
    }),
    getSelection: vi.fn().mockReturnValue({ isEmpty: () => true }),
    getPosition: vi.fn().mockReturnValue({ lineNumber: 1, column: 1 }),
    dispose: vi.fn(),
    onDidChangeModelContent: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    addAction: vi.fn(),
  };
  return { mockEditor };
});

vi.mock('monaco-editor', () => ({
  editor: {
    create: vi.fn().mockReturnValue(mockEditor),
    setModelLanguage: vi.fn(),
  },
  KeyMod: { Shift: 1024 },
  KeyCode: { F12: 63 },
  languages: {},
}));

const mockTree = [
  'com/example/app/MainActivity.java',
  'com/example/app/utils/Helper.java',
  'com/example/app/utils/Logger.java',
  'res/layout/activity_main.xml',
  'AndroidManifest.xml',
];

const mockFileContent = 'package com.example.app;\n\npublic class MainActivity {}';

function createMockWs(overrides?: Partial<WebSocketContextValue>): WebSocketContextValue {
  const sendRestApi = vi.fn().mockImplementation((method: string, path: string) => {
    if (path.includes('/tree')) {
      return Promise.resolve({
        type: 'restapi',
        id: '1',
        status: 200,
        body: { success: true, data: { tree: mockTree, sources: ['jadx', 'apktool'] } },
      });
    }
    if (path.includes('/file')) {
      return Promise.resolve({
        type: 'restapi',
        id: '2',
        status: 200,
        body: { success: true, data: mockFileContent },
      });
    }
    return Promise.resolve({ type: 'restapi', id: '3', status: 200, body: { success: true } });
  });

  return {
    connected: true,
    serverReady: true,
    startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi,
    subscribe: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

function renderCodeBrowser(ws?: WebSocketContextValue) {
  const mockWs = ws || createMockWs();
  render(
    <WebSocketContext.Provider value={mockWs}>
      <CodeBrowser versionId="42" />
    </WebSocketContext.Provider>,
  );
  return mockWs;
}

describe('buildTree', () => {
  it('converts flat paths into nested tree structure', () => {
    const tree = buildTree(['a/b/c.java', 'a/b/d.java', 'a/e.xml']);
    expect(tree).toHaveLength(1); // root dir 'a'
    expect(tree[0].name).toBe('a');
    expect(tree[0].type).toBe('dir');
    expect(tree[0].children).toHaveLength(2); // 'b' dir and 'e.xml' file
  });

  it('sorts directories before files', () => {
    const tree = buildTree(['z.txt', 'a/file.java']);
    expect(tree[0].type).toBe('dir');
    expect(tree[0].name).toBe('a');
    expect(tree[1].type).toBe('file');
    expect(tree[1].name).toBe('z.txt');
  });

  it('handles empty array', () => {
    const tree = buildTree([]);
    expect(tree).toHaveLength(0);
  });

  it('handles single file at root', () => {
    const tree = buildTree(['README.md']);
    expect(tree).toHaveLength(1);
    expect(tree[0].type).toBe('file');
    expect(tree[0].name).toBe('README.md');
    expect(tree[0].path).toBe('README.md');
  });
});

describe('FileTree', () => {
  const sampleTree: TreeNode[] = [
    {
      name: 'com',
      path: 'com',
      type: 'dir',
      children: [
        {
          name: 'example',
          path: 'com/example',
          type: 'dir',
          children: [
            { name: 'Main.java', path: 'com/example/Main.java', type: 'file' },
            { name: 'Helper.java', path: 'com/example/Helper.java', type: 'file' },
          ],
        },
      ],
    },
    { name: 'config.xml', path: 'config.xml', type: 'file' },
  ];

  it('renders the file tree container', () => {
    render(<FileTree tree={sampleTree} selectedPath={null} onSelect={vi.fn()} filter="" />);
    expect(screen.getByTestId('file-tree')).toBeInTheDocument();
  });

  it('renders top-level directories and files', () => {
    render(<FileTree tree={sampleTree} selectedPath={null} onSelect={vi.fn()} filter="" />);
    expect(screen.getByTestId('tree-dir-com')).toBeInTheDocument();
    expect(screen.getByTestId('tree-file-config.xml')).toBeInTheDocument();
  });

  it('shows file count for directories', () => {
    render(<FileTree tree={sampleTree} selectedPath={null} onSelect={vi.fn()} filter="" />);
    const comDir = screen.getByTestId('tree-dir-com');
    // 'com' has 2 files nested inside
    expect(comDir).toHaveTextContent('2');
  });

  it('expands directory on click to show children', () => {
    render(<FileTree tree={sampleTree} selectedPath={null} onSelect={vi.fn()} filter="" />);
    // Initially, children not visible
    expect(screen.queryByTestId('tree-dir-example')).not.toBeInTheDocument();
    // Click to expand
    fireEvent.click(screen.getByTestId('tree-dir-com'));
    expect(screen.getByTestId('tree-dir-example')).toBeInTheDocument();
  });

  it('collapses directory on second click', () => {
    render(<FileTree tree={sampleTree} selectedPath={null} onSelect={vi.fn()} filter="" />);
    fireEvent.click(screen.getByTestId('tree-dir-com'));
    expect(screen.getByTestId('tree-dir-example')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('tree-dir-com'));
    expect(screen.queryByTestId('tree-dir-example')).not.toBeInTheDocument();
  });

  it('calls onSelect when a file is clicked', () => {
    const onSelect = vi.fn();
    render(<FileTree tree={sampleTree} selectedPath={null} onSelect={onSelect} filter="" />);
    fireEvent.click(screen.getByTestId('tree-file-config.xml'));
    expect(onSelect).toHaveBeenCalledWith('config.xml');
  });

  it('calls onDoubleClick when a file is double-clicked', () => {
    const onDoubleClick = vi.fn();
    render(<FileTree tree={sampleTree} selectedPath={null} onSelect={vi.fn()} onDoubleClick={onDoubleClick} filter="" />);
    fireEvent.doubleClick(screen.getByTestId('tree-file-config.xml'));
    expect(onDoubleClick).toHaveBeenCalledWith('config.xml');
  });

  it('highlights the selected file', () => {
    render(<FileTree tree={sampleTree} selectedPath="config.xml" onSelect={vi.fn()} filter="" />);
    expect(screen.getByTestId('tree-file-config.xml')).toHaveClass('file-tree-item-selected');
  });

  it('filters tree nodes by search string', () => {
    render(<FileTree tree={sampleTree} selectedPath={null} onSelect={vi.fn()} filter="config" />);
    expect(screen.getByTestId('tree-file-config.xml')).toBeInTheDocument();
    expect(screen.queryByTestId('tree-dir-com')).not.toBeInTheDocument();
  });

  it('shows parent dirs when a nested file matches filter', () => {
    render(<FileTree tree={sampleTree} selectedPath={null} onSelect={vi.fn()} filter="Main" />);
    // Parent dirs should be present because they contain a matching file
    expect(screen.getByTestId('tree-dir-com')).toBeInTheDocument();
  });

  it('shows no-match message when filter matches nothing', () => {
    render(<FileTree tree={sampleTree} selectedPath={null} onSelect={vi.fn()} filter="zzzzz" />);
    expect(screen.getByText(/No files matching/)).toBeInTheDocument();
  });
});

describe('CodeBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the code browser container', async () => {
    renderCodeBrowser();
    expect(screen.getByTestId('code-browser')).toBeInTheDocument();
  });

  it('renders the sidebar', async () => {
    renderCodeBrowser();
    expect(screen.getByTestId('code-browser-sidebar')).toBeInTheDocument();
  });

  it('renders source switcher with dropdown', async () => {
    renderCodeBrowser();
    expect(screen.getByTestId('source-switcher')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('source-select')).toBeInTheDocument();
    });
  });

  it('shows display names in dropdown options', async () => {
    renderCodeBrowser();
    await waitFor(() => {
      const select = screen.getByTestId('source-select');
      const options = within(select).getAllByRole('option');
      expect(options).toHaveLength(2);
      expect(options[0]).toHaveTextContent('Java (jadx)');
      expect(options[1]).toHaveTextContent('Smali (apktool)');
    });
  });

  it('selects jadx as active source by default', async () => {
    renderCodeBrowser();
    await waitFor(() => {
      expect(screen.getByTestId('source-select')).toHaveValue('jadx');
    });
  });

  it('switches active source when dropdown value changes', async () => {
    renderCodeBrowser();
    await waitFor(() => {
      expect(screen.getByTestId('source-select')).toHaveValue('jadx');
    });
    fireEvent.change(screen.getByTestId('source-select'), { target: { value: 'apktool' } });
    expect(screen.getByTestId('source-select')).toHaveValue('apktool');
  });

  it('only shows available sources in dropdown', async () => {
    const ws = createMockWs();
    ws.sendRestApi = vi.fn().mockImplementation((method: string, urlPath: string) => {
      if (urlPath.includes('/tree') && !urlPath.includes('source=')) {
        return Promise.resolve({
          type: 'restapi', id: '1', status: 200,
          body: { success: true, data: { tree: mockTree, sources: ['jadx', 'apktool', 'hermes-dec'] } },
        });
      }
      if (urlPath.includes('/tree')) {
        return Promise.resolve({
          type: 'restapi', id: '1', status: 200,
          body: { success: true, data: { tree: mockTree, sources: ['jadx', 'apktool', 'hermes-dec'] } },
        });
      }
      if (urlPath.includes('/file')) {
        return Promise.resolve({
          type: 'restapi', id: '2', status: 200,
          body: { success: true, data: mockFileContent },
        });
      }
      return Promise.resolve({ type: 'restapi', id: '3', status: 200, body: { success: true } });
    });
    renderCodeBrowser(ws);
    await waitFor(() => {
      const select = screen.getByTestId('source-select');
      const options = within(select).getAllByRole('option');
      expect(options).toHaveLength(3);
      expect(options[2]).toHaveTextContent('React Native (hermes-dec)');
    });
  });

  it('fetches tree data on mount', async () => {
    const ws = renderCodeBrowser();
    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith(
        'GET',
        '/v1/apps/analysis/42/tree?source=jadx',
      );
    });
  });

  it('fetches tree with new source when source is changed', async () => {
    const ws = renderCodeBrowser();
    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith('GET', '/v1/apps/analysis/42/tree?source=jadx');
    });
    fireEvent.change(screen.getByTestId('source-select'), { target: { value: 'apktool' } });
    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith('GET', '/v1/apps/analysis/42/tree?source=apktool');
    });
  });

  it('renders file tree after loading', async () => {
    renderCodeBrowser();
    await waitFor(() => {
      expect(screen.getByTestId('file-tree')).toBeInTheDocument();
    });
  });

  it('shows file tree directory structure', async () => {
    renderCodeBrowser();
    await waitFor(() => {
      // Top-level dirs from mockTree: 'com', 'res', and file 'AndroidManifest.xml'
      expect(screen.getByTestId('tree-dir-com')).toBeInTheDocument();
      expect(screen.getByTestId('tree-dir-res')).toBeInTheDocument();
      expect(screen.getByTestId('tree-file-AndroidManifest.xml')).toBeInTheDocument();
    });
  });

  it('shows empty state when no file is selected', () => {
    renderCodeBrowser();
    expect(screen.getByTestId('code-browser-empty')).toBeInTheDocument();
    expect(screen.getByText('Select a file to view')).toBeInTheDocument();
  });

  it('fetches file content when a file is clicked', async () => {
    const ws = renderCodeBrowser();
    await waitFor(() => screen.getByTestId('tree-file-AndroidManifest.xml'));
    fireEvent.click(screen.getByTestId('tree-file-AndroidManifest.xml'));
    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith(
        'GET',
        '/v1/apps/analysis/42/file?path=AndroidManifest.xml&source=jadx',
      );
    });
  });

  it('opens file as preview tab (italic) on single click', async () => {
    renderCodeBrowser();
    await waitFor(() => screen.getByTestId('tree-file-AndroidManifest.xml'));
    fireEvent.click(screen.getByTestId('tree-file-AndroidManifest.xml'));
    await waitFor(() => {
      const tab = screen.getByTestId('tab-AndroidManifest.xml');
      expect(tab).toBeInTheDocument();
      expect(tab).toHaveClass('code-browser-tab-preview');
      expect(tab).toHaveClass('code-browser-tab-active');
    });
  });

  it('pins tab on double click in file tree', async () => {
    renderCodeBrowser();
    await waitFor(() => screen.getByTestId('tree-file-AndroidManifest.xml'));
    fireEvent.doubleClick(screen.getByTestId('tree-file-AndroidManifest.xml'));
    await waitFor(() => {
      const tab = screen.getByTestId('tab-AndroidManifest.xml');
      expect(tab).toBeInTheDocument();
      expect(tab).not.toHaveClass('code-browser-tab-preview');
    });
  });

  it('pins preview tab on double click on the tab', async () => {
    renderCodeBrowser();
    await waitFor(() => screen.getByTestId('tree-file-AndroidManifest.xml'));
    // Single click to open as preview
    fireEvent.click(screen.getByTestId('tree-file-AndroidManifest.xml'));
    await waitFor(() => {
      expect(screen.getByTestId('tab-AndroidManifest.xml')).toHaveClass('code-browser-tab-preview');
    });
    // Double click the tab to pin
    fireEvent.doubleClick(screen.getByTestId('tab-AndroidManifest.xml'));
    expect(screen.getByTestId('tab-AndroidManifest.xml')).not.toHaveClass('code-browser-tab-preview');
  });

  it('replaces preview tab when clicking another file', async () => {
    renderCodeBrowser();
    await waitFor(() => screen.getByTestId('tree-file-AndroidManifest.xml'));
    // Open first file as preview
    fireEvent.click(screen.getByTestId('tree-file-AndroidManifest.xml'));
    await waitFor(() => {
      expect(screen.getByTestId('tab-AndroidManifest.xml')).toBeInTheDocument();
    });
    // Expand com > example > app to get to nested files
    fireEvent.click(screen.getByTestId('tree-dir-com'));
    await waitFor(() => screen.getByTestId('tree-dir-example'));
    fireEvent.click(screen.getByTestId('tree-dir-example'));
    await waitFor(() => screen.getByTestId('tree-dir-app'));
    fireEvent.click(screen.getByTestId('tree-dir-app'));
    await waitFor(() => screen.getByTestId('tree-file-MainActivity.java'));
    // Click another file - should replace preview
    fireEvent.click(screen.getByTestId('tree-file-MainActivity.java'));
    await waitFor(() => {
      expect(screen.getByTestId('tab-MainActivity.java')).toBeInTheDocument();
      expect(screen.queryByTestId('tab-AndroidManifest.xml')).not.toBeInTheDocument();
    });
  });

  it('keeps pinned tab when clicking another file as preview', async () => {
    renderCodeBrowser();
    await waitFor(() => screen.getByTestId('tree-file-AndroidManifest.xml'));
    // Pin first file
    fireEvent.doubleClick(screen.getByTestId('tree-file-AndroidManifest.xml'));
    await waitFor(() => {
      expect(screen.getByTestId('tab-AndroidManifest.xml')).not.toHaveClass('code-browser-tab-preview');
    });
    // Navigate to nested file (com > example > app)
    fireEvent.click(screen.getByTestId('tree-dir-com'));
    await waitFor(() => screen.getByTestId('tree-dir-example'));
    fireEvent.click(screen.getByTestId('tree-dir-example'));
    await waitFor(() => screen.getByTestId('tree-dir-app'));
    fireEvent.click(screen.getByTestId('tree-dir-app'));
    await waitFor(() => screen.getByTestId('tree-file-MainActivity.java'));
    // Click another file as preview
    fireEvent.click(screen.getByTestId('tree-file-MainActivity.java'));
    await waitFor(() => {
      // Both should be present
      expect(screen.getByTestId('tab-AndroidManifest.xml')).toBeInTheDocument();
      expect(screen.getByTestId('tab-MainActivity.java')).toBeInTheDocument();
    });
  });

  it('closes tab when close button is clicked', async () => {
    renderCodeBrowser();
    await waitFor(() => screen.getByTestId('tree-file-AndroidManifest.xml'));
    fireEvent.click(screen.getByTestId('tree-file-AndroidManifest.xml'));
    await waitFor(() => {
      expect(screen.getByTestId('tab-AndroidManifest.xml')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('tab-close-AndroidManifest.xml'));
    expect(screen.queryByTestId('tab-AndroidManifest.xml')).not.toBeInTheDocument();
  });

  it('shows empty state after closing last tab', async () => {
    renderCodeBrowser();
    await waitFor(() => screen.getByTestId('tree-file-AndroidManifest.xml'));
    fireEvent.click(screen.getByTestId('tree-file-AndroidManifest.xml'));
    await waitFor(() => {
      expect(screen.getByTestId('tab-AndroidManifest.xml')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('tab-close-AndroidManifest.xml'));
    await waitFor(() => {
      expect(screen.getByTestId('code-browser-empty')).toBeInTheDocument();
    });
  });

  it('renders filter input', () => {
    renderCodeBrowser();
    expect(screen.getByTestId('file-filter-input')).toBeInTheDocument();
  });

  it('filters file tree when typing in filter input', async () => {
    renderCodeBrowser();
    await waitFor(() => screen.getByTestId('tree-file-AndroidManifest.xml'));
    fireEvent.change(screen.getByTestId('file-filter-input'), { target: { value: 'Manifest' } });
    // After filtering, the AndroidManifest.xml should still be visible
    expect(screen.getByTestId('tree-file-AndroidManifest.xml')).toBeInTheDocument();
    // Directories that don't match and have no matching children should be gone
    expect(screen.queryByTestId('tree-dir-res')).not.toBeInTheDocument();
  });

  it('renders editor container', () => {
    renderCodeBrowser();
    expect(screen.getByTestId('code-browser-editor')).toBeInTheDocument();
  });

  it('handles API error gracefully for tree', async () => {
    const ws = createMockWs();
    ws.sendRestApi = vi.fn().mockRejectedValue(new Error('Network error'));
    renderCodeBrowser(ws);
    // Should not crash, should show empty file tree
    await waitFor(() => {
      expect(screen.getByTestId('file-tree')).toBeInTheDocument();
    });
  });

  it('clears tabs when switching source', async () => {
    renderCodeBrowser();
    await waitFor(() => screen.getByTestId('tree-file-AndroidManifest.xml'));
    // Open a tab
    fireEvent.click(screen.getByTestId('tree-file-AndroidManifest.xml'));
    await waitFor(() => {
      expect(screen.getByTestId('tab-AndroidManifest.xml')).toBeInTheDocument();
    });
    // Switch source
    fireEvent.change(screen.getByTestId('source-select'), { target: { value: 'apktool' } });
    // Tabs should be cleared
    expect(screen.queryByTestId('tab-AndroidManifest.xml')).not.toBeInTheDocument();
    expect(screen.getByTestId('code-browser-empty')).toBeInTheDocument();
  });

  it('renders search toggle button', async () => {
    renderCodeBrowser();
    expect(screen.getByTestId('search-toggle-btn')).toBeInTheDocument();
  });

  it('opens search panel when search button is clicked', async () => {
    renderCodeBrowser();
    expect(screen.queryByTestId('search-panel')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('search-toggle-btn'));
    expect(screen.getByTestId('search-panel')).toBeInTheDocument();
  });

  it('closes search panel when search button is clicked again', async () => {
    renderCodeBrowser();
    fireEvent.click(screen.getByTestId('search-toggle-btn'));
    expect(screen.getByTestId('search-panel')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('search-toggle-btn'));
    expect(screen.queryByTestId('search-panel')).not.toBeInTheDocument();
  });

  it('renders download button with correct href', async () => {
    renderCodeBrowser();
    await waitFor(() => {
      expect(screen.getByTestId('source-select')).toHaveValue('jadx');
    });
    const downloadBtn = screen.getByTestId('download-btn');
    expect(downloadBtn).toBeInTheDocument();
    expect(downloadBtn).toHaveAttribute('href', '/v1/apps/analysis/42/download?source=jadx');
    expect(downloadBtn).toHaveAttribute('target', '_blank');
  });

  it('registers 3 context menu actions on Monaco editor', async () => {
    renderCodeBrowser();
    // Wait for Monaco async init to complete
    await waitFor(() => {
      expect(mockEditor.addAction).toHaveBeenCalledTimes(3);
    });
    const ids = mockEditor.addAction.mock.calls.map((c: any) => c[0].id);
    expect(ids).toContain('find-all-references');
    expect(ids).toContain('go-to-definition');
    expect(ids).toContain('search-in-files');
  });

  it('Find All References action opens search panel with selected text', async () => {
    renderCodeBrowser();
    await waitFor(() => {
      expect(mockEditor.addAction).toHaveBeenCalledTimes(3);
    });

    // Simulate having selected text
    mockEditor.getSelection.mockReturnValue({ isEmpty: () => false });
    mockEditor.getModel().getValueInRange.mockReturnValue('MyClass');

    const action = mockEditor.addAction.mock.calls.find((c: any) => c[0].id === 'find-all-references')[0];
    action.run(mockEditor);

    // Search panel should be open
    await waitFor(() => {
      expect(screen.getByTestId('search-panel')).toBeInTheDocument();
    });
  });

  it('Go to Definition action opens search panel with regex', async () => {
    renderCodeBrowser();
    await waitFor(() => {
      expect(mockEditor.addAction).toHaveBeenCalledTimes(3);
    });

    mockEditor.getSelection.mockReturnValue({ isEmpty: () => true });
    mockEditor.getPosition.mockReturnValue({ lineNumber: 1, column: 5 });
    mockEditor.getModel().getWordAtPosition.mockReturnValue({ word: 'Foo' });

    const action = mockEditor.addAction.mock.calls.find((c: any) => c[0].id === 'go-to-definition')[0];
    action.run(mockEditor);

    await waitFor(() => {
      expect(screen.getByTestId('search-panel')).toBeInTheDocument();
      expect(screen.getByTestId('search-toggle-regex')).toHaveClass('search-panel-toggle-active');
    });
  });

  it('Search in Files action opens search panel without auto-executing', async () => {
    renderCodeBrowser();
    await waitFor(() => {
      expect(mockEditor.addAction).toHaveBeenCalledTimes(3);
    });

    mockEditor.getSelection.mockReturnValue({ isEmpty: () => false });
    mockEditor.getModel().getValueInRange.mockReturnValue('searchTerm');

    const action = mockEditor.addAction.mock.calls.find((c: any) => c[0].id === 'search-in-files')[0];
    action.run(mockEditor);

    await waitFor(() => {
      expect(screen.getByTestId('search-panel')).toBeInTheDocument();
      expect(screen.getByTestId('search-input')).toHaveValue('searchTerm');
    });
  });
});
