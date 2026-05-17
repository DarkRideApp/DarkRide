import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TierPicker } from '../TierPicker';

const TIERS = [
  { id: 1, name: 'High', sortOrder: 0, isHardcoded: true, enabledModelCount: 2, createdAt: 0, updatedAt: 0 },
  { id: 2, name: 'Low', sortOrder: 1, isHardcoded: true, enabledModelCount: 0, createdAt: 0, updatedAt: 0 },
  { id: 3, name: 'Medium', sortOrder: 2, isHardcoded: false, enabledModelCount: 1, createdAt: 0, updatedAt: 0 },
];

describe('TierPicker', () => {
  it('renders all tiers in sort order with (empty) annotation on empty tiers', () => {
    render(<TierPicker tiers={TIERS} value="High" onChange={vi.fn()} label="AI tier" />);
    const select = screen.getByLabelText('AI tier') as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll('option')).map(o => o.textContent);
    expect(options).toEqual(['High', 'Low (empty)', 'Medium']);
  });

  it('fires onChange with the selected tier name', () => {
    const onChange = vi.fn();
    render(<TierPicker tiers={TIERS} value="High" onChange={onChange} label="AI tier" />);
    fireEvent.change(screen.getByLabelText('AI tier'), { target: { value: 'Medium' } });
    expect(onChange).toHaveBeenCalledWith('Medium');
  });
});
