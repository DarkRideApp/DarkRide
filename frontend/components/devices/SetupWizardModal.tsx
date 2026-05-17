import React, { useState } from 'react';
import { Modal } from '@darkrideapp/plugin-sdk/react';
import { LoadingSpinner } from '@darkrideapp/plugin-sdk/react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { CURRENT_SETUP_VERSION } from '../../../shared/types/api';
import type { Device } from '../../../shared/types/api';
import { CheckCircle, Circle, Shield, Wifi, Bug, MonitorSpeaker } from 'lucide-react';

interface SetupWizardModalProps {
  device: Device;
  onClose: () => void;
  onSetupComplete: () => void;
}

interface SetupStep {
  version: number;
  title: string;
  description: string;
  icon: React.ReactNode;
  rootRequired: boolean;
}

const SETUP_STEPS: SetupStep[] = [
  {
    version: 1,
    title: 'Basic Device Config',
    description: 'Stay awake while charging, disable screen lock',
    icon: <MonitorSpeaker size={18} />,
    rootRequired: false,
  },
  {
    version: 2,
    title: 'WireGuard Tunnel & CA Certificate',
    description: 'Configure WireGuard for traffic capture and inject mitmproxy CA certificate',
    icon: <Wifi size={18} />,
    rootRequired: true,
  },
  {
    version: 3,
    title: 'Frida Server',
    description: 'Push Frida server binary for runtime instrumentation',
    icon: <Bug size={18} />,
    rootRequired: true,
  },
  {
    version: 4,
    title: 'Stream Binaries',
    description: 'Pre-push minicap, minitouch, and scrcpy for fast screen streaming',
    icon: <Shield size={18} />,
    rootRequired: false,
  },
];

export function SetupWizardModal({ device, onClose, onSetupComplete }: SetupWizardModalProps) {
  const ws = useWebSocket();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const completedVersion = device.setupVersion ?? 0;
  const pendingSteps = SETUP_STEPS.filter(s => s.version > completedVersion);
  const completedSteps = SETUP_STEPS.filter(s => s.version <= completedVersion);
  const isFullySetup = completedVersion >= CURRENT_SETUP_VERSION;

  const handleRunSetup = async () => {
    setRunning(true);
    setError(null);
    try {
      await ws.sendRestApi('POST', `/v1/device/setup/${encodeURIComponent(device.id)}`);
      onSetupComplete();
    } catch (err: any) {
      setError(err.message || 'Setup failed. Ensure the device is online and try again.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      title={`Device Setup — ${device.name || device.id}`}
      onClose={onClose}
      footer={
        <div className="setup-wizard-footer">
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
          {!isFullySetup && (
            <button
              className="btn btn-primary"
              onClick={handleRunSetup}
              disabled={running}
              data-testid="run-setup-btn"
            >
              {running ? <><LoadingSpinner /> Running Setup…</> : 'Run Setup'}
            </button>
          )}
        </div>
      }
    >
      <div className="setup-wizard" data-testid="setup-wizard">
        {isFullySetup ? (
          <div className="setup-wizard-complete">
            <CheckCircle size={32} />
            <p>This device is fully configured.</p>
          </div>
        ) : (
          <p className="setup-wizard-intro">
            {pendingSteps.length} step{pendingSteps.length !== 1 ? 's' : ''} remaining.
            {!device.isRooted && pendingSteps.some(s => s.rootRequired) && (
              <span className="setup-wizard-root-note">
                {' '}Some steps require root and will be skipped on this device.
              </span>
            )}
          </p>
        )}

        {error && (
          <div className="setup-wizard-error" data-testid="setup-error">
            {error}
          </div>
        )}

        <ul className="setup-wizard-steps">
          {SETUP_STEPS.map(step => {
            const done = step.version <= completedVersion;
            const skippable = step.rootRequired && !device.isRooted;
            return (
              <li
                key={step.version}
                className={`setup-wizard-step${done ? ' done' : ''}${skippable && !done ? ' skippable' : ''}`}
                data-testid={`setup-step-${step.version}`}
              >
                <span className="setup-wizard-step-icon">
                  {done ? <CheckCircle size={18} /> : <Circle size={18} />}
                </span>
                <div className="setup-wizard-step-content">
                  <div className="setup-wizard-step-header">
                    <span className="setup-wizard-step-label">{step.icon} {step.title}</span>
                    {done && <span className="badge badge-success">Done</span>}
                    {skippable && !done && <span className="badge badge-warning">Requires root</span>}
                  </div>
                  <p className="setup-wizard-step-desc">{step.description}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </Modal>
  );
}
