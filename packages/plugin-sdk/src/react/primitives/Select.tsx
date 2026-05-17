// packages/plugin-sdk/src/react/primitives/Select.tsx
import { forwardRef } from 'react';
import type { SelectHTMLAttributes } from 'react';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { invalid, className, children, ...rest },
  ref,
) {
  const classes = ['form-select'];
  if (invalid) classes.push('form-select-error');
  if (className) classes.push(className);
  return <select ref={ref} className={classes.join(' ')} {...rest}>{children}</select>;
});
