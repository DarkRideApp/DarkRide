import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeviceFridaImpl, NoopDeviceFrida } from './device-frida';

describe('DeviceFridaImpl', () => {
  let callBridge: ReturnType<typeof vi.fn>;
  let logCall: ReturnType<typeof vi.fn>;
  let resolveScript: ReturnType<typeof vi.fn>;
  let frida: DeviceFridaImpl;

  beforeEach(() => {
    callBridge = vi.fn().mockResolvedValue({});
    logCall = vi.fn().mockImplementation((_method, _params, fn) => fn());
    resolveScript = vi.fn().mockImplementation(async (name: string) => {
      if (name === 'test-script') return 'Java.perform(function(){})';
      return null;
    });
    frida = new DeviceFridaImpl(callBridge, logCall, resolveScript);
  });

  describe('run', () => {
    it('should start server, spawn, load scripts, and resume', async () => {
      callBridge
        .mockResolvedValueOnce({ status: 'running' })
        .mockResolvedValueOnce({ session_id: 1, pid: 1234 })
        .mockResolvedValueOnce({ script_id: 1 })
        .mockResolvedValueOnce({ status: 'resumed' });

      await frida.run('com.example.app', 'test-script');

      expect(callBridge).toHaveBeenCalledWith('frida_start_server', {});
      expect(callBridge).toHaveBeenCalledWith('frida_spawn', { bundle_id: 'com.example.app' });
      expect(callBridge).toHaveBeenCalledWith('frida_load_script', { session_id: 1, code: 'Java.perform(function(){})' });
      expect(callBridge).toHaveBeenCalledWith('frida_resume', { pid: 1234 });
    });

    it('should accept array of script names', async () => {
      resolveScript.mockImplementation(async (name: string) => `code_${name}`);
      callBridge
        .mockResolvedValueOnce({ status: 'running' })
        .mockResolvedValueOnce({ session_id: 1, pid: 100 })
        .mockResolvedValueOnce({ script_id: 1 })
        .mockResolvedValueOnce({ script_id: 2 })
        .mockResolvedValueOnce({ status: 'resumed' });

      await frida.run('com.example', ['a', 'b']);

      expect(callBridge).toHaveBeenCalledWith('frida_load_script', { session_id: 1, code: 'code_a' });
      expect(callBridge).toHaveBeenCalledWith('frida_load_script', { session_id: 1, code: 'code_b' });
    });

    it('should throw if script not found', async () => {
      callBridge
        .mockResolvedValueOnce({ status: 'running' })
        .mockResolvedValueOnce({ session_id: 1, pid: 100 });

      await expect(frida.run('com.example', 'nonexistent')).rejects.toThrow('Frida script not found: nonexistent');
    });

    it('should not start server twice', async () => {
      callBridge
        .mockResolvedValueOnce({ status: 'running' })
        .mockResolvedValueOnce({ session_id: 1, pid: 100 })
        .mockResolvedValueOnce({ script_id: 1 })
        .mockResolvedValueOnce({ status: 'resumed' })
        .mockResolvedValueOnce({ session_id: 2, pid: 200 })
        .mockResolvedValueOnce({ script_id: 2 })
        .mockResolvedValueOnce({ status: 'resumed' });

      await frida.run('com.a', 'test-script');
      await frida.run('com.b', 'test-script');

      const startCalls = callBridge.mock.calls.filter(c => c[0] === 'frida_start_server');
      expect(startCalls).toHaveLength(1);
    });
  });

  describe('inject', () => {
    it('should start server, find app, attach, and load code', async () => {
      callBridge
        .mockResolvedValueOnce({ status: 'running' })
        .mockResolvedValueOnce([{ identifier: 'com.example', pid: 5678, name: 'Example' }])
        .mockResolvedValueOnce({ session_id: 2, pid: 5678 })
        .mockResolvedValueOnce({ script_id: 2 });

      await frida.inject('com.example', 'console.log("hello")');

      expect(callBridge).toHaveBeenCalledWith('frida_attach', { pid: 5678 });
      expect(callBridge).toHaveBeenCalledWith('frida_load_script', { session_id: 2, code: 'console.log("hello")' });
    });

    it('should throw if app not running', async () => {
      callBridge
        .mockResolvedValueOnce({ status: 'running' })
        .mockResolvedValueOnce([{ identifier: 'com.other', pid: 123, name: 'Other' }]);

      await expect(frida.inject('com.missing', 'code')).rejects.toThrow('not running');
    });
  });

  describe('loadScript', () => {
    it('should load into the most recent session', async () => {
      callBridge
        .mockResolvedValueOnce({ status: 'running' })
        .mockResolvedValueOnce({ session_id: 1, pid: 100 })
        .mockResolvedValueOnce({ script_id: 1 })
        .mockResolvedValueOnce({ status: 'resumed' });
      await frida.run('com.example', 'test-script');

      callBridge.mockResolvedValueOnce({ script_id: 2 });
      await frida.loadScript('test-script');

      expect(callBridge).toHaveBeenLastCalledWith('frida_load_script', { session_id: 1, code: 'Java.perform(function(){})' });
    });

    it('should throw if no active session', async () => {
      await expect(frida.loadScript('test-script')).rejects.toThrow('No active Frida session');
    });
  });

  describe('getMessages', () => {
    it('should return messages and advance index', async () => {
      callBridge.mockResolvedValueOnce({
        messages: [{ type: 'log', payload: 'hello', timestamp: 'now' }],
        next_index: 1,
      });

      const msgs = await frida.getMessages();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].payload).toBe('hello');

      // Next call should use updated index
      callBridge.mockResolvedValueOnce({ messages: [], next_index: 1 });
      await frida.getMessages();
      expect(callBridge).toHaveBeenLastCalledWith('frida_get_messages', { since: 1 });
    });
  });

  describe('stop', () => {
    it('should detach all sessions and stop server', async () => {
      callBridge
        .mockResolvedValueOnce({ status: 'running' })
        .mockResolvedValueOnce({ session_id: 1, pid: 100 })
        .mockResolvedValueOnce({ script_id: 1 })
        .mockResolvedValueOnce({ status: 'resumed' });
      await frida.run('com.example', 'test-script');

      callBridge
        .mockResolvedValueOnce({ status: 'detached' })
        .mockResolvedValueOnce({ status: 'stopped' });
      await frida.stop();

      expect(callBridge).toHaveBeenCalledWith('frida_detach', { session_id: 1 });
      expect(callBridge).toHaveBeenCalledWith('frida_stop_server', {});
    });

    it('should handle detach errors gracefully', async () => {
      callBridge
        .mockResolvedValueOnce({ status: 'running' })
        .mockResolvedValueOnce({ session_id: 1, pid: 100 })
        .mockResolvedValueOnce({ script_id: 1 })
        .mockResolvedValueOnce({ status: 'resumed' });
      await frida.run('com.example', 'test-script');

      callBridge
        .mockRejectedValueOnce(new Error('already detached'))
        .mockResolvedValueOnce({ status: 'stopped' });
      await frida.stop(); // should not throw
    });
  });

  describe('cleanup', () => {
    it('should not throw even if stop fails', async () => {
      callBridge.mockRejectedValue(new Error('fail'));
      // cleanup on a fresh instance should not throw
      await frida.cleanup();
    });
  });
});

describe('NoopDeviceFrida', () => {
  const noop = new NoopDeviceFrida();

  it('run throws', async () => {
    await expect(noop.run('com.example', 'script')).rejects.toThrow('Frida is not available');
  });

  it('inject throws', async () => {
    await expect(noop.inject('com.example', 'code')).rejects.toThrow('Frida is not available');
  });

  it('loadScript throws', async () => {
    await expect(noop.loadScript('name')).rejects.toThrow('Frida is not available');
  });

  it('getMessages returns empty', async () => {
    expect(await noop.getMessages()).toEqual([]);
  });

  it('send throws', async () => {
    await expect(noop.send('data')).rejects.toThrow('Frida is not available');
  });

  it('stop is noop', async () => {
    await noop.stop(); // should not throw
  });
});
