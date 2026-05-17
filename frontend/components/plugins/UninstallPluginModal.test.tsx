import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UninstallPluginModal, type UninstallFootprint } from './UninstallPluginModal';

const fullFootprint: UninstallFootprint = {
  tables: ['plugin_demo__items', 'plugin_demo__cache'],
  fileStorageBytes: 2 * 1024 * 1024 * 1024, // 2 GB
  npmPackage: '@example.org/plugin-demo',
};

const emptyFootprint: UninstallFootprint = {
  tables: [],
  fileStorageBytes: 0,
  npmPackage: null,
};

describe('UninstallPluginModal', () => {
  it('shows plugin name in title', () => {
    render(
      <UninstallPluginModal
        pluginName="demo"
        footprint={fullFootprint}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText(/Uninstall "demo"\?/)).toBeTruthy();
  });

  it('shows loading state while footprint is null', () => {
    render(
      <UninstallPluginModal
        pluginName="demo"
        footprint={null}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText(/Checking what would be removed/)).toBeTruthy();
  });

  it('lists tables and formatted file size when footprint has data', () => {
    render(
      <UninstallPluginModal
        pluginName="demo"
        footprint={fullFootprint}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    const summary = screen.getByTestId('uninstall-footprint-summary');
    expect(summary.textContent).toContain('plugin_demo__items');
    expect(summary.textContent).toContain('plugin_demo__cache');
    expect(summary.textContent).toContain('2.0 GB');
    expect(summary.textContent).toContain('data/plugins/demo/');
  });

  it('shows danger button summary with table count and size', () => {
    render(
      <UninstallPluginModal
        pluginName="demo"
        footprint={fullFootprint}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    const danger = screen.getByTestId('uninstall-delete-data');
    expect(danger.textContent).toContain('2 tables');
    expect(danger.textContent).toContain('2.0 GB');
  });

  it('reports no plugin data when footprint is empty', () => {
    render(
      <UninstallPluginModal
        pluginName="demo"
        footprint={emptyFootprint}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText(/No plugin data on this server/)).toBeTruthy();
    const danger = screen.getByTestId('uninstall-delete-data');
    expect(danger.textContent).toBe('Uninstall and delete all data');
  });

  it('confirms with preserveData: true when "keep data" button is clicked', () => {
    const onConfirm = vi.fn();
    render(
      <UninstallPluginModal
        pluginName="demo"
        footprint={fullFootprint}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByTestId('uninstall-keep-data'));
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it('confirms with preserveData: false when "delete all data" button is clicked', () => {
    const onConfirm = vi.fn();
    render(
      <UninstallPluginModal
        pluginName="demo"
        footprint={fullFootprint}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByTestId('uninstall-delete-data'));
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it('calls onCancel when Cancel is clicked', () => {
    const onCancel = vi.fn();
    render(
      <UninstallPluginModal
        pluginName="demo"
        footprint={fullFootprint}
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('uninstall-cancel'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('focuses safe button by default (autoFocus)', () => {
    render(
      <UninstallPluginModal
        pluginName="demo"
        footprint={fullFootprint}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(document.activeElement).toBe(screen.getByTestId('uninstall-keep-data'));
  });
});
