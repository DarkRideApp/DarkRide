// packages/plugin-sdk/src/react/primitives/__tests__/Input.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Input } from '../Input';

describe('Input', () => {
  it('renders with default class names', () => {
    render(<Input placeholder="x" />);
    expect(screen.getByPlaceholderText('x')).toHaveClass('form-input');
  });

  it('applies error variant', () => {
    render(<Input invalid placeholder="x" />);
    expect(screen.getByPlaceholderText('x')).toHaveClass('form-input', 'form-input-error');
  });

  it('forwards arbitrary HTML input props', () => {
    render(<Input type="email" required name="email" placeholder="e" />);
    const el = screen.getByPlaceholderText('e');
    expect(el).toHaveAttribute('type', 'email');
    expect(el).toBeRequired();
    expect(el).toHaveAttribute('name', 'email');
  });

  it('merges user className', () => {
    render(<Input className="extra" placeholder="x" />);
    expect(screen.getByPlaceholderText('x')).toHaveClass('form-input', 'extra');
  });
});
