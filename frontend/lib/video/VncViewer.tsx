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

    // Console-level lifecycle logging so a blank canvas can be diagnosed
    // from devtools without backend log access. Prefixed so users can grep.
    const tag = `[VncViewer ${serial}]`;
    console.log(`${tag} connecting to ${url}`);

    let rfb: RFB | null = null;
    try {
      rfb = new RFB(containerRef.current, url, {});
    } catch (e: any) {
      console.error(`${tag} RFB constructor threw:`, e);
      onErrorRef.current?.(new Error(`VNC failed to initialise for ${serial}: ${e?.message ?? String(e)}`));
      return;
    }
    // scaleViewport=true sizes noVNC's canvas to fit the wrapper div's
    // offsetWidth/offsetHeight. That fails for us because the existing
    // .device-canvas-container CSS has no explicit height — it's content-
    // sized — so a wrapper with height:100% collapses to 0 and the canvas
    // becomes invisible. Match the scrcpy player's pattern instead: let
    // the canvas take its natural framebuffer dimensions (e.g. 1080x2400
    // for a Pixel 8), and let the existing global CSS rule
    // `.device-canvas-container canvas { max-width: 100% }` scale it to
    // fit width while preserving aspect ratio.
    rfb.scaleViewport = false;
    rfb.resizeSession = false;
    // The wrapper's inline width/height:100% are removed below; clipping
    // is unnecessary now (the canvas drives the height), and the parent
    // already has overflow:hidden + a black background.

    const onConnect = () => {
      console.log(`${tag} connect event fired — RFB session established`);
      onReadyRef.current?.();
    };
    const onDisc = (e: any) => {
      console.log(`${tag} disconnect event fired, detail:`, e?.detail);
      if (e?.detail?.clean === false) {
        // Unclean disconnect — surface as error only, do NOT also fire onDisconnect.
        onErrorRef.current?.(new Error(`VNC disconnected uncleanly for ${serial}`));
        return;
      }
      onDisconnectRef.current?.();
    };
    const onSecFail = (e: any) => {
      console.error(`${tag} securityfailure:`, e?.detail);
      onErrorRef.current?.(new Error(`VNC security failure for ${serial}: ${e?.detail?.reason ?? 'unknown'}`));
    };
    // 'credentialsrequired' is a *separate* event from securityfailure and
    // means the server asked for a password but we didn't pre-supply one.
    // budtmo's image leaves VNC password-less in our spawn path, so seeing
    // this in the wild means the image was rebuilt with a password set —
    // worth logging explicitly so the cause isn't mistaken for a bridge bug.
    const onCredentialsRequired = () => {
      console.error(`${tag} credentialsrequired — server is asking for a VNC password but the spawn path doesn't set one. Did budtmo's VNC_PASSWORD env get inherited from elsewhere?`);
      onErrorRef.current?.(new Error(`VNC server requested credentials for ${serial}; check VNC_PASSWORD env on the container`));
    };
    rfb.addEventListener('connect', onConnect);
    rfb.addEventListener('disconnect', onDisc);
    rfb.addEventListener('securityfailure', onSecFail);
    rfb.addEventListener('credentialsrequired', onCredentialsRequired);

    return () => {
      try {
        rfb!.removeEventListener('connect', onConnect);
        rfb!.removeEventListener('disconnect', onDisc);
        rfb!.removeEventListener('securityfailure', onSecFail);
        rfb!.removeEventListener('credentialsrequired', onCredentialsRequired);
        rfb!.disconnect();
      } catch { /* best effort: cleanup must not throw */ }
    };
  }, [serial, wsPath]);

  return (
    <div
      ref={containerRef}
      className="vnc-viewer"
      data-testid={`vnc-viewer-${serial}`}
      // No fixed height — let the noVNC canvas inside drive the size, then
      // the global `.device-canvas-container canvas { max-width: 100% }`
      // rule constrains it. width:100% on the wrapper lets the canvas
      // know how much horizontal room it can shrink-to-fit into. The
      // .vnc-viewer class adds max-height so a 1080x2400 phone canvas
      // doesn't blow past the viewport.
      style={{ width: '100%', background: '#000' }}
    />
  );
}
