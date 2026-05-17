import React, { useEffect, useState } from 'react';
import { useWebSocket, LoadingSpinner } from '@darkrideapp/plugin-sdk/react';

export type InstallProgressPhase =
  | 'installing'
  | 'verifying'
  | 'recording'
  | 'migrating'
  | 'starting'
  | 'done';

interface ProgressEvent {
  type: 'plugin-install-progress';
  plugin: string;
  phase: InstallProgressPhase;
  message: string;
}

const PHASE_ORDER: InstallProgressPhase[] = ['installing', 'verifying', 'recording', 'done'];

const PHASE_LABELS: Record<InstallProgressPhase, string> = {
  installing: 'Downloading + installing package',
  verifying: 'Verifying signature + content',
  recording: 'Registering with plugin manager',
  migrating: 'Applying plugin migrations',
  starting: 'Starting plugin',
  done: 'Done',
};

interface PluginInstallProgressModalProps {
  /** The plugin name (matches the `plugin` field on progress events). */
  pluginName: string;
  /** Initial event that opened the modal, if any (useful when the first event
   *  fired before the subscriber attached — passed by the caller). */
  initialEvent?: ProgressEvent;
  /** Called once the modal observes a 'done' phase OR the user dismisses. */
  onClose: () => void;
}

export function PluginInstallProgressModal({ pluginName, initialEvent, onClose }: PluginInstallProgressModalProps) {
  const ws = useWebSocket();
  const [phase, setPhase] = useState<InstallProgressPhase>(initialEvent?.phase ?? 'installing');
  const [message, setMessage] = useState<string>(initialEvent?.message ?? `Installing "${pluginName}"…`);
  const [completed, setCompleted] = useState<Set<InstallProgressPhase>>(new Set());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    return ws.subscribe('plugin-install-progress', (event: ProgressEvent) => {
      if (event.plugin !== pluginName) return;
      setPhase(event.phase);
      setMessage(event.message);
      if (event.phase === 'done') {
        // If the message reads like a failure, surface it as such.
        if (/fail|refusing|refuse|error/i.test(event.message)) {
          setErrorMessage(event.message);
        }
        // Don't auto-dismiss — let the user read the result.
      } else {
        setCompleted(prev => {
          const next = new Set(prev);
          next.add(event.phase);
          return next;
        });
      }
    });
  }, [ws, pluginName]);

  const isDone = phase === 'done';

  return (
    <div className="modal-overlay" onClick={isDone ? onClose : undefined}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <h3 style={{ marginTop: 0, marginBottom: 16 }}>Installing "{pluginName}"</h3>

        <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {PHASE_ORDER.map(p => {
            const isCurrent = p === phase;
            const isComplete = completed.has(p) || (PHASE_ORDER.indexOf(p) < PHASE_ORDER.indexOf(phase));
            const isPending = !isCurrent && !isComplete;
            const tone = errorMessage && isCurrent ? 'var(--danger, #ef4444)'
              : isComplete ? 'var(--success, #22c55e)'
              : isCurrent ? 'var(--accent, #4a9eff)'
              : 'var(--text-muted)';
            return (
              <li
                key={p}
                data-testid={`install-phase-${p}`}
                style={{ display: 'flex', alignItems: 'center', gap: 10, color: isPending ? 'var(--text-muted)' : 'var(--text-primary)' }}
              >
                <span style={{
                  width: 18, height: 18, display: 'inline-flex',
                  alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  {isCurrent && !isDone && !errorMessage ? (
                    <LoadingSpinner />
                  ) : (
                    <span style={{
                      width: 10, height: 10, borderRadius: '50%',
                      background: tone,
                    }} />
                  )}
                </span>
                <span style={{ fontSize: 13 }}>
                  {PHASE_LABELS[p]}
                </span>
              </li>
            );
          })}
        </ol>

        <p
          data-testid="install-progress-message"
          style={{
            marginTop: 16,
            fontSize: 13,
            color: errorMessage ? 'var(--danger, #ef4444)' : 'var(--text-secondary)',
            minHeight: 18,
          }}
        >
          {errorMessage ?? message}
        </p>

        {isDone && (
          <div className="modal-footer" style={{ marginTop: 16 }}>
            <button type="button" className="btn btn-primary" onClick={onClose} autoFocus>
              {errorMessage ? 'Close' : 'OK'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
