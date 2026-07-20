import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { InterceptScopeEditor } from './InterceptScopeEditor';

function ws() { return { sendRestApi: vi.fn().mockResolvedValue({}) }; }

describe('InterceptScopeEditor', () => {
  it('seeds a blank rule row when disarmed with no rules', () => {
    render(<InterceptScopeEditor ws={ws() as any} config={{ enabled: false, rules: [], phases: ['request', 'response'] }} onClose={() => {}} />);
    expect(screen.getAllByTestId(/^intercept-rule-row-/)).toHaveLength(1);
  });

  it('adds and removes rule rows', () => {
    render(<InterceptScopeEditor ws={ws() as any} config={{ enabled: false, rules: [], phases: ['request'] }} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('intercept-add-rule'));
    expect(screen.getAllByTestId(/^intercept-rule-row-/)).toHaveLength(2);
    fireEvent.click(within(screen.getAllByTestId(/^intercept-rule-row-/)[0]).getByLabelText(/remove rule/i));
    expect(screen.getAllByTestId(/^intercept-rule-row-/)).toHaveLength(1);
  });

  it('arms with the entered rules and closes', () => {
    const w = ws();
    const onClose = vi.fn();
    render(<InterceptScopeEditor ws={w as any} config={{ enabled: false, rules: [], phases: ['request', 'response'] }} onClose={onClose} />);
    fireEvent.change(screen.getByTestId('intercept-rule-host-0'), { target: { value: '*.stripe.com' } });
    fireEvent.click(screen.getByTestId('intercept-arm-apply'));
    expect(w.sendRestApi).toHaveBeenCalledWith('POST', '/v1/intercept/armed',
      expect.objectContaining({ enabled: true, rules: [{ hostname: '*.stripe.com', path: null, method: null }] }));
    expect(onClose).toHaveBeenCalled();
  });

  it('updates the plain-English summary as rules change', () => {
    render(<InterceptScopeEditor ws={ws() as any} config={{ enabled: false, rules: [], phases: ['request'] }} onClose={() => {}} />);
    fireEvent.change(screen.getByTestId('intercept-rule-host-0'), { target: { value: 'api.x.com' } });
    expect(screen.getByTestId('intercept-scope-summary')).toHaveTextContent(/pause requests matching api\.x\.com/i);
  });

  it('shows a disarm button when currently armed', () => {
    const w = ws();
    render(<InterceptScopeEditor ws={w as any} config={{ enabled: true, rules: [{ hostname: 'a.com' }], phases: ['request'] }} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('intercept-disarm'));
    expect(w.sendRestApi).toHaveBeenCalledWith('POST', '/v1/intercept/armed', expect.objectContaining({ enabled: false }));
  });
});
