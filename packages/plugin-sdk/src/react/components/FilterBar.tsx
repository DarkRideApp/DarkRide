import React, { useId } from 'react';
import type { ReactNode, ReactElement } from 'react';

interface FilterBarProps {
  children: ReactNode;
}

export function FilterBar({ children }: FilterBarProps) {
  return <div className="filter-bar" data-testid="filter-bar">{children}</div>;
}

interface FilterFieldProps {
  label: string;
  children: ReactNode;
}

export function FilterField({ label, children }: FilterFieldProps) {
  const id = useId();
  const fieldId = `filter-${id}`;
  const child = React.Children.only(children) as ReactElement;
  const boundChild = React.cloneElement(child, { id: fieldId } as any);
  return (
    <div className="form-group">
      <label htmlFor={fieldId}>{label}</label>
      {boundChild}
    </div>
  );
}
