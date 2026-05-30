import React, { useEffect, useRef, useMemo, useState, useCallback } from 'react';
// android-emulator-webrtc ships CJS; the `/emulator` subpath re-exports dist.
// The <Emulator> component builds EmulatorControllerService + RtcService +
// JsepProtocol from `uri`/`auth` internally and renders a WebRTC <video> of
// JUST the device screen (no budtmo desktop, no toolbar). It speaks grpc-web
// (same-origin), so the DarkRide session cookie is sent automatically — no
// explicit auth object needed (auth defaults to a no-op authenticator).
import { Emulator } from 'android-emulator-webrtc/emulator';

export interface EmulatorViewProps {
  /** Device serial — logging context + remount key. */
  serial: string;
  /** Base grpc-web path from /video-transport, e.g. /v1/devices/<serial>/grpc.
   *  The grpc-web client appends `/<Service>/<Method>` to this. */
  grpcWebPath: string;
  /**
   * Initial streaming engine. Defaults to 'png' (screenshot stream over the
   * grpc-web bridge) because it works everywhere with no extra infrastructure.
   * 'webrtc' gives smoother H.264 video BUT its media track needs a reachable
   * ICE path — on Docker-NAT'd emulators that requires a TURN relay (-turncfg
   * + coturn), without which the peer connects then drops. Set 'webrtc' once
   * TURN is configured; the engine still degrades to png on failure.
   */
  initialEngine?: 'webrtc' | 'png';
  /** Fired when the session reaches "connected". */
  onReady?: () => void;
  /** Fired on a low-level gRPC/WebRTC error. */
  onError?: (err: Error) => void;
  /** Fired when the session transitions to "disconnected". */
  onDisconnect?: () => void;
}

/** How long to wait for the WebRTC session to connect before degrading to the
 *  png screenshot stream. WebRTC media crosses Docker's NAT and may need TURN;
 *  png streams over the same grpc-web bridge and never does. */
const WEBRTC_CONNECT_TIMEOUT_MS = 9000;

/**
 * Emulator renderer. Prefers WebRTC video (device-only, native-res), and
 * gracefully degrades to png screenshot streaming — over the SAME grpc-web
 * bridge, so it works even where WebRTC media can't traverse Docker's network
 * (no TURN). Both engines render only the Android screen.
 *
 * Mirrors VncViewer's callback shape so DeviceView swaps between scrcpy / VNC /
 * emulator with a single conditional, and uses the same callback-ref
 * discipline so an inline-closure parent doesn't tear down the live session on
 * every render. Keyed by serial+engine for a clean remount. Reconnect policy
 * is the parent's, as with VncViewer.
 */
export function EmulatorView({ serial, grpcWebPath, initialEngine = 'png', onReady, onError, onDisconnect }: EmulatorViewProps) {
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  const onDisconnectRef = useRef(onDisconnect);
  useEffect(() => {
    onReadyRef.current = onReady;
    onErrorRef.current = onError;
    onDisconnectRef.current = onDisconnect;
  });

  // Absolute same-origin URI so the session cookie is sent (and so a stray
  // <base> tag can't repoint the grpc-web calls). Stable across renders.
  const uri = useMemo(() => `${window.location.origin}${grpcWebPath}`, [grpcWebPath]);
  const tag = `[EmulatorView ${serial}]`;

  const [engine, setEngine] = useState<'webrtc' | 'png'>(initialEngine);
  const connectedRef = useRef(false);
  const engineRef = useRef(engine);
  engineRef.current = engine;

  // Degrade to png if WebRTC hasn't connected within the timeout (most likely
  // cause: media can't cross Docker NAT and no TURN relay is configured).
  useEffect(() => {
    if (engine !== 'webrtc') return;
    const timer = setTimeout(() => {
      if (!connectedRef.current) {
        console.warn(`${tag} WebRTC did not connect within ${WEBRTC_CONNECT_TIMEOUT_MS}ms — falling back to png screenshot stream (no TURN needed)`);
        setEngine('png');
      }
    }, WEBRTC_CONNECT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [engine, tag]);

  const handleStateChange = useCallback((state: string) => {
    console.log(`${tag} [${engineRef.current}] state: ${state}`);
    if (state === 'connected') {
      connectedRef.current = true;
      onReadyRef.current?.();
    } else if (state === 'disconnected' && connectedRef.current) {
      // Only a drop AFTER a successful connect is a real disconnect; pre-connect
      // 'disconnected' churn during webrtc setup is just the fallback path.
      onDisconnectRef.current?.();
    }
  }, [tag]);

  const handleError = useCallback((e: any) => {
    const detail = e?.message ?? e?.details ?? (typeof e === 'string' ? e : JSON.stringify(e));
    if (engineRef.current === 'webrtc') {
      // A webrtc-engine error is recoverable: drop to png rather than surfacing
      // a fatal stream error to the parent.
      console.warn(`${tag} WebRTC engine error — falling back to png: ${detail}`);
      setEngine('png');
      return;
    }
    console.error(`${tag} png engine gRPC error:`, e);
    onErrorRef.current?.(new Error(`Emulator stream error for ${serial}: ${detail}`));
  }, [tag, serial]);

  return (
    <div
      className="emulator-view"
      data-testid={`emulator-view-${serial}`}
      data-engine={engine}
      // Let the inner <video>/<img> drive height; the global
      // `.device-canvas-container canvas/video/img { max-width: 100% }` rule
      // (and .emulator-view max-height) keep a tall portrait device within the
      // viewport. Black background while the first frame arrives.
      style={{ width: '100%', background: '#000' }}
    >
      <Emulator
        key={`${serial}:${engine}`}
        uri={uri}
        view={engine}
        muted
        onStateChange={handleStateChange}
        onError={handleError}
      />
    </div>
  );
}
