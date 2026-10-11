import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SidePanel } from './SidePanel';
import type { PipelineGraph } from '../../../backend/services/ai-jobs/types';

const agentNode = {
  id: 'agent-overview',
  config: { kind: 'AgentCall' as const, tier: 'High', instructionTemplate: 'Analyze {{trigger.appName}}.', toolAllowlist: ['get_apk_overview'] },
};
const triggerSchema = [{ field: 'appName', type: 'string', description: 'x' }];
const emptyGraph: PipelineGraph = { nodes: [agentNode], edges: [] };

describe('SidePanel — AgentCall', () => {
  it('shows the instruction template in an editable textarea', () => {
    render(<SidePanel node={agentNode} graph={emptyGraph} triggerSchema={triggerSchema} onClose={() => {}} onSave={() => {}} />);
    expect(screen.getByRole('textbox', { name: /instruction template/i })).toHaveValue('Analyze {{trigger.appName}}.');
  });

  it('inserting a variable chip with no prior focus appends it at the end, not the start', () => {
    const onSave = vi.fn();
    render(<SidePanel node={agentNode} graph={emptyGraph} triggerSchema={triggerSchema} onClose={() => {}} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /trigger\.appName/i }));
    const textarea = screen.getByRole('textbox', { name: /instruction template/i }) as HTMLTextAreaElement;
    expect(textarea.value).toBe('Analyze {{trigger.appName}}.{{trigger.appName}}');
    expect(onSave).toHaveBeenCalledWith('agent-overview', { instructionTemplate: 'Analyze {{trigger.appName}}.{{trigger.appName}}' });
  });

  it('inserting a variable chip while the textarea is focused inserts at the real cursor position', () => {
    const onSave = vi.fn();
    render(<SidePanel node={agentNode} graph={emptyGraph} triggerSchema={triggerSchema} onClose={() => {}} onSave={onSave} />);
    const textarea = screen.getByRole('textbox', { name: /instruction template/i }) as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(8, 8);
    fireEvent.click(screen.getByRole('button', { name: /trigger\.appName/i }));
    expect(textarea.value).toBe('Analyze {{trigger.appName}}{{trigger.appName}}.');
    expect(onSave).toHaveBeenCalledWith('agent-overview', { instructionTemplate: 'Analyze {{trigger.appName}}{{trigger.appName}}.' });
  });

  it('closing calls onClose', () => {
    const onClose = vi.fn();
    render(<SidePanel node={agentNode} graph={emptyGraph} triggerSchema={triggerSchema} onClose={onClose} onSave={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes from the Escape key', () => {
    const onClose = vi.fn();
    render(<SidePanel node={agentNode} graph={emptyGraph} triggerSchema={triggerSchema} onClose={onClose} onSave={() => {}} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows a delete-node button that calls onDeleteNode with the node id', () => {
    const onDeleteNode = vi.fn();
    render(<SidePanel node={agentNode} graph={emptyGraph} triggerSchema={triggerSchema} onClose={() => {}} onSave={() => {}} onDeleteNode={onDeleteNode} />);
    fireEvent.click(screen.getByRole('button', { name: /delete node/i }));
    expect(onDeleteNode).toHaveBeenCalledWith('agent-overview');
  });

  it('shows the node kind and id as metadata, and the name field defaulting to the kind label when unset', () => {
    render(<SidePanel node={agentNode} graph={emptyGraph} triggerSchema={triggerSchema} onClose={() => {}} onSave={() => {}} />);
    expect(screen.getByLabelText(/node name/i)).toHaveValue('Agent Call');
    expect(screen.getByText(/agent-overview/)).toBeInTheDocument();
  });

  it('renaming calls onRename with the node id and new name', () => {
    const onRename = vi.fn();
    render(<SidePanel node={agentNode} graph={emptyGraph} triggerSchema={triggerSchema} onClose={() => {}} onSave={() => {}} onRename={onRename} />);
    fireEvent.change(screen.getByLabelText(/node name/i), { target: { value: 'Overview Agent' } });
    expect(onRename).toHaveBeenCalledWith('agent-overview', 'Overview Agent');
  });

  it('shows an existing label as the name field value instead of the kind default', () => {
    const named = { ...agentNode, label: 'Overview Agent' };
    render(<SidePanel node={named} graph={emptyGraph} triggerSchema={triggerSchema} onClose={() => {}} onSave={() => {}} />);
    expect(screen.getByLabelText(/node name/i)).toHaveValue('Overview Agent');
  });
});

describe('SidePanel — Trigger', () => {
  const triggerNode = {
    id: 'trigger-full',
    config: { kind: 'Trigger' as const, expandFn: 'apk-analysis/apk-context', outputSchema: [{ field: 'appName', type: 'string', description: 'Display name' }] },
  };
  const graph: PipelineGraph = { nodes: [triggerNode], edges: [] };

  it('edits the expand function name', () => {
    const onSave = vi.fn();
    render(<SidePanel node={triggerNode} graph={graph} triggerSchema={triggerSchema} onClose={() => {}} onSave={onSave} />);
    const input = screen.getByDisplayValue('apk-analysis/apk-context');
    fireEvent.change(input, { target: { value: 'custom/expand' } });
    expect(onSave).toHaveBeenCalledWith('trigger-full', { expandFn: 'custom/expand', outputSchema: triggerNode.config.outputSchema });
  });

  it('adds a new output schema field', () => {
    const onSave = vi.fn();
    render(<SidePanel node={triggerNode} graph={graph} triggerSchema={triggerSchema} onClose={() => {}} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /add field/i }));
    expect(onSave).toHaveBeenCalledWith('trigger-full', {
      expandFn: 'apk-analysis/apk-context',
      outputSchema: [...triggerNode.config.outputSchema, { field: '', type: '', description: '' }],
    });
  });

  it('removes an output schema field', () => {
    const onSave = vi.fn();
    render(<SidePanel node={triggerNode} graph={graph} triggerSchema={triggerSchema} onClose={() => {}} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /remove field/i }));
    expect(onSave).toHaveBeenCalledWith('trigger-full', { expandFn: 'apk-analysis/apk-context', outputSchema: [] });
  });
});

