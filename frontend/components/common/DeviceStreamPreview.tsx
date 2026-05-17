import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import type { DeviceStreamFrame } from '../../../shared/types/websocket';
import { H264Decoder } from '../../lib/video/h264-decoder';
import { decodeFrame, WireVersionMismatchError } from '../../lib/video/wire-format';

interface DeviceStreamPreviewProps {
  deviceId: string;
  onNavigate?: () => void;
}

export function DeviceStreamPreview({ deviceId, onNavigate }: DeviceStreamPreviewProps) {
  const ws = useWebSocket();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerIdRef = useRef(crypto.randomUUID());
  const [h264Supported, setH264Supported] = useState<boolean | null>(null);

  const renderFrame = useCallback((base64: string) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const img = new Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
    };
    img.src = `data:image/jpeg;base64,${base64}`;
  }, []);

  // Start/stop stream
  useEffect(() => {
    if (!ws.connected) return;
    ws.sendMessage('device-stream-start', { deviceId, viewerId: viewerIdRef.current });
    return () => { ws.sendMessage('device-stream-stop', { deviceId, viewerId: viewerIdRef.current }); };
  }, [ws, deviceId]);

  // JPEG path: minicap / adb-poll fallback streams (and all iOS streams) push
  // base64 JPEG frames over the `device-frame` channel. Always subscribed so
  // the preview keeps working when scrcpy can't bring up its H.264 pipeline.
  useEffect(() => {
    return ws.subscribe('device-frame', (msg: DeviceStreamFrame) => {
      if (msg.deviceId !== deviceId) return;
      renderFrame(msg.frame);
    });
  }, [ws, deviceId, renderFrame]);

  // Capability-detect WebCodecs VideoDecoder. Required to render the scrcpy
  // binary H.264 path. Without this the preview only sees the (often absent)
  // JPEG fallback — which is exactly the "black box" bug on modern Androids
  // where scrcpy is the only active backend.
  useEffect(() => {
    if (typeof (globalThis as any).VideoDecoder === 'undefined') {
      setH264Supported(false);
      return;
    }
    let cancelled = false;
    (globalThis as any).VideoDecoder.isConfigSupported({ codec: 'avc1.42E01E' })
      .then((r: any) => { if (!cancelled) setH264Supported(!!r.supported); })
      .catch(() => { if (!cancelled) setH264Supported(false); });
    return () => { cancelled = true; };
  }, []);

  // H.264 path: when scrcpy is the active backend, frames arrive as binary
  // WebSocket messages and need WebCodecs to decode. Preview-only flavour —
  // no keyframe watchdog or gap detection (those belong in the full
  // DeviceViewer; the drawer thumbnail can tolerate brief stalls).
  useEffect(() => {
    if (h264Supported !== true) return;

    const decoder = new H264Decoder({
      onFrame: (frame) => {
        const canvas = canvasRef.current;
        if (!canvas) { frame.close(); return; }
        const ctx = canvas.getContext('2d');
        if (!ctx) { frame.close(); return; }
        if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
        if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
        ctx.drawImage(frame, 0, 0);
        frame.close();
      },
      onError: (e) => { console.error('[DeviceStreamPreview] decode error', { deviceId, error: e?.message ?? String(e) }); },
    });

    const unsub = ws.subscribeBinary((data: ArrayBuffer) => {
      let frame;
      try {
        frame = decodeFrame(data);
      } catch (e) {
        if (e instanceof WireVersionMismatchError) {
          console.error('[DeviceStreamPreview] wire version mismatch', { deviceId, received: e.received, expected: e.expected });
        }
        return;
      }
      decoder.push(frame);
    });

    return () => {
      unsub();
      decoder.close();
    };
  }, [ws, h264Supported, deviceId]);

  return (
    <div className="live-log-stream" data-testid="device-stream-preview">
      <canvas
        ref={canvasRef}
        className="live-log-stream-canvas"
        onClick={onNavigate}
        title="Click to open device view"
      />
      <div className="live-log-stream-label">{deviceId}</div>
    </div>
  );
}
