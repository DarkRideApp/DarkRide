import { describe, it, expect } from 'vitest';
import { detectGraphQL, formatGraphQLQuery } from '../../shared/lib/graphql-detect';

describe('detectGraphQL', () => {
  it('detects a named query', () => {
    const result = detectGraphQL('POST', 'https://api.example.com/graphql',
      JSON.stringify({ query: 'query GetUser { user { id name } }' }));
    expect(result).not.toBeNull();
    expect(result!.operationType).toBe('query');
    expect(result!.operationName).toBe('GetUser');
    expect(result!.query).toContain('GetUser');
  });

  it('detects a named mutation', () => {
    const result = detectGraphQL('POST', 'https://api.example.com/graphql',
      JSON.stringify({ query: 'mutation UpdateUser($id: ID!) { updateUser(id: $id) { id } }', variables: { id: '123' } }));
    expect(result).not.toBeNull();
    expect(result!.operationType).toBe('mutation');
    expect(result!.operationName).toBe('UpdateUser');
    expect(result!.variables).toEqual({ id: '123' });
  });

  it('detects a subscription', () => {
    const result = detectGraphQL('POST', 'https://api.example.com/graphql',
      JSON.stringify({ query: 'subscription OnMessage { messageAdded { id text } }' }));
    expect(result).not.toBeNull();
    expect(result!.operationType).toBe('subscription');
    expect(result!.operationName).toBe('OnMessage');
  });

  it('detects anonymous query shorthand', () => {
    const result = detectGraphQL('POST', 'https://api.example.com/graphql',
      JSON.stringify({ query: '{ user { id name } }' }));
    expect(result).not.toBeNull();
    expect(result!.operationType).toBe('query');
    expect(result!.operationName).toBeNull();
  });

  it('uses operationName from body if provided', () => {
    const result = detectGraphQL('POST', 'https://api.example.com/graphql',
      JSON.stringify({ query: '{ user { id } }', operationName: 'GetUser' }));
    expect(result!.operationName).toBe('GetUser');
  });

  it('returns null for GET requests', () => {
    expect(detectGraphQL('GET', 'https://api.example.com/graphql', null)).toBeNull();
  });

  it('returns null for non-JSON body', () => {
    expect(detectGraphQL('POST', 'https://api.example.com/graphql', 'not json')).toBeNull();
  });

  it('returns null for JSON without query field', () => {
    expect(detectGraphQL('POST', 'https://api.example.com/api',
      JSON.stringify({ data: 'hello' }))).toBeNull();
  });

  it('returns null for empty query string', () => {
    expect(detectGraphQL('POST', 'https://api.example.com/graphql',
      JSON.stringify({ query: '' }))).toBeNull();
  });

  it('returns null for query that does not look like GraphQL', () => {
    expect(detectGraphQL('POST', 'https://api.example.com/search',
      JSON.stringify({ query: 'SELECT * FROM users' }))).toBeNull();
  });

  it('returns null for null body', () => {
    expect(detectGraphQL('POST', 'https://api.example.com/graphql', null)).toBeNull();
  });

  it('parses variables correctly', () => {
    const result = detectGraphQL('POST', 'https://api.example.com/graphql',
      JSON.stringify({ query: 'query Foo { foo }', variables: { bar: 42, baz: 'test' } }));
    expect(result!.variables).toEqual({ bar: 42, baz: 'test' });
  });

  it('returns null variables when not provided', () => {
    const result = detectGraphQL('POST', 'https://api.example.com/graphql',
      JSON.stringify({ query: 'query Foo { foo }' }));
    expect(result!.variables).toBeNull();
  });
});

describe('formatGraphQLQuery', () => {
  it('formats a single-line query', () => {
    const result = formatGraphQLQuery('query GetUser { user { id name } }');
    expect(result).toContain('\n');
  });

  it('preserves already-formatted queries', () => {
    const formatted = 'query GetUser {\n  user {\n    id\n    name\n  }\n}';
    expect(formatGraphQLQuery(formatted)).toBe(formatted);
  });

  it('handles empty string', () => {
    expect(formatGraphQLQuery('')).toBe('');
  });
});
