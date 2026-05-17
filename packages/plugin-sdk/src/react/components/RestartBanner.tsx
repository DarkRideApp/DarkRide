import { useContext } from 'react';
import { useRestartRequired } from '../hooks/useRestartRequired';
import { WebSocketContext } from '../contexts/WebSocketContext';
import { AuthContext } from '../contexts/AuthContext';

const RESTART_SCOPE = 'core.plugins:manage';

export function RestartBanner() {
  const { required, reason } = useRestartRequired();
  const ws = useContext(WebSocketContext);
  const auth = useContext(AuthContext);
  if (!required) return null;
  const canRestart = auth?.hasScope?.(RESTART_SCOPE) ?? false;

  const handleRestart = () => {
    if (!ws) return;
    ws.sendRestApi('POST', '/v1/system/restart');
    // After-effects (overlay etc.) are handled elsewhere (App.tsx) via the
    // system:restarting WS event broadcast by the backend.
  };

  return (
    <div className="restart-banner" role="alert">
      <div className="restart-banner-content">
        <strong>Server restart required</strong>
        {reason && <p className="restart-banner-reason">{reason}</p>}
      </div>
      {canRestart ? (
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleRestart}
        >
          Restart Server
        </button>
      ) : (
        <p className="restart-banner-no-scope">
          An administrator needs to restart the server.
        </p>
      )}
    </div>
  );
}
