import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon?: ReactNode;
  message: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, message, description, action }: EmptyStateProps) {
  return (
    <div className="empty-state" data-testid="empty-state">
      {icon && <div className="empty-icon">{icon}</div>}
      <div className="empty-message">{message}</div>
      {description && <div className="empty-description">{description}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}
