
export class TemplateResolutionError extends Error {
  constructor(public readonly path: string) {
    super(`Unresolved template path "{{${path}}}" — the node fails rather than sending literal braces to the model.`);
    this.name = 'TemplateResolutionError';
  }
}

// Source is a node id (may contain hyphens, e.g. "agent-overview"); fields are identifiers only.
const PLACEHOLDER_RE = /\{\{([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_]+)*)\}\}/g;

/**
 * Dotted-path-only substitution: {{source.field}} → scope[source][field]. Never an expression —
 * a path with anything but identifiers and dots (e.g. "trigger.fileSizeBytes / 1024") simply
 * never matches PLACEHOLDER_RE as a whole, so the literal "{{...}}" is left in the template and
 * then fails the generic "still has braces after substitution" check below. Fails loud: an
 * unresolved placeholder throws, it never survives into what gets sent to a model.
 */
export function resolveTemplate(template: string, scope: Record<string, unknown>): string {
  const resolved = template.replace(PLACEHOLDER_RE, (_match, path: string) => {
    const [source, ...fieldParts] = path.split('.');
    if (fieldParts.length === 0) throw new TemplateResolutionError(path);
    let value: unknown = scope[source];
    for (const part of fieldParts) {
      if (value === null || typeof value !== 'object') throw new TemplateResolutionError(path);
      value = (value as Record<string, unknown>)[part];
    }
    if (value === undefined || value === null) throw new TemplateResolutionError(path);
    return String(value);
  });
  // A malformed placeholder (e.g. an expression) never matched PLACEHOLDER_RE, so it's still
  // sitting in `resolved` verbatim — catch it here rather than silently shipping it to a model.
  const stillBraced = resolved.match(/\{\{[^}]*\}\}/);
  if (stillBraced) throw new TemplateResolutionError(stillBraced[0].slice(2, -2));
  return resolved;
}
