// packages/plugin-sdk/src/react/primitives/Button.tsx
import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, className, children, ...rest },
  ref,
) {
  const classes = ['btn'];
  if (variant) classes.push(`btn-${variant}`);
  if (size && size !== 'md') classes.push(`btn-${size}`); // md is the default; no class needed
  if (className) classes.push(className);
  return (
    <button ref={ref} className={classes.join(' ')} {...rest}>
      {children}
    </button>
  );
});
