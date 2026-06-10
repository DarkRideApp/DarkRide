import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SearchInput } from '../SearchInput';

describe('SearchInput', () => {
  it('renders with placeholder and calls onChange', () => {
    const onChange = vi.fn();
    render(<SearchInput value="" onChange={onChange} placeholder="Search apps…" />);
    const input = screen.getByPlaceholderText('Search apps…');
    fireEvent.change(input, { target: { value: 'disney' } });
    expect(onChange).toHaveBeenCalledWith('disney');
  });

  it('shows a clear button only when non-empty, which clears', () => {
    const onChange = vi.fn();
    const { rerender } = render(<SearchInput value="" onChange={onChange} />);
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
    rerender(<SearchInput value="disney" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(onChange).toHaveBeenCalledWith('');
  });
});
