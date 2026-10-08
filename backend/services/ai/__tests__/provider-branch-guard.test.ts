import { describe, it, expect } from 'vitest';
import path from 'path';
import { AI_PROVIDER_IDS } from '../../../../shared/lib/ai-provider-catalog';
import { scanTree } from '../../../test-utils/provider-branch-scan';

// Provider-specific behaviour belongs in the catalog (data) and the wire dialects (code).
// Everything else asks the catalog (isCliProvider, providerFormShape, getProviderDescriptor)
// instead of comparing against a provider id. The two data migrations are allowed because
// they translate legacy rows that predate the catalog.
const ROOT = path.resolve(__dirname, '../../../..');
const ALLOW = (rel: string) =>
  rel === 'shared/lib/ai-provider-catalog.ts' ||
  rel.startsWith('backend/services/ai/dialects/') ||
  rel === 'backend/db/migrate-ai-models.ts' ||
  rel === 'backend/db/migrate-ai-providers.ts';

describe('provider id branches live only in the catalog, dialects, and the two data migrations', () => {
  for (const dir of ['backend', 'frontend', 'shared']) {
    it(`no provider-id comparisons under ${dir}/`, () => {
      const hits = scanTree(path.join(ROOT, dir), AI_PROVIDER_IDS, (rel) => ALLOW(`${dir}/${rel}`));
      expect(hits.map((h) => `${dir}/${h.file}:${h.line} ${h.text}`)).toEqual([]);
    });
  }
});
