import { createContext } from 'react';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  persistent: boolean;   // if true, must be dismissed manually
  createdAt: number;
}

export interface ToastContextValue {
  addToast: (type: ToastType, message: string, options?: { persistent?: boolean }) => void;
  success: (message: string) => void;
  error: (message: string, persistent?: boolean) => void;
  warning: (message: string) => void;
  info: (message: string) => void;
  removeToast: (id: string) => void;
}

/* ------------------------------------------------------------------ */
/*  Context                                                            */
/* ------------------------------------------------------------------ */

export const ToastContext = createContext<ToastContextValue | null>(null);
