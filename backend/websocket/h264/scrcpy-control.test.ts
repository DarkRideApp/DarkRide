import { describe, it, expect } from 'vitest';
import { RESET_VIDEO_BYTE } from './scrcpy-control';

describe('scrcpy control protocol', () => {
  it('RESET_VIDEO type byte is 0x11 (scrcpy 2.7 SC_CONTROL_MSG_TYPE_RESET_VIDEO = 17)', () => {
    expect(RESET_VIDEO_BYTE).toBe(0x11);
    expect(RESET_VIDEO_BYTE).toBe(17);
  });
});
