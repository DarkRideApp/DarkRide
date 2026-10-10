import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { RunControls } from './RunControls';

const triggers = [{ id: 'trigger-full', label: 'Full Analysis' }, { id: 'trigger-rescan', label: 'Quick Rescan' }];

describe('RunControls', () => {
  it('defaults to the first trigger and reuse off, Run calls onRun with those', async () => {
    const onRun = vi.fn().mockResolvedValue({ status: 'ok', nodes: [] });
    render(<RunControls triggers={triggers} onRun={onRun} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(onRun).toHaveBeenCalledWith('trigger-full', false));
  });

  it('switching the entry point and checking reuse changes what Run sends', async () => {
    const onRun = vi.fn().mockResolvedValue({ status: 'ok', nodes: [] });
    render(<RunControls triggers={triggers} onRun={onRun} />);
    fireEvent.change(screen.getByRole('combobox', { name: /entry point/i }), { target: { value: 'trigger-rescan' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /reuse unchanged/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(onRun).toHaveBeenCalledWith('trigger-rescan', true));
  });

  it('disables the Run button while a run is in flight and re-enables after it settles', async () => {
    let resolve!: (v: unknown) => void;
    const onRun = vi.fn(() => new Promise(r => { resolve = r; }));
    render(<RunControls triggers={triggers} onRun={onRun as any} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getByRole('button', { name: /running/i })).toBeDisabled();
    resolve({ status: 'ok', nodes: [] });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run' })).not.toBeDisabled());
  });
});
