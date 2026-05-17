import React, { useEffect, useState } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { LoadingSpinner } from '@darkrideapp/plugin-sdk/react';

interface WireGuardSetupProps {
  deviceId: string;
}

export function WireGuardSetup({ deviceId }: WireGuardSetupProps) {
  const ws = useWebSocket();
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ws.connected) return;
    setLoading(true);
    ws.sendRestApi('GET', `/v1/device/wg-qr/${encodeURIComponent(deviceId)}`).then(res => {
      if (res.body?.data?.qrCode) {
        setQrCode(res.body.data.qrCode);
      } else {
        setError('Failed to generate QR code');
      }
    }).catch((err: any) => {
      setError(err.message || 'Failed to generate QR code');
    }).finally(() => setLoading(false));
  }, [ws, deviceId]);

  return (
    <div className="card" data-testid="wireguard-setup">
      <h3 style={{ marginBottom: 12, fontSize: 15 }}>WireGuard Setup (iOS)</h3>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
        Configure WireGuard on your iPhone to route traffic through DarkRide for HTTPS capture.
      </p>

      {loading && <LoadingSpinner />}
      {error && <div style={{ color: 'var(--color-danger, #ef4444)', fontSize: 13 }}>{error}</div>}

      {qrCode && (
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <img
            src={`data:image/png;base64,${qrCode}`}
            alt="WireGuard QR Code"
            style={{ maxWidth: 280, borderRadius: 8, background: '#fff', padding: 8 }}
            data-testid="wg-qr-image"
          />
        </div>
      )}

      <div style={{ fontSize: 13, lineHeight: 1.6 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Setup Steps:</div>
        <ol style={{ paddingLeft: 20, margin: 0 }}>
          <li style={{ marginBottom: 6 }}>
            Install <strong>WireGuard</strong> from the App Store
          </li>
          <li style={{ marginBottom: 6 }}>
            Open WireGuard, tap <strong>+</strong> &rarr; <strong>Create from QR code</strong>
          </li>
          <li style={{ marginBottom: 6 }}>
            Scan the QR code above to import the tunnel config
          </li>
          <li style={{ marginBottom: 6 }}>
            Activate the tunnel in WireGuard
          </li>
          <li style={{ marginBottom: 6 }}>
            Open Safari and go to <strong>mitm.it</strong> to download the CA certificate
          </li>
          <li style={{ marginBottom: 6 }}>
            Go to <strong>Settings &rarr; General &rarr; VPN & Device Management</strong> and install the profile
          </li>
          <li>
            Go to <strong>Settings &rarr; General &rarr; About &rarr; Certificate Trust Settings</strong> and enable the mitmproxy CA
          </li>
        </ol>
      </div>
    </div>
  );
}
