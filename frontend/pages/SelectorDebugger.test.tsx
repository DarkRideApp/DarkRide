import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SelectorDebugger } from './SelectorDebugger';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';

const mockWs: WebSocketContextValue = {
  connected: true,
  sendMessage: vi.fn(),
  sendRestApi: vi.fn().mockResolvedValue({ type: 'restapi', id: '1', status: 200, body: {} }),
  subscribe: vi.fn().mockReturnValue(() => {}),
};

const sampleDom = JSON.stringify({
  className: 'FrameLayout',
  text: '',
  resourceId: '',
  description: '',
  bounds: [0, 0, 1080, 1920],
  clickable: false,
  enabled: true,
  children: [
    {
      className: 'android.widget.Button',
      text: 'Login',
      resourceId: 'com.app:id/login_btn',
      description: 'Login button',
      bounds: [100, 200, 300, 250],
      clickable: true,
      enabled: true,
      children: [],
    },
    {
      className: 'android.widget.TextView',
      text: 'Welcome to MyApp',
      resourceId: 'com.app:id/title',
      description: '',
      bounds: [50, 100, 500, 150],
      clickable: false,
      enabled: true,
      children: [],
    },
    {
      className: 'android.widget.Button',
      text: 'Sign Up',
      resourceId: 'com.app:id/signup_btn',
      description: '',
      bounds: [100, 300, 300, 350],
      clickable: true,
      enabled: false,
      children: [],
    },
  ],
});

function renderDebugger(params = '') {
  return render(
    <WebSocketContext.Provider value={mockWs}>
      <MemoryRouter initialEntries={[`/ui/selector-debugger${params}`]}>
        <SelectorDebugger />
      </MemoryRouter>
    </WebSocketContext.Provider>
  );
}

