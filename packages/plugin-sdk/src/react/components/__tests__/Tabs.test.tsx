import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Tabs } from '../Tabs';

const items = [
  { key: 'overview', label: 'Overview' },
  { key: 'findings', label: 'Findings', count: 23 },
  { key: 'notes', label: 'Notes', dot: true },
];

describe('Tabs', () => {
  it('renders tablist with aria roles and active state', () => {
    render(<Tabs items={items} active="overview" onChange={() => {}} />);
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
  });

  it('renders count badge and dot', () => {
    render(<Tabs items={items} active="overview" onChange={() => {}} />);
    expect(screen.getByText('23')).toBeInTheDocument();
    expect(screen.getByTestId('tab-dot-notes')).toBeInTheDocument();
  });

  it('calls onChange on click', () => {
    const onChange = vi.fn();
    render(<Tabs items={items} active="overview" onChange={onChange} />);
    fireEvent.click(screen.getByRole('tab', { name: /Findings/ }));
    expect(onChange).toHaveBeenCalledWith('findings');
  });

  it('moves selection with arrow keys and wraps', () => {
    const onChange = vi.fn();
    render(<Tabs items={items} active="overview" onChange={onChange} />);
    const first = screen.getAllByRole('tab')[0];
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('findings');
    fireEvent.keyDown(first, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenCalledWith('notes'); // wraps backwards
  });

  it('wraps forward from the last tab and supports Home/End', () => {
    const onChange = vi.fn();
    render(<Tabs items={items} active="notes" onChange={onChange} />);
    const tabs = screen.getAllByRole('tab');
    fireEvent.keyDown(tabs[2], { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('overview'); // wraps forward
    fireEvent.keyDown(tabs[2], { key: 'Home' });
    expect(onChange).toHaveBeenCalledWith('overview');
    fireEvent.keyDown(tabs[0], { key: 'End' });
    expect(onChange).toHaveBeenCalledWith('notes');
  });

  it('renders an icon inside the tab', () => {
    const withIcon = [{ key: 'a', label: 'Alpha', icon: <span data-testid="my-icon" /> }];
    render(<Tabs items={withIcon} active="a" onChange={() => {}} />);
    expect(screen.getByTestId('my-icon')).toBeInTheDocument();
  });

  it('renders trailing content', () => {
    render(<Tabs items={items} active="overview" onChange={() => {}} trailing={<button>Extra</button>} />);
    expect(screen.getByRole('button', { name: 'Extra' })).toBeInTheDocument();
  });

  it('renders an empty tablist without crashing when items is empty', () => {
    render(<Tabs items={[]} active="" onChange={() => {}} />);
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });

  it('gives tab buttons type="button" so they never submit a surrounding form', () => {
    render(<Tabs items={items} active="overview" onChange={() => {}} />);
    for (const tab of screen.getAllByRole('tab')) expect(tab).toHaveAttribute('type', 'button');
  });
});