describe('SidePanel — Sink', () => {
  const sinkNode = {
    id: 'sink-report',
    config: { kind: 'Sink' as const, writeFn: 'apk-analysis/write-full-document', from: 'report' },
  };
  const graph: PipelineGraph = {
    nodes: [{ id: 'report', config: { kind: 'Report', sections: [] } }, sinkNode],
    edges: [{ from: 'report', to: 'sink-report' }],
  };

  it('picks the write function from the known registry, with current value selected', () => {
    render(<SidePanel node={sinkNode} graph={graph} triggerSchema={triggerSchema} onClose={() => {}} onSave={() => {}} />);
    expect(screen.getByLabelText(/write function/i)).toHaveValue('apk-analysis/write-full-document');
  });

  it('offers only direct predecessors as the from option', () => {
    render(<SidePanel node={sinkNode} graph={graph} triggerSchema={triggerSchema} onClose={() => {}} onSave={() => {}} />);
    const fromSelect = screen.getByLabelText(/^from/i) as HTMLSelectElement;
    expect(Array.from(fromSelect.options).map(o => o.value)).toEqual(['', 'report']);
    expect(fromSelect.value).toBe('report');
  });

  it('switching write function to write-section calls onSave with the new writeFn', () => {
    const onSave = vi.fn();
    render(<SidePanel node={sinkNode} graph={graph} triggerSchema={triggerSchema} onClose={() => {}} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText(/write function/i), { target: { value: 'apk-analysis/write-section' } });
    expect(onSave).toHaveBeenCalledWith('sink-report', expect.objectContaining({ writeFn: 'apk-analysis/write-section' }));
  });

  it('hides the Section title field for write-full-document (it only reads from)', () => {
    render(<SidePanel node={sinkNode} graph={graph} triggerSchema={triggerSchema} onClose={() => {}} onSave={() => {}} />);
    expect(screen.queryByLabelText(/section title/i)).not.toBeInTheDocument();
  });

  it('shows the Section title field for write-section, with a description of its destination', () => {
    const diffNode = { id: 'sink-diff', config: { kind: 'Sink' as const, writeFn: 'apk-analysis/write-section', from: 'report', section: 'Diff Summary' } };
    render(<SidePanel node={diffNode} graph={graph} triggerSchema={triggerSchema} onClose={() => {}} onSave={() => {}} />);
    expect(screen.getByLabelText(/section title/i)).toHaveValue('Diff Summary');
    expect(screen.getByText(/writes the connected step's output into one named section/i)).toBeInTheDocument();
  });

  it('describes where write-full-document\'s output lands', () => {
    render(<SidePanel node={sinkNode} graph={graph} triggerSchema={triggerSchema} onClose={() => {}} onSave={() => {}} />);
    expect(screen.getByText(/writes every section from the connected report/i)).toBeInTheDocument();
  });
});

describe('SidePanel — Report (editable)', () => {
  const reportNode = {
    id: 'report',
    config: { kind: 'Report' as const, sections: [{ title: 'Overview', from: 'agent-overview' }, { title: 'Bypass Script', from: 'agent-bypass' }] },
  };
  const graph: PipelineGraph = {
    nodes: [
      { id: 'agent-overview', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: [], instructionTemplate: '' } },
      { id: 'agent-bypass', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: [], instructionTemplate: '' } },
      reportNode,
    ],
    edges: [{ from: 'agent-overview', to: 'report' }, { from: 'agent-bypass', to: 'report' }],
  };

  it('lists sections in declared order with their title and source', () => {
    render(<SidePanel node={reportNode} graph={graph} triggerSchema={triggerSchema} onClose={() => {}} onSave={() => {}} />);
    const rows = screen.getAllByTestId('report-section-row');
    expect(rows).toHaveLength(2);
    const titleInputs = screen.getAllByPlaceholderText('Section title');
    expect(titleInputs.map(i => (i as HTMLInputElement).value)).toEqual(['Overview', 'Bypass Script']);
  });

  it('editing a section title saves the full sections array', () => {
    const onSave = vi.fn();
    render(<SidePanel node={reportNode} graph={graph} triggerSchema={triggerSchema} onClose={() => {}} onSave={onSave} />);
    fireEvent.change(screen.getAllByPlaceholderText('Section title')[0], { target: { value: 'Summary' } });
    expect(onSave).toHaveBeenCalledWith('report', {
      sections: [{ title: 'Summary', from: 'agent-overview' }, { title: 'Bypass Script', from: 'agent-bypass' }],
    });
  });

  it('adding a section appends a blank row defaulting to the first predecessor', () => {
    const onSave = vi.fn();
    render(<SidePanel node={reportNode} graph={graph} triggerSchema={triggerSchema} onClose={() => {}} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /add section/i }));
    expect(onSave).toHaveBeenCalledWith('report', {
      sections: [...reportNode.config.sections, { title: '', from: 'agent-overview' }],
    });
  });

  it('removing a section drops only that row', () => {
    const onSave = vi.fn();
    render(<SidePanel node={reportNode} graph={graph} triggerSchema={triggerSchema} onClose={() => {}} onSave={onSave} />);
    fireEvent.click(screen.getAllByRole('button', { name: /remove section/i })[0]);
    expect(onSave).toHaveBeenCalledWith('report', { sections: [{ title: 'Bypass Script', from: 'agent-bypass' }] });
  });
});

