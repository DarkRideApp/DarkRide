import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { NodeContextMenu } from './NodeContextMenu';

describe('NodeContextMenu', () => {
  it('renders Duplicate, Disconnect and Delete actions at the given position', () => {
    render(<NodeContextMenu position={{ x: 10, y: 20 }} onDelete={() => {}} onDuplicate={() => {}} onDisconnect={() => {}} onClose={() => {}} />);
    expect(screen.getByRole('menuitem', { name: 'Duplicate' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Disconnect' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
    const root = screen.getByRole('menu');
    expect(root.style.left).toBe('10px');
    expect(root.style.top).toBe('20px');
  });

  it('clicking Duplicate calls onDuplicate then onClose', () => {
    const onDuplicate = vi.fn();
    const onClose = vi.fn();
    render(<NodeContextMenu position={{ x: 0, y: 0 }} onDelete={() => {}} onDuplicate={onDuplicate} onDisconnect={() => {}} onClose={onClose} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    expect(onDuplicate).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('clicking Disconnect calls onDisconnect then onClose', () => {
    const onDisconnect = vi.fn();
    const onClose = vi.fn();
    render(<NodeContextMenu position={{ x: 0, y: 0 }} onDelete={() => {}} onDuplicate={() => {}} onDisconnect={onDisconnect} onClose={onClose} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Disconnect' }));
    expect(onDisconnect).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('clicking Delete calls onDelete then onClose', () => {
    const onDelete = vi.fn();
    const onClose = vi.fn();
    render(<NodeContextMenu position={{ x: 0, y: 0 }} onDelete={onDelete} onDuplicate={() => {}} onDisconnect={() => {}} onClose={onClose} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('pressing Escape calls onClose without any action', () => {
    const onDelete = vi.fn();
    const onClose = vi.fn();
    render(<NodeContextMenu position={{ x: 0, y: 0 }} onDelete={onDelete} onDuplicate={() => {}} onDisconnect={() => {}} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onDelete).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('clicking outside the menu calls onClose', () => {
    const onClose = vi.fn();
    render(
      <div>
        <div data-testid="outside">elsewhere</div>
        <NodeContextMenu position={{ x: 0, y: 0 }} onDelete={() => {}} onDuplicate={() => {}} onDisconnect={() => {}} onClose={onClose} />
      </div>,
    );
    fireEvent.pointerDown(screen.getByTestId('outside'));
    expect(onClose).toHaveBeenCalled();
  });
});
