import { describe, it, expect } from 'vitest';
import { createPathsApi } from '../paths-api';

describe('PathsApi', () => {
  it('fileStorage forwards to absoluteLocalPath', () => {
    const absoluteLocalPath = (rel: string) => `/data-root/${rel}`;
    const api = createPathsApi({ absoluteLocalPath });
    expect(api.fileStorage('plugin/foo.dat')).toBe('/data-root/plugin/foo.dat');
  });
});
