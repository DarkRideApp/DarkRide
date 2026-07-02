import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft, Move, Camera, MoreHorizontal,
  ArrowUp, ArrowDown, ArrowRight, Unlock as UnlockIcon,
} from 'lucide-react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { ButtonList } from '@darkrideapp/plugin-sdk/react';
import type { ButtonListItem } from '@darkrideapp/plugin-sdk/react';
import { pluginRegistry } from '@darkrideapp/plugin-sdk/react';
import { DeviceNavButtons } from './DeviceNavButtons';
import { StreamController } from '../../lib/video/stream-controller';
import { createCanvasRenderer } from '../../lib/video/canvas-renderer';
import { createStreamWorkerClient } from '../../lib/video/stream-worker-client';
import type { KeyframeReason } from '../../lib/video/keyframe-trigger';
import { VideoHealthIndicator, HealthState } from './VideoHealthIndicator';
import { VideoQualitySelector } from './VideoQualitySelector';
import { EmulatorVideo, type EmulatorVideoHandle } from '../../lib/video/EmulatorVideo';
import './DeviceViewer.css';

pluginRegistry.registerUiSlots('core', [
  {
    id: 'device-viewer:overflow-actions',
    kind: 'button-list',
    description: 'Buttons shown inside the DeviceViewer ⋯ overflow popover. Plugins can inject device-scoped actions here.',
  },
]);

/**
 * Popover anchored to a trigger element, rendered via portal so it escapes any
 * parent stacking context. Closes on outside click (mousedown on anything that
 * isn't the anchor or the popover itself).
 */
interface PopoverProps {
  anchorRef: React.RefObject<HTMLElement>;
  open: boolean;
  align?: 'start' | 'end';
  onClose: () => void;
  children: React.ReactNode;
}

function Popover({ anchorRef, open, align = 'start', onClose, children }: PopoverProps): JSX.Element | null {
  const [style, setStyle] = useState<React.CSSProperties | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Recompute position on open AND on scroll/resize so the popover follows
  // its anchor when the user scrolls. Prefers below; flips above if there's
  // no room below or more room above.
  const reposition = useCallback(() => {
    if (!anchorRef.current) { setStyle(null); return; }
    const rect = anchorRef.current.getBoundingClientRect();
    const popH = popoverRef.current?.getBoundingClientRect().height ?? 0;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const flipAbove = (popH > 0 && popH + 8 > spaceBelow && spaceAbove > spaceBelow) || spaceBelow < 80;
    const base: React.CSSProperties = { position: 'fixed', zIndex: 9999 };
    if (flipAbove) base.bottom = Math.round(window.innerHeight - rect.top + 4);
    else base.top = Math.round(rect.bottom + 4);
    if (align === 'end') base.right = Math.round(window.innerWidth - rect.right);
    else base.left = Math.round(rect.left);
    setStyle(base);
  }, [anchorRef, align]);

  useLayoutEffect(() => {
    if (!open) { setStyle(null); return; }
    reposition();
  }, [open, reposition]);

  // Re-run after the popover first renders so we can measure its real height
  // and decide whether to flip above.
  useLayoutEffect(() => {
    if (!open) return;
    if (popoverRef.current) reposition();
  }, [open, reposition, children]);

  useEffect(() => {
    if (!open) return;
    // Re-measure on scroll (capture=true catches any scrollable ancestor) and resize
    const onScroll = () => reposition();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || popoverRef.current?.contains(t)) return;
      onClose();
    };
    const keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // setTimeout 0 so the mousedown that opened this doesn't immediately close it
    const t = setTimeout(() => document.addEventListener('mousedown', handler), 0);
    document.addEventListener('keydown', keyHandler);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', keyHandler);
    };
  }, [open, anchorRef, onClose]);

  if (!open || !style) return null;
  return createPortal(
    <div
      ref={popoverRef}
      style={{
        ...style,
        background: 'var(--bg-primary, #222)',
        border: '1px solid var(--border-color, #444)',
        borderRadius: 4,
        padding: 6,
        boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
      }}
    >{children}</div>,
    document.body,
  );
}

export interface DeviceAction {
  key: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void | Promise<void>;
  disabled?: boolean;
  placement?: 'primary' | 'overflow';
}

/** A stream sink drains WebSocket frames into a decoder+renderer. Two impls:
 *  the main-thread StreamController, or the Worker client (decode off-thread). */
