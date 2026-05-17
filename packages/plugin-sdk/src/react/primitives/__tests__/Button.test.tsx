// packages/plugin-sdk/src/react/primitives/__tests__/Button.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button } from '../Button';

describe('Button', () => {
  it('renders with default class names', () => {
    render(<Button>Click me</Button>);
    const btn = screen.getByRole('button', { name: 'Click me' });
    expect(btn).toHaveClass('btn');
  });

  it('applies variant class names', () => {
    const { rerender } = render(<Button variant="primary">x</Button>);
    expect(screen.getByRole('button')).toHaveClass('btn', 'btn-primary');

    rerender(<Button variant="danger">x</Button>);
    expect(screen.getByRole('button')).toHaveClass('btn', 'btn-danger');
  });

  it('applies size class names', () => {
    render(<Button size="sm">x</Button>);
    expect(screen.getByRole('button')).toHaveClass('btn', 'btn-sm');
  });

  it('forwards arbitrary HTML button props', () => {
    render(<Button type="submit" disabled aria-label="submit">x</Button>);
    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('type', 'submit');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-label', 'submit');
  });

  it('merges user-provided className with built-in classes', () => {
    render(<Button className="extra-class">x</Button>);
    const btn = screen.getByRole('button');
    expect(btn).toHaveClass('btn', 'extra-class');
  });
});
