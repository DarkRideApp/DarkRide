// packages/plugin-sdk/src/react/primitives/Input.tsx
import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, className, ...rest },
  ref,
) {
  const classes = ['form-input'];
  if (invalid) classes.push('form-input-error');
  if (className) classes.push(className);
  return <input ref={ref} className={classes.join(' ')} {...rest} />;
});
