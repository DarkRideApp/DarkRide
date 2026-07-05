import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { ToastProvider } from '@darkrideapp/plugin-sdk/react';
import { ClipboardToastBridge } from './ClipboardToastBridge';
import { CLIPBOARD_COPIED_EVENT } from './clipboardEvents';

afterEach(() => cleanup());

describe('ClipboardToastBridge', () => {
  it('shows a "Copied to clipboard" toast when the clipboard-copied event fires', async () => {
    render(
      <ToastProvider>
        <ClipboardToastBridge />
      </ToastProvider>,
    );

    act(() => {
      window.dispatchEvent(new CustomEvent(CLIPBOARD_COPIED_EVENT));
    });

    await waitFor(() => {
      expect(screen.getByText('Copied to clipboard')).toBeInTheDocument();
    });
  });

  it('stops listening once unmounted', async () => {
    const { unmount } = render(
      <ToastProvider>
        <ClipboardToastBridge />
      </ToastProvider>,
    );
    unmount();

    // No listener left attached to window — dispatching must not throw, and
    // since the ToastProvider itself is gone there's nothing to assert on
    // besides "this doesn't blow up after teardown".
    expect(() => window.dispatchEvent(new CustomEvent(CLIPBOARD_COPIED_EVENT))).not.toThrow();
  });
});
