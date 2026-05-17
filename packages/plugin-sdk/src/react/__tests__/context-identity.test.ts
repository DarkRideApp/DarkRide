// packages/plugin-sdk/src/react/__tests__/context-identity.test.ts
import { describe, it, expect } from 'vitest';
import { WebSocketContext, AuthContext, ToastContext } from '../index';
import { WebSocketContext as WS2, AuthContext as Auth2, ToastContext as Toast2 } from '../index';
import { pluginRegistry } from '../index';
import { pluginRegistry as PR2 } from '../index';

describe('SDK context identity (regression guard)', () => {
  it('exports the same WebSocketContext object across imports', () => {
    expect(WebSocketContext).toBeDefined();
    expect(Object.is(WebSocketContext, WS2)).toBe(true);
  });

  it('exports the same AuthContext object across imports', () => {
    expect(AuthContext).toBeDefined();
    expect(Object.is(AuthContext, Auth2)).toBe(true);
  });

  it('exports the same ToastContext object across imports', () => {
    expect(ToastContext).toBeDefined();
    expect(Object.is(ToastContext, Toast2)).toBe(true);
  });
});

describe('SDK plugin-registry identity (regression guard)', () => {
  it('exports the same pluginRegistry singleton across imports', () => {
    expect(pluginRegistry).toBeDefined();
    expect(Object.is(pluginRegistry, PR2)).toBe(true);
  });
});
