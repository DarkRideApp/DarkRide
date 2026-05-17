import QRCode from 'qrcode';
import { ensureConfigs, derivePublicKey, getServerIp } from '../services/wireguard-config';

/**
 * Generate a WireGuard config string for iOS WireGuard app.
 * Includes Address + DNS in [Interface] section (needed for iOS app, not used for Android ADB setup).
 */
export function generateIosWireGuardConfig(deviceId: string, serverPort: number = 51820): string {
  const config = ensureConfigs(deviceId, serverPort);

  return [
    '[Interface]',
    `PrivateKey = ${config.clientPrivateKey}`,
    `Address = ${config.clientAddress}`,
    'DNS = 1.1.1.1, 8.8.8.8',
    '',
    '[Peer]',
    `PublicKey = ${config.serverPublicKey}`,
    `Endpoint = ${config.serverEndpoint}`,
    'AllowedIPs = 0.0.0.0/0',
    'PersistentKeepalive = 25',
  ].join('\n');
}

/**
 * Generate a QR code (base64 PNG) containing the WireGuard config for a device.
 */
export async function generateWireGuardQrCode(deviceId: string, serverPort: number = 51820): Promise<string> {
  const configText = generateIosWireGuardConfig(deviceId, serverPort);
  const dataUrl = await QRCode.toDataURL(configText, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 400,
  });
  // Strip the data:image/png;base64, prefix to return just the base64
  return dataUrl.replace(/^data:image\/png;base64,/, '');
}
