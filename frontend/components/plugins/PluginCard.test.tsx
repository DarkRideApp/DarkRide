import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { PluginCard } from './PluginCard';

const baseProps = {
  name: 'test-plugin',
  version: '1.0.0',
  description: 'description',
  author: null,
  enabled: true,
  installedVia: 'npm',
  loaded: true,
  onEnable: vi.fn(),
  onDisable: vi.fn(),
  onUninstall: vi.fn(),
};

describe('PluginCard uninstall button visibility', () => {
  it('shows trash button for installedVia=npm', () => {
    render(<PluginCard {...baseProps} installedVia="npm" />);
    expect(screen.getByTitle(/Uninstall plugin/i)).toBeInTheDocument();
  });

  it('shows trash button for installedVia=managed', () => {
    render(<PluginCard {...baseProps} installedVia="managed" />);
    expect(screen.getByTitle(/Uninstall plugin/i)).toBeInTheDocument();
  });

  it('shows "Remove leftover state" button for installedVia=missing', () => {
    render(<PluginCard {...baseProps} installedVia="missing" />);
    expect(screen.getByText(/Remove leftover state/i)).toBeInTheDocument();
  });

  it('hides uninstall for installedVia=workspace', () => {
    render(<PluginCard {...baseProps} installedVia="workspace" />);
    expect(screen.queryByTitle(/Uninstall plugin/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Remove leftover state/i)).not.toBeInTheDocument();
  });
});

describe('PluginCard managed-disabled badge', () => {
  it('shows "Disabled — enable to activate" badge for managed plugin with enabled=false', () => {
    render(<PluginCard {...baseProps} installedVia="managed" enabled={false} />);
    expect(screen.getByText(/Disabled — enable to activate/i)).toBeInTheDocument();
  });

  it('does NOT show the badge for enabled managed plugin', () => {
    render(<PluginCard {...baseProps} installedVia="managed" enabled={true} />);
    expect(screen.queryByText(/Disabled — enable to activate/i)).not.toBeInTheDocument();
  });

  it('does NOT show the badge for disabled npm plugin', () => {
    render(<PluginCard {...baseProps} installedVia="npm" enabled={false} />);
    expect(screen.queryByText(/Disabled — enable to activate/i)).not.toBeInTheDocument();
  });
});

describe('PluginCard lastError banner', () => {
  // A plugin auto-disabled by the host (e.g. failed migration) needs to
  // surface WHY — otherwise it looks identical to "user disabled this".
  const fixture = "kitchen-sink:0001_broken.sql: near 'BANANA': syntax error";

  it('renders the auto-disabled banner with the host error message', () => {
    render(<PluginCard {...baseProps} enabled={false} lastError={fixture} />);
    expect(screen.getByText(/Auto-disabled by host/i)).toBeInTheDocument();
    expect(screen.getByText(/syntax error/i)).toBeInTheDocument();
  });

  it('does NOT render the banner when lastError is null/undefined', () => {
    render(<PluginCard {...baseProps} enabled={false} />);
    expect(screen.queryByText(/Auto-disabled by host/i)).not.toBeInTheDocument();
  });

  it('renders the banner even on an enabled plugin (lastError sticks until next successful boot)', () => {
    // A plugin can be re-enabled by the user but still have a stale
    // lastError until the next clean boot clears it. Surface it so the
    // user knows why it was disabled and that a restart is needed.
    render(<PluginCard {...baseProps} enabled={true} lastError={fixture} />);
    expect(screen.getByText(/Auto-disabled by host/i)).toBeInTheDocument();
  });
});

const updateBaseProps = {
  name: 'maps',
  version: '1.0.0',
  description: null,
  author: null,
  enabled: true,
  installedVia: 'managed',
  loaded: true,
  onEnable: vi.fn(),
  onDisable: vi.fn(),
  onUninstall: vi.fn(),
};

describe('PluginCard — update affordances', () => {
  it('renders the version-update chip when updateAvailable + latestVersion provided', () => {
    render(<PluginCard {...updateBaseProps} updateAvailable={true} latestVersion="1.0.1" onUpdate={vi.fn()} />);
    const chip = screen.getByText(/v1\.0\.0\s*→\s*v1\.0\.1/);
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveClass('version-update-chip');
  });

  it('omits the chip when updateAvailable is false', () => {
    render(<PluginCard {...updateBaseProps} updateAvailable={false} latestVersion={undefined} />);
    expect(screen.queryByText(/→/)).not.toBeInTheDocument();
  });

  it('Update button label includes the new version', () => {
    render(<PluginCard {...updateBaseProps} updateAvailable={true} latestVersion="1.0.1" onUpdate={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Update to v1\.0\.1/ })).toBeInTheDocument();
  });

  it('shows a spinner and disables the Update button when updating prop is true', () => {
    render(<PluginCard {...updateBaseProps} updateAvailable={true} latestVersion="1.0.1" updating={true} onUpdate={vi.fn()} />);
    const btn = screen.getByRole('button', { name: /Updating/ });
    expect(btn).toBeDisabled();
  });
});
