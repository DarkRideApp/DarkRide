import React, { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

export function Modal({ title, onClose, children, footer, className }: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  // A layout effect, so the dialog is open in the commit that puts it in the document. A passive effect leaves it
  // closed (and out of the accessibility tree) until a later task, and anything that waits for the title to
  // appear and then reaches for a button can get there first.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
    const handleCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    dialog?.addEventListener('cancel', handleCancel);
    return () => dialog?.removeEventListener('cancel', handleCancel);
  }, [onClose]);

  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === dialogRef.current) {
      onClose();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="modal-dialog"
      onClick={handleBackdropClick}
      data-testid="modal-overlay"
      aria-labelledby="modal-title"
    >
      <div className={`modal${className ? ` ${className}` : ''}`} onClick={e => e.stopPropagation()} data-testid="modal">
        <div className="modal-header">
          <h2 id="modal-title">{title}</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </dialog>
  );
}
