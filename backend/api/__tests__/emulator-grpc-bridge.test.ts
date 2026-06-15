import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import request from 'supertest';
import express from 'express';
import {
  registerEmulatorGrpcBridge,
  encodeGrpcWebFrame,
  decodeFirstGrpcWebMessage,
  encodeTrailer,
  Base64StreamEncoder,
  type GrpcUpstream,
} from '../emulator-grpc-bridge';
import { clearEndpoints, getApiRouter, getRegisteredEndpoints } from '../api-service';
import { createTestDb } from '../../test-utils/create-test-db';
import { createAuthMiddleware } from '../../auth/middleware';
import { users, apiKeys } from '../../db/schema';

// ---- framing helpers (pure) ----
describe('grpc-web framing', () => {
  it('encodes a data frame as [flag][BE32 len][payload] and round-trips', () => {
    const payload = Buffer.from('hello-emulator');
    const frame = encodeGrpcWebFrame(0x00, payload);
    expect(frame[0]).toBe(0x00);
    expect(frame.readUInt32BE(1)).toBe(payload.length);
    expect(decodeFirstGrpcWebMessage(frame).equals(payload)).toBe(true);
  });

  it('decodes an empty/short body to an empty message (no-arg RPCs)', () => {
    expect(decodeFirstGrpcWebMessage(Buffer.alloc(0)).length).toBe(0);
    expect(decodeFirstGrpcWebMessage(encodeGrpcWebFrame(0x00, Buffer.alloc(0))).length).toBe(0);
  });

  it('encodes a trailer frame with the high-bit flag and %-encoded message', () => {
    const t = encodeTrailer(0, 'OK done');
    expect(t[0]).toBe(0x80);
    const text = t.subarray(5).toString('utf8');
    expect(text).toContain('grpc-status:0');
    expect(text).toContain('grpc-message:OK%20done');
  });

  it('Base64StreamEncoder concatenated output decodes to the exact byte stream', () => {
    const enc = new Base64StreamEncoder();
    // Chunk on non-3-aligned boundaries to exercise the carry.
    const parts = [Buffer.from([1, 2]), Buffer.from([3, 4, 5, 6, 7]), Buffer.from([8])];
    let b64 = '';
    for (const p of parts) b64 += enc.push(p);
    b64 += enc.flush();
    const decoded = Buffer.from(b64, 'base64');
    expect(decoded.equals(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))).toBe(true);
  });
});

// ---- handler ----
/** A fake upstream that replays a scripted sequence of events on the call. */
function scriptedUpstream(script: Array<{ data?: Buffer; status?: { code: number; details: string }; error?: any }>) {
  const calls: Array<{ method: string; req: Buffer }> = [];
  const cancel = vi.fn();
  const close = vi.fn();
  const createUpstream = vi.fn((_host: string, _port: number, _token?: string): GrpcUpstream => ({
    serverStream(method: string, requestMessage: Buffer) {
      calls.push({ method, req: requestMessage });
      const handlers: Record<string, (a: any) => void> = {};
      setImmediate(() => {
        for (const step of script) {
          if (step.data) handlers.data?.(step.data);
          else if (step.error) handlers.error?.(step.error);
          else if (step.status) handlers.status?.(step.status);
        }
      });
      return { on(ev: any, cb: any) { handlers[ev] = cb; }, cancel };
    },
    close,
  }));
  return { createUpstream, calls, cancel, close };
}

