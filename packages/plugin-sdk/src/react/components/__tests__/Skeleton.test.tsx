import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SkeletonLine, SkeletonCard, SkeletonTable } from '../Skeleton';

describe('SkeletonLine', () => {
  it('renders with default dimensions', () => {
    const { container } = render(<SkeletonLine />);
    const el = container.querySelector('.skeleton-line')!;
    expect(el).toBeInTheDocument();
    expect(el).toHaveClass('skeleton');
    expect(el).toHaveStyle({ width: '100%', height: '14px' });
  });

  it('renders with custom dimensions', () => {
    const { container } = render(<SkeletonLine width="50%" height={20} />);
    const el = container.querySelector('.skeleton-line')!;
    expect(el).toHaveStyle({ width: '50%', height: '20px' });
  });
});

describe('SkeletonCard', () => {
  it('renders three skeleton lines', () => {
    const { container } = render(<SkeletonCard />);
    expect(container.querySelector('.skeleton-card')).toBeInTheDocument();
    expect(container.querySelectorAll('.skeleton-line')).toHaveLength(3);
  });
});

describe('SkeletonTable', () => {
  it('renders default 5 rows and 4 columns', () => {
    const { container } = render(<SkeletonTable />);
    expect(container.querySelector('.skeleton-table')).toBeInTheDocument();
    expect(container.querySelector('.skeleton-table-header')).toBeInTheDocument();
    expect(container.querySelectorAll('.skeleton-table-row')).toHaveLength(5);
    // 4 columns in header + 5 rows * 4 columns = 24 skeleton lines total
    expect(container.querySelectorAll('.skeleton-line')).toHaveLength(4 + 5 * 4);
  });

  it('renders custom row and column counts', () => {
    const { container } = render(<SkeletonTable rows={3} columns={6} />);
    expect(container.querySelectorAll('.skeleton-table-row')).toHaveLength(3);
    // 6 header + 3*6 body = 24
    expect(container.querySelectorAll('.skeleton-line')).toHaveLength(6 + 3 * 6);
  });

  it('has skeleton animation class on all lines', () => {
    const { container } = render(<SkeletonTable rows={2} columns={2} />);
    const lines = container.querySelectorAll('.skeleton-line');
    lines.forEach(line => {
      expect(line).toHaveClass('skeleton');
    });
  });
});
