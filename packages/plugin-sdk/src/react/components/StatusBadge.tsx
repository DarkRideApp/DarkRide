import { CheckCircle, XCircle, Circle, Loader, AlertTriangle, MinusCircle, ShieldCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface StatusBadgeProps {
  status: string;
  className?: string;
}

const STATUS_CLASS_MAP: Record<string, string> = {
  online: 'badge-online',
  offline: 'badge-offline',
  success: 'badge-success',
  failed: 'badge-failed',
  error: 'badge-error',
  running: 'badge-running',
  cancelled: 'badge-cancelled',
  warning: 'badge-warning',
  rooted: 'badge-rooted',
};

const STATUS_ICON_MAP: Record<string, LucideIcon> = {
  online: CheckCircle,
  offline: Circle,
  success: CheckCircle,
  failed: XCircle,
  error: XCircle,
  running: Loader,
  cancelled: MinusCircle,
  warning: AlertTriangle,
  rooted: ShieldCheck,
};

export function StatusBadge({ status, className = '' }: StatusBadgeProps) {
  const badgeClass = STATUS_CLASS_MAP[status] || 'badge-offline';
  const Icon = STATUS_ICON_MAP[status] || Circle;
  return (
    <span className={`badge ${badgeClass} ${className}`} data-testid={`badge-${status}`}>
      <Icon size={11} aria-hidden="true" style={{ marginRight: 4, verticalAlign: '-1px' }} />
      {status}
    </span>
  );
}