describe('SidePanel — Transform / Branch / ForEach (unregistered primitives)', () => {
  const graph: PipelineGraph = { nodes: [], edges: [] };

  it('Transform: edits fn and discloses that nothing is registered', () => {
    const node = { id: 'transform-1', config: { kind: 'Transform' as const, fn: '' } };
    const onSave = vi.fn();
    render(<SidePanel node={node} graph={graph} triggerSchema={triggerSchema} onClose={() => {}} onSave={onSave} />);
    fireEvent.change(screen.getByRole('textbox', { name: /transform function/i }), { target: { value: 'my/fn' } });
    expect(onSave).toHaveBeenCalledWith('transform-1', { fn: 'my/fn' });
    expect(screen.getByText(/no transform functions are registered/i)).toBeInTheDocument();
  });

  it('Branch: edits predicate and edge labels', () => {
    const node = { id: 'branch-1', config: { kind: 'Branch' as const, predicate: '', edges: ['yes', 'no'] } };
    const onSave = vi.fn();
    render(<SidePanel node={node} graph={graph} triggerSchema={triggerSchema} onClose={() => {}} onSave={onSave} />);
    expect(screen.getByDisplayValue('yes, no')).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue('yes, no'), { target: { value: 'yes, no, maybe' } });
    expect(onSave).toHaveBeenCalledWith('branch-1', { edges: ['yes', 'no', 'maybe'] });
  });

  it('ForEach: edits itemFn and discloses that nothing is registered', () => {
    const node = { id: 'foreach-1', config: { kind: 'ForEach' as const, itemFn: '' } };
    const onSave = vi.fn();
    render(<SidePanel node={node} graph={graph} triggerSchema={triggerSchema} onClose={() => {}} onSave={onSave} />);
    fireEvent.change(screen.getByRole('textbox', { name: /per-item function/i }), { target: { value: 'my/item-fn' } });
    expect(onSave).toHaveBeenCalledWith('foreach-1', { itemFn: 'my/item-fn' });
    expect(screen.getByText(/no foreach item functions are registered/i)).toBeInTheDocument();
  });
});
