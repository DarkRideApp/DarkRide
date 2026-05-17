import { describe, it, expect, beforeEach, vi } from 'vitest';

// We need a fresh module for each test to avoid state leakage from the singleton pattern.
// Use dynamic import + vi.resetModules to get clean state.

describe('Logging System', () => {
  let createLoggers: typeof import('./logs').createLoggers;
  let subscribe: typeof import('./logs').subscribe;
  let subscribeAll: typeof import('./logs').subscribeAll;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('./logs');
    createLoggers = mod.createLoggers;
    subscribe = mod.subscribe;
    subscribeAll = mod.subscribeAll;
  });

  describe('createLoggers', () => {
    it('should return log and error functions', () => {
      const logger = createLoggers('test-system');
      expect(typeof logger.log).toBe('function');
      expect(typeof logger.error).toBe('function');
    });

    it('should return the same logger for the same systemId', () => {
      const logger1 = createLoggers('same-id');
      const logger2 = createLoggers('same-id');
      expect(logger1).toBe(logger2);
    });

    it('should return different loggers for different systemIds', () => {
      const logger1 = createLoggers('system-a');
      const logger2 = createLoggers('system-b');
      expect(logger1).not.toBe(logger2);
    });
  });

  describe('subscribe', () => {
    it('should receive events for a specific system', () => {
      const entries: any[] = [];
      subscribe('my-system', (entry) => entries.push(entry));

      const logger = createLoggers('my-system');
      logger.log('hello');

      expect(entries).toHaveLength(1);
      expect(entries[0].system).toBe('my-system');
      expect(entries[0].message).toBe('hello');
      expect(entries[0].severity).toBe('log');
    });

    it('should not receive events for other systems', () => {
      const entries: any[] = [];
      subscribe('system-a', (entry) => entries.push(entry));

      const logger = createLoggers('system-b');
      logger.log('hello from b');

      expect(entries).toHaveLength(0);
    });

    it('should handle error severity', () => {
      const entries: any[] = [];
      subscribe('err-system', (entry) => entries.push(entry));

      const logger = createLoggers('err-system');
      logger.error('something went wrong');

      expect(entries).toHaveLength(1);
      expect(entries[0].severity).toBe('error');
      expect(entries[0].message).toBe('something went wrong');
    });

    it('should return an unsubscribe function', () => {
      const entries: any[] = [];
      const unsub = subscribe('unsub-test', (entry) => entries.push(entry));

      const logger = createLoggers('unsub-test');
      logger.log('first');
      unsub();
      logger.log('second');

      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe('first');
    });
  });

  describe('subscribeAll', () => {
    it('should receive events from all systems', () => {
      const entries: any[] = [];
      subscribeAll((entry) => entries.push(entry));

      const loggerA = createLoggers('all-a');
      const loggerB = createLoggers('all-b');
      loggerA.log('from a');
      loggerB.error('from b');

      expect(entries).toHaveLength(2);
      expect(entries[0].system).toBe('all-a');
      expect(entries[1].system).toBe('all-b');
    });

    it('should return an unsubscribe function', () => {
      const entries: any[] = [];
      const unsub = subscribeAll((entry) => entries.push(entry));

      const logger = createLoggers('unsub-all');
      logger.log('first');
      unsub();
      logger.log('second');

      expect(entries).toHaveLength(1);
    });
  });

  describe('LogEntry structure', () => {
    it('should have correct fields', () => {
      const entries: any[] = [];
      subscribe('struct-test', (entry) => entries.push(entry));

      const logger = createLoggers('struct-test');
      logger.log('test message');

      const entry = entries[0];
      expect(entry).toHaveProperty('system', 'struct-test');
      expect(entry).toHaveProperty('datetime');
      expect(entry).toHaveProperty('severity', 'log');
      expect(entry).toHaveProperty('message', 'test message');
      expect(entry).toHaveProperty('file');
      expect(entry).toHaveProperty('line');
      // datetime should be a valid ISO string
      expect(() => new Date(entry.datetime)).not.toThrow();
      expect(new Date(entry.datetime).toISOString()).toBe(entry.datetime);
    });

    it('should concatenate multiple arguments', () => {
      const entries: any[] = [];
      subscribe('concat-test', (entry) => entries.push(entry));

      const logger = createLoggers('concat-test');
      logger.log('hello', 'world', 42);

      expect(entries[0].message).toBe('hello world 42');
    });

    it('should stringify objects', () => {
      const entries: any[] = [];
      subscribe('obj-test', (entry) => entries.push(entry));

      const logger = createLoggers('obj-test');
      logger.log('data:', { key: 'val' });

      expect(entries[0].message).toContain('{"key":"val"}');
    });
  });
});