interface StreamSink {
  feedBinary(data: ArrayBuffer): void;
  /** Present only for the Worker sink, which owns the (transferred) canvas and
   *  therefore must paint polling/minicap JPEG stills too. */
  feedJpeg?(data: ArrayBuffer): void;
  reset(): void;
  close(): void;
}

/** Opt-in flag (off by default) for the experimental off-main-thread decode
 *  path. Enable per-browser with localStorage 'darkride:stream-worker' = '1'. */
function streamWorkerEnabled(): boolean {
  try { return localStorage.getItem('darkride:stream-worker') === '1'; } catch { return false; }
}

function supportsOffscreenWorker(): boolean {
  return typeof Worker !== 'undefined'
    && typeof OffscreenCanvas !== 'undefined'
    && typeof HTMLCanvasElement !== 'undefined'
    && typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function';
}

function base64ToArrayBuffer(b64: string): ArrayBuffer | null {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  } catch { return null; }
}

export interface DeviceViewerProps {
  deviceId: string;
  onStreamReady?: (info: {
    screenWidth: number;
    screenHeight: number;
    backend: 'scrcpy' | 'minicap' | 'polling' | 'wda-polling' | 'webrtc';
  }) => void;
  onError?: (error: string) => void;
  className?: string;
  extraActions?: DeviceAction[];
  captureSessionId?: number;
  /**
   * When set, the viewer runs in "emulator mode": the video surface is an
   * <EmulatorVideo> (WebRTC, with png fallback) over this grpc-web path, and
   * controls route to the emulator's gRPC input channel (sendKey) instead of
   * the adb scrcpy WebSocket. The on-screen control surface is identical.
   */
  webrtcGrpcPath?: string;
}

