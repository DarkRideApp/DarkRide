import React, { useEffect, useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PluginDrawer } from './PluginDrawer';
import { buildEntries } from './catalog';
import { registryPlugin, installedPlugin } from './testing';

// React's scheduler binds setImmediate when it first loads. Running its tasks 150ms late stands in for a slow CI
// runner, where they land after Testing Library's own setTimeout(0) that follows every findBy query. The delay
// is longer than a role query takes, so the late task cannot overtake that timer on a fast machine either.
vi.hoisted(() => {
  globalThis.setImmediate = ((fn: (...args: unknown[]) => void, ...args: unknown[]) => setTimeout(fn, 150, ...args)) as unknown as typeof setImmediate;
});

const entry = buildEntries([registryPlugin({ name: 'maps' })], [installedPlugin({ name: 'maps' })])[0];

/** Mounts the drawer from a timer, the way it appears once the plugin lists have loaded. */
function DrawerAfterLoad({ onClose }: { onClose: () => void }) {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLoaded(true), 0);
    return () => clearTimeout(timer);
  }, []);
  if (!loaded) return null;
  return (
    <MemoryRouter>
      <PluginDrawer
        entry={entry}
        requestedName="maps"
        entries={[entry]}
        busy={null}
        installBlocked={false}
        hasSettingsPage={false}
        onClose={onClose}
        onInstall={vi.fn()}
        onUpdate={vi.fn()}
        onToggleEnabled={vi.fn()}
        onReviewPermissions={vi.fn()}
        onUninstall={vi.fn()}
      />
    </MemoryRouter>
  );
}

describe('PluginDrawer on a slow runner', () => {
  it('closes on Escape pressed as soon as the drawer can be found', async () => {
    const onClose = vi.fn();
    render(<DrawerAfterLoad onClose={onClose} />);

    await screen.findByRole('dialog', { name: /details/ });
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
