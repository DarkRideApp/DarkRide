import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { AuthProvider } from '../../components/AuthProvider';
import { useAuth } from '../useAuth';

describe('AuthProvider', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function renderAuthHook() {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthProvider>{children}</AuthProvider>
    );
    return renderHook(() => useAuth(), { wrapper });
  }

  it('sets authenticated when server returns authenticated user', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          authenticated: true,
          user: { id: 1, username: 'admin', displayName: 'Admin', email: null, scopes: [] },
          csrfToken: 'tok123',
        }),
    });

    const { result } = renderAuthHook();

    await waitFor(() => {
      expect(result.current.status).toBe('authenticated');
    });
    expect(result.current.user?.username).toBe('admin');
    expect(result.current.csrfToken).toBe('tok123');
  });

  it('sets unauthenticated when server returns not authenticated', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ authenticated: false }),
    });

    const { result } = renderAuthHook();

    await waitFor(() => {
      expect(result.current.status).toBe('unauthenticated');
    });
  });

  it('sets setup-required when server indicates setup needed', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ authenticated: false, setupRequired: true }),
    });

    const { result } = renderAuthHook();

    await waitFor(() => {
      expect(result.current.status).toBe('setup-required');
    });
  });

  it('stays in loading state when server is unreachable (network error)', async () => {
    // Simulate network error — fetch() throws when server is down
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const { result } = renderAuthHook();

    // Give the effect time to run and (incorrectly) change state
    await new Promise((r) => setTimeout(r, 100));

    // The status should remain 'loading', NOT 'unauthenticated'
    expect(result.current.status).toBe('loading');
  });
});