export function DeviceViewer({ deviceId, onStreamReady, onError, className, extraActions, captureSessionId, webrtcGrpcPath }: DeviceViewerProps): JSX.Element {
  const ws = useWebSocket();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const emulatorVideoRef = useRef<EmulatorVideoHandle>(null);
  const isEmulator = !!webrtcGrpcPath;
  const viewerId = useMemo(
    () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    [deviceId],
  );
  const screenDimsRef = useRef<{ width: number; height: number } | null>(null);
  const draggingRef = useRef<boolean>(false);
  const lastTouchRef = useRef<{ x: number; y: number } | null>(null);
  // Cached resolution reserves canvas space immediately on mount so the
  // buttons don't reflow when the first frame arrives. Populated from
  // localStorage or replaced when a stream-ready event reports new dims.
  const cachedResKey = `darkride:device-viewer:last-res:${deviceId}`;
  const [reservedDims, setReservedDims] = React.useState<{ width: number; height: number } | null>(() => {
    try {
      const raw = localStorage.getItem(cachedResKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (typeof parsed?.width === 'number' && typeof parsed?.height === 'number' && parsed.width > 0 && parsed.height > 0) {
        return { width: parsed.width, height: parsed.height };
      }
    } catch { /* ignore */ }
    return null;
  });

  const toDeviceCoords = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const normX = (e.clientX - rect.left) / rect.width;
    const normY = (e.clientY - rect.top) / rect.height;
    const screen = screenDimsRef.current;
    const targetW = screen?.width ?? canvas.width;
    const targetH = screen?.height ?? canvas.height;
    return {
      x: Math.round(normX * targetW),
      y: Math.round(normY * targetH),
    };
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const coords = toDeviceCoords(e);
    if (!coords) return;
    draggingRef.current = true;
    lastTouchRef.current = coords;
    ws.sendMessage('device-touch', { deviceId, eventType: 'down', x: coords.x, y: coords.y });
  }, [ws, deviceId, toDeviceCoords]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!draggingRef.current) return;
    const coords = toDeviceCoords(e);
    if (!coords) return;
    lastTouchRef.current = coords;
    ws.sendMessage('device-touch', { deviceId, eventType: 'move', x: coords.x, y: coords.y });
  }, [ws, deviceId, toDeviceCoords]);

  const handleMouseUp = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    const { x, y } = lastTouchRef.current ?? { x: 0, y: 0 };
    ws.sendMessage('device-touch', { deviceId, eventType: 'up', x, y });
  }, [ws, deviceId]);

  const handleNav = useCallback((button: 'back' | 'home' | 'recents' | 'power') => {
    if (isEmulator) {
      // Emulator can't use the adb input path — map to the emulator's hardware
      // keys over the gRPC input channel.
      emulatorVideoRef.current?.sendKey(({ back: 'GoBack', home: 'GoHome', recents: 'AppSwitch', power: 'Power' } as const)[button]);
      return;
    }
    ws.sendMessage('device-nav', { deviceId, button });
  }, [ws, deviceId, isEmulator]);

  const handleScreenshot = useCallback(async () => {
    if (captureSessionId != null) {
      await ws.sendRestApi('POST', `/v1/device/screenshot/${encodeURIComponent(deviceId)}`, { sessionId: captureSessionId });
    } else {
      await ws.sendRestApi('GET', `/v1/device/screenshot/${encodeURIComponent(deviceId)}`);
    }
  }, [ws, deviceId, captureSessionId]);

  const [supported, setSupported] = useState<boolean | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [videoTier, setVideoTier] = useState(1);
  const [videoBitrate, setVideoBitrate] = useState(4_000_000);
  const [resetSticky, setResetSticky] = useState(false);
  const [swipeOpen, setSwipeOpen] = React.useState(false);
  const [overflowOpen, setOverflowOpen] = React.useState(false);
  const swipeTriggerRef = useRef<HTMLButtonElement>(null);
  const overflowTriggerRef = useRef<HTMLButtonElement>(null);
  const [platform, setPlatform] = React.useState<'android' | 'ios' | null>(null);

  const runCommand = useCallback(async (command: string) => {
    await ws.sendRestApi('POST', `/v1/device/command/${encodeURIComponent(deviceId)}`, { command });
    setOverflowOpen(false);
  }, [ws, deviceId]);

  const handleRetryStream = useCallback(() => {
    ws.sendMessage('device-stream-restart', { deviceId, viewerId });
    setOverflowOpen(false);
  }, [ws, deviceId, viewerId]);

  const handleQualityChange = useCallback((tier: number | null) => {
    ws.sendMessage('device-stream-set-tier', { deviceId, tier });
  }, [ws, deviceId]);

  const handleSwipe = useCallback((direction: 'up' | 'down' | 'left' | 'right') => {
    const screen = screenDimsRef.current;
    const w = screen?.width ?? 1080;
    const h = screen?.height ?? 1920;
    const cx = Math.round(w / 2);
    const cy = Math.round(h / 2);
    const dist = Math.round(Math.min(w, h) * 0.35);
    const swipes = {
      up:    { startX: cx, startY: cy + dist, endX: cx, endY: cy - dist },
      down:  { startX: cx, startY: cy - dist, endX: cx, endY: cy + dist },
      left:  { startX: cx + dist, startY: cy, endX: cx - dist, endY: cy },
      right: { startX: cx - dist, startY: cy, endX: cx + dist, endY: cy },
    } as const;
    ws.sendMessage('device-swipe', { deviceId, ...swipes[direction], durationMs: 400 });
    setSwipeOpen(false);
  }, [ws, deviceId]);

  // Capability detection: check whether the browser supports WebCodecs VideoDecoder.
  useEffect(() => {
    if (isEmulator) return; // emulator renders via <EmulatorVideo>, no WebCodecs path
    if (typeof (globalThis as any).VideoDecoder === 'undefined') {
      setSupported(false);
      return;
    }
    let cancelled = false;
    (globalThis as any).VideoDecoder.isConfigSupported({ codec: 'avc1.42E01E' })
      .then((r: any) => { if (!cancelled) setSupported(!!r.supported); })
      .catch(() => { if (!cancelled) setSupported(false); });
    return () => { cancelled = true; };
  }, [isEmulator]);

  useEffect(() => {
    if (isEmulator) return; // emulator stream is driven by <EmulatorVideo> over gRPC
    if (!deviceId || !ws.connected) return;
    ws.sendMessage('device-stream-start', { deviceId, viewerId });
    return () => {
      ws.sendMessage('device-stream-stop', { deviceId, viewerId });
    };
  }, [ws, deviceId, viewerId, isEmulator]);

  // Polling/minicap fallback: JSON device-frame messages carry base64 JPEG.
  // Kept alongside the binary WebCodecs path — both backends can coexist.
  useEffect(() => {
    if (isEmulator) return;
    return ws.subscribe('device-frame', (msg: any) => {
      if (msg.deviceId !== deviceId) return;
      // Worker mode owns the (transferred) canvas — hand it the JPEG bytes so
      // it decodes and paints them; the main thread can't touch the canvas.
      const sink = sinkRef.current;
      if (sink?.feedJpeg) {
        const bytes = base64ToArrayBuffer(msg.frame);
        if (bytes) sink.feedJpeg(bytes);
        return;
      }
      // Main-thread mode: draw directly to the 2D canvas.
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const img = new Image();
      img.onload = () => {
        const currentCanvas = canvasRef.current;
        if (!currentCanvas) return;
        const currentCtx = currentCanvas.getContext('2d');
        if (!currentCtx) return;
        currentCanvas.width = img.width;
        currentCanvas.height = img.height;
        currentCtx.drawImage(img, 0, 0);
        img.onload = null;
      };
      img.src = `data:image/jpeg;base64,${msg.frame}`;
    });
  }, [ws, deviceId, isEmulator]);

  // scrcpy H.264 path via WebCodecs. Frames drain into a StreamSink: either the
  // main-thread StreamController, or (opt-in) a Worker that decodes and paints
  // on an OffscreenCanvas so React re-renders can't stutter the video.
  const sinkRef = useRef<StreamSink | null>(null);
  // Set once when the worker path is abandoned (init threw, or it produced no
  // frames). Forces subsequent runs onto the main thread for this component.
  const workerDisabledRef = useRef(false);
  const workerRenderedRef = useRef(false);
  // Bumped to remount the <canvas> (fresh element) when falling back from a
  // worker: transferControlToOffscreen is irreversible, so the old canvas is
  // spent and the main-thread path needs a new one.
  const [canvasGen, setCanvasGen] = useState(0);

  useEffect(() => {
    if (isEmulator) return;
    if (!supported) return;

    const requestKeyframe = (reason: KeyframeReason) => {
      ws.sendMessage('device-stream-request-keyframe', { deviceId, viewerId, reason });
    };

    let watchdogTimer: ReturnType<typeof setInterval> | null = null;
    let renderCheckTimer: ReturnType<typeof setTimeout> | null = null;

    const makeMainThreadSink = (): StreamSink => {
      const renderer = createCanvasRenderer(() => canvasRef.current);
      const controller = new StreamController(renderer, {
        requestKeyframe,
        onConfig: () => setReconnecting(false),
        onError: (e) => console.error('[DeviceViewer] decode error', { deviceId, error: e?.message ?? String(e) }),
        onGap: (info) => console.warn('[DeviceViewer] frame gap', { deviceId, ...info }),
        onRegression: (info) => console.warn('[DeviceViewer] frame counter regression', { deviceId, ...info }),
        onWireVersionMismatch: (info) => console.error('[DeviceViewer] wire version mismatch — backend/frontend out of sync', { deviceId, ...info }),
      });
      watchdogTimer = setInterval(() => controller.checkWatchdog(), 1000);
      return {
        feedBinary: (d) => controller.feedBinary(d),
        reset: () => controller.reset(),
        close: () => controller.close(),
      };
    };

    const useWorker = streamWorkerEnabled() && supportsOffscreenWorker() && !workerDisabledRef.current;
    let sink: StreamSink;
    if (useWorker && canvasRef.current) {
      try {
        workerRenderedRef.current = false;
        sink = createStreamWorkerClient(canvasRef.current, {
          onKeyframe: (reason) => requestKeyframe(reason),
          onConfig: () => setReconnecting(false),
          onRendered: () => { workerRenderedRef.current = true; },
        });
        // Self-heal: if the worker never paints a frame, abandon it and remount
        // onto the main-thread path so the user is never left on a black canvas.
        renderCheckTimer = setTimeout(() => {
          if (!workerRenderedRef.current) {
            console.error('[DeviceViewer] stream worker produced no frames — falling back to main thread', { deviceId });
            workerDisabledRef.current = true;
            setCanvasGen((g) => g + 1);
          }
        }, 5000);
      } catch (e) {
        console.error('[DeviceViewer] stream worker init failed — using main thread', { deviceId, error: (e as Error)?.message });
        workerDisabledRef.current = true;
        sink = makeMainThreadSink();
      }
    } else {
      sink = makeMainThreadSink();
    }
    sinkRef.current = sink;

    const unsub = ws.subscribeBinary((data: ArrayBuffer) => sink.feedBinary(data));

    return () => {
      if (watchdogTimer) clearInterval(watchdogTimer);
      if (renderCheckTimer) clearTimeout(renderCheckTimer);
      unsub();
      sink.close();
      sinkRef.current = null;
    };
  }, [ws, supported, deviceId, viewerId, isEmulator, canvasGen]);

  useEffect(() => {
    if (isEmulator) return;
    return ws.subscribe('device-stream-started', (msg: any) => {
      if (msg.deviceId !== deviceId) return;
      if (msg.screenWidth && msg.screenHeight) {
        const dims = { width: msg.screenWidth, height: msg.screenHeight };
        screenDimsRef.current = dims;
        setReservedDims(dims);
        try { localStorage.setItem(cachedResKey, JSON.stringify(dims)); } catch { /* private mode */ }
      }
      onStreamReady?.({
        screenWidth: msg.screenWidth,
        screenHeight: msg.screenHeight,
        backend: msg.backend,
      });
    });
  }, [ws, deviceId, onStreamReady, isEmulator]);

  useEffect(() => {
    if (isEmulator) return;
    if (!onError) return;
    return ws.subscribe('device-stream-error', (msg: any) => {
      if (msg.deviceId !== deviceId) return;
      onError(msg.error ?? 'Stream error');
    });
  }, [ws, deviceId, onError, isEmulator]);

  useEffect(() => {
    if (isEmulator) return;
    return ws.subscribe('video-reset', (msg: any) => {
      if (msg.deviceId !== deviceId) return;
      setReconnecting(true);
      // The backend is intentionally restarting the stream — its per-viewer
      // counter is about to start over. Reset the sink so gap detection, the
      // keyframe-request debounce, and the watchdog clock all start fresh and
      // the next frame is treated as a new reference.
      sinkRef.current?.reset();
    });
  }, [ws, deviceId, isEmulator]);

  useEffect(() => {
    if (isEmulator) return;
    return ws.subscribe('video-config-change', (msg: any) => {
      if (msg.deviceId !== deviceId) return;
      if (typeof msg.tier === 'number') setVideoTier(msg.tier);
      if (typeof msg.bitrate === 'number') setVideoBitrate(msg.bitrate);
    });
  }, [ws, deviceId, isEmulator]);

  useEffect(() => {
    if (!reconnecting) {
      setResetSticky(false);
      return;
    }
    setResetSticky(true);
    const t = setTimeout(() => setResetSticky(false), 5000);
    return () => clearTimeout(t);
  }, [reconnecting]);

  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    ws.sendRestApi('GET', `/v1/device/view/${encodeURIComponent(deviceId)}`).then(res => {
      if (cancelled) return;
      const p = res.body?.data?.platform;
      if (p === 'android' || p === 'ios') setPlatform(p);
    }).catch(() => {/* fall through — safer to show Android-superset */});
    return () => { cancelled = true; };
  }, [ws, deviceId]);

  // Keyboard forwarding for emulator mode. The WebRTC <Emulator> doesn't
  // capture keys and the emulator's adb input path fails, so we forward
  // keystrokes over the same gRPC channel as mouse (sendKey). Browser
  // shortcuts + form fields are left alone.
  useEffect(() => {
    if (!isEmulator) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t?.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;      // browser shortcuts
      if (/^F\d{1,2}$/.test(e.key)) return;                 // function keys
      e.preventDefault();
      emulatorVideoRef.current?.sendKey(e.key);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isEmulator]);

  const isAndroid = platform !== 'ios'; // default = Android-superset until we know otherwise

  const healthState: HealthState =
    reconnecting || resetSticky ? 'resetting' :
    videoTier >= 2 ? 'degraded' : 'healthy';

  const iconSize = 16;
  const primaryExtras = (extraActions ?? []).filter(a => a.placement === 'primary');

  const overflowButtons: ButtonListItem[] = [
    ...(isAndroid ? [{
      id: 'core:stop-all',
      label: 'Stop all apps',
      icon: 'x-circle',
      onClick: () => runCommand('stopall'),
    }] : []),
    ...(isAndroid && !isEmulator ? [{
      id: 'core:retry-stream',
      label: 'Retry stream',
      icon: 'refresh-cw',
      onClick: handleRetryStream,
    }] : []),
    ...(extraActions ?? [])
      .filter(a => a.placement !== 'primary')
      .map(a => ({
        id: a.key,
        label: a.label,
        icon: '',
        onClick: a.onClick,
        disabled: a.disabled,
      })),
  ];
  return (
    <div className={className}>
      {/* Canvas container — max-height clamps the rendered size so the video can't exceed
          ~viewport height on a wide layout (DeviceView page). maxWidth+maxHeight on the
          canvas itself preserves aspect ratio as a replaced element. reservedDims
          gives the container an aspect ratio from the last-known device resolution,
          so buttons below don't reflow when the first frame arrives. */}
      <div className="device-viewer-canvas-wrap" style={{
        display: 'flex', justifyContent: 'center', alignItems: 'center',
        background: '#000', maxHeight: 'calc(100vh - 200px)', overflow: 'hidden',
        ...(reservedDims ? { aspectRatio: `${reservedDims.width} / ${reservedDims.height}` } : {}),
        flexDirection: 'column',
      }}>
        {isEmulator ? (
          // Emulator mode: WebRTC video (with png fallback) over gRPC. The
          // <Emulator> captures mouse itself; controls route to sendKey.
          <EmulatorVideo
            ref={emulatorVideoRef}
            serial={deviceId}
            grpcWebPath={webrtcGrpcPath!}
            onReady={() => onStreamReady?.({ screenWidth: 0, screenHeight: 0, backend: 'webrtc' })}
            onError={(e) => onError?.(e.message)}
          />
        ) : (
          <>
            {supported === false && (
              <div className="device-viewer-unsupported">
                Live video requires a modern browser (Chrome 94+, Firefox 130+, Safari 16.4+, Edge 94+).
                Touch and screenshot still work.
              </div>
            )}
            <canvas
              key={canvasGen}
              ref={canvasRef}
              style={{
                maxWidth: '100%', maxHeight: 'calc(100vh - 200px)', cursor: 'pointer', display: 'block',
                ...(supported === false ? { visibility: 'hidden', position: 'absolute', pointerEvents: 'none' } : {}),
              }}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
            />
            {reconnecting && <div className="device-viewer-reconnecting">Reconnecting…</div>}
          </>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, padding: '6px', justifyContent: 'center', flexWrap: 'wrap', alignItems: 'center' }}>
        <DeviceNavButtons onNav={handleNav} isAndroid={isAndroid} iconSize={iconSize} />
        {isAndroid && <button className="btn btn-sm" data-testid="dv-cmd-unlock" title="Unlock" onClick={() => runCommand('unlock')}><UnlockIcon size={iconSize} /></button>}
        <button ref={swipeTriggerRef} className="btn btn-sm" data-testid="dv-swipe" title="Swipe" onClick={() => setSwipeOpen(o => !o)}><Move size={iconSize} /></button>
        <button className="btn btn-sm" data-testid="dv-screenshot" title="Screenshot" onClick={handleScreenshot}><Camera size={iconSize} /></button>
        {primaryExtras.map(a => (
          <button
            key={a.key}
            className="btn btn-sm"
            data-testid={`dv-extra-${a.key}`}
            title={a.label}
            disabled={a.disabled}
            onClick={a.onClick}
          >{a.icon}</button>
        ))}
        {!isEmulator && <VideoQualitySelector onChange={handleQualityChange} autoTier={videoTier} />}
        {!isEmulator && <VideoHealthIndicator state={healthState} tier={videoTier} bitrate={videoBitrate} />}
        <button ref={overflowTriggerRef} className="btn btn-sm" data-testid="dv-overflow" title="More" onClick={() => setOverflowOpen(o => !o)}><MoreHorizontal size={iconSize} /></button>
      </div>

      <Popover anchorRef={swipeTriggerRef} open={swipeOpen} onClose={() => setSwipeOpen(false)}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, auto)', gap: 4 }}>
          <span /><button className="btn btn-sm" data-testid="dv-swipe-up" onClick={() => handleSwipe('up')}><ArrowUp size={iconSize} /></button><span />
          <button className="btn btn-sm" data-testid="dv-swipe-left" onClick={() => handleSwipe('left')}><ArrowLeft size={iconSize} /></button>
          <span />
          <button className="btn btn-sm" data-testid="dv-swipe-right" onClick={() => handleSwipe('right')}><ArrowRight size={iconSize} /></button>
          <span /><button className="btn btn-sm" data-testid="dv-swipe-down" onClick={() => handleSwipe('down')}><ArrowDown size={iconSize} /></button><span />
        </div>
      </Popover>

      <Popover anchorRef={overflowTriggerRef} open={overflowOpen} align="end" onClose={() => setOverflowOpen(false)}>
        <ButtonList
          id="device-viewer:overflow-actions"
          className="button-list-vertical"
          buttons={overflowButtons}
        />
      </Popover>
    </div>
  );
}
