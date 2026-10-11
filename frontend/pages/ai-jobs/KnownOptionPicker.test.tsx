import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { KnownOptionPicker } from './KnownOptionPicker';

const options = [
  { value: 'a', description: 'Option A' },
  { value: 'b', description: 'Option B' },
];

describe('KnownOptionPicker', () => {
  it('shows the known value selected, with its description', () => {
    render(<KnownOptionPicker id="p" label="Pick one" options={options} value="a" onPick={() => {}} onCustomType={() => {}} />);
    expect(screen.getByLabelText('Pick one')).toHaveValue('a');
    expect(screen.getByText('Option A')).toBeInTheDocument();
  });

  it('calls onPick with the picked value, not Custom\'s sentinel', () => {
    const onPick = vi.fn();
    render(<KnownOptionPicker id="p" label="Pick one" options={options} value="a" onPick={onPick} onCustomType={() => {}} />);
    fireEvent.change(screen.getByLabelText('Pick one'), { target: { value: 'b' } });
    expect(onPick).toHaveBeenCalledWith('b');
  });

  it('selecting Custom calls onPick with an empty string and shows the custom text field', () => {
    const onPick = vi.fn();
    render(<KnownOptionPicker id="p" label="Pick one" options={options} value="a" onPick={onPick} onCustomType={() => {}} customPlaceholder="custom value" />);
    fireEvent.change(screen.getByLabelText('Pick one'), { target: { value: '__custom__' } });
    expect(onPick).toHaveBeenCalledWith('');
    expect(screen.getByPlaceholderText('custom value')).toBeInTheDocument();
  });

  it('an unrecognized value shows as Custom with its own editable text field', () => {
    const onCustomType = vi.fn();
    render(<KnownOptionPicker id="p" label="Pick one" options={options} value="my-plugin/thing" onPick={() => {}} onCustomType={onCustomType} customPlaceholder="custom value" />);
    expect(screen.getByLabelText('Pick one')).toHaveValue('__custom__');
    const input = screen.getByPlaceholderText('custom value');
    expect(input).toHaveValue('my-plugin/thing');
    fireEvent.change(input, { target: { value: 'my-plugin/other' } });
    expect(onCustomType).toHaveBeenCalledWith('my-plugin/other');
  });

  it('switching to a different known value after being in Custom mode leaves Custom mode (regression guard for the empty-string-looks-known bug)', () => {
    const onPick = vi.fn();
    const { rerender } = render(<KnownOptionPicker id="p" label="Pick one" options={options} value="" onPick={onPick} onCustomType={() => {}} customPlaceholder="custom value" />);
    fireEvent.change(screen.getByLabelText('Pick one'), { target: { value: '__custom__' } });
    rerender(<KnownOptionPicker id="p" label="Pick one" options={options} value="" onPick={onPick} onCustomType={() => {}} customPlaceholder="custom value" />);
    expect(screen.getByPlaceholderText('custom value')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Pick one'), { target: { value: 'a' } });
    expect(onPick).toHaveBeenLastCalledWith('a');
  });
});
