import React, { useEffect, useRef, useMemo, useState, useCallback, useImperativeHandle } from 'react';
// android-emulator-webrtc ships CJS; the `/emulator` subpath re-exports dist.
// The <Emulator> component builds EmulatorControllerService + RtcService +
// JsepProtocol from `uri`/`auth` internally and renders a WebRTC <video> of
// JUST the device screen (no budtmo desktop, no toolbar). It speaks grpc-web
// (same-origin), so the DarkRide session cookie is sent automatically — no
// explicit auth object needed (auth defaults to a no-op authenticator).
import { Emulator } from 'android-emulator-webrtc/emulator';

export interface EmulatorVideoProps {
  /** Device serial — logging context + remount key. */
  serial: string;
  /** Base grpc-web path from /video-transport, e.g. /v1/devices/<serial>/grpc.
   *  The grpc-web client appends `/<Service>/<Method>` to this. */
  grpcWebPath: string;
  /**
   * Initial streaming engine. Defaults to 'webrtc' (smooth H.264 video + live
   * input), which needs a reachable ICE path — DarkRide supplies a TURN relay
   * (coturn + the emulator's -turncfg) so the media traverses Docker NAT. If
   * the media still can't connect/sustain, the engine automatically degrades
   * to 'png' (screenshot stream over the grpc-web bridge — works everywhere,
   * just laggier). Pass 'png' to force the fallback.
   */
  initialEngine?: 'webrtc' | 'png';
  /** Fired when the session reaches "connected". */
  onReady?: () => void;
  /** Fired on a low-level gRPC/WebRTC error. */
  onError?: (err: Error) => void;
}

/** Imperative handle exposed via ref so the parent (DeviceViewer) can drive the
 *  device's hardware keys + keystrokes over the emulator's gRPC input channel. */
export interface EmulatorVideoHandle {
  sendKey(key: string): void;
}

/** How long to wait for the WebRTC session to connect before degrading to the
 *  png screenshot stream. WebRTC media crosses Docker's NAT and may need TURN;
 *  png streams over the same grpc-web bridge and never does. */
const WEBRTC_CONNECT_TIMEOUT_MS = 9000;

/** Grace period after a WebRTC `disconnected` before degrading to png. ICE
 *  routinely blips to `disconnected` and recovers (e.g. when the tab loses
 *  focus and the browser throttles the connection); degrading immediately
 *  would strand the user on the laggy png engine after a momentary hiccup. */
const WEBRTC_RECONNECT_GRACE_MS = 12000;

/**
 * Emulator VIDEO core. Prefers WebRTC video (device-only, native-res), and
 * gracefully degrades to png screenshot streaming — over the SAME grpc-web
 * bridge, so it works even where WebRTC media can't traverse Docker's network
 * (no TURN). Both engines render only the Android screen.
 *
 * This component renders ONLY the video surface; the control chrome (nav bar,
 * keyboard forwarding) is owned by DeviceViewer, which drives this component's
 * gRPC input channel through the imperative `sendKey` handle. Keyed by
 * serial+engine for a clean remount.
 */
export const EmulatorVideo = React.forwardRef<EmulatorVideoHandle, EmulatorVideoProps>(function EmulatorVideo(
  { serial, grpcWebPath, initialEngine = 'webrtc', onReady, onError },
  ref,
) {
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onReadyRef.current = onReady;
    onErrorRef.current = onError;
  });

  // Absolute same-origin URI so the session cookie is sent (and so a stray
  // <base> tag can't repoint the grpc-web calls). Stable across renders.
  const uri = useMemo(() => `${window.location.origin}${grpcWebPath}`, [grpcWebPath]);
  const tag = `[EmulatorVideo ${serial}]`;

  // Ref to the <Emulator> instance so the parent's on-screen nav bar +
  // keyboard can drive the device's input. The component's sendKey() goes over
  // the live JSEP input channel (webrtc engine); in the png fallback that
  // channel is dormant.
  const emulatorRef = useRef<{ sendKey?: (key: string) => void } | null>(null);
  const sendKey = useCallback((key: string) => {
    try { emulatorRef.current?.sendKey?.(key); }
    catch (e) { console.warn(`${tag} sendKey(${key}) failed`, e); }
  }, [tag]);

  useImperativeHandle(ref, () => ({ sendKey }), [sendKey]);

  const [engine, setEngine] = useState<'webrtc' | 'png'>(initialEngine);
  const connectedRef = useRef(false);
  const engineRef = useRef(engine);
  engineRef.current = engine;
  // Pending "degrade to png" timer armed on a webrtc disconnect; cancelled if
  // the connection recovers within the grace window.
  const degradeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (degradeTimerRef.current) clearTimeout(degradeTimerRef.current); }, []);

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
      // Recovered (or first connect) — cancel any pending degrade.
      if (degradeTimerRef.current) { clearTimeout(degradeTimerRef.current); degradeTimerRef.current = null; }
      onReadyRef.current?.();
    } else if (state === 'disconnected') {
      if (engineRef.current === 'webrtc') {
        // Don't degrade on the first blip — ICE recovers constantly (focus
        // loss, brief network stalls). Arm a grace timer; if it's still down
        // when it fires, THEN drop to png. A subsequent 'connected' cancels it.
        if (!degradeTimerRef.current) {
          degradeTimerRef.current = setTimeout(() => {
            degradeTimerRef.current = null;
            if (engineRef.current === 'webrtc') {
              console.warn(`${tag} WebRTC stayed disconnected ${WEBRTC_RECONNECT_GRACE_MS}ms — degrading to png`);
              connectedRef.current = false;
              setEngine('png');
            }
          }, WEBRTC_RECONNECT_GRACE_MS);
        }
      }
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
      data-testid={`emulator-video-${serial}`}
      data-engine={engine}
      // Let the inner <video>/<img> drive height; the global
      // `.device-canvas-container canvas/video/img { max-width: 100% }` rule
      // (and .emulator-view max-height) keep a tall portrait device within the
      // viewport. Black background while the first frame arrives.
      style={{ width: '100%', background: '#000' }}
    >
      <Emulator
        ref={emulatorRef as any}
        key={`${serial}:${engine}`}
        uri={uri}
        view={engine}
        muted
        onStateChange={handleStateChange}
        onError={handleError}
      />
    </div>
  );
});