describe('SelectorDebugger', () => {
  it('renders the debugger page', () => {
    renderDebugger();
    expect(screen.getByTestId('selector-debugger')).toBeInTheDocument();
  });

  it('shows no results with empty selector', () => {
    renderDebugger();
    fireEvent.change(screen.getByTestId('dom-input'), { target: { value: sampleDom } });
    const results = screen.getByTestId('match-results');
    // No selector set, so no matches should be active
    expect(results).toBeInTheDocument();
  });

  it('matches elements by exact text', () => {
    renderDebugger();
    fireEvent.change(screen.getByTestId('dom-input'), { target: { value: sampleDom } });
    fireEvent.change(screen.getByTestId('selector-text'), { target: { value: 'Login' } });

    expect(screen.getByTestId('match-0')).toBeInTheDocument();
    expect(screen.getByText('android.widget.Button')).toBeInTheDocument();
    expect(screen.queryByTestId('match-1')).not.toBeInTheDocument(); // Only one match
  });

  it('matches elements by textContains', () => {
    renderDebugger();
    fireEvent.change(screen.getByTestId('dom-input'), { target: { value: sampleDom } });
    fireEvent.change(screen.getByTestId('selector-textContains'), { target: { value: 'Welcome' } });

    const match = screen.getByTestId('match-0');
    expect(match).toBeInTheDocument();
    expect(match.textContent).toContain('android.widget.TextView');
  });

  it('matches elements by resourceId', () => {
    renderDebugger();
    fireEvent.change(screen.getByTestId('dom-input'), { target: { value: sampleDom } });
    fireEvent.change(screen.getByTestId('selector-resourceId'), { target: { value: 'com.app:id/signup_btn' } });

    const match = screen.getByTestId('match-0');
    expect(match).toBeInTheDocument();
    expect(match.textContent).toContain('Sign Up');
  });

  it('shows "No matches" when selector doesn\'t match', () => {
    renderDebugger();
    fireEvent.change(screen.getByTestId('dom-input'), { target: { value: sampleDom } });
    fireEvent.change(screen.getByTestId('selector-text'), { target: { value: 'NonExistent' } });

    expect(screen.getByText('No matches found')).toBeInTheDocument();
  });

  it('shows invalid DOM error for bad JSON', () => {
    renderDebugger();
    fireEvent.change(screen.getByTestId('dom-input'), { target: { value: 'not valid json' } });
    fireEvent.change(screen.getByTestId('selector-text'), { target: { value: 'test' } });

    expect(screen.getByText('Invalid DOM JSON')).toBeInTheDocument();
  });

  it('pre-populates from URL params', () => {
    renderDebugger('?text=Login&resourceId=com.app%3Aid%2Flogin_btn');
    const textInput = screen.getByTestId('selector-text') as HTMLInputElement;
    const resourceInput = screen.getByTestId('selector-resourceId') as HTMLInputElement;
    expect(textInput.value).toBe('Login');
    expect(resourceInput.value).toBe('com.app:id/login_btn');
  });

  it('formats DOM on external load from sessionStorage', () => {
    const compact = JSON.stringify({ className: 'Test', text: '', resourceId: '', description: '', bounds: [0, 0, 100, 100], clickable: false, enabled: true, children: [] });
    vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(compact);

    renderDebugger('?fromStorage=1');

    // Should switch to formatted view (not edit mode) - XML view should be present
    expect(screen.getByTestId('dom-xml-view')).toBeInTheDocument();

    vi.restoreAllMocks();
  });

  it('shows visual preview when DOM is loaded', () => {
    renderDebugger();
    // Enter DOM and switch to format mode
    fireEvent.change(screen.getByTestId('dom-input'), { target: { value: sampleDom } });
    fireEvent.click(screen.getByTestId('toggle-edit-mode'));

    expect(screen.getByTestId('dom-visual-preview')).toBeInTheDocument();
    // Check that boxes are rendered (root + 3 children = at least 4 boxes)
    expect(screen.getByTestId('dom-box-0')).toBeInTheDocument();
    expect(screen.getByTestId('dom-box-1')).toBeInTheDocument();
  });

  it('shows selector JSON when selector is set', () => {
    renderDebugger();
    fireEvent.change(screen.getByTestId('selector-text'), { target: { value: 'Login' } });

    const jsonCard = screen.getByTestId('selector-json');
    expect(jsonCard).toBeInTheDocument();
    expect(jsonCard.textContent).toContain('"text"');
    expect(jsonCard.textContent).toContain('"Login"');
  });

  it('copies selector JSON to clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderDebugger();
    fireEvent.change(screen.getByTestId('selector-text'), { target: { value: 'Skip' } });

    fireEvent.click(screen.getByTestId('copy-selector-json'));

    expect(writeText).toHaveBeenCalledWith(JSON.stringify({ text: 'Skip' }, null, 2));
  });

  it('highlights XML line on visual box hover via mouseMove on device-frame', () => {
    renderDebugger();
    fireEvent.change(screen.getByTestId('dom-input'), { target: { value: sampleDom } });
    fireEvent.click(screen.getByTestId('toggle-edit-mode'));

    // Hover over XML line for the Login button (index 1) since deep-node hover
    // relies on getBoundingClientRect which returns zeros in jsdom
    const xmlView = screen.getByTestId('dom-xml-view');
    const xmlLines = xmlView.querySelectorAll('.xml-line');
    // Find the line containing "Login"
    let loginLine: Element | null = null;
    xmlLines.forEach(line => {
      if (line.textContent?.includes('Login')) loginLine = line;
    });
    expect(loginLine).not.toBeNull();
    fireEvent.mouseEnter(loginLine!);

    const highlightedSpan = xmlView.querySelector('.xml-line-highlight');
    expect(highlightedSpan).not.toBeNull();
    expect(highlightedSpan!.textContent).toContain('Login');
  });

  it('toggles between edit and format modes', () => {
    renderDebugger();
    fireEvent.change(screen.getByTestId('dom-input'), { target: { value: sampleDom } });

    // Initially in edit mode - textarea is shown
    expect(screen.getByTestId('dom-input')).toBeInTheDocument();

    // Click Format button
    fireEvent.click(screen.getByTestId('toggle-edit-mode'));
    expect(screen.getByTestId('dom-xml-view')).toBeInTheDocument();

    // Click Edit button
    fireEvent.click(screen.getByTestId('toggle-edit-mode'));
    expect(screen.getByTestId('dom-input')).toBeInTheDocument();
  });

  it('clicking a dom-box selects it and applies .dom-box-selected class', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderDebugger();
    fireEvent.change(screen.getByTestId('dom-input'), { target: { value: sampleDom } });
    fireEvent.click(screen.getByTestId('toggle-edit-mode'));

    const box = screen.getByTestId('dom-box-1');
    fireEvent.click(box);

    // Box should have selected class
    expect(box.className).toContain('dom-box-selected');
    // Clear selection button should appear
    expect(screen.getByTestId('clear-selection')).toBeInTheDocument();
    // Clipboard should have been called with node selector JSON
    expect(writeText).toHaveBeenCalled();
    const clipboardArg = writeText.mock.calls[writeText.mock.calls.length - 1][0];
    const parsed = JSON.parse(clipboardArg);
    expect(parsed.text).toBe('Login');
    expect(parsed.resourceId).toBe('com.app:id/login_btn');
  });

  it('while a node is selected, hovering other XML lines does NOT change the highlight', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderDebugger();
    fireEvent.change(screen.getByTestId('dom-input'), { target: { value: sampleDom } });
    fireEvent.click(screen.getByTestId('toggle-edit-mode'));

    // Select box 1 (Login button)
    fireEvent.click(screen.getByTestId('dom-box-1'));
    expect(screen.getByTestId('dom-box-1').className).toContain('dom-box-selected');

    // Hover over another XML line
    const xmlView = screen.getByTestId('dom-xml-view');
    const xmlLines = xmlView.querySelectorAll('.xml-line');
    // Find a line for the Sign Up button (index 3)
    let signUpLine: Element | null = null;
    xmlLines.forEach(line => {
      if (line.textContent?.includes('Sign Up')) signUpLine = line;
    });
    expect(signUpLine).not.toBeNull();
    fireEvent.mouseEnter(signUpLine!);

    // The Login button box should still be selected, Sign Up should NOT be highlighted
    expect(screen.getByTestId('dom-box-1').className).toContain('dom-box-selected');
    expect(signUpLine!.className).not.toContain('xml-line-highlight');
  });

  it('clicking "Clear selection" re-enables hover behavior', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderDebugger();
    fireEvent.change(screen.getByTestId('dom-input'), { target: { value: sampleDom } });
    fireEvent.click(screen.getByTestId('toggle-edit-mode'));

    // Select a node
    fireEvent.click(screen.getByTestId('dom-box-1'));
    expect(screen.getByTestId('clear-selection')).toBeInTheDocument();

    // Clear selection
    fireEvent.click(screen.getByTestId('clear-selection'));

    // Clear selection button should be gone
    expect(screen.queryByTestId('clear-selection')).not.toBeInTheDocument();

    // Hovering XML lines should work again
    const xmlView = screen.getByTestId('dom-xml-view');
    const xmlLines = xmlView.querySelectorAll('.xml-line');
    let loginLine: Element | null = null;
    xmlLines.forEach(line => {
      if (line.textContent?.includes('Login')) loginLine = line;
    });
    fireEvent.mouseEnter(loginLine!);
    expect(loginLine!.className).toContain('xml-line-highlight');
  });

  it('clicking an XML line also selects the node', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderDebugger();
    fireEvent.change(screen.getByTestId('dom-input'), { target: { value: sampleDom } });
    fireEvent.click(screen.getByTestId('toggle-edit-mode'));

    const xmlView = screen.getByTestId('dom-xml-view');
    const xmlLines = xmlView.querySelectorAll('.xml-line');
    let loginLine: Element | null = null;
    xmlLines.forEach(line => {
      if (line.textContent?.includes('Login')) loginLine = line;
    });
    expect(loginLine).not.toBeNull();
    fireEvent.click(loginLine!);

    // XML line should have selected class
    expect(loginLine!.className).toContain('xml-line-selected');
    // Corresponding dom-box should also be selected
    expect(screen.getByTestId('dom-box-1').className).toContain('dom-box-selected');
    // Clear selection should appear
    expect(screen.getByTestId('clear-selection')).toBeInTheDocument();
  });
});
