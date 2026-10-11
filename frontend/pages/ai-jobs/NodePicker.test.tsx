import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { NodePicker } from './NodePicker';

describe('NodePicker', () => {
  it('is closed until the Add node button is clicked', () => {
    render(<NodePicker onPick={() => {}} />);
    expect(screen.queryByLabelText('Search node kinds')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '+ Add node' }));
    expect(screen.getByLabelText('Search node kinds')).toBeInTheDocument();
  });

  it('lists every node kind by its display name and a one-line description', () => {
    render(<NodePicker onPick={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '+ Add node' }));
    expect(screen.getByRole('option', { name: /Agent Call.*Calls an AI agent with a prompt/s })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^Output/ })).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(7);
  });

  it('filters by name as you type', () => {
    render(<NodePicker onPick={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '+ Add node' }));
    fireEvent.change(screen.getByLabelText('Search node kinds'), { target: { value: 'branch' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: /^Branch/ })).toBeInTheDocument();
  });

  it('filters by description text too, not just the name', () => {
    render(<NodePicker onPick={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '+ Add node' }));
    fireEvent.change(screen.getByLabelText('Search node kinds'), { target: { value: 'ai agent' } });
    expect(screen.getByRole('option', { name: /^Agent Call/ })).toBeInTheDocument();
  });

  it('shows an empty state when nothing matches', () => {
    render(<NodePicker onPick={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '+ Add node' }));
    fireEvent.change(screen.getByLabelText('Search node kinds'), { target: { value: 'zzz' } });
    expect(screen.getByText(/no matching node kinds/i)).toBeInTheDocument();
  });

  it('clicking a kind calls onPick with it and closes the popover', () => {
    const onPick = vi.fn();
    render(<NodePicker onPick={onPick} />);
    fireEvent.click(screen.getByRole('button', { name: '+ Add node' }));
    fireEvent.click(screen.getByRole('option', { name: /^Branch/ }));
    expect(onPick).toHaveBeenCalledWith('Branch');
    expect(screen.queryByLabelText('Search node kinds')).not.toBeInTheDocument();
  });

  it('pressing Enter picks the first filtered result', () => {
    const onPick = vi.fn();
    render(<NodePicker onPick={onPick} />);
    fireEvent.click(screen.getByRole('button', { name: '+ Add node' }));
    fireEvent.change(screen.getByLabelText('Search node kinds'), { target: { value: 'report' } });
    fireEvent.keyDown(screen.getByLabelText('Search node kinds'), { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('Report');
  });

  it('pressing Escape closes without picking anything', () => {
    const onPick = vi.fn();
    render(<NodePicker onPick={onPick} />);
    fireEvent.click(screen.getByRole('button', { name: '+ Add node' }));
    fireEvent.keyDown(screen.getByLabelText('Search node kinds'), { key: 'Escape' });
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Search node kinds')).not.toBeInTheDocument();
  });

  it('clicking outside the picker closes it', () => {
    render(
      <div>
        <div data-testid="outside">elsewhere</div>
        <NodePicker onPick={() => {}} />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: '+ Add node' }));
    expect(screen.getByLabelText('Search node kinds')).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByTestId('outside'));
    expect(screen.queryByLabelText('Search node kinds')).not.toBeInTheDocument();
  });
});
