import type { ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}

export function Card({ children, className = '', onClick }: CardProps) {
  return (
    <div className={`card ${className}`} onClick={onClick} data-testid="card">
      {children}
    </div>
  );
}

interface StatCardProps {
  value: string | number;
  label: string;
  detail?: string;
  onClick?: () => void;
}

export function StatCard({ value, label, detail, onClick }: StatCardProps) {
  return (
    <div
      className={`card stat-card${onClick ? ' stat-card-clickable' : ''}`}
      data-testid="stat-card"
      onClick={onClick}
      style={onClick ? { cursor: 'pointer' } : undefined}
    >
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {detail && <div className="stat-detail">{detail}</div>}
    </div>
  );
}
