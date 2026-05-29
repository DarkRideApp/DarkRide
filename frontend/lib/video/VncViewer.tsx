import React, { useEffect, useRef } from 'react';
// The @novnc/novnc package's "exports" field maps the package name to
// core/rfb.js directly (the default export is the RFB class). Using a
// subpath like /lib/rfb.js or /core/rfb.js fails ERR_PACKAGE_PATH_NOT_EXPORTED
// against v1.7+.
import RFB from '@novnc/novnc';

export interface VncViewerProps {
  /** Device serial, used purely for logging context. */
  serial: string;
  /** Path returned by /v1/devices/:serial/video-transport — already includes the encoded serial. */
  wsPath: string;
  /** Fired once the RFB session is established. */
  onReady?: () => void;
  /** Fired on RFB error events (securityfailure, etc.). */
  onError?: (err: Error) => void;
  /** Fired when the remote drops the connection. */
  onDisconnect?: () => void;
}

/**
 * noVNC RFB renderer wrapped as a thin React component. Mirrors the
 * existing scrcpy DeviceViewer's callback shape so the device-detail
 * page can swap between them with a single conditional.
 *
 * Reconnect-on-drop is deliberately NOT implemented here in Phase 1 —
 * the parent component owns retry policy (the existing DeviceViewer
 * does the same). onDisconnect fires once and stays.
 */
export function VncViewer({ serial, wsPath, onReady, onError, onDisconnect }: VncViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    // Build the absolute WS URL from the relative wsPath. window.location
    // gives us host + protocol (http→ws, https→wss).
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}${wsPath}`;

    const rfb = new RFB(containerRef.current, url, {});
    rfb.scaleViewport = true;
    rfb.resizeSession = false;

    const onConnect = () => { onReady?.(); };
    const onDisc = (e: any) => {
      if (e?.detail?.clean === false) {
        onError?.(new Error(`VNC disconnected uncleanly for ${serial}`));
      }
      onDisconnect?.();
    };
    const onSecFail = (e: any) => {
      onError?.(new Error(`VNC security failure for ${serial}: ${e?.detail?.reason ?? 'unknown'}`));
    };
    rfb.addEventListener('connect', onConnect);
    rfb.addEventListener('disconnect', onDisc);
    rfb.addEventListener('securityfailure', onSecFail);

    return () => {
      try { rfb.disconnect(); } catch { /* best effort */ }
    };
    // serial/wsPath are stable for the lifetime of this mount; the parent
    // unmounts to switch devices, so a tight dep array is intentional.
  }, [serial, wsPath, onReady, onError, onDisconnect]);

  return (
    <div
      ref={containerRef}
      data-testid={`vnc-viewer-${serial}`}
      style={{ width: '100%', height: '100%', background: '#000' }}
    />
  );
}
