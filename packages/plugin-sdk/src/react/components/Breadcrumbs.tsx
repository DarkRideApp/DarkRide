import React from 'react';
import { useNavigate } from 'react-router-dom';

interface BreadcrumbItem {
  label: string;
  to?: string;
}

interface BreadcrumbsProps {
  items: BreadcrumbItem[];
}

export function Breadcrumbs({ items }: BreadcrumbsProps) {
  const navigate = useNavigate();

  return (
    <div className="breadcrumbs">
      {items.map((item, index) => (
        <React.Fragment key={index}>
          {index > 0 && <span className="breadcrumb-sep">/</span>}
          {item.to ? (
            <button className="breadcrumb-item" onClick={() => navigate(item.to!)}>
              {item.label}
            </button>
          ) : (
            <span className="breadcrumb-item active">{item.label}</span>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}
