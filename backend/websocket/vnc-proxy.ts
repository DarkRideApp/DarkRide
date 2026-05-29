import * as net from 'net';
import type { WebSocket } from 'ws';
import { createLoggers } from '../logs';

const { log, error: logError } = createLoggers('vnc-proxy');

export interface VncEndpoint {
  host: string;
  port: number;
}

export interface VncBridgeDeps {
  /** Resolve a device serial to a loopback VNC endpoint. Returns null for unknown serials. */
  resolveEndpoint(serial: string): Promise<VncEndpoint | null>;
  /** Open a TCP socket to the given endpoint. Defaulted to net.connect; injected for tests. */
  connectTcp(host: string, port: number): net.Socket;
}

/**
 * Bridge a single WebSocket connection to a TCP socket on the resolved
 * VNC endpoint. Bytes pass through verbatim — RFB is binary, no framing
 * translation is needed. Lifecycle is symmetric: either side closing
 * tears down the other.
 *
 * Errors at handshake time close the WebSocket with structured codes:
 * - 1008 (policy violation) if the serial doesn't resolve.
 * - 1011 (internal error) if resolveEndpoint throws (container not
 *   running, port not bound, etc.) — the underlying error message is
 *   sent as the close reason.
 *
 * Mid-stream TCP closures close the WS with 1001 (going away).
 */
export async function createVncBridge(
  ws: WebSocket,
  serial: string,
  deps: VncBridgeDeps,
): Promise<void> {
  let endpoint: VncEndpoint | null;
  try {
    endpoint = await deps.resolveEndpoint(serial);
  } catch (e: any) {
    const reason = (e?.message ?? String(e)).slice(0, 120);
    logError(`vnc bridge: resolveEndpoint(${serial}) threw: ${reason}`);
    ws.close(1011, reason);
    return;
  }
  if (!endpoint) {
    ws.close(1008, `unknown serial: ${serial}`);
    return;
  }

  const tcp = deps.connectTcp(endpoint.host, endpoint.port);
  log(`vnc bridge ${serial} → ${endpoint.host}:${endpoint.port} opened`);

  let torndown = false;
  const teardown = (origin: 'ws' | 'tcp', code: number, reason: string) => {
    if (torndown) return;
    torndown = true;
    log(`vnc bridge ${serial}: torn down by ${origin} (${code} ${reason})`);
    try { tcp.destroy(); } catch { /* best effort */ }
    try { ws.close(code, reason); } catch { /* best effort */ }
  };

  ws.on('message', (data: Buffer) => {
    // ws library always delivers messages as Buffer for binary frames.
    try { tcp.write(data); } catch (e: any) { logError(`vnc bridge ${serial}: tcp.write failed: ${e.message}`); }
  });
  ws.on('close', () => teardown('ws', 1000, 'ws closed'));
  ws.on('error', (e: any) => teardown('ws', 1011, `ws error: ${e.message}`));

  tcp.on('data', (chunk: Buffer) => {
    try { ws.send(chunk); } catch (e: any) { logError(`vnc bridge ${serial}: ws.send failed: ${e.message}`); }
  });
  tcp.on('close', () => teardown('tcp', 1001, 'tcp closed'));
  tcp.on('error', (e: any) => teardown('tcp', 1011, `tcp error: ${e.message}`));
}

/** Default TCP connector. Tests inject a synthetic one. */
export function defaultConnectTcp(host: string, port: number): net.Socket {
  return net.connect({ host, port });
}
