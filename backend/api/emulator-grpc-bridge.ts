import type { Request, Response } from 'express';
import * as grpc from '@grpc/grpc-js';
import { registerEndpoint } from './api-service';
import type { ProviderRegistry } from '../services/providers';
import type { DeviceInstancesRepo } from '../services/device-instances-repo';
import { createLoggers } from '../logs';

const { log, error: logError } = createLoggers('emulator-grpc-bridge');

/**
 * grpc-web ⇄ gRPC bridge for the emulator WebRTC video path.
 *
 * The browser's `android-emulator-webrtc` <Emulator> component speaks grpc-web
 * (HTTP) to the EmulatorController + Rtc services. Browsers can't speak raw
 * gRPC, so this endpoint — mounted on the DarkRide origin behind the normal
 * session auth — translates grpc-web ⇄ gRPC and forwards to the emulator's
 * loopback gRPC endpoint (resolved per-serial via the provider), injecting the
 * console token. Single origin, single auth surface, no Envoy/Firebase.
 *
 * Why this is method-agnostic: grpc-web only supports **unary** and
 * **server-streaming** calls — both send exactly ONE request message. So every
 * call is handled identically as "decode the one request message → open a
 * server-streaming upstream call → stream framed responses back → trailer".
 * A unary RPC simply yields one response message before its status. No
 * per-method streaming-type table is required.
 */

const DATA_FLAG = 0x00;
const TRAILER_FLAG = 0x80;

