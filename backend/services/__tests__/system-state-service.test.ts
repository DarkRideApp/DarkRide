import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { SystemStateService } from '../system-state-service';
import * as schema from '../../db/schema';

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE system_state (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return drizzle(sqlite, { schema });
}

describe('SystemStateService', () => {
  let broadcastSpy: ReturnType<typeof vi.fn>;
  let service: SystemStateService;

  beforeEach(() => {
    broadcastSpy = vi.fn();
    service = new SystemStateService(makeDb(), broadcastSpy);
  });

  it('getRestartRequired returns null when unset', () => {
    expect(service.getRestartRequired()).toBeNull();
  });

  it('setRestartRequired stores reason and broadcasts WS event', () => {
    service.setRestartRequired('plugin foo installed');
    const got = service.getRestartRequired();
    expect(got?.reason).toBe('plugin foo installed');
    expect(typeof got?.since).toBe('number');
    expect(broadcastSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'system:restart-required',
      reason: 'plugin foo installed',
      since: expect.any(Number),
    }));
  });

  it('setRestartRequired called twice keeps latest reason', () => {
    service.setRestartRequired('first');
    service.setRestartRequired('second');
    expect(service.getRestartRequired()?.reason).toBe('second');
  });

  it('setRestartRequired broadcasts only on null→set transition, not on subsequent updates', () => {
    service.setRestartRequired('first');
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    broadcastSpy.mockClear();
    service.setRestartRequired('second');
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('clearRestartRequired removes state and broadcasts cleared event', () => {
    service.setRestartRequired('temp');
    broadcastSpy.mockClear();
    service.clearRestartRequired();
    expect(service.getRestartRequired()).toBeNull();
    expect(broadcastSpy).toHaveBeenCalledWith({ type: 'system:restart-cleared' });
  });

  it('clearRestartRequired on empty state is a no-op (no broadcast)', () => {
    service.clearRestartRequired();
    expect(broadcastSpy).not.toHaveBeenCalled();
  });
});
