import { describe, it, expect } from 'vitest';
import { DOWNLOAD_PENDING_NOTE, isDownloadPendingNote } from './download-pending';

describe('isDownloadPendingNote', () => {
  it('is true for the marker itself', () => {
    expect(isDownloadPendingNote(DOWNLOAD_PENDING_NOTE)).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['a real download failure', 'apkeep produced no downloadable files (APKPure)'],
    ['a version check failure', 'getaddrinfo ENOTFOUND play.google.com'],
    ['the marker with different case', DOWNLOAD_PENDING_NOTE.toUpperCase()],
    ['the marker embedded in a longer message', `${DOWNLOAD_PENDING_NOTE}: sha256 mismatch`],
  ])('is false for %s', (_name, value) => {
    expect(isDownloadPendingNote(value as string | null | undefined)).toBe(false);
  });
});
