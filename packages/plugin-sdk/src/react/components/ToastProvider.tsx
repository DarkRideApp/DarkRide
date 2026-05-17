import { useState, useCallback, useRef, useEffect, type ReactNode } from 'react';
import { X, CheckCircle, AlertCircle, AlertTriangle, Info } from 'lucide-react';
import { ToastContext, type Toast, type ToastType } from '../contexts/ToastContext';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const AUTO_DISMISS_MS = 5000;      // success/warning/info auto-dismiss
const MAX_VISIBLE = 5;             // max toasts shown at once

/* ------------------------------------------------------------------ */
/*  Provider                                                           */
/* ------------------------------------------------------------------ */

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const removeToast = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) { clearTimeout(timer); timersRef.current.delete(id); }
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const addToast = useCallback((type: ToastType, message: string, options?: { persistent?: boolean }) => {
    const persistent = options?.persistent ?? (type === 'error');
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const toast: Toast = { id, type, message, persistent, createdAt: Date.now() };

    setToasts(prev => {
      // deduplicate: if same message+type already visible, skip
      if (prev.some(t => t.message === message && t.type === type)) return prev;
      const next = [...prev, toast];
      // trim oldest non-persistent if over limit
      if (next.length > MAX_VISIBLE) {
        const oldest = next.find(t => !t.persistent) ?? next[0];
        const timer = timersRef.current.get(oldest.id);
        if (timer) { clearTimeout(timer); timersRef.current.delete(oldest.id); }
        return next.filter(t => t.id !== oldest.id);
      }
      return next;
    });

    if (!persistent) {
      const timer = setTimeout(() => removeToast(id), AUTO_DISMISS_MS);
      timersRef.current.set(id, timer);
    }
  }, [removeToast]);

  // Cleanup on unmount
  useEffect(() => {
    return () => { timersRef.current.forEach(t => clearTimeout(t)); };
  }, []);

  const success = useCallback((msg: string) => addToast('success', msg), [addToast]);
  const error = useCallback((msg: string, persistent = true) => addToast('error', msg, { persistent }), [addToast]);
  const warning = useCallback((msg: string) => addToast('warning', msg), [addToast]);
  const info = useCallback((msg: string) => addToast('info', msg), [addToast]);

  return (
    <ToastContext.Provider value={{ addToast, success, error, warning, info, removeToast }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={removeToast} />
    </ToastContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/*  Toast Container + Item                                             */
/* ------------------------------------------------------------------ */

const ICON_MAP: Record<ToastType, ReactNode> = {
  success: <CheckCircle size={16} />,
  error: <AlertCircle size={16} />,
  warning: <AlertTriangle size={16} />,
  info: <Info size={16} />,
};

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-container" role="log" aria-live="polite">
      {toasts.map(t => (
        <div key={t.id} className={`toast-item toast-${t.type}`} role="status">
          <span className="toast-icon">{ICON_MAP[t.type]}</span>
          <span className="toast-message">{t.message}</span>
          <button className="toast-close" onClick={() => onDismiss(t.id)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
