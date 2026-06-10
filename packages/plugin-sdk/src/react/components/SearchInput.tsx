import React from 'react';
import { Search, X } from 'lucide-react';

export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  style?: React.CSSProperties;
  'data-testid'?: string;
}

/**
 * Search field with a leading icon and a clear button.
 * Styling via host classes `.search-input` (wrapper) and `.form-input`.
 */
export function SearchInput({ value, onChange, placeholder, autoFocus, style, 'data-testid': testId }: SearchInputProps) {
  return (
    <div className="search-input" style={style}>
      <Search size={14} className="search-input-icon" aria-hidden="true" />
      <input
        type="text"
        className="form-input search-input-field"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        data-testid={testId}
      />
      {value && (
        <button type="button" className="search-input-clear" aria-label="Clear search" onClick={() => onChange('')}>
          <X size={13} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
