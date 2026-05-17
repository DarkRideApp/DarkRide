import React, { useState } from 'react';

export interface ToolCallCardProps {
  toolName: string;
  input: Record<string, any>;
  output?: string;
  durationMs?: number;
  isRunning: boolean;
}

export function ToolCallCard({ toolName, input, output, durationMs, isRunning }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);

  const canExpand = !isRunning && !!output;
  const outputPreview = output ? (output.length > 80 ? output.slice(0, 80) + '...' : output) : '';

  return (
    <div className="tool-call-card" data-testid="tool-call-card">
      <div
        className={`tool-call-header${canExpand ? ' tool-call-expandable' : ''}`}
        onClick={canExpand ? () => setExpanded(!expanded) : undefined}
        data-testid="tool-call-header"
        style={canExpand ? { cursor: 'pointer' } : undefined}
      >
        <span className="tool-call-icon" data-testid="tool-call-icon">
          {isRunning ? (
            <span className="spinner spinner-sm" data-testid="tool-call-spinner" />
          ) : (
            <span className="tool-call-check" data-testid="tool-call-check">&#10003;</span>
          )}
        </span>
        <code className="tool-call-name" data-testid="tool-call-name">{toolName}</code>
        {durationMs !== undefined && (
          <span className="tool-call-duration" data-testid="tool-call-duration">{durationMs}ms</span>
        )}
        {outputPreview && !expanded && !isRunning && (
          <span className="tool-call-preview" data-testid="tool-call-preview">{outputPreview}</span>
        )}
        {canExpand && (
          <span className="tool-call-chevron" data-testid="tool-call-chevron">
            {expanded ? '\u25B2' : '\u25BC'}
          </span>
        )}
      </div>
      {expanded && output && (
        <pre className="tool-call-output" data-testid="tool-call-output">{output}</pre>
      )}
    </div>
  );
}
