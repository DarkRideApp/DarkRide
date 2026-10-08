import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProviderStatusBadge } from '../SettingsShared';
import type { AiProviderConfig } from '../../../../shared/types/ai-providers';

function provider(type: string, hasApiKey: boolean): AiProviderConfig {
  return { id: 1, name: 'P', type: type as AiProviderConfig['type'], hasApiKey, baseUrl: null, createdAt: 0, updatedAt: 0 };
}

describe('ProviderStatusBadge', () => {
  it('shows "Unknown type" for a stored type the catalog does not know, with or without a key', () => {
    const { unmount } = render(<ProviderStatusBadge provider={provider('retired-vendor', true)} />);
    expect(screen.getByText('Unknown type')).toBeTruthy();
    expect(screen.queryByText('Ready')).toBeNull();
    unmount();
    render(<ProviderStatusBadge provider={provider('retired-vendor', false)} />);
    expect(screen.getByText('Unknown type')).toBeTruthy();
  });

  it('shows "No Key" for a key-requiring provider without a key', () => {
    render(<ProviderStatusBadge provider={provider('anthropic', false)} />);
    expect(screen.getByText('No Key')).toBeTruthy();
  });

  it('shows "Ready" for a key-requiring provider with a key and for a keyless provider', () => {
    const { unmount } = render(<ProviderStatusBadge provider={provider('anthropic', true)} />);
    expect(screen.getByText('Ready')).toBeTruthy();
    unmount();
    render(<ProviderStatusBadge provider={provider('ollama', false)} />);
    expect(screen.getByText('Ready')).toBeTruthy();
  });

  it('shows "Token Set" for the CLI provider with a stored token', () => {
    render(<ProviderStatusBadge provider={provider('claude-cli', true)} />);
    expect(screen.getByText('Token Set')).toBeTruthy();
  });
});
