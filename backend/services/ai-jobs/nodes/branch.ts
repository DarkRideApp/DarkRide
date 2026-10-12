import type { BranchConfig, Envelope } from '../types';

// `config` lets a generic, configurable predicate (e.g. core/field-equals below) read its own
// static args; a predicate that doesn't need them can just declare a 1-arg function — TypeScript
// allows a function with fewer params to satisfy a type expecting more, so every existing
// envelope-only predicate keeps working unchanged.
export type BranchPredicate = (envelope: Envelope, config: BranchConfig) => string;

export const BRANCH_REGISTRY: Record<string, BranchPredicate> = Object.create(null);

export function registerBranchPredicate(name: string, fn: BranchPredicate): void {
  BRANCH_REGISTRY[name] = fn;
}

export function runBranch(config: BranchConfig, envelope: Envelope): string {
  const predicate = BRANCH_REGISTRY[config.predicate];
  if (!predicate) throw new Error(`Unknown branch predicate "${config.predicate}"`);
  const edge = predicate(envelope, config);
  if (!config.edges.includes(edge)) {
    throw new Error(`Branch predicate "${config.predicate}" returned edge "${edge}", not declared in config.edges (${config.edges.join(', ')})`);
  }
  return edge;
}

// The one generic, UI-configurable predicate: compares a named field off the predecessor's
// output to a static value from config.args, routing to a fixed 'yes'/'no' pair of edges. Lets a
// pipeline author wire a condition (e.g. "docId equals X") entirely from the graph editor, with
// no new backend code per condition — the alternative is a hand-written predicate per use case.
registerBranchPredicate('core/field-equals', (envelope, config) => {
  if (envelope.status !== 'ok') return 'no';
  const field = config.args?.field;
  const expected = config.args?.value;
  if (!field) return 'no';
  const actual = (envelope.output as Record<string, unknown> | undefined)?.[field];
  if (actual === undefined) return 'no';
  return String(actual) === expected ? 'yes' : 'no';
});
