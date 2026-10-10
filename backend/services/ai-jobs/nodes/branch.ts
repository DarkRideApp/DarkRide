import type { BranchConfig, Envelope } from '../types';

export type BranchPredicate = (envelope: Envelope) => string;

export const BRANCH_REGISTRY: Record<string, BranchPredicate> = Object.create(null);

export function registerBranchPredicate(name: string, fn: BranchPredicate): void {
  BRANCH_REGISTRY[name] = fn;
}

export function runBranch(config: BranchConfig, envelope: Envelope): string {
  const predicate = BRANCH_REGISTRY[config.predicate];
  if (!predicate) throw new Error(`Unknown branch predicate "${config.predicate}"`);
  const edge = predicate(envelope);
  if (!config.edges.includes(edge)) {
    throw new Error(`Branch predicate "${config.predicate}" returned edge "${edge}", not declared in config.edges (${config.edges.join(', ')})`);
  }
  return edge;
}
