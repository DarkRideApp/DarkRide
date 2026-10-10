/**
 * Client-side-only convenience copy of the server's `resolveTemplate` logic (Task 3,
 * backend/services/ai-jobs/template.ts). Duplicated deliberately rather than imported
 * across the frontend/backend boundary: this is a preview aid for the prompt editor, never the
 * authoritative resolution — that only ever happens server-side, inside an actual run.
 *
 * The placeholder regex must stay identical to the server's PLACEHOLDER_RE (a hyphen is allowed
 * in the first segment, the source node id, e.g. `agent-overview`) — otherwise the preview leaves
 * a token untouched that a real run would substitute.
 *
 * Unlike the server copy, this NEVER throws: a typo in a `{{path}}` while the user is still
 * typing must render as a visibly-marked miss, not crash the editor.
 */
export function resolvePreview(template: string, scope: Record<string, unknown>): string {
  return template.replace(/\{\{([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_]+)*)\}\}/g, (match, path: string) => {
    const [source, ...fieldParts] = path.split('.');
    let value: unknown = scope[source];
    for (const part of fieldParts) {
      if (value === null || typeof value !== 'object') { value = undefined; break; }
      value = (value as Record<string, unknown>)[part];
    }
    return value === undefined || value === null ? `${match} (unresolved)` : String(value);
  });
}
