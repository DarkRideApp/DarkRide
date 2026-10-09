import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../test-utils/create-test-db';
import { getNote, patchNoteSection, removeNoteSection, setNote } from './apk-notes';

describe('removeNoteSection', () => {
  let db: ReturnType<typeof createTestDb>;
  beforeEach(() => { db = createTestDb(); });

  it('removes one section and leaves the others as they were', () => {
    setNote(db as any, 1, '## Overview\nfirst\n## AI Analysis Failed\nreason\n## Maps\nlast\n');
    expect(removeNoteSection(db as any, 1, 'AI Analysis Failed')).toBe('## Overview\nfirst\n## Maps\nlast\n');
    expect(getNote(db as any, 1)).toBe('## Overview\nfirst\n## Maps\nlast\n');
  });

  it('removes the last section without leaving a dangling heading', () => {
    setNote(db as any, 1, '## Overview\nfirst\n## AI Analysis Failed\nreason\n');
    expect(removeNoteSection(db as any, 1, 'AI Analysis Failed')).toBe('## Overview\nfirst\n');
  });

  it('returns null and changes nothing when the section is not there', () => {
    setNote(db as any, 1, '## Overview\nfirst\n');
    expect(removeNoteSection(db as any, 1, 'AI Analysis Failed')).toBeNull();
    expect(getNote(db as any, 1)).toBe('## Overview\nfirst\n');
    expect(removeNoteSection(db as any, 2, 'AI Analysis Failed')).toBeNull();
    expect(getNote(db as any, 2)).toBe('');
  });

  it('matches the whole heading, not a longer one that starts with it', () => {
    setNote(db as any, 1, '## AI Analysis Failed Again\nkeep\n');
    expect(removeNoteSection(db as any, 1, 'AI Analysis Failed')).toBeNull();
    expect(getNote(db as any, 1)).toBe('## AI Analysis Failed Again\nkeep\n');
  });

  it('leaves a note that held only that section empty', () => {
    patchNoteSection(db as any, 1, 'AI Analysis Failed', 'reason');
    expect(removeNoteSection(db as any, 1, 'AI Analysis Failed')).toBe('');
    expect(getNote(db as any, 1)).toBe('');
  });
});
