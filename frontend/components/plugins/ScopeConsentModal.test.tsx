import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ScopeConsentModal } from './ScopeConsentModal';

// jsdom doesn't implement HTMLDialogElement.showModal — stub it
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

describe('ScopeConsentModal', () => {
  const scopes = [
    { key: 'core.apk:read', label: 'Read APKs', description: 'Browse APK inventory.' },
    { key: 'mcp', label: 'Use MCP tools', description: 'Call DarkRide MCP tools.' },
  ];

  it('shows scope labels and descriptions', () => {
    render(
      <ScopeConsentModal
        pluginName="demo"
        scopes={scopes}
        onApprove={vi.fn()}
        onDisable={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('Read APKs')).toBeTruthy();
    expect(screen.getByText('Browse APK inventory.')).toBeTruthy();
    expect(screen.getByText('Use MCP tools')).toBeTruthy();
  });

  it('includes plugin name in modal title', () => {
    render(
      <ScopeConsentModal
        pluginName="demo"
        scopes={scopes}
        onApprove={vi.fn()}
        onDisable={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/demo/)).toBeTruthy();
  });

  it('includes plugin version in title when provided', () => {
    render(
      <ScopeConsentModal
        pluginName="demo"
        pluginVersion="1.2.3"
        scopes={scopes}
        onApprove={vi.fn()}
        onDisable={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/demo v1\.2\.3/)).toBeTruthy();
  });

  it('calls onApprove with all scopes when "Allow and enable"', () => {
    const onApprove = vi.fn();
    render(
      <ScopeConsentModal
        pluginName="demo"
        scopes={scopes}
        onApprove={onApprove}
        onDisable={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /allow and enable/i }));
    expect(onApprove).toHaveBeenCalledWith(['core.apk:read', 'mcp']);
  });

  it('calls onDisable for "Install but leave disabled"', () => {
    const onDisable = vi.fn();
    render(
      <ScopeConsentModal
        pluginName="demo"
        scopes={scopes}
        onApprove={vi.fn()}
        onDisable={onDisable}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /install but leave disabled/i }));
    expect(onDisable).toHaveBeenCalled();
  });

  it('calls onCancel for Cancel', () => {
    const onCancel = vi.fn();
    render(
      <ScopeConsentModal
        pluginName="demo"
        scopes={scopes}
        onApprove={vi.fn()}
        onDisable={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('disables all buttons when busy prop is true', () => {
    render(
      <ScopeConsentModal
        pluginName="demo"
        scopes={scopes}
        onApprove={vi.fn()}
        onDisable={vi.fn()}
        onCancel={vi.fn()}
        busy
      />,
    );
    expect(screen.getByRole('button', { name: /allow and enable/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /install but leave disabled/i })).toBeDisabled();
  });

  it('shows empty state message when scopes array is empty', () => {
    render(
      <ScopeConsentModal
        pluginName="demo"
        scopes={[]}
        onApprove={vi.fn()}
        onDisable={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/No AI scopes declared/)).toBeTruthy();
  });

  it('shows scope key as code element', () => {
    render(
      <ScopeConsentModal
        pluginName="demo"
        scopes={scopes}
        onApprove={vi.fn()}
        onDisable={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('core.apk:read')).toBeTruthy();
  });
});
