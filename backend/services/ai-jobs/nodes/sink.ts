import type { SinkConfig } from '../types';
import type { AppDatabase } from '../../../db/index';
import { patchNoteSection } from '../../apk-notes';
import { createFunctionRegistry } from './function-registry';
import { resolveTemplate } from '../template';

export interface SinkCtx {
  db: AppDatabase;
  versionId: number;
  /** Narrowed to just `emit` — a Sink only ever sends, never manages channels/history. Absent in
   *  contexts that don't wire notifications in (e.g. most existing tests); core/notify no-ops
   *  rather than throwing when it's missing. */
  notificationService?: { emit: (event: { type: string; title: string; body: string; sourceType?: string; sourceId?: string; url?: string }) => void };
}

// Every node's input is wrapped by source-node-id, even with exactly one incoming edge (see
// Tasks 13-17). A write function reading a field straight off `input` would read `undefined`
// through the real executor, not whatever a unit test calling runSink directly handed it —
// the config param lets a write function unwrap the right predecessor via config.from, the
// same convention Report's sections[].from uses.
export type SinkWriteFn = (config: SinkConfig, input: Record<string, unknown>, ctx: SinkCtx) => Promise<void>;

const registry = createFunctionRegistry<SinkWriteFn>();
/** Direct map access, same shape as before the merge — every existing import site reads this as a plain Record. */
export const SINK_REGISTRY: Record<string, SinkWriteFn> = new Proxy({} as Record<string, SinkWriteFn>, {
  get: (_t, name: string) => registry.get(name),
});
export const SINK_DESCRIPTIONS: Record<string, string> = new Proxy({} as Record<string, string>, {
  get: (_t, name: string) => registry.list().find(e => e.name === name)?.description,
});
/** Whether a write function reads `config.section` — governs whether the editor shows that field. Not a schema concept (it's a UI-only hint), kept as its own separate map, unrelated to the registry merge. */
export const SINK_USES_SECTION: Record<string, boolean> = Object.create(null);

export function registerSink(name: string, fn: SinkWriteFn, description: string, usesSection = false): void {
  registry.register(name, fn, description);
  SINK_USES_SECTION[name] = usesSection;
}

export async function runSink(config: SinkConfig, input: Record<string, unknown>, ctx: SinkCtx): Promise<void> {
  const fn = registry.get(config.writeFn);
  if (!fn) throw new Error(`Unknown sink "${config.writeFn}"`);
  await fn(config, input, ctx);
}

// Patches each section in place — never overwrites the whole note, so other sections (e.g. the
// Quick Rescan zone's "Diff Summary", or anything an analyst wrote by hand) survive untouched.
registerSink('apk-analysis/write-full-document', async (config, input, ctx) => {
  const source = config.from
    ? (input[config.from] as { markdown?: string; sections?: Array<{ title: string; body: string }> } | undefined)
    : undefined;
  if (!source?.sections) return;
  for (const section of source.sections) {
    patchNoteSection(ctx.db, ctx.versionId, section.title, section.body);
  }
}, "Writes every section from the connected Report into this APK version's analysis notes.");

registerSink('apk-analysis/write-section', async (config, input, ctx) => {
  const source = config.from ? (input[config.from] as { text?: string } | undefined) : undefined;
  patchNoteSection(ctx.db, ctx.versionId, config.section ?? 'Untitled', source?.text ?? '');
}, "Writes the connected step's output into one named section of this APK version's analysis notes.", true);

// Generic, pipeline-agnostic — unlike the two apk-analysis sinks above, this reads nothing off
// `config.from`/`input` directly; titleTemplate/bodyTemplate resolve {{node.field}} placeholders
// against the whole input bag (same convention as AgentCall's instructionTemplate), so a pipeline
// author composes the message entirely from the graph editor, no new backend code per condition.
registerSink('core/notify', async (config, input, ctx) => {
  if (!ctx.notificationService) return;
  const title = resolveTemplate(config.titleTemplate ?? '', input);
  const body = resolveTemplate(config.bodyTemplate ?? '', input);
  ctx.notificationService.emit({ type: 'ai-pipeline:notify', title, body });
}, 'Sends a notification through the configured channels (Discord, Slack, email, etc). Title/body use {{node.field}} templates.');
