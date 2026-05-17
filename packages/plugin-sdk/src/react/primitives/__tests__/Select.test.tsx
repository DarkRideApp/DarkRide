// packages/plugin-sdk/src/react/primitives/__tests__/Select.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Select } from '../Select';

describe('Select', () => {
  it('renders with default class', () => {
    render(<Select aria-label="picker"><option value="a">A</option></Select>);
    expect(screen.getByLabelText('picker')).toHaveClass('form-select');
  });

  it('applies invalid variant', () => {
    render(<Select aria-label="p" invalid><option>x</option></Select>);
    expect(screen.getByLabelText('p')).toHaveClass('form-select', 'form-select-error');
  });

  it('forwards arbitrary HTML select props', () => {
    render(
      <Select aria-label="p" name="country" defaultValue="us">
        <option value="us">US</option><option value="uk">UK</option>
      </Select>
    );
    expect(screen.getByLabelText('p')).toHaveAttribute('name', 'country');
  });

  it('merges user className', () => {
    render(<Select aria-label="p" className="extra"><option>x</option></Select>);
    expect(screen.getByLabelText('p')).toHaveClass('form-select', 'extra');
  });
});