/** supertest parser that returns the raw response bytes as a Buffer. */
function rawParser(res: any, cb: (err: any, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

function makeApp(repo: any, registry: any, deps: any) {
  clearEndpoints();
  registerEmulatorGrpcBridge(repo, registry, deps);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

const RUNNING_ROW = { id: 11, providerId: 'docker-android', runtimeId: 'cid', serial: 'localhost:32771', state: 'running' };
// The bridge resolves the gRPC instance via resolveGrpcInstance → listBySerial +
// a provider that declares videoTransport:'webrtc' AND getGrpcEndpoint.
function repoWith(row: any) { return { listBySerial: vi.fn().mockReturnValue(row ? [row] : []) }; }
function registryWithEndpoint(ep: any) {
  return { get: vi.fn().mockReturnValue({ videoTransport: 'webrtc', getGrpcEndpoint: vi.fn().mockResolvedValue(ep) }) };
}

describe('emulator grpc-web bridge handler', () => {
  beforeEach(() => clearEndpoints());

  // Errors are conveyed as grpc-web status trailers (HTTP 200) — NOT JSON with a
  // 4xx/5xx status, which would make the grpc-web client throw
  // "Unknown Content-type received." grpc codes: NOT_FOUND=5, FAILED_PRECONDITION=9, UNAVAILABLE=14.
  it('returns a grpc-web NOT_FOUND trailer when the serial maps to no instance', async () => {
    const app = makeApp(repoWith(null), { get: vi.fn() }, scriptedUpstream([]));
    const res = await request(app).post('/v1/devices/localhost%3A32771/grpc/svc/M')
      .set('Content-Type', 'application/grpc-web+proto').send(Buffer.alloc(0)).buffer(true).parse(rawParser);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/grpc-web');
    expect((res.body as Buffer).subarray(5).toString('utf8')).toContain('grpc-status:5');
  });

  it('returns a grpc-web NOT_FOUND trailer when no instance for the serial is gRPC-capable', async () => {
    // A row exists but its provider doesn't declare webrtc/getGrpcEndpoint (e.g.
    // only a stale adb-device row) → no gRPC-capable instance → NOT_FOUND.
    const registry = { get: vi.fn().mockReturnValue({ id: 'adb-device' /* no videoTransport */ }) };
    const app = makeApp(repoWith(RUNNING_ROW), registry, scriptedUpstream([]));
    const res = await request(app).post('/v1/devices/localhost%3A32771/grpc/svc/M')
      .set('Content-Type', 'application/grpc-web+proto').send(Buffer.alloc(0)).buffer(true).parse(rawParser);
    expect(res.status).toBe(200);
    expect((res.body as Buffer).subarray(5).toString('utf8')).toContain('grpc-status:5');
  });

  it('returns a grpc-web UNAVAILABLE trailer when the endpoint cannot be resolved (e.g. not running)', async () => {
    const registry = { get: vi.fn().mockReturnValue({ videoTransport: 'webrtc', getGrpcEndpoint: vi.fn().mockRejectedValue(new Error('not running')) }) };
    const app = makeApp(repoWith(RUNNING_ROW), registry, scriptedUpstream([]));
    const res = await request(app).post('/v1/devices/localhost%3A32771/grpc/svc/M')
      .set('Content-Type', 'application/grpc-web+proto').send(Buffer.alloc(0)).buffer(true).parse(rawParser);
    expect(res.status).toBe(200);
    expect((res.body as Buffer).subarray(5).toString('utf8')).toContain('grpc-status:14');
  });

  it('forwards the decoded request, injects token, and streams framed responses + trailer (binary)', async () => {
    const up = scriptedUpstream([
      { data: Buffer.from('frame-A') },
      { data: Buffer.from('frame-B') },
      { status: { code: 0, details: '' } },
    ]);
    const app = makeApp(
      repoWith(RUNNING_ROW),
      registryWithEndpoint({ host: '127.0.0.1', port: 34567, token: 'tok-xyz' }),
      up,
    );
    const reqMsg = Buffer.from('the-request-proto');
    const res = await request(app)
      .post('/v1/devices/localhost%3A32771/grpc/android.emulation.control.Rtc/requestRtcStream')
      .set('Content-Type', 'application/grpc-web+proto')
      .send(encodeGrpcWebFrame(0x00, reqMsg))
      .buffer(true)
      .parse(rawParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/grpc-web+proto');
    // Upstream dialled with the resolved endpoint + token, correct method + body.
    expect(up.createUpstream).toHaveBeenCalledWith('127.0.0.1', 34567, 'tok-xyz');
    expect(up.calls[0].method).toBe('/android.emulation.control.Rtc/requestRtcStream');
    expect(up.calls[0].req.equals(reqMsg)).toBe(true);
    // Response = frame(A) + frame(B) + trailer(status 0).
    const body: Buffer = res.body;
    const expected = Buffer.concat([
      encodeGrpcWebFrame(0x00, Buffer.from('frame-A')),
      encodeGrpcWebFrame(0x00, Buffer.from('frame-B')),
      encodeTrailer(0, ''),
    ]);
    expect(body.equals(expected)).toBe(true);
  });

  it('maps an upstream error into a trailer with the gRPC status code', async () => {
    const up = scriptedUpstream([{ error: { code: 16, details: 'UNAUTHENTICATED' } }]);
    const app = makeApp(repoWith(RUNNING_ROW), registryWithEndpoint({ host: '127.0.0.1', port: 1 }), up);
    const res = await request(app)
      .post('/v1/devices/localhost%3A32771/grpc/svc/M')
      .set('Content-Type', 'application/grpc-web+proto')
      .send(encodeGrpcWebFrame(0x00, Buffer.alloc(0)))
      .buffer(true)
      .parse(rawParser);
    const text = (res.body as Buffer).subarray(5).toString('utf8');
    expect(text).toContain('grpc-status:16');
  });

  it('handles grpc-web-text: base64 request in, base64 frames+trailer out', async () => {
    const up = scriptedUpstream([
      { data: Buffer.from('hello') },
      { status: { code: 0, details: '' } },
    ]);
    const app = makeApp(repoWith(RUNNING_ROW), registryWithEndpoint({ host: '127.0.0.1', port: 9 }), up);
    const reqMsg = Buffer.from('req');
    const b64Req = encodeGrpcWebFrame(0x00, reqMsg).toString('base64');
    const res = await request(app)
      .post('/v1/devices/localhost%3A32771/grpc/svc/M')
      .set('Content-Type', 'application/grpc-web-text')
      .send(b64Req)
      .buffer(true)
      .parse(rawParser);

    expect(res.headers['content-type']).toContain('grpc-web-text');
    // Upstream saw the decoded request message.
    expect(up.calls[0].req.equals(reqMsg)).toBe(true);
    // Decode the whole base64 response → frame(hello) + trailer(0).
    const decoded = Buffer.from((res.body as Buffer).toString('utf8'), 'base64');
    const expected = Buffer.concat([encodeGrpcWebFrame(0x00, Buffer.from('hello')), encodeTrailer(0, '')]);
    expect(decoded.equals(expected)).toBe(true);
  });

  // Client navigated away / closed the tab mid-stream → the bridge must cancel
  // the upstream gRPC call (res.on('close') → call.cancel() + upstream.close()),
  // otherwise the emulator keeps streaming WebRTC frames into a dead socket.
  //
  // We drive the registered handler directly with a fake req/res rather than over
  // HTTP: an upstream that opens the stream but never emits status (stays open
  // until cancelled), then we fire res 'close' and assert the upstream was
  // cancelled. This fails if the res.on('close') → call.cancel() wiring is removed.
  it('cancels the upstream gRPC call when the client disconnects mid-stream', async () => {
    let statusHandler: ((s: { code: number; details: string }) => void) | undefined;
    const cancel = vi.fn();
    const close = vi.fn();
    const createUpstream = vi.fn((): GrpcUpstream => ({
      serverStream() {
        // Never auto-finalizes: no 'status'/'error' is emitted, so the only way
        // the call ends is the client-disconnect cancel path under test.
        return {
          on(ev: any, cb: any) { if (ev === 'status') statusHandler = cb; },
          cancel,
        };
      },
      close,
    }));

    clearEndpoints();
    registerEmulatorGrpcBridge(
      repoWith(RUNNING_ROW),
      registryWithEndpoint({ host: '127.0.0.1', port: 5555 }),
      { createUpstream },
    );
    const handler = getRegisteredEndpoints().find(e => e.path === '/v1/devices/:serial/grpc/*')!.handler;

    // Fake req: a Buffer body (readRawBody short-circuits on Buffer.isBuffer).
    const req: any = {
      params: { serial: 'localhost:32771', 0: 'svc/M' },
      headers: { 'content-type': 'application/grpc-web+proto' },
      body: encodeGrpcWebFrame(0x00, Buffer.alloc(0)),
    };
    // Fake res: an EventEmitter with the handler's res surface.
    const res: any = new EventEmitter();
    res.status = vi.fn(() => res);
    res.setHeader = vi.fn(() => res);
    res.flushHeaders = vi.fn();
    res.write = vi.fn();
    res.end = vi.fn();

    await handler(req, res);

    // Stream is live (upstream opened, no status yet → not finalized).
    expect(createUpstream).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    expect(statusHandler).toBeTypeOf('function'); // handler did wire the upstream

    // Client closes the connection mid-stream.
    res.emit('close');

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalled();
    // It must NOT write a trailer/end the response after a client-side close.
    expect(res.end).not.toHaveBeenCalled();
  });
});

// ---- auth / scope gate (M4) ----
// The grpc-web bridge handler itself does no auth: it relies on the global auth
// middleware (sets req.authUser / 401s the unauthenticated) plus the per-endpoint
// `requires: ['core.devices:read']` scope check in api-service (403s the
// under-scoped). These bypass-the-real-middleware handler tests above never
// exercise that gate, so here we wire the REAL createAuthMiddleware + getApiRouter
// the same way backend/auth/init.ts does, against a seeded test DB.
//
// We use the API-key auth path (Bearer darkride_pat_…) because it needs no
// cookie/CSRF plumbing: a key row whose sha256 == the plaintext, owned by a user,
// and effectiveScopes = key.scopes ∩ user.scopes. This is a real 401/403 from the
// production middleware, NOT a registration-layer assertion — so it fails closed
// if `requires` is dropped from the registration (403 case) or if the route is
// ever allowlisted / the gate removed (401 case).
describe('emulator grpc-web bridge auth gate (M4)', () => {
  const PAT = 'darkride_pat_test_key_abc123';
  const keyHash = createHash('sha256').update(PAT).digest('hex');

  function appWithAuth(db: any): express.Express {
    clearEndpoints();
    // On the happy path the handler runs the upstream; emit an immediate status so
    // the grpc-web stream finalizes and supertest sees `end`. On the 401/403 paths
    // the handler is never reached, so this is just a harmless stub.
    registerEmulatorGrpcBridge(
      repoWith(RUNNING_ROW),
      registryWithEndpoint({ host: '127.0.0.1', port: 1 }),
      scriptedUpstream([{ status: { code: 0, details: '' } }]),
    );
    const app = express();
    app.use(express.json());
    // Mirror backend/auth/init.ts: the grpc bridge path is NOT allowlisted.
    app.use(createAuthMiddleware(db, ['/v1/auth', '/health']));
    app.use(getApiRouter());
    return app;
  }

  function seedUser(db: any, userScopes: string[]): void {
    const now = new Date();
    // Let SQLite assign the user id (matches the repo's other auth-test seeders)
    // and thread it into the api key, rather than hardcoding id: 1.
    const inserted = db.insert(users).values({
      username: 'alice', providerId: 'local', scopes: userScopes,
      enabled: true, createdAt: now, updatedAt: now,
    }).run();
    const userId = Number(inserted.lastInsertRowid);
    db.insert(apiKeys).values({
      userId, name: 'test', keyHash, keyPrefix: 'darkride_pat_test',
      scopes: userScopes, createdAt: now,
    }).run();
  }

  it('rejects an unauthenticated grpc-web request with 401', async () => {
    const db = createTestDb([users, apiKeys]);
    const res = await request(appWithAuth(db))
      .post('/v1/devices/localhost%3A32771/grpc/svc/M')
      .set('Content-Type', 'application/grpc-web+proto')
      .send(encodeGrpcWebFrame(0x00, Buffer.alloc(0)));
    expect(res.status).toBe(401);
  });

  it('rejects an authenticated request lacking core.devices:read with 403', async () => {
    const db = createTestDb([users, apiKeys]);
    // Authenticated, but only holds an unrelated scope → effectiveScopes lacks core.devices:read.
    seedUser(db, ['core.apps:read']);
    const res = await request(appWithAuth(db))
      .post('/v1/devices/localhost%3A32771/grpc/svc/M')
      .set('Authorization', `Bearer ${PAT}`)
      .set('Content-Type', 'application/grpc-web+proto')
      .send(encodeGrpcWebFrame(0x00, Buffer.alloc(0)));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ missing: ['core.devices:read'] });
  });

  it('admits an authenticated request that holds core.devices:read', async () => {
    const db = createTestDb([users, apiKeys]);
    seedUser(db, ['core.devices:read']);
    const res = await request(appWithAuth(db))
      .post('/v1/devices/localhost%3A32771/grpc/svc/M')
      .set('Authorization', `Bearer ${PAT}`)
      .set('Content-Type', 'application/grpc-web+proto')
      .send(encodeGrpcWebFrame(0x00, Buffer.alloc(0)))
      .buffer(true)
      .parse(rawParser);
    // Passes the gate → handler runs → grpc-web 200 with a status trailer (here
    // the scripted upstream emits no events so the empty stream is fine; the
    // point is we got past 401/403 into the handler, not the trailer contents).
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/grpc-web');
  });
});
