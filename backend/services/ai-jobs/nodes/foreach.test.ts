// backend/services/ai-jobs/nodes/foreach.test.ts
import { describe, it, expect } from 'vitest';
import { registerForEachItemFn, runForEach } from './foreach';

describe('runForEach', () => {
  registerForEachItemFn('test/maybe-fail', async (item) => {
    if ((item as number) % 3 === 0) throw new Error(`item ${item} is divisible by 3`);
    return (item as number) * 10;
  });

  registerForEachItemFn('test/sync-throw', (item) => {
    if ((item as number) === 2) throw new Error('sync failure on 2');
    return Promise.resolve((item as number) + 100);
  });

  it('collects all 10 results, ok and failed, never throws for a per-item failure', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i + 1); // 1..10, three multiples of 3 (3, 6, 9)
    const results = await runForEach({ itemFn: 'test/maybe-fail' }, items);

    expect(results).toHaveLength(10);
    const failed = results.filter(r => r.status === 'failed');
    const ok = results.filter(r => r.status === 'ok');
    expect(failed).toHaveLength(3);
    expect(ok).toHaveLength(7);
  });

  it('treats a synchronous throw from the item function as a failed item, not a rejection', async () => {
    const results = await runForEach({ itemFn: 'test/sync-throw' }, [1, 2, 3]);

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ status: 'ok', output: 101 });
    expect(results[1]).toEqual({ status: 'failed', error: 'Error: sync failure on 2' });
    expect(results[2]).toEqual({ status: 'ok', output: 103 });
  });

  it('rejects outright when the input list is malformed, not per-item', async () => {
    await expect(runForEach({ itemFn: 'test/maybe-fail' }, 'not an array' as any)).rejects.toThrow(/array/);
  });

  it('throws on an unregistered item function name before touching any item', async () => {
    await expect(runForEach({ itemFn: 'test/nope' }, [1, 2])).rejects.toThrow(/Unknown ForEach item function/);
  });

  it('treats an inherited Object.prototype key as unregistered rather than resolving it', async () => {
    await expect(runForEach({ itemFn: 'constructor' }, [1, 2])).rejects.toThrow(/Unknown ForEach item function "constructor"/);
  });
});
