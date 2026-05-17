/**
 * GraphQL detection utilities — shared between backend and frontend.
 */

export interface GraphQLInfo {
  operationType: 'query' | 'mutation' | 'subscription';
  operationName: string | null;
  query: string;
  variables: Record<string, any> | null;
}

/**
 * Detect if a request is GraphQL and extract metadata.
 * Returns null if not GraphQL.
 */
export function detectGraphQL(
  method: string,
  url: string,
  requestBody: string | null,
  contentType?: string | null,
): GraphQLInfo | null {
  // Must be POST (or GET with query param, but POST is standard)
  if (method !== 'POST') return null;

  // Try parsing body as JSON with a `query` field
  if (!requestBody) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(requestBody);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;

  // Standard GraphQL: { query: "...", variables?: {...}, operationName?: "..." }
  const query = parsed.query;
  if (typeof query !== 'string') return null;

  // Validate it looks like GraphQL (not just any object with a `query` key)
  const trimmed = query.trim();
  if (!trimmed) return null;

  // Must start with a GraphQL keyword or shorthand `{`
  const looksLikeGQL = /^(query|mutation|subscription)\b/.test(trimmed) || trimmed.startsWith('{');
  if (!looksLikeGQL) return null;

  // Extract operation type
  let operationType: GraphQLInfo['operationType'] = 'query';
  if (trimmed.startsWith('mutation')) operationType = 'mutation';
  else if (trimmed.startsWith('subscription')) operationType = 'subscription';

  // Extract operation name
  let operationName: string | null = parsed.operationName || null;
  if (!operationName) {
    // Try parsing from query string: "query GetFoo(" or "mutation DoBar {"
    const nameMatch = trimmed.match(/^(?:query|mutation|subscription)\s+([A-Za-z_]\w*)/);
    if (nameMatch) operationName = nameMatch[1];
  }

  return {
    operationType,
    operationName,
    query,
    variables: parsed.variables && typeof parsed.variables === 'object' ? parsed.variables : null,
  };
}

/**
 * Format a GraphQL query for display (basic indentation cleanup).
 */
export function formatGraphQLQuery(query: string): string {
  // Simple formatter: normalize whitespace, add newlines after { and before }
  let result = query.trim();
  // Don't reformat if it already has newlines (user-formatted)
  if (result.includes('\n')) return result;

  result = result
    .replace(/\s*\{\s*/g, ' {\n  ')
    .replace(/\s*\}\s*/g, '\n}\n')
    .replace(/\s*,\s*/g, '\n  ')
    .replace(/\n\s*\n/g, '\n');

  return result.trim();
}