/** Frame a grpc-web message: [1-byte flag][4-byte BE length][payload]. */
export function encodeGrpcWebFrame(flag: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(flag, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

/**
 * Decode the first data frame's payload from a grpc-web request body. Browser
 * clients send exactly one request message; we ignore anything trailing.
 * Returns an empty Buffer for an empty/short body (valid for no-arg RPCs).
 */
export function decodeFirstGrpcWebMessage(body: Buffer): Buffer {
  if (body.length < 5) return Buffer.alloc(0);
  const len = body.readUInt32BE(1);
  return body.subarray(5, 5 + len);
}

/** A grpc-web trailers frame carrying the final grpc-status/message. */
export function encodeTrailer(status: number, message: string): Buffer {
  // Trailer payload is HTTP/1-style header lines. grpc-message is %-encoded
  // per the gRPC spec so CRLFs/non-ASCII in details can't corrupt the frame.
  const text = `grpc-status:${status}\r\ngrpc-message:${encodeURIComponent(message ?? '')}\r\n`;
  return encodeGrpcWebFrame(TRAILER_FLAG, Buffer.from(text, 'utf8'));
}

/**
 * Streaming base64 encoder for grpc-web-text responses. Naive per-write
 * base64 would corrupt the stream because base64 must align to 3-byte groups;
 * this carries the 0–2 leftover bytes between writes so the concatenated
 * output decodes back to the exact frame byte stream.
 */
export class Base64StreamEncoder {
  private rem = Buffer.alloc(0);
  push(buf: Buffer): string {
    const data = this.rem.length ? Buffer.concat([this.rem, buf]) : buf;
    const usable = data.length - (data.length % 3);
    this.rem = Buffer.from(data.subarray(usable));
    return data.subarray(0, usable).toString('base64');
  }
  flush(): string {
    const out = this.rem.length ? this.rem.toString('base64') : '';
    this.rem = Buffer.alloc(0);
    return out;
  }
}

/** One upstream server-streaming call. Mirrors the slice of grpc-js we use. */
export interface UpstreamCall {
  on(event: 'data', cb: (chunk: Buffer) => void): void;
  on(event: 'error', cb: (err: { code?: number; details?: string; message?: string }) => void): void;
  on(event: 'status', cb: (status: { code: number; details: string }) => void): void;
  cancel(): void;
}

/** A connection to one emulator's gRPC endpoint. */
export interface GrpcUpstream {
  serverStream(method: string, requestMessage: Buffer): UpstreamCall;
  close(): void;
}

export interface EmulatorGrpcBridgeDeps {
  /** Override for tests — default dials the real emulator gRPC over loopback. */
  createUpstream?: (host: string, port: number, token?: string) => GrpcUpstream;
}

const identity = (b: Buffer): Buffer => b;

/**
 * Send a grpc-web *error* the client can parse: HTTP 200 with a content-type it
 * recognises and a single trailer frame carrying the grpc-status. Returning a
 * JSON body with a 4xx/5xx status instead makes the grpc-web client throw
 * "Unknown Content-type received." Used when we can't even reach the upstream
 * (unknown serial, no gRPC capability, endpoint not resolvable).
 */
function sendGrpcWebError(res: Response, isText: boolean, code: number, message: string): void {
  res.status(200);
  res.setHeader('Content-Type', isText ? 'application/grpc-web-text+proto' : 'application/grpc-web+proto');
  res.setHeader('X-Grpc-Web', '1');
  const trailer = encodeTrailer(code, message);
  res.end(isText ? trailer.toString('base64') : trailer);
}

function defaultCreateUpstream(host: string, port: number, token?: string): GrpcUpstream {
  // Loopback, no TLS — the endpoint is host-loopback-only and the container
  // forwarder fronts the emulator's localhost gRPC. Auth is the console token.
  const client = new grpc.Client(`${host}:${port}`, grpc.credentials.createInsecure());
  return {
    serverStream(method, requestMessage) {
      const md = new grpc.Metadata();
      if (token) md.set('authorization', `Bearer ${token}`);
      const call = client.makeServerStreamRequest(method, identity, identity, requestMessage, md);
      return {
        on(event: any, cb: any) { call.on(event, cb); },
        cancel() { try { call.cancel(); } catch { /* already torn down */ } },
      };
    },
    close() { try { client.close(); } catch { /* already closed */ } },
  };
}

/** Read the raw request body. express.json/urlencoded skip grpc-web content
 *  types, so the stream is intact here. */
async function readRawBody(req: Request): Promise<Buffer> {
  if (Buffer.isBuffer((req as any).body)) return (req as any).body as Buffer;
  const chunks: Buffer[] = [];
  for await (const chunk of req as any) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export function registerEmulatorGrpcBridge(
  repo: DeviceInstancesRepo,
  registry: ProviderRegistry,
  deps: EmulatorGrpcBridgeDeps = {},
): void {
  const createUpstream = deps.createUpstream ?? defaultCreateUpstream;

  // Wildcard captures the gRPC `<package.Service>/<Method>` path the browser
  // appends to the configured base uri.
  registerEndpoint('POST', '/v1/devices/:serial/grpc/*', async (req: Request, res: Response) => {
    const serial = req.params.serial;
    const methodPath = '/' + ((req.params as any)[0] ?? '');
    const isText = String(req.headers['content-type'] ?? '').includes('grpc-web-text');

    const row = repo.getBySerial(serial);
    if (!row) {
      sendGrpcWebError(res, isText, grpc.status.NOT_FOUND, `No instance for serial ${serial}`);
      return;
    }
    const provider = registry.get(row.providerId);
    if (!provider?.getGrpcEndpoint) {
      sendGrpcWebError(res, isText, grpc.status.FAILED_PRECONDITION, `Provider ${row.providerId} has no gRPC endpoint`);
      return;
    }

    let endpoint: { host: string; port: number; token?: string };
    try {
      endpoint = await provider.getGrpcEndpoint(row.runtimeId);
    } catch (err: any) {
      sendGrpcWebError(res, isText, grpc.status.UNAVAILABLE, err?.message ?? 'gRPC endpoint unavailable');
      return;
    }

    let body = await readRawBody(req);
    if (isText) body = Buffer.from(body.toString('utf8'), 'base64');
    const requestMessage = decodeFirstGrpcWebMessage(body);

    res.status(200);
    res.setHeader('Content-Type', isText ? 'application/grpc-web-text+proto' : 'application/grpc-web+proto');
    res.setHeader('X-Grpc-Web', '1');
    res.setHeader('Cache-Control', 'no-transform');
    (res as any).flushHeaders?.();

    const textEncoder = isText ? new Base64StreamEncoder() : null;
    const writeFrame = (flag: number, payload: Buffer) => {
      const frame = encodeGrpcWebFrame(flag, payload);
      res.write(textEncoder ? textEncoder.push(frame) : frame);
    };

    const upstream = createUpstream(endpoint.host, endpoint.port, endpoint.token);
    const call = upstream.serverStream(methodPath, requestMessage);

    let finalized = false;
    const finalize = (code: number, details: string) => {
      if (finalized) return;
      finalized = true;
      const trailer = encodeTrailer(code, details);
      if (textEncoder) {
        res.write(textEncoder.push(trailer));
        res.write(textEncoder.flush());
      } else {
        res.write(trailer);
      }
      res.end();
      upstream.close();
    };

    call.on('data', (chunk: Buffer) => writeFrame(DATA_FLAG, chunk));
    call.on('error', (err) => {
      // 'status' fires alongside 'error' in grpc-js and carries the code; we
      // finalize there. This handler exists so the EventEmitter error doesn't
      // throw, and as a fallback if 'status' never arrives.
      logError(`upstream gRPC error ${methodPath} (${serial}): ${err?.details ?? err?.message ?? err}`);
      finalize(typeof err?.code === 'number' ? err.code : grpc.status.UNKNOWN, err?.details ?? err?.message ?? 'upstream error');
    });
    call.on('status', (status) => finalize(status.code, status.details ?? ''));

    // Client navigated away / closed the tab — stop the upstream stream.
    res.on('close', () => {
      if (!finalized) { try { call.cancel(); } catch { /* noop */ } upstream.close(); }
    });

    log(`grpc-web ${methodPath} → ${endpoint.host}:${endpoint.port} (${serial}${isText ? ', text' : ''})`);
    // CSRF: grpc-web's non-simple content type is exempted in csrfProtection
    // (a cross-site forgery can't produce it without a disallowed preflight).
    // Auth is still enforced via the session cookie + core.devices:read scope.
  }, { requires: ['core.devices:read'] });
}
