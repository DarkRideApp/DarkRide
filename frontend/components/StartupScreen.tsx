import React from 'react';
import { Smartphone } from 'lucide-react';

interface StartupScreenProps {
  connected: boolean;
  message: string;
}

export function StartupScreen({ connected, message }: StartupScreenProps) {
  return (
    <div className="startup-screen">
      <div className="startup-card">
        <div className="startup-icon">
          <Smartphone size={40} />
        </div>
        <h1 className="startup-title">DarkRide</h1>
        <div className="startup-status">
          <div className="startup-spinner" />
          <span className="startup-message">
            {connected ? message : 'Connecting to server...'}
          </span>
        </div>
      </div>
    </div>
  );
}
