// packages/plugin-sdk/src/react/primitives/__tests__/Textarea.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Textarea } from '../Textarea';

describe('Textarea', () => {
  it('renders with default class', () => {
    render(<Textarea placeholder="x" />);
    expect(screen.getByPlaceholderText('x')).toHaveClass('form-textarea');
  });

  it('applies invalid variant', () => {
    render(<Textarea placeholder="x" invalid />);
    expect(screen.getByPlaceholderText('x')).toHaveClass('form-textarea', 'form-textarea-error');
  });

  it('forwards arbitrary HTML textarea props', () => {
    render(<Textarea placeholder="x" rows={5} maxLength={100} />);
    const el = screen.getByPlaceholderText('x');
    expect(el).toHaveAttribute('rows', '5');
    expect(el).toHaveAttribute('maxLength', '100');
  });

  it('merges user className', () => {
    render(<Textarea placeholder="x" className="extra" />);
    expect(screen.getByPlaceholderText('x')).toHaveClass('form-textarea', 'extra');
  });
});
