import type { Envelope, ReportConfig } from '../types';

export interface AssembledSection {
  title: string;
  body: string;
}

/** Turns resolved sections into one document. A job kind supplies its own formatting here. */
export type ReportAssembler = (sections: AssembledSection[]) => string;

export const REPORT_ASSEMBLERS: Record<string, ReportAssembler> = Object.create(null);

REPORT_ASSEMBLERS['apk-analysis'] = (sections) =>
  sections.map((s) => `## ${s.title}\n${s.body}`).join('\n\n') + '\n';

export function registerReportAssembler(jobKind: string, fn: ReportAssembler): void {
  REPORT_ASSEMBLERS[jobKind] = fn;
}

/**
 * Pure and synchronous. Never throws for a failed, skipped or inactive source, and never
 * for a source key that is absent from the map: each such section gets an honest placeholder
 * so one failed AI call cannot take down the whole report. The raw error is deliberately not
 * included in the document.
 */
export function runReport(
  config: ReportConfig,
  envelopes: Record<string, Envelope<{ text: string }>>,
  jobKind = 'apk-analysis',
): { markdown: string } {
  const assembler = REPORT_ASSEMBLERS[jobKind];
  if (!assembler) throw new Error(`Unknown report assembler "${jobKind}"`);
  const sections = config.sections.map((section) => {
    const envelope = envelopes[section.from];
    const body = envelope && envelope.status === 'ok'
      ? envelope.output.text.trimEnd()
      : `— ${section.title} unavailable this run. Its source node did not complete.`;
    return { title: section.title, body };
  });
  return { markdown: assembler(sections) };
}
