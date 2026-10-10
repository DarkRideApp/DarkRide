import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SidePanel } from './SidePanel';

const agentNode = {
  id: 'agent-overview',
  config: { kind: 'AgentCall' as const, tier: 'High', instructionTemplate: 'Analyze {{trigger.appName}}.', toolAllowlist: ['get_apk_overview'] },
};
const triggerSchema = [{ field: 'appName', type: 'string', description: 'x' }];

describe('SidePanel — AgentCall', () => {
  it('shows the instruction template in an editable textarea', () => {
    render(<SidePanel node={agentNode} triggerSchema={triggerSchema} onClose={() => {}} onSave={() => {}} />);
    expect(screen.getByRole('textbox')).toHaveValue('Analyze {{trigger.appName}}.');
  });

  it('inserting a variable chip with no prior focus appends it at the end, not the start', () => {
    const onSave = vi.fn();
    render(<SidePanel node={agentNode} triggerSchema={triggerSchema} onClose={() => {}} onSave={onSave} />);
    // No fireEvent.focus on the textarea — the panel's close button holds focus on open (the
    // focus-management fix working as intended), so this is the real first-click path.
    fireEvent.click(screen.getByRole('button', { name: /trigger\.appName/i }));
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Analyze {{trigger.appName}}.{{trigger.appName}}');
    expect(onSave).toHaveBeenCalledWith('agent-overview', { instructionTemplate: 'Analyze {{trigger.appName}}.{{trigger.appName}}' });
  });

  it('inserting a variable chip while the textarea is focused inserts at the real cursor position', () => {
    const onSave = vi.fn();
    render(<SidePanel node={agentNode} triggerSchema={triggerSchema} onClose={() => {}} onSave={onSave} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    // Real .focus(), not fireEvent.focus — a synthetic focus event does not move
    // document.activeElement in jsdom, and the component checks activeElement, not just a
    // dispatched event.
    textarea.focus();
    textarea.setSelectionRange(8, 8); // right after "Analyze " in 'Analyze {{trigger.appName}}.'
    fireEvent.click(screen.getByRole('button', { name: /trigger\.appName/i }));
    expect(textarea.value).toBe('Analyze {{trigger.appName}}{{trigger.appName}}.');
    expect(onSave).toHaveBeenCalledWith('agent-overview', { instructionTemplate: 'Analyze {{trigger.appName}}{{trigger.appName}}.' });
  });

  it('closing calls onClose', () => {
    const onClose = vi.fn();
    render(<SidePanel node={agentNode} triggerSchema={triggerSchema} onClose={onClose} onSave={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes from the Escape key', () => {
    const onClose = vi.fn();
    render(<SidePanel node={agentNode} triggerSchema={triggerSchema} onClose={onClose} onSave={() => {}} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('SidePanel — Report', () => {
  const reportNode = {
    id: 'report',
    config: { kind: 'Report' as const, sections: [{ title: 'Overview', from: 'agent-overview' }, { title: 'Bypass Script', from: 'agent-bypass' }] },
  };

  it('lists sections in declared order, numbered', () => {
    render(<SidePanel node={reportNode} triggerSchema={triggerSchema} onClose={() => {}} onSave={() => {}} />);
    const rows = screen.getAllByTestId('report-section-row');
    expect(rows.map(r => r.textContent)).toEqual([expect.stringContaining('1'), expect.stringContaining('2')].map((m, i) => expect.stringContaining(['Overview', 'Bypass Script'][i])));
  });
});
