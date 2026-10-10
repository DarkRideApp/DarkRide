import { describe, it, expect } from 'vitest';
import { isEnvelopeOk } from './types';
import type { Envelope } from './types';

describe('Envelope', () => {
  it('isEnvelopeOk narrows to the ok variant', () => {
    const ok: Envelope<{ n: number }> = { status: 'ok', output: { n: 1 } };
    const failed: Envelope<{ n: number }> = { status: 'failed', error: 'boom' };
    expect(isEnvelopeOk(ok)).toBe(true);
    expect(isEnvelopeOk(failed)).toBe(false);
    if (isEnvelopeOk(ok)) {
      expect(ok.output.n).toBe(1); // type-level: output must be accessible here
    }
  });
});
