import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { NodeKindPalette } from './NodeKindPalette';

describe('NodeKindPalette', () => {
  it('renders open at the given position, search box focused', () => {
    render(<NodeKindPalette position={{ x: 10, y: 20 }} onPick={() => {}} onClose={() => {}} />);
    expect(screen.getByLabelText('Search node kinds')).toBeInTheDocument();
    expect(screen.getByLabelText('Search node kinds')).toHaveFocus();
  });

  it('lists every node kind by its display name and a one-line description', () => {
    render(<NodeKindPalette position={{ x: 0, y: 0 }} onPick={() => {}} onClose={() => {}} />);
    expect(screen.getByRole('option', { name: /Agent Call.*Calls an AI agent with a prompt/s })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^Output/ })).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(7);
  });

  it('filters by name as you type', () => {
    render(<NodeKindPalette position={{ x: 0, y: 0 }} onPick={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Search node kinds'), { target: { value: 'branch' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: /^Branch/ })).toBeInTheDocument();
  });

  it('filters by description text too, not just the name', () => {
    render(<NodeKindPalette position={{ x: 0, y: 0 }} onPick={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Search node kinds'), { target: { value: 'ai agent' } });
    expect(screen.getByRole('option', { name: /^Agent Call/ })).toBeInTheDocument();
  });

  it('shows an empty state when nothing matches', () => {
    render(<NodeKindPalette position={{ x: 0, y: 0 }} onPick={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Search node kinds'), { target: { value: 'zzz' } });
    expect(screen.getByText(/no matching node kinds/i)).toBeInTheDocument();
  });

  it('clicking a kind calls onPick with it', () => {
    const onPick = vi.fn();
    render(<NodeKindPalette position={{ x: 0, y: 0 }} onPick={onPick} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('option', { name: /^Branch/ }));
    expect(onPick).toHaveBeenCalledWith('Branch');
  });

  it('pressing Enter picks the first filtered result', () => {
    const onPick = vi.fn();
    render(<NodeKindPalette position={{ x: 0, y: 0 }} onPick={onPick} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Search node kinds'), { target: { value: 'report' } });
    fireEvent.keyDown(screen.getByLabelText('Search node kinds'), { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('Report');
  });

  it('pressing Escape calls onClose without picking anything', () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<NodeKindPalette position={{ x: 0, y: 0 }} onPick={onPick} onClose={onClose} />);
    fireEvent.keyDown(screen.getByLabelText('Search node kinds'), { key: 'Escape' });
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('clicking outside the palette calls onClose', () => {
    const onClose = vi.fn();
    render(
      <div>
        <div data-testid="outside">elsewhere</div>
        <NodeKindPalette position={{ x: 0, y: 0 }} onPick={() => {}} onClose={onClose} />
      </div>,
    );
    fireEvent.pointerDown(screen.getByTestId('outside'));
    expect(onClose).toHaveBeenCalled();
  });

  it('positions itself at the given fixed coordinates', () => {
    render(<NodeKindPalette position={{ x: 123, y: 456 }} onPick={() => {}} onClose={() => {}} />);
    const root = screen.getByLabelText('Search node kinds').closest('.ai-jobs-node-picker-popover') as HTMLElement;
    expect(root.style.left).toBe('123px');
    expect(root.style.top).toBe('456px');
  });
});
