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
  /** Fired on RFB error events (securityfailure, constructor throw, unclean disconnect). */
  onError?: (err: Error) => void;
  /** Fired when the remote drops the connection CLEANLY. Unclean drops surface via onError. */
  onDisconnect?: () => void;
}

/**
 * noVNC RFB renderer wrapped as a thin React component. Mirrors the
 * existing scrcpy DeviceViewer's callback shape so the device-detail
 * page can swap between them with a single conditional.
 *
 * Callbacks are held in refs so a parent passing inline closures
 * doesn't cause the effect to re-run and tear down the live VNC
 * session on every render. The main effect only re-runs when serial
 * or wsPath actually change (which always means a different bridge).
 *
 * Reconnect-on-drop is deliberately NOT implemented here in Phase 1 —
 * the parent component owns retry policy (the existing DeviceViewer
 * does the same). onDisconnect fires once and stays.
 */
export function VncViewer({ serial, wsPath, onReady, onError, onDisconnect }: VncViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  const onDisconnectRef = useRef(onDisconnect);

  // Keep callback refs fresh without making them dependencies of the
  // main mount effect. Without this, inline-callback parents would
  // re-mount the RFB on every render (a tear-down + reconnect storm).
  useEffect(() => {
    onReadyRef.current = onReady;
    onErrorRef.current = onError;
    onDisconnectRef.current = onDisconnect;
  });

  useEffect(() => {
    if (!containerRef.current) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}${wsPath}`;

    let rfb: RFB | null = null;
    try {
      rfb = new RFB(containerRef.current, url, {});
    } catch (e: any) {
      onErrorRef.current?.(new Error(`VNC failed to initialise for ${serial}: ${e?.message ?? String(e)}`));
      return;
    }
    rfb.scaleViewport = true;
    rfb.resizeSession = false;

    const onConnect = () => { onReadyRef.current?.(); };
    const onDisc = (e: any) => {
      if (e?.detail?.clean === false) {
        // Unclean disconnect — surface as error only, do NOT also fire onDisconnect.
        onErrorRef.current?.(new Error(`VNC disconnected uncleanly for ${serial}`));
        return;
      }
      onDisconnectRef.current?.();
    };
    const onSecFail = (e: any) => {
      onErrorRef.current?.(new Error(`VNC security failure for ${serial}: ${e?.detail?.reason ?? 'unknown'}`));
    };
    rfb.addEventListener('connect', onConnect);
    rfb.addEventListener('disconnect', onDisc);
    rfb.addEventListener('securityfailure', onSecFail);

    return () => {
      try {
        rfb!.removeEventListener('connect', onConnect);
        rfb!.removeEventListener('disconnect', onDisc);
        rfb!.removeEventListener('securityfailure', onSecFail);
        rfb!.disconnect();
      } catch { /* best effort: cleanup must not throw */ }
    };
  }, [serial, wsPath]);

  return (
    <div
      ref={containerRef}
      data-testid={`vnc-viewer-${serial}`}
      style={{ width: '100%', height: '100%', background: '#000' }}
    />
  );
}
