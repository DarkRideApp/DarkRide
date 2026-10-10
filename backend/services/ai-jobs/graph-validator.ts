import type { PipelineGraph, PipelineNode } from './types';

export interface ValidationError {
  nodeId?: string;
  message: string;
}

function schemasMatch(a: PipelineNode['config'], b: PipelineNode['config']): boolean {
  if (a.kind !== 'Trigger' || b.kind !== 'Trigger') return true;
  const norm = (schema: typeof a.outputSchema) =>
    [...schema].sort((x, y) => x.field.localeCompare(y.field)).map(f => `${f.field}:${f.type}`).join(',');
  return norm(a.outputSchema) === norm(b.outputSchema);
}

export function validateGraph(graph: PipelineGraph): ValidationError[] {
  const errors: ValidationError[] = [];
  const triggers = graph.nodes.filter(n => n.config.kind === 'Trigger');

  if (triggers.length === 0) {
    errors.push({ message: 'A pipeline needs at least one Trigger node.' });
    return errors; // nothing else to check meaningfully without a root
  }

  for (let i = 1; i < triggers.length; i++) {
    if (!schemasMatch(triggers[0].config, triggers[i].config)) {
      errors.push({
        nodeId: triggers[i].id,
        message: `Trigger "${triggers[i].id}" does not declare the same output schema as Trigger "${triggers[0].id}" — every Trigger in a pipeline must.`,
      });
    }
  }

  // Reachability: for each trigger, BFS forward over edges, recording which trigger(s) reach each node.
  const reachedBy = new Map<string, Set<string>>();
  for (const trigger of triggers) {
    const seen = new Set<string>([trigger.id]);
    const queue = [trigger.id];
    while (queue.length) {
      const current = queue.shift()!;
      for (const edge of graph.edges) {
        if (edge.from !== current || seen.has(edge.to)) continue;
        seen.add(edge.to);
        queue.push(edge.to);
      }
    }
    for (const nodeId of seen) {
      if (nodeId === trigger.id) continue;
      if (!reachedBy.has(nodeId)) reachedBy.set(nodeId, new Set());
      reachedBy.get(nodeId)!.add(trigger.id);
    }
  }

  for (const n of graph.nodes) {
    if (n.config.kind === 'Trigger') continue;
    const reachers = reachedBy.get(n.id) ?? new Set();
    if (reachers.size === 0) {
      errors.push({ nodeId: n.id, message: `Node "${n.id}" is not reachable from any Trigger.` });
    } else if (reachers.size > 1) {
      errors.push({ nodeId: n.id, message: `Node "${n.id}" is reachable from more than one Trigger (${[...reachers].join(', ')}) — Triggers must partition the graph into disjoint zones.` });
    }
  }

  for (const n of graph.nodes) {
    if (n.config.kind !== 'Report') continue;
    const incomingSources = new Set(graph.edges.filter(e => e.to === n.id).map(e => e.from));
    for (const section of n.config.sections) {
      if (!incomingSources.has(section.from)) {
        errors.push({ nodeId: n.id, message: `Report "${n.id}" declares section "${section.title}" from "${section.from}", which is not a direct incoming edge into this Report.` });
      }
    }
  }

  // Same "authored data can drift from the graph" check Report gets above, for Branch's
  // declared config.edges against its real outgoing edge labels — plan review caught that this
  // was missing: a Branch with a declared edge that has no matching graph edge, or a graph edge
  // whose label isn't declared, was only ever caught at runtime if a run happened to exercise
  // that exact path, contradicting Review Focus item 3's own "catch this at publish time" goal.
  for (const n of graph.nodes) {
    if (n.config.kind !== 'Branch') continue;
    const outgoingLabels = new Set(
      graph.edges.filter(e => e.from === n.id).map(e => e.label).filter((l): l is string => !!l),
    );
    for (const declaredEdge of n.config.edges) {
      if (!outgoingLabels.has(declaredEdge)) {
        errors.push({ nodeId: n.id, message: `Branch "${n.id}" declares edge "${declaredEdge}" in its config, but no outgoing graph edge carries that label.` });
      }
    }
    for (const label of outgoingLabels) {
      if (!n.config.edges.includes(label)) {
        errors.push({ nodeId: n.id, message: `Branch "${n.id}" has an outgoing edge labeled "${label}" that isn't declared in its config.edges.` });
      }
    }
  }

  // Same drift-detection pattern as Report's sections[].from and Branch's declared edges —
  // a Sink's config.from, when present, must name a real incoming edge's source. Added
  // alongside the SDD pre-flight fix to SinkConfig (Task 2) and sink.ts (Task 11): without
  // this, a typo'd or stale `from` is only ever caught by a live run writing an empty section,
  // not at publish time.
  for (const n of graph.nodes) {
    if (n.config.kind !== 'Sink' || !n.config.from) continue;
    const incomingSources = new Set(graph.edges.filter(e => e.to === n.id).map(e => e.from));
    if (!incomingSources.has(n.config.from)) {
      errors.push({ nodeId: n.id, message: `Sink "${n.id}" declares from: "${n.config.from}", which is not a direct incoming edge into this Sink.` });
    }
  }

  return errors;
}
