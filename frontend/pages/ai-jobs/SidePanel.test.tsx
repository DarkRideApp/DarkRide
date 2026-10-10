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

  it('inserting a variable chip appends it at the cursor and the preview updates', () => {
    const onSave = vi.fn();
    render(<SidePanel node={agentNode} triggerSchema={triggerSchema} onClose={() => {}} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /trigger\.appName/i }));
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toContain('{{trigger.appName}}');
    expect(onSave).toHaveBeenCalledWith('agent-overview', expect.objectContaining({ instructionTemplate: expect.stringContaining('{{trigger.appName}}') }));
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
