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
