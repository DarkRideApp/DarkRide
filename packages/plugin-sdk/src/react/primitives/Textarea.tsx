// packages/plugin-sdk/src/react/primitives/Textarea.tsx
import { forwardRef } from 'react';
import type { TextareaHTMLAttributes } from 'react';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, className, ...rest },
  ref,
) {
  const classes = ['form-textarea'];
  if (invalid) classes.push('form-textarea-error');
  if (className) classes.push(className);
  return <textarea ref={ref} className={classes.join(' ')} {...rest} />;
});
