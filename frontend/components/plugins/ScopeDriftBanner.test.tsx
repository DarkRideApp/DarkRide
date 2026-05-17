import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ScopeDriftBanner } from './ScopeDriftBanner';

describe('ScopeDriftBanner', () => {
  const added = [
    { key: 'core.apk:manage', label: 'Manage APKs', description: '' },
  ];

  it('shows the plugin name and version', () => {
    render(
      <ScopeDriftBanner
        pluginName="demo"
        pluginVersion="2.0.0"
        added={added}
        removed={[]}
        onReview={vi.fn()}
        onUninstall={vi.fn()}
      />,
    );
    expect(screen.getByText(/demo v2\.0\.0 requests additional AI scopes/)).toBeTruthy();
  });

  it('lists added scopes with labels', () => {
    render(
      <ScopeDriftBanner
        pluginName="demo"
        pluginVersion="2.0.0"
        added={added}
        removed={[]}
        onReview={vi.fn()}
        onUninstall={vi.fn()}
      />,
    );
    expect(screen.getByText(/Manage APKs/)).toBeTruthy();
  });

  it('shows added scope keys as code', () => {
    render(
      <ScopeDriftBanner
        pluginName="demo"
        pluginVersion="2.0.0"
        added={added}
        removed={[]}
        onReview={vi.fn()}
        onUninstall={vi.fn()}
      />,
    );
    expect(screen.getByText('core.apk:manage')).toBeTruthy();
  });

  it('lists removed scopes', () => {
    render(
      <ScopeDriftBanner
        pluginName="demo"
        pluginVersion="2.0.0"
        added={[]}
        removed={['core.frida:manage']}
        onReview={vi.fn()}
        onUninstall={vi.fn()}
      />,
    );
    expect(screen.getByText('core.frida:manage')).toBeTruthy();
  });

  it('fires onReview when Review clicked', () => {
    const onReview = vi.fn();
    render(
      <ScopeDriftBanner
        pluginName="demo"
        pluginVersion="2.0.0"
        added={added}
        removed={[]}
        onReview={onReview}
        onUninstall={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /review/i }));
    expect(onReview).toHaveBeenCalled();
  });

  it('fires onUninstall when Uninstall clicked', () => {
    const onUninstall = vi.fn();
    render(
      <ScopeDriftBanner
        pluginName="demo"
        pluginVersion="2.0.0"
        added={added}
        removed={[]}
        onReview={vi.fn()}
        onUninstall={onUninstall}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /uninstall/i }));
    expect(onUninstall).toHaveBeenCalled();
  });

  it('disables buttons when busy', () => {
    render(
      <ScopeDriftBanner
        pluginName="demo"
        pluginVersion="2.0.0"
        added={added}
        removed={[]}
        onReview={vi.fn()}
        onUninstall={vi.fn()}
        busy
      />,
    );
    expect(screen.getByRole('button', { name: /review/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /uninstall/i })).toBeDisabled();
  });

  it('renders as role=alert', () => {
    render(
      <ScopeDriftBanner
        pluginName="demo"
        pluginVersion="2.0.0"
        added={added}
        removed={[]}
        onReview={vi.fn()}
        onUninstall={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  describe('variant="pending"', () => {
    it('says "requests AI permissions" (not "additional")', () => {
      render(
        <ScopeDriftBanner
          pluginName="demo-plugin"
          pluginVersion="1.0.0"
          added={added}
          removed={[]}
          onReview={vi.fn()}
          onUninstall={vi.fn()}
          variant="pending"
        />,
      );
      expect(screen.getByText(/demo-plugin v1.0.0 requests AI permissions/)).toBeTruthy();
      expect(screen.queryByText(/additional AI scopes/)).toBeNull();
    });

    it('lists manifest scopes without a + prefix', () => {
      render(
        <ScopeDriftBanner
          pluginName="demo-plugin"
          pluginVersion="1.0.0"
          added={added}
          removed={[]}
          onReview={vi.fn()}
          onUninstall={vi.fn()}
          variant="pending"
        />,
      );
      // Label still shown
      expect(screen.getByText(/Manage APKs/)).toBeTruthy();
      // No "+ " prefix in the item text
      const items = screen.getAllByRole('listitem');
      for (const li of items) {
        expect(li.textContent?.trimStart().startsWith('+')).toBe(false);
      }
    });

    it('Review button still opens review flow', () => {
      const onReview = vi.fn();
      render(
        <ScopeDriftBanner
          pluginName="demo-plugin"
          pluginVersion="1.0.0"
          added={added}
          removed={[]}
          onReview={onReview}
          onUninstall={vi.fn()}
          variant="pending"
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /review/i }));
      expect(onReview).toHaveBeenCalled();
    });
  });
});
