import React, { useState, useEffect, useRef } from 'react';
import { Wand2 } from 'lucide-react';

export interface MatchedRule {
  id: number;
  name: string;
  phase: string;
  actionsApplied: string[];
}

interface RuleAttributionProps {
  rules: MatchedRule[];
}

export function RuleAttribution({ rules }: RuleAttributionProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [open]);

  if (!rules || rules.length === 0) return null;

  return (
    <span className="rule-attribution" ref={containerRef}>
      <span
        className="rule-attribution-badge"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(prev => !prev);
        }}
        title={`Modified by ${rules.length} rule${rules.length !== 1 ? 's' : ''}`}
        data-testid="rule-attribution-badge"
      >
        <Wand2 size={14} />
      </span>
      {open && (
        <span className="rule-attribution-popover" data-testid="rule-attribution-popover">
          {rules.map((rule, i) => (
            <div key={i} className="rule-attribution-item">
              <span className="rule-name">{rule.name || `Rule #${rule.id}`}</span>
              <span className="rule-phase">{rule.phase}</span>
              {rule.actionsApplied.length > 0 && (
                <div className="rule-actions">{rule.actionsApplied.join(', ')}</div>
              )}
            </div>
          ))}
        </span>
      )}
    </span>
  );
}
