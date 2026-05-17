import React, { useContext } from 'react';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';

export function RestartConfirmModal({ onClose }: { onClose: () => void }) {
  const ws = useContext(WebSocketContext);
  const handleConfirm = () => {
    ws?.sendRestApi('POST', '/v1/system/restart');
    onClose();
  };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>Restart Server?</h3>
        <p>Connected clients will reconnect within ~30 seconds.</p>
        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={handleConfirm}>Restart</button>
        </div>
      </div>
    </div>
  );
}
