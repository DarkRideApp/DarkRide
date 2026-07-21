import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ActionMenu } from '../ActionMenu';

const makeItems = (onDelete = vi.fn(), onDownload = vi.fn()) => [
  { key: 'download', label: 'Download APK', onSelect: onDownload },
  'divider' as const,
  { key: 'delete', label: 'Delete version…', danger: true, onSelect: onDelete },
];

describe('ActionMenu', () => {
  it('opens on trigger click and renders menu items', () => {
    render(<ActionMenu items={makeItems()} label="Version actions" />);
    const trigger = screen.getByRole('button', { name: 'Version actions' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem')).toHaveLength(2);
    expect(screen.getByRole('separator')).toBeInTheDocument();
  });

  it('invokes onSelect and closes', () => {
    const onDelete = vi.fn();
    render(<ActionMenu items={makeItems(onDelete)} label="Version actions" />);
    fireEvent.click(screen.getByRole('button', { name: 'Version actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete version…' }));
    expect(onDelete).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('marks danger items with the danger class', () => {
    render(<ActionMenu items={makeItems()} label="Version actions" />);
    fireEvent.click(screen.getByRole('button', { name: 'Version actions' }));
    expect(screen.getByRole('menuitem', { name: 'Delete version…' })).toHaveClass('action-menu-item-danger');
  });

  it('closes on Escape', () => {
    render(<ActionMenu items={makeItems()} label="Version actions" />);
    fireEvent.click(screen.getByRole('button', { name: 'Version actions' }));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('does not propagate trigger click (safe inside clickable rows)', () => {
    const rowClick = vi.fn();
    render(<div onClick={rowClick}><ActionMenu items={makeItems()} label="Version actions" /></div>);
    fireEvent.click(screen.getByRole('button', { name: 'Version actions' }));
    expect(rowClick).not.toHaveBeenCalled();
  });

  it('does not invoke onSelect for a disabled item', () => {
    const onDisabled = vi.fn();
    const items = [
      { key: 'go', label: 'Go', onSelect: vi.fn() },
      { key: 'nope', label: 'Disabled action', disabled: true, onSelect: onDisabled },
    ];
    render(<ActionMenu items={items} label="Actions" />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    const disabled = screen.getByRole('menuitem', { name: 'Disabled action' });
    expect(disabled).toBeDisabled();
    fireEvent.click(disabled);
    expect(onDisabled).not.toHaveBeenCalled();
  });

  it('closes on click outside', () => {
    render(<ActionMenu items={makeItems()} label="Version actions" />);
    fireEvent.click(screen.getByRole('button', { name: 'Version actions' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('focuses the first enabled item on open and cycles with arrow keys', () => {
    render(<ActionMenu items={makeItems()} label="Version actions" />);
    fireEvent.click(screen.getByRole('button', { name: 'Version actions' }));
    const [download, del] = screen.getAllByRole('menuitem');
    expect(download).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(del).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(download).toHaveFocus(); // wraps
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowUp' });
    expect(del).toHaveFocus(); // wraps backward
  });

  it('returns focus to the trigger on Escape', () => {
    render(<ActionMenu items={makeItems()} label="Version actions" />);
    const trigger = screen.getByRole('button', { name: 'Version actions' });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(trigger).toHaveFocus();
  });

  it('omits aria-expanded when closed', () => {
    render(<ActionMenu items={makeItems()} label="Version actions" />);
    expect(screen.getByRole('button', { name: 'Version actions' })).not.toHaveAttribute('aria-expanded');
  });

  it('renders the open menu in a portal on document.body, not inside the trigger root', () => {
    render(<ActionMenu items={makeItems()} label="Version actions" data-testid="am-root" />);
    fireEvent.click(screen.getByRole('button', { name: 'Version actions' }));
    const menu = screen.getByRole('menu');
    const root = screen.getByTestId('am-root');
    // The list must escape the .action-menu root so ancestor overflow:hidden
    // (tables, cards) cannot clip it.
    expect(root.contains(menu)).toBe(false);
    expect(document.body.contains(menu)).toBe(true);
    expect(menu.style.position).toBe('fixed');
  });

  it('click outside still closes; clicking a menu item selects and closes', () => {
    const onDelete = vi.fn();
    render(<ActionMenu items={makeItems(onDelete)} label="Version actions" />);
    const trigger = screen.getByRole('button', { name: 'Version actions' });

    // Clicking a portalled menu item must count as "inside": it selects and closes.
    fireEvent.click(trigger);
    const item = screen.getByTestId('menu-item-delete');
    fireEvent.mouseDown(item);
    expect(screen.getByRole('menu')).toBeInTheDocument(); // mousedown on the list must not close it
    fireEvent.click(item);
    expect(onDelete).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    // Clicking genuinely outside still closes.
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
