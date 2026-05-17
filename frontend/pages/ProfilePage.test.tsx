import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DeveloperToolsSection } from './ProfilePage';

describe('DeveloperToolsSection', () => {
  beforeEach(() => { localStorage.clear(); });

  it('checkbox reflects current setting (unchecked when off)', () => {
    render(<DeveloperToolsSection />);
    const cb = screen.getByLabelText(/slot inspector/i) as HTMLInputElement;
    expect(cb.checked).toBe(false);
  });

  it('checking the box enables the inspector in localStorage', () => {
    render(<DeveloperToolsSection />);
    const cb = screen.getByLabelText(/slot inspector/i) as HTMLInputElement;
    fireEvent.click(cb);
    expect(localStorage.getItem('darkride:devtools:slotInspector')).toBe('1');
    expect(cb.checked).toBe(true);
  });

  it('unchecking the box disables the inspector', () => {
    localStorage.setItem('darkride:devtools:slotInspector', '1');
    render(<DeveloperToolsSection />);
    const cb = screen.getByLabelText(/slot inspector/i) as HTMLInputElement;
    expect(cb.checked).toBe(true);
    fireEvent.click(cb);
    expect(localStorage.getItem('darkride:devtools:slotInspector')).toBeNull();
  });

  it('mentions the keyboard shortcut', () => {
    render(<DeveloperToolsSection />);
    expect(screen.getByText(/shift\+alt\+s/i)).toBeInTheDocument();
  });
});
