import { describe, it, expect } from 'vitest';
import { RESET_VIDEO_BYTE } from './scrcpy-control';

describe('scrcpy control protocol', () => {
  it('RESET_VIDEO type byte is 0x11 (TYPE_RESET_VIDEO = 17, unchanged v2.7 through v3.3.1)', () => {
    expect(RESET_VIDEO_BYTE).toBe(0x11);
    expect(RESET_VIDEO_BYTE).toBe(17);
  });
});
