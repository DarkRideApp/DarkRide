import type { SinkConfig } from '../types';
import type { AppDatabase } from '../../../db/index';
import { patchNoteSection } from '../../apk-notes';

export interface SinkCtx {
  db: AppDatabase;
  versionId: number;
}

// Every node's input is wrapped by source-node-id, even with exactly one incoming edge (see
// Tasks 13-17). A write function reading a field straight off `input` would read `undefined`
// through the real executor, not whatever a unit test calling runSink directly handed it —
// the config param lets a write function unwrap the right predecessor via config.from, the
// same convention Report's sections[].from uses.
export type SinkWriteFn = (config: SinkConfig, input: Record<string, unknown>, ctx: SinkCtx) => Promise<void>;

export const SINK_REGISTRY: Record<string, SinkWriteFn> = Object.create(null);

export function registerSink(name: string, fn: SinkWriteFn): void {
  SINK_REGISTRY[name] = fn;
}

export async function runSink(config: SinkConfig, input: Record<string, unknown>, ctx: SinkCtx): Promise<void> {
  const fn = SINK_REGISTRY[config.writeFn];
  if (!fn) throw new Error(`Unknown sink "${config.writeFn}"`);
  await fn(config, input, ctx);
}

// Patches each Report section in place rather than overwriting the whole note. Found in the final
// review: the old setNote() overwrite wiped everything else in the note, including the Quick
// Rescan zone's own "Diff Summary" section and anything an analyst wrote by hand, so the two
// zones of the same pipeline undid each other. A source with no sections writes nothing.
registerSink('apk-analysis/write-full-document', async (config, input, ctx) => {
  const source = config.from
    ? (input[config.from] as { markdown?: string; sections?: Array<{ title: string; body: string }> } | undefined)
    : undefined;
  if (!source?.sections) return;
  for (const section of source.sections) {
    patchNoteSection(ctx.db, ctx.versionId, section.title, section.body);
  }
});

registerSink('apk-analysis/write-section', async (config, input, ctx) => {
  const source = config.from ? (input[config.from] as { text?: string } | undefined) : undefined;
  patchNoteSection(ctx.db, ctx.versionId, config.section ?? 'Untitled', source?.text ?? '');
});
