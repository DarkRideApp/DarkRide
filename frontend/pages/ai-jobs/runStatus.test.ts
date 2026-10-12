import { describe, it, expect } from 'vitest';
import { runStatusMessage, displayRunStatus } from './runStatus';

describe('runStatusMessage', () => {
  it('shows the real error text for a failed node', () => {
    expect(runStatusMessage('failed', 'boom: something broke')).toBe('boom: something broke');
  });

  it('falls back to a generic message when a failed node somehow has no error text', () => {
    expect(runStatusMessage('failed', undefined)).toBe('Failed.');
  });

  it('explains a skipped node points at an upstream failure, not its own error', () => {
    expect(runStatusMessage('skipped')).toBe('Skipped — an upstream node failed.');
  });

  it('describes ok, cached, and inactive in plain English', () => {
    expect(runStatusMessage('ok')).toBe('Succeeded.');
    expect(runStatusMessage('cached')).toBe('Reused from a previous run.');
    expect(runStatusMessage('inactive')).toBe('Not part of this run.');
  });
});

describe('displayRunStatus', () => {
  it('reports cached regardless of the underlying status when wasMemoized is true', () => {
    expect(displayRunStatus({ status: 'ok', wasMemoized: true })).toBe('cached');
  });

  it('reports the real status when not memoized', () => {
    expect(displayRunStatus({ status: 'failed', wasMemoized: false })).toBe('failed');
    expect(displayRunStatus({ status: 'skipped' })).toBe('skipped');
  });
});
