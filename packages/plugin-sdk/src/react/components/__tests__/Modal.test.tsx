import { useEffect, useState } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ConfirmDialog } from '../ConfirmDialog';

// React's scheduler binds setImmediate when it first loads. Running its tasks 150ms late stands in for a slow CI
// runner, where they land after Testing Library's own setTimeout(0) that follows every findBy query. The delay
// is longer than a query takes, so the late task cannot overtake that timer on a fast machine either.
vi.hoisted(() => {
  globalThis.setImmediate = ((fn: (...args: unknown[]) => void, ...args: unknown[]) => setTimeout(fn, 150, ...args)) as unknown as typeof setImmediate;
});

/** Mounts a dialog from a timer, the way a dialog appears after a server response. */
function DialogAfterResponse() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), 0);
    return () => clearTimeout(timer);
  }, []);
  return shown ? <ConfirmDialog title="Install unverified plugin?" message="Unsigned." onConfirm={() => {}} onCancel={() => {}} /> : null;
}

describe('Modal', () => {
  it('is open, so its buttons can be reached, as soon as its title is in the document', async () => {
    render(<DialogAfterResponse />);

    await screen.findByText('Install unverified plugin?');

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });
});
