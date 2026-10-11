# ADB Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let remote machines run stock `adb connect <host>:<port>` against Android devices attached to the DarkRide host, with each client's adb key approved in the DarkRide UI before it can reach a device.

**Architecture:** An in-process service (`backend/services/adb-proxy/`) with one persistent TCP port per online device. Each port speaks the ADB wire protocol as a device: it runs the RSA-key AUTH handshake, holds unknown keys as in-memory pending requests until approved, then turns each client stream into a fresh connection to the local ADB server (`host:transport:<serial>` plus the service string). A REST API, a filtered WebSocket channel and a settings page manage approvals.

**Tech Stack:** TypeScript on Node 24 (`node:net`, `node:crypto`), Express via `registerEndpoint`, Drizzle + better-sqlite3, React frontend, vitest (backend and frontend lanes), Playwright, the real `adb` binary for the conformance lane.

**Spec:** `docs/specs/2026-10-11-adb-proxy-design.md` (read it first; this plan implements it, including its "Revisions after approval").

## Global Constraints

Every task's requirements include this section. Values are copied from the spec.

- **Off by default.** Setting `adb_proxy.enabled` defaults to `false`; nothing listens until an admin enables it.
- **Settings keys and defaults:** `adb_proxy.enabled` = `false`, `adb_proxy.bind_host` = `0.0.0.0`, `adb_proxy.port_start` = `6500`, `adb_proxy.port_end` = `6599`.
- **Wire constants:** advertised version `0x01000001`, advertised max data 1 MiB (`1048576`), payload cap before auth 4 KiB (`4096`), at most 128 open streams per session, at most 3 signature attempts per connection, TCP keepalive 30 s.
- **Pre-auth limits:** at most 8 unauthenticated sockets per IP and 64 in total; 10 s from accept to a decided handshake (a held pending connection is exempt).
- **Pending requests:** memory only, never written to the DB; at most 20 in total; at most 3 new per IP per minute; a repeat attempt for the same (key, device) replaces the older one and does not use the rate budget; held for at most 5 minutes.
- **Keys:** only 2048-bit adb keys (524-byte blob, 64 words, exponent 65537). Identity (`key_id`) is the SHA-256 hex of the decoded blob. Display fingerprint is MD5 of the same bytes, uppercase hex pairs separated by colons. The key comment is capped at 128 characters with control characters stripped.
- **Possession:** a key offer (AUTH RSAPUBLICKEY) is only honoured when one signature this connection already sent verifies, over a token this connection was issued, under the offered key. A public key alone never authenticates, never creates a pending request and never replaces one.
- **Refused services** (reply `CLSE`): anything starting with `host`, `reverse:`, `tcpip:`, `usb:`.
- **Scopes:** `core.adb-proxy:read` (view) and `core.adb-proxy:manage` (approve, deny, revoke, change settings), category `Devices`.
- **Android only.** iOS devices are never proxied.
- **Commits:** conventional style (`feat(adb-proxy): ...`), end with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`, no session links, no `--no-verify`. The repo is public; the feature ships disabled. Push the branch after each task.
- **Test hygiene:** never touch a developer's running ADB server (port 5037) or `~/.android` keys. Tests that run the real `adb` use their own `HOME`, `ANDROID_USER_HOME` and `ANDROID_ADB_SERVER_PORT`.
- **Migrations:** a new journal entry's `when` must be greater than the maximum `when` of every existing entry (the journal is not sorted). Multi-statement files need `--> statement-breakpoint` between statements.
- **Comments:** one line, only where the reason is not obvious. No edit-history or narration comments. No em dashes, no filler vocabulary, in code, docs or commit messages.
- **Frontend is never type-checked** by `tsc` or Vite, so new frontend files get a throwaway `tsc` pass (Task 15 has the command).
- **Parallel work:** at most 3 agents at once, and run vitest on single files (`npx vitest run <file>`) or with `--maxWorkers=2`. A fresh worktree needs `npm run build -w @darkrideapp/plugin-sdk` once before backend tests.

## Review Focus

Failure modes the spec implies but the obvious tests would miss. Each has a test in the task named in brackets.

1. **A client that connects and sends nothing** (or stalls mid-handshake) must be dropped after the pre-auth budget and must give its per-IP slot back. [Task 9, Task 8]
2. **A key that is approved but whose device allow-list excludes this device** must be closed without creating a pending request. [Task 11, Task 12]
3. **Approving a request after its client already disconnected** must return not-found cleanly, throw nothing and leave no timer or promise behind. [Task 12]
4. **Unplug and replug on the same serial** must keep the same port, close the old sessions, and accept new connections after the device returns. [Task 12]
5. **A key comment containing markup or control characters** must reach the UI as plain text, never as HTML, and never break the table. [Task 3, Task 15]

## Order of work and what can run in parallel

| Wave | Tasks | Notes |
|---|---|---|
| 1 | 1 | Spike first. Its findings can change constants in later tasks. |
| 2 | 2, 3, 5 | Independent files. |
| 3 | 4, 6, 7 | Task 4 needs 2; 6 and 7 need 5. |
| 4 | 8, 9 | Task 9 needs 2, 3 and 4. |
| 5 | 10 | Same file as 9, so it follows it. |
| 6 | 11 | Needs 6, 8, 9, 10. |
| 7 | 12 | Needs 7 and 11. |
| 8 | 13 | Needs 12. |
| 9 | 14, 15 | Need 13 (the API contract). |
| 10 | 16, then 17 | Task 16 needs 13 and 15. |

## File Structure

New, under `backend/services/adb-proxy/`:

| File | Responsibility |
|---|---|
| `packet.ts` | ADB wire codec: constants, `encodePacket`, bounded streaming `PacketParser`. |
| `adb-key.ts` | Parse the adb public-key blob, fingerprint and key id, comment sanitising, signature verification. |
| `host-client.ts` | ADB host-protocol client for the local ADB server: bound service sockets, queries, device banner. |
| `session.ts` | One client connection: handshake state machine, stream table, flow control, services policy. |
| `listener.ts` | Thin `net.Server` wrapper per device. |
| `pending.ts` | In-memory pending requests with caps, rate limit, timeouts and decision promises. |
| `limits.ts` | Pre-auth connection limiter. |
| `throttle.ts` | Run a function at most once per interval (keeps a dead ADB server from flooding the log). |
| `key-store.ts` | Persisted key records. |
| `auth-gate.ts` | `AuthGate` implementation over key store and pending registry. |
| `settings.ts` | `adb_proxy.*` settings load, validate, save. |
| `port-allocator.ts` | Persistent port per device. |
| `device-directory.ts` | `DeviceDirectory` interface and the `DeviceManager` adapter. |
| `adb-proxy-service.ts` | Orchestrator, live-session registry, counters, status snapshot. |
| `testing/*.ts` | Test support: `fake-adb-server.ts`, `test-keys.ts`, `wire-client.ts`, `session-server.ts`. Not collected as tests. |
| `__fixtures__/adb-key-fixture.json` | Public key, token and signature from a real `adb keygen` key (no private key). |

New elsewhere: `backend/api/adb-proxy.ts` (+ test), `migrations/0102_adb_proxy.sql`, `scripts/gen-adb-key-fixture.mjs`, `vitest.adb-proxy.config.ts`, `tests/conformance/*.conformance.test.ts`, `playwright.adb-proxy.config.ts`, `tests/e2e-adb-proxy/*`, `frontend/pages/settings/AdbProxyPage.tsx` (+ test), `docs/adb-proxy.md`.

Modified: `backend/db/schema.ts`, `migrations/meta/_journal.json`, `backend/services/forget-device.ts`, `backend/services/device-manager.ts`, `backend/auth/scopes-registry.ts`, `backend/index.ts`, `vitest.config.ts`, `package.json`, `frontend/App.tsx`, `frontend/components/settings/SettingsSidebar.tsx`, `docs/ARCHITECTURE.md`, `CHANGELOG.md`.

---

### Task 1: Handshake spike (throwaway)

Answers the spec's risks 1, 3 and 5 against the real `adb` clients before anything is built on them. The probe script lives outside the repo and is deleted afterwards; only the findings are committed.

**Files:**
- Create (not committed): `/tmp/adb-proxy-spike/spike.cjs`
- Modify: `docs/specs/2026-10-11-adb-proxy-design.md` (Risks section: record results)

**Interfaces:**
- Consumes: two real clients, `adb` on PATH (Debian 34.0.4) and a newer SDK platform-tools `adb` (37.0.0) whose path is in `$ADB_ALT`.
- Produces: recorded answers used by Tasks 9, 10 and 14: the exact `CNXN` the client sends, whether it ever sends `STLS`, the service strings `adb shell` and `adb push` open, whether `adb devices` shows `unauthorized` during a hold and `device` after, and how long the client keeps a held connection.

- [ ] **Step 1: Write the probe**

Create `/tmp/adb-proxy-spike/spike.cjs`:

```js
// Throwaway handshake probe. Node builtins only. Not part of the repo.
const net = require('node:net');
const crypto = require('node:crypto');

const PORT = Number(process.env.SPIKE_PORT || 16500);
const HOLD_MS = Number(process.env.HOLD_MS || 3000);
const CMD = { CNXN: 0x4e584e43, AUTH: 0x48545541, OPEN: 0x4e45504f, OKAY: 0x59414b4f, CLSE: 0x45534c43, WRTE: 0x45545257 };
const NAME = Object.fromEntries(Object.entries(CMD).map(([k, v]) => [v, k]));
const SHA1_PREFIX = Buffer.from('3021300906052b0e03021a05000414', 'hex');
const trusted = new Map();

function encode(command, arg0, arg1, data = Buffer.alloc(0)) {
  const h = Buffer.alloc(24);
  h.writeUInt32LE(command, 0);
  h.writeUInt32LE(arg0, 4);
  h.writeUInt32LE(arg1, 8);
  h.writeUInt32LE(data.length, 12);
  let sum = 0;
  for (const b of data) sum = (sum + b) >>> 0;
  h.writeUInt32LE(sum, 16);
  h.writeUInt32LE((command ^ 0xffffffff) >>> 0, 20);
  return Buffer.concat([h, data]);
}

function keyFromText(text) {
  const b64 = text.toString('utf8').replace(/\0+$/, '').trim().split(/\s+/)[0];
  const blob = Buffer.from(b64, 'base64');
  const n = Buffer.from(blob.subarray(8, 264)).reverse();
  const exp = Buffer.alloc(4);
  exp.writeUInt32BE(blob.readUInt32LE(520));
  const e = exp.subarray(exp.findIndex((b) => b !== 0));
  const key = crypto.createPublicKey({ key: { kty: 'RSA', n: n.toString('base64url'), e: e.toString('base64url') }, format: 'jwk' });
  return { key, id: crypto.createHash('sha256').update(blob).digest('hex').slice(0, 12), blobLen: blob.length };
}

function verify(key, token, sig) {
  try {
    const out = crypto.publicDecrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, sig);
    return out.equals(Buffer.concat([SHA1_PREFIX, token]));
  } catch {
    return false;
  }
}

net.createServer((sock) => {
  const t0 = Date.now();
  const say = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s [${sock.remotePort}] ${m}`);
  let buf = Buffer.alloc(0);
  let token = null;
  say('tcp connected');
  sock.on('close', () => say('tcp closed'));
  sock.on('error', (e) => say(`error ${e.code}`));
  const send = (c, a0, a1, d) => sock.write(encode(CMD[c], a0, a1, d));
  const ready = () => {
    say('send CNXN');
    send('CNXN', 0x01000001, 1048576, Buffer.from('device::ro.product.name=spike;ro.product.model=spike;ro.product.device=spike;features=cmd,stat_v2,ls_v2\0'));
  };
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 24) {
      const len = buf.readUInt32LE(12);
      if (buf.length < 24 + len) return;
      const cmd = buf.readUInt32LE(0);
      const a0 = buf.readUInt32LE(4);
      const a1 = buf.readUInt32LE(8);
      const data = buf.subarray(24, 24 + len);
      buf = buf.subarray(24 + len);
      const label = NAME[cmd] || '0x' + cmd.toString(16);
      const text = cmd === CMD.CNXN || cmd === CMD.OPEN ? ' ' + JSON.stringify(data.toString()) : '';
      say(`recv ${label} arg0=${a0} arg1=${a1} len=${len}${text}`);
      if (cmd === CMD.CNXN) {
        token = crypto.randomBytes(20);
        send('AUTH', 1, 0, token);
      } else if (cmd === CMD.AUTH && a0 === 2) {
        const hit = [...trusted.values()].find((k) => verify(k.key, token, data));
        if (hit) {
          say('signature OK for key ' + hit.id);
          ready();
        } else {
          say('signature not recognised, sending a new token');
          token = crypto.randomBytes(20);
          send('AUTH', 1, 0, token);
        }
      } else if (cmd === CMD.AUTH && a0 === 3) {
        const k = keyFromText(data);
        say(`public key offered id=${k.id} blob=${k.blobLen}B, holding ${HOLD_MS}ms`);
        setTimeout(() => {
          trusted.set(k.id, k);
          say('approved');
          ready();
        }, HOLD_MS);
      } else if (cmd === CMD.OPEN) {
        send('CLSE', 0, a0);
      }
    }
  });
}).listen(PORT, '127.0.0.1', () => console.log('spike listening on 127.0.0.1:' + PORT));
```

- [ ] **Step 2: Start the probe and define an isolated client helper**

```bash
mkdir -p /tmp/adb-proxy-spike/home
cd /tmp/adb-proxy-spike && (HOLD_MS=3000 node spike.cjs > server.log 2>&1 &)
spike_adb() { env HOME=/tmp/adb-proxy-spike/home ANDROID_USER_HOME=/tmp/adb-proxy-spike/home ANDROID_ADB_SERVER_PORT=15037 "${ADB_BIN:-adb}" "$@"; }
```

Expected: `server.log` contains `spike listening on 127.0.0.1:16500`. The helper uses server port 15037, so the developer's ADB server on 5037 is untouched.

- [ ] **Step 3: Unknown key, then known key, with the Debian client**

```bash
spike_adb start-server
spike_adb connect 127.0.0.1:16500
sleep 1; spike_adb devices
sleep 4; spike_adb devices
spike_adb disconnect 127.0.0.1:16500
spike_adb connect 127.0.0.1:16500
sleep 1; spike_adb devices
cat /tmp/adb-proxy-spike/server.log
```

Expected: the first `devices` shows `127.0.0.1:16500  unauthorized`, the second shows `device`, and after the reconnect the third shows `device` immediately. The log shows `recv CNXN`, `signature not recognised`, `recv AUTH arg0=3`, `holding 3000ms`, `approved`, then on the reconnect `signature OK`. Record: the exact `CNXN` arg0/arg1 and payload text, whether any `STLS` or other unknown command appears, and what `adb connect` printed.

If the first connection never shows `unauthorized`, or the signature is never accepted, stop and report NEEDS_CONTEXT with the log: the auth design in the spec needs revisiting.

- [ ] **Step 4: Repeat with the SDK client**

```bash
spike_adb kill-server
rm -rf /tmp/adb-proxy-spike/home && mkdir -p /tmp/adb-proxy-spike/home
ADB_BIN=$ADB_ALT spike_adb start-server
ADB_BIN=$ADB_ALT spike_adb connect 127.0.0.1:16500
sleep 1; ADB_BIN=$ADB_ALT spike_adb devices
sleep 4; ADB_BIN=$ADB_ALT spike_adb devices
ADB_BIN=$ADB_ALT spike_adb kill-server
```

Expected: the same `unauthorized` then `device` sequence. Record any difference in the `CNXN` the 37.0.0 client sends or in the commands it uses. The probe now trusts the key from step 3, so a fresh key (the `rm -rf` above) exercises the unknown-key path again.

- [ ] **Step 5: Record the service strings real clients send**

With a connected `device`, run:

```bash
spike_adb -s 127.0.0.1:16500 shell echo hi
spike_adb -s 127.0.0.1:16500 push /etc/hostname /sdcard/x
spike_adb -s 127.0.0.1:16500 forward tcp:17000 tcp:17001
tail -20 /tmp/adb-proxy-spike/server.log
```

Expected: `recv OPEN` lines with the real service strings (for example `shell:echo hi` or a `shell,v2,...` form depending on the features the probe advertised, `sync:`), each answered by `CLSE`. Record the strings.

- [ ] **Step 6: Patience test for a held connection**

```bash
pkill -f spike.cjs
cd /tmp/adb-proxy-spike && (HOLD_MS=330000 node spike.cjs > server-long.log 2>&1 &)
spike_adb kill-server; rm -rf home && mkdir home
spike_adb start-server
spike_adb connect 127.0.0.1:16500
for t in 30 120 300 335; do sleep $((t - ${prev:-0})); prev=$t; echo "t=${t}s"; spike_adb devices; done
```

Expected: `unauthorized` at 30, 120 and 300 seconds, then `device` at 335 seconds. If the transport disappears or flips to `offline` earlier, record the time: the pending timeout in Task 8 becomes that value minus 30 seconds.

- [ ] **Step 7: Record the findings in the spec**

In `docs/specs/2026-10-11-adb-proxy-design.md`, under "Risks and things to verify first", add a short block named "Spike results (2026-10-11)" stating, from the logs above: the signature scheme verdict for both clients, the `CNXN` each client sends (version, max data, payload), whether `STLS` or any other unexpected command appeared, the service strings seen, the `adb devices` states observed, and the longest hold observed. Change risk 1 to "confirmed" or "revised" accordingly and risk 5 likewise. Use only facts from the logs.

- [ ] **Step 8: Clean up and commit**

```bash
pkill -f spike.cjs
ADB_BIN=adb spike_adb kill-server
rm -rf /tmp/adb-proxy-spike
git add docs/specs/2026-10-11-adb-proxy-design.md
git commit -m "docs(specs): record ADB handshake spike results

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Wire packet codec

**Files:**
- Create: `backend/services/adb-proxy/packet.ts`
- Test: `backend/services/adb-proxy/packet.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Tasks 3, 4, 9, 10 and the test support files):
  - constants `A_CNXN, A_AUTH, A_OPEN, A_OKAY, A_CLSE, A_WRTE` (numbers), `A_VERSION = 0x01000001`, `MAX_DATA = 1048576`, `PREAUTH_MAX_PAYLOAD = 4096`, `HEADER_SIZE = 24`, `AUTH_TOKEN = 1`, `AUTH_SIGNATURE = 2`, `AUTH_RSAPUBLICKEY = 3`
  - `interface Packet { command: number; arg0: number; arg1: number; data: Buffer }`
  - `class PacketError extends Error`
  - `encodePacket(p: { command: number; arg0: number; arg1: number; data?: Buffer }): Buffer`
  - `class PacketParser { constructor(maxPayload: number); setMaxPayload(n: number): void; push(chunk: Buffer): Packet[] }` (throws `PacketError`)
  - `isKnownCommand(command: number): boolean`, `commandName(command: number): string`

- [ ] **Step 1: Write the failing test**

Create `backend/services/adb-proxy/packet.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  A_AUTH, A_CNXN, A_WRTE, HEADER_SIZE,
  PacketError, PacketParser, commandName, encodePacket, isKnownCommand,
} from './packet';

describe('encodePacket', () => {
  it('writes a 24-byte little-endian header, the byte-sum checksum and the magic', () => {
    const data = Buffer.from([1, 2, 3, 250]);
    const buf = encodePacket({ command: A_WRTE, arg0: 7, arg1: 9, data });
    expect(buf.length).toBe(HEADER_SIZE + 4);
    expect(buf.subarray(0, 4).toString('ascii')).toBe('WRTE');
    expect(buf.readUInt32LE(4)).toBe(7);
    expect(buf.readUInt32LE(8)).toBe(9);
    expect(buf.readUInt32LE(12)).toBe(4);
    expect(buf.readUInt32LE(16)).toBe(1 + 2 + 3 + 250);
    expect(buf.readUInt32LE(20)).toBe((A_WRTE ^ 0xffffffff) >>> 0);
    expect(buf.subarray(HEADER_SIZE)).toEqual(data);
  });

  it('encodes an empty payload as a bare header', () => {
    const buf = encodePacket({ command: A_CNXN, arg0: 1, arg1: 2 });
    expect(buf.length).toBe(HEADER_SIZE);
    expect(buf.readUInt32LE(12)).toBe(0);
  });
});

describe('PacketParser', () => {
  it('round-trips a packet', () => {
    const parser = new PacketParser(1024);
    const [p] = parser.push(encodePacket({ command: A_AUTH, arg0: 2, arg1: 0, data: Buffer.from('sig') }));
    expect(p.command).toBe(A_AUTH);
    expect(p.arg0).toBe(2);
    expect(p.data.toString()).toBe('sig');
  });

  it('reassembles a packet delivered one byte at a time', () => {
    const parser = new PacketParser(1024);
    const wire = encodePacket({ command: A_WRTE, arg0: 1, arg1: 2, data: Buffer.from('hello world') });
    const out = [];
    for (const byte of wire) out.push(...parser.push(Buffer.from([byte])));
    expect(out).toHaveLength(1);
    expect(out[0].data.toString()).toBe('hello world');
  });

  it('splits two packets that arrive in one chunk', () => {
    const parser = new PacketParser(1024);
    const wire = Buffer.concat([
      encodePacket({ command: A_WRTE, arg0: 1, arg1: 2, data: Buffer.from('a') }),
      encodePacket({ command: A_WRTE, arg0: 3, arg1: 4, data: Buffer.from('bb') }),
    ]);
    const out = parser.push(wire);
    expect(out.map((p) => p.data.toString())).toEqual(['a', 'bb']);
  });

  it('keeps a partial trailing packet until the rest arrives', () => {
    const parser = new PacketParser(1024);
    const first = encodePacket({ command: A_WRTE, arg0: 1, arg1: 2, data: Buffer.from('a') });
    const second = encodePacket({ command: A_WRTE, arg0: 3, arg1: 4, data: Buffer.from('bb') });
    const wire = Buffer.concat([first, second]);
    expect(parser.push(wire.subarray(0, first.length + 10))).toHaveLength(1);
    expect(parser.push(wire.subarray(first.length + 10))).toHaveLength(1);
  });

  it('rejects a bad magic', () => {
    const parser = new PacketParser(1024);
    const wire = encodePacket({ command: A_CNXN, arg0: 1, arg1: 2 });
    wire.writeUInt32LE(0, 20);
    expect(() => parser.push(wire)).toThrow(PacketError);
  });

  it('rejects an oversize payload from the header alone, before the body arrives', () => {
    const parser = new PacketParser(16);
    const wire = encodePacket({ command: A_WRTE, arg0: 1, arg1: 2, data: Buffer.alloc(17) });
    expect(() => parser.push(wire.subarray(0, HEADER_SIZE))).toThrow(PacketError);
  });

  it('honours a raised limit', () => {
    const parser = new PacketParser(16);
    parser.setMaxPayload(64);
    const wire = encodePacket({ command: A_WRTE, arg0: 1, arg1: 2, data: Buffer.alloc(40) });
    expect(parser.push(wire)).toHaveLength(1);
  });

  it('passes an unknown command through for the caller to decide', () => {
    const parser = new PacketParser(1024);
    const wire = encodePacket({ command: 0x12345678, arg0: 0, arg1: 0 });
    const [p] = parser.push(wire);
    expect(p.command).toBe(0x12345678);
    expect(isKnownCommand(p.command)).toBe(false);
    expect(commandName(p.command)).toBe('0x12345678');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run backend/services/adb-proxy/packet.test.ts`
Expected: FAIL with "Failed to resolve import './packet'".

- [ ] **Step 3: Write the implementation**

Create `backend/services/adb-proxy/packet.ts`:

```ts
export const A_CNXN = 0x4e584e43;
export const A_AUTH = 0x48545541;
export const A_OPEN = 0x4e45504f;
export const A_OKAY = 0x59414b4f;
export const A_CLSE = 0x45534c43;
export const A_WRTE = 0x45545257;

export const A_VERSION = 0x01000001;
export const MAX_DATA = 1024 * 1024;
export const PREAUTH_MAX_PAYLOAD = 4096;
export const HEADER_SIZE = 24;

export const AUTH_TOKEN = 1;
export const AUTH_SIGNATURE = 2;
export const AUTH_RSAPUBLICKEY = 3;

const NAMES: Record<number, string> = {
  [A_CNXN]: 'CNXN',
  [A_AUTH]: 'AUTH',
  [A_OPEN]: 'OPEN',
  [A_OKAY]: 'OKAY',
  [A_CLSE]: 'CLSE',
  [A_WRTE]: 'WRTE',
};

export interface Packet {
  command: number;
  arg0: number;
  arg1: number;
  data: Buffer;
}

export class PacketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PacketError';
  }
}

export function isKnownCommand(command: number): boolean {
  return NAMES[command] !== undefined;
}

export function commandName(command: number): string {
  return NAMES[command] ?? `0x${command.toString(16)}`;
}

export function encodePacket(p: { command: number; arg0: number; arg1: number; data?: Buffer }): Buffer {
  const data = p.data ?? Buffer.alloc(0);
  const out = Buffer.alloc(HEADER_SIZE + data.length);
  out.writeUInt32LE(p.command >>> 0, 0);
  out.writeUInt32LE(p.arg0 >>> 0, 4);
  out.writeUInt32LE(p.arg1 >>> 0, 8);
  out.writeUInt32LE(data.length, 12);
  let sum = 0;
  for (const b of data) sum = (sum + b) >>> 0;
  out.writeUInt32LE(sum, 16);
  out.writeUInt32LE((p.command ^ 0xffffffff) >>> 0, 20);
  data.copy(out, HEADER_SIZE);
  return out;
}

export class PacketParser {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private maxPayload: number) {}

  setMaxPayload(n: number): void {
    this.maxPayload = n;
  }

  /** Feed bytes; returns every complete packet. Throws PacketError on a bad magic or an oversize payload. */
  push(chunk: Buffer): Packet[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: Packet[] = [];
    while (this.buf.length >= HEADER_SIZE) {
      const command = this.buf.readUInt32LE(0);
      const arg0 = this.buf.readUInt32LE(4);
      const arg1 = this.buf.readUInt32LE(8);
      const length = this.buf.readUInt32LE(12);
      const magic = this.buf.readUInt32LE(20);
      if (magic !== ((command ^ 0xffffffff) >>> 0)) throw new PacketError('bad magic');
      if (length > this.maxPayload) throw new PacketError(`payload too large: ${length}`);
      if (this.buf.length < HEADER_SIZE + length) break;
      out.push({ command, arg0, arg1, data: Buffer.from(this.buf.subarray(HEADER_SIZE, HEADER_SIZE + length)) });
      this.buf = this.buf.subarray(HEADER_SIZE + length);
    }
    return out;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run backend/services/adb-proxy/packet.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/services/adb-proxy/packet.ts backend/services/adb-proxy/packet.test.ts
git commit -m "feat(adb-proxy): add ADB wire packet codec

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Adb key parsing, fingerprint and signature verification

**Files:**
- Create: `scripts/gen-adb-key-fixture.mjs`
- Create: `backend/services/adb-proxy/__fixtures__/adb-key-fixture.json` (generated by the script)
- Create: `backend/services/adb-proxy/testing/test-keys.ts`
- Create: `backend/services/adb-proxy/adb-key.ts`
- Test: `backend/services/adb-proxy/adb-key.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `KEY_BLOB_SIZE = 524`
  - `class AdbKeyError extends Error`
  - `interface ParsedAdbKey { blob: Buffer; publicKey: string; comment: string; keyId: string; fingerprint: string; key: KeyObject }` (`publicKey` is the canonical base64 of `blob`)
  - `parseAdbPublicKey(input: Buffer | string): ParsedAdbKey` (throws `AdbKeyError`)
  - `verifyAuthSignature(key: KeyObject, token: Buffer, signature: Buffer): boolean`
  - `sanitiseComment(raw: string): string`, `keyIdOf(blob: Buffer): string`, `fingerprintOf(blob: Buffer): string`
  - test support: `interface TestAdbKey { publicKeyText: string; blob: Buffer; keyId: string; sign(token: Buffer): Buffer }` and `makeTestAdbKey(comment?: string): TestAdbKey`

- [ ] **Step 1: Write the fixture generator and run it**

Create `scripts/gen-adb-key-fixture.mjs`:

```js
#!/usr/bin/env node
// Regenerates backend/services/adb-proxy/__fixtures__/adb-key-fixture.json from a real adb key.
// Usage: ADB_BIN=/path/to/adb node scripts/gen-adb-key-fixture.mjs
// The private key is discarded; only the public key, a token and its signature are kept.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'backend/services/adb-proxy/__fixtures__/adb-key-fixture.json');
const adb = process.env.ADB_BIN || 'adb';
const dir = mkdtempSync(join(tmpdir(), 'adb-key-fixture-'));
try {
  execFileSync(adb, ['keygen', join(dir, 'adbkey')], { stdio: 'ignore' });
  const token = randomBytes(20);
  writeFileSync(join(dir, 'token.bin'), token);
  execFileSync('openssl', [
    'pkeyutl', '-sign', '-inkey', join(dir, 'adbkey'),
    '-pkeyopt', 'digest:sha1', '-in', join(dir, 'token.bin'), '-out', join(dir, 'sig.bin'),
  ]);
  const publicKeyText = readFileSync(join(dir, 'adbkey.pub'), 'utf8').trim();
  const blob = Buffer.from(publicKeyText.split(/\s+/)[0], 'base64');
  const fingerprint = createHash('md5').update(blob).digest('hex').toUpperCase().match(/../g).join(':');
  const generatedWith = execFileSync(adb, ['version'], { encoding: 'utf8' }).split('\n')[1].trim();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({
    generatedWith,
    publicKeyText,
    tokenHex: token.toString('hex'),
    signatureHex: readFileSync(join(dir, 'sig.bin')).toString('hex'),
    keyId: createHash('sha256').update(blob).digest('hex'),
    fingerprint,
  }, null, 2) + '\n');
  console.log('wrote', out);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
```

Run: `node scripts/gen-adb-key-fixture.mjs`
Expected: prints `wrote .../adb-key-fixture.json`; the file has six keys and `publicKeyText` ends with a `user@host` comment.

- [ ] **Step 2: Write the test key helper**

Create `backend/services/adb-proxy/testing/test-keys.ts`:

```ts
import { constants, createHash, generateKeyPairSync, privateEncrypt } from 'node:crypto';

const SHA1_PREFIX = Buffer.from('3021300906052b0e03021a05000414', 'hex');

function modInverse(a: bigint, m: bigint): bigint {
  let [oldR, r] = [a % m, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return ((oldS % m) + m) % m;
}

function toLittleEndian(value: bigint, length: number): Buffer {
  const out = Buffer.alloc(length);
  let v = value;
  for (let i = 0; i < length; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export interface TestAdbKey {
  /** What a client sends in AUTH(RSAPUBLICKEY): base64 blob, a space, the comment, a NUL. */
  publicKeyText: string;
  blob: Buffer;
  keyId: string;
  sign(token: Buffer): Buffer;
}

export function makeTestAdbKey(comment = 'tester@testhost'): TestAdbKey {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 });
  const jwk = publicKey.export({ format: 'jwk' });
  const n = BigInt('0x' + Buffer.from(jwk.n as string, 'base64url').toString('hex'));
  const n0inv = Number((-modInverse(n & 0xffffffffn, 1n << 32n)) & 0xffffffffn) >>> 0;
  const rr = (1n << 4096n) % n;
  const blob = Buffer.alloc(524);
  blob.writeUInt32LE(64, 0);
  blob.writeUInt32LE(n0inv, 4);
  toLittleEndian(n, 256).copy(blob, 8);
  toLittleEndian(rr, 256).copy(blob, 264);
  blob.writeUInt32LE(65537, 520);
  return {
    publicKeyText: `${blob.toString('base64')} ${comment}\0`,
    blob,
    keyId: createHash('sha256').update(blob).digest('hex'),
    sign: (token) =>
      privateEncrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.concat([SHA1_PREFIX, token])),
  };
}
```

- [ ] **Step 3: Write the failing test**

Create `backend/services/adb-proxy/adb-key.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AdbKeyError, KEY_BLOB_SIZE, fingerprintOf, keyIdOf, parseAdbPublicKey, sanitiseComment, verifyAuthSignature,
} from './adb-key';
import { makeTestAdbKey } from './testing/test-keys';

const fixture = JSON.parse(readFileSync(join(__dirname, '__fixtures__/adb-key-fixture.json'), 'utf8'));
const fixtureB64 = fixture.publicKeyText.split(/\s+/)[0] as string;

describe('parseAdbPublicKey with a key from the real adb', () => {
  it('parses the blob, comment, key id and fingerprint', () => {
    const parsed = parseAdbPublicKey(fixture.publicKeyText);
    expect(parsed.blob.length).toBe(KEY_BLOB_SIZE);
    expect(parsed.keyId).toBe(fixture.keyId);
    expect(parsed.fingerprint).toBe(fixture.fingerprint);
    expect(parsed.comment).toBe(fixture.publicKeyText.slice(fixtureB64.length + 1));
    expect(parsed.publicKey).toBe(fixtureB64);
  });

  it('accepts a Buffer with a trailing NUL, as sent on the wire', () => {
    const parsed = parseAdbPublicKey(Buffer.from(fixture.publicKeyText + '\0'));
    expect(parsed.keyId).toBe(fixture.keyId);
  });
});

describe('verifyAuthSignature', () => {
  const parsed = parseAdbPublicKey(fixture.publicKeyText);
  const token = Buffer.from(fixture.tokenHex, 'hex');
  const signature = Buffer.from(fixture.signatureHex, 'hex');

  it('accepts a signature made by the real key over the token', () => {
    expect(verifyAuthSignature(parsed.key, token, signature)).toBe(true);
  });

  it('rejects a tampered signature', () => {
    const bad = Buffer.from(signature);
    bad[10] ^= 0x01;
    expect(verifyAuthSignature(parsed.key, token, bad)).toBe(false);
  });

  it('rejects the signature for a different token', () => {
    expect(verifyAuthSignature(parsed.key, randomBytes(20), signature)).toBe(false);
  });

  it('rejects a wrong-length signature and a wrong-length token', () => {
    expect(verifyAuthSignature(parsed.key, token, signature.subarray(0, 255))).toBe(false);
    expect(verifyAuthSignature(parsed.key, token.subarray(0, 19), signature)).toBe(false);
  });

  it('rejects a signature made by a different key', () => {
    const other = makeTestAdbKey();
    expect(verifyAuthSignature(parsed.key, token, other.sign(token))).toBe(false);
  });
});

describe('round trip with the generated test key', () => {
  it('parses what the test helper produces and verifies its signatures', () => {
    const k = makeTestAdbKey('ci@runner');
    const parsed = parseAdbPublicKey(k.publicKeyText);
    expect(parsed.keyId).toBe(k.keyId);
    expect(parsed.comment).toBe('ci@runner');
    const token = randomBytes(20);
    expect(verifyAuthSignature(parsed.key, token, k.sign(token))).toBe(true);
  });
});

describe('parseAdbPublicKey rejects malformed input', () => {
  const good = Buffer.from(fixtureB64, 'base64');
  const asText = (blob: Buffer) => `${blob.toString('base64')} x@y`;

  it('rejects empty, oversize and non-base64 text', () => {
    expect(() => parseAdbPublicKey('')).toThrow(AdbKeyError);
    expect(() => parseAdbPublicKey('A'.repeat(3000))).toThrow(AdbKeyError);
    expect(() => parseAdbPublicKey('not base64 !!!')).toThrow(AdbKeyError);
  });

  it('rejects a blob of the wrong size', () => {
    expect(() => parseAdbPublicKey(asText(good.subarray(0, 100)))).toThrow(AdbKeyError);
  });

  it('rejects a wrong word count', () => {
    const bad = Buffer.from(good);
    bad.writeUInt32LE(32, 0);
    expect(() => parseAdbPublicKey(asText(bad))).toThrow(AdbKeyError);
  });

  it('rejects an exponent other than 65537', () => {
    const bad = Buffer.from(good);
    bad.writeUInt32LE(3, 520);
    expect(() => parseAdbPublicKey(asText(bad))).toThrow(AdbKeyError);
  });

  it('rejects an even modulus and a modulus without the top bit set', () => {
    const even = Buffer.from(good);
    even[8] &= 0xfe;
    expect(() => parseAdbPublicKey(asText(even))).toThrow(AdbKeyError);
    const small = Buffer.from(good);
    small[8 + 255] &= 0x7f;
    expect(() => parseAdbPublicKey(asText(small))).toThrow(AdbKeyError);
  });
});

describe('comment handling', () => {
  it('strips control characters and caps the length at 128', () => {
    const cleaned = sanitiseComment('a\u0000b\nc\u0007d' + 'x'.repeat(200));
    expect(cleaned).toMatch(/^abcd/);
    expect(cleaned.length).toBe(128);
    expect(/[\u0000-\u001f\u007f-\u009f]/.test(cleaned)).toBe(false);
  });

  it('keeps markup as plain text for the UI to escape', () => {
    expect(sanitiseComment('<img src=x onerror=alert(1)>@host')).toBe('<img src=x onerror=alert(1)>@host');
  });

  it('applies the same cleaning when parsing a key whose comment contains a newline', () => {
    const parsed = parseAdbPublicKey(`${fixtureB64} evil\nname`);
    expect(parsed.comment).toBe('evilname');
  });
});

describe('identity helpers', () => {
  it('formats the fingerprint as 16 uppercase hex pairs separated by colons', () => {
    expect(fingerprintOf(Buffer.alloc(524, 1))).toMatch(/^([0-9A-F]{2}:){15}[0-9A-F]{2}$/);
  });

  it('derives a stable 64-character key id', () => {
    expect(keyIdOf(Buffer.alloc(524, 1))).toMatch(/^[0-9a-f]{64}$/);
    expect(keyIdOf(Buffer.alloc(524, 1))).toBe(keyIdOf(Buffer.alloc(524, 1)));
    expect(keyIdOf(Buffer.alloc(524, 1))).not.toBe(keyIdOf(Buffer.alloc(524, 2)));
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run backend/services/adb-proxy/adb-key.test.ts`
Expected: FAIL with "Failed to resolve import './adb-key'".

- [ ] **Step 5: Write the implementation**

Create `backend/services/adb-proxy/adb-key.ts`:

```ts
import { constants, createHash, createPublicKey, publicDecrypt, timingSafeEqual, type KeyObject } from 'node:crypto';

export const KEY_BLOB_SIZE = 524;
const MODULUS_BYTES = 256;
const MODULUS_WORDS = 64;
const EXPONENT_OFFSET = 8 + 2 * MODULUS_BYTES;
const RSA_EXPONENT = 65537;
const MAX_COMMENT = 128;
const MAX_KEY_TEXT = 2048;
// ASN.1 DigestInfo header for SHA-1; adb signs the raw 20-byte token as if it were the digest.
const SHA1_DIGEST_INFO_PREFIX = Buffer.from('3021300906052b0e03021a05000414', 'hex');

export class AdbKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdbKeyError';
  }
}

export interface ParsedAdbKey {
  blob: Buffer;
  /** Canonical base64 of `blob`. */
  publicKey: string;
  comment: string;
  keyId: string;
  fingerprint: string;
  key: KeyObject;
}

export function sanitiseComment(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f-\u009f  ]/g, '').trim().slice(0, MAX_COMMENT);
}

export function keyIdOf(blob: Buffer): string {
  return createHash('sha256').update(blob).digest('hex');
}

export function fingerprintOf(blob: Buffer): string {
  return (createHash('md5').update(blob).digest('hex').toUpperCase().match(/../g) as string[]).join(':');
}

/** Parse the text adb sends in AUTH(RSAPUBLICKEY): base64 blob, optional `user@host`, optional NULs. */
export function parseAdbPublicKey(input: Buffer | string): ParsedAdbKey {
  const text = (typeof input === 'string' ? input : input.toString('utf8')).replace(/\0+$/, '').trim();
  if (text.length === 0 || text.length > MAX_KEY_TEXT) throw new AdbKeyError('empty or oversize key');
  const space = text.search(/\s/);
  const b64 = space === -1 ? text : text.slice(0, space);
  const comment = space === -1 ? '' : sanitiseComment(text.slice(space + 1));
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new AdbKeyError('key is not base64');
  const blob = Buffer.from(b64, 'base64');
  if (blob.length !== KEY_BLOB_SIZE) throw new AdbKeyError(`key blob is ${blob.length} bytes, expected ${KEY_BLOB_SIZE}`);
  if (blob.readUInt32LE(0) !== MODULUS_WORDS) throw new AdbKeyError('unsupported modulus size');
  if (blob.readUInt32LE(EXPONENT_OFFSET) !== RSA_EXPONENT) throw new AdbKeyError('unsupported exponent');
  const modulus = Buffer.from(blob.subarray(8, 8 + MODULUS_BYTES)).reverse();
  if ((modulus[0] & 0x80) === 0 || (modulus[modulus.length - 1] & 1) === 0) {
    throw new AdbKeyError('modulus is not an odd 2048-bit number');
  }
  const key = createPublicKey({
    key: { kty: 'RSA', n: modulus.toString('base64url'), e: Buffer.from([0x01, 0x00, 0x01]).toString('base64url') },
    format: 'jwk',
  });
  return { blob, publicKey: blob.toString('base64'), comment, keyId: keyIdOf(blob), fingerprint: fingerprintOf(blob), key };
}

/** adb signs the 20-byte token with RSA_sign(NID_sha1, ...): PKCS#1 v1.5 over a SHA-1 DigestInfo of the raw token. */
export function verifyAuthSignature(key: KeyObject, token: Buffer, signature: Buffer): boolean {
  if (token.length !== 20 || signature.length !== MODULUS_BYTES) return false;
  try {
    const decoded = publicDecrypt({ key, padding: constants.RSA_PKCS1_PADDING }, signature);
    const expected = Buffer.concat([SHA1_DIGEST_INFO_PREFIX, token]);
    return decoded.length === expected.length && timingSafeEqual(decoded, expected);
  } catch {
    return false;
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run backend/services/adb-proxy/adb-key.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 7: Commit**

```bash
git add scripts/gen-adb-key-fixture.mjs backend/services/adb-proxy/__fixtures__ backend/services/adb-proxy/testing/test-keys.ts backend/services/adb-proxy/adb-key.ts backend/services/adb-proxy/adb-key.test.ts
git commit -m "feat(adb-proxy): parse adb public keys and verify token signatures

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Host-protocol client and the fake ADB server

**Files:**
- Create: `backend/services/adb-proxy/testing/fake-adb-server.ts`
- Create: `backend/services/adb-proxy/host-client.ts`
- Test: `backend/services/adb-proxy/host-client.test.ts`
- Test: `backend/services/adb-proxy/testing/fake-adb-server.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface AdbServerAddress { host: string; port: number }`, `resolveAdbServerAddress(env?: NodeJS.ProcessEnv): AdbServerAddress`
  - `class HostProtocolError extends Error`
  - `class HostClient { constructor(addr?: AdbServerAddress, timeoutMs?: number); openService(serial: string, service: string): Promise<net.Socket>; query(service: string): Promise<string>; features(serial: string): Promise<string>; collect(serial: string, service: string, maxBytes?: number): Promise<string>; deviceBanner(serial: string): Promise<string> }`. The socket from `openService` is paused; any bytes that arrived with the service `OKAY` are pushed back with `unshift`.
  - `interface FakeDevice { serial: string; features?: string; name?: string; model?: string; device?: string; online?: boolean }`
  - `class FakeAdbServer { constructor(devices: FakeDevice[], opts?: { shell?: (serial: string, command: string) => string }); readonly requests: string[]; start(port?: number): Promise<{ host: string; port: number }>; stop(): Promise<void>; setOnline(serial: string, online: boolean): void; activeServiceSockets(): number }`. Supported requests: `host:version`, `host:devices`, `host:devices-l`, `host:track-devices`, `host:track-devices-l`, `host-serial:<s>:features`, `host:transport:<s>`, `host:kill` (recorded, then closed), and on a bound connection the services `shell:<cmd>`, `echo:`, `flood:<n>`, `hold:`. Default features are `cmd,stat_v2` (no `shell_v2`, so real clients use legacy `shell:`).

- [ ] **Step 1: Write the fake ADB server**

Create `backend/services/adb-proxy/testing/fake-adb-server.ts`:

```ts
import net from 'node:net';

export interface FakeDevice {
  serial: string;
  features?: string;
  name?: string;
  model?: string;
  device?: string;
  online?: boolean;
}

type Entry = Required<FakeDevice>;
type Handled = { bind?: string; raw?: (chunk: Buffer) => void; close?: boolean };

function hex4(n: number): string {
  return n.toString(16).padStart(4, '0');
}

export class FakeAdbServer {
  /** Every request string received, in order, across all connections. */
  readonly requests: string[] = [];
  private readonly devices = new Map<string, Entry>();
  private readonly sockets = new Set<net.Socket>();
  private readonly deviceSockets = new Map<string, Set<net.Socket>>();
  private readonly trackers = new Set<{ socket: net.Socket; long: boolean }>();
  private readonly server: net.Server;
  private readonly shell: (serial: string, command: string) => string;

  constructor(devices: FakeDevice[], opts: { shell?: (serial: string, command: string) => string } = {}) {
    for (const d of devices) {
      this.devices.set(d.serial, {
        serial: d.serial,
        features: d.features ?? 'cmd,stat_v2',
        name: d.name ?? 'fakeprod',
        model: d.model ?? 'FakeModel',
        device: d.device ?? 'fakedev',
        online: d.online ?? true,
      });
    }
    this.shell = opts.shell ?? ((_serial, command) => `ran: ${command}\n`);
    this.server = net.createServer((s) => this.accept(s));
  }

  async start(port = 0): Promise<{ host: string; port: number }> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => resolve());
    });
    return { host: '127.0.0.1', port: (this.server.address() as net.AddressInfo).port };
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  setOnline(serial: string, online: boolean): void {
    const d = this.devices.get(serial);
    if (!d) return;
    d.online = online;
    if (!online) for (const s of this.deviceSockets.get(serial) ?? []) s.destroy();
    for (const t of this.trackers) t.socket.write(this.frame(this.list(t.long)));
  }

  activeServiceSockets(): number {
    let n = 0;
    for (const set of this.deviceSockets.values()) n += set.size;
    return n;
  }

  private frame(payload: string): string {
    return hex4(Buffer.byteLength(payload)) + payload;
  }

  private list(long: boolean): string {
    let n = 0;
    return [...this.devices.values()]
      .map((d) => {
        n++;
        const state = d.online ? 'device' : 'offline';
        return long
          ? `${d.serial.padEnd(22)} ${state} product:${d.name} model:${d.model} device:${d.device} transport_id:${n}\n`
          : `${d.serial}\t${state}\n`;
      })
      .join('');
  }

  private accept(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => {
      this.sockets.delete(socket);
      for (const t of this.trackers) if (t.socket === socket) this.trackers.delete(t);
      for (const set of this.deviceSockets.values()) set.delete(socket);
    });
    let buf = Buffer.alloc(0);
    let bound: string | null = null;
    let raw: ((chunk: Buffer) => void) | null = null;
    socket.on('data', (chunk) => {
      if (raw) {
        raw(chunk);
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 4) return;
        const len = parseInt(buf.subarray(0, 4).toString('ascii'), 16);
        if (!Number.isFinite(len)) {
          socket.destroy();
          return;
        }
        if (buf.length < 4 + len) return;
        const request = buf.subarray(4, 4 + len).toString('utf8');
        buf = buf.subarray(4 + len);
        this.requests.push(request);
        const result = this.handle(socket, request, bound);
        if (result.bind) bound = result.bind;
        if (result.raw) {
          raw = result.raw;
          if (buf.length > 0) {
            raw(buf);
            buf = Buffer.alloc(0);
          }
          return;
        }
        if (result.close) return;
      }
    });
  }

  private handle(socket: net.Socket, request: string, bound: string | null): Handled {
    const okay = () => socket.write('OKAY');
    const fail = (message: string): Handled => {
      socket.write('FAIL' + this.frame(message));
      socket.end();
      return { close: true };
    };
    const reply = (payload: string): Handled => {
      socket.write('OKAY' + this.frame(payload));
      socket.end();
      return { close: true };
    };

    if (bound) return this.service(socket, bound, request, okay, fail);

    if (request === 'host:version') return reply('0029');
    if (request === 'host:devices') return reply(this.list(false));
    if (request === 'host:devices-l') return reply(this.list(true));
    if (request === 'host:track-devices' || request === 'host:track-devices-l') {
      const long = request.endsWith('-l');
      okay();
      socket.write(this.frame(this.list(long)));
      this.trackers.add({ socket, long });
      return { raw: () => {} };
    }
    if (request === 'host:kill') {
      okay();
      socket.end();
      return { close: true };
    }
    const features = /^host-serial:(.+):features$/.exec(request);
    if (features) {
      const d = this.devices.get(features[1]);
      return d ? reply(d.features) : fail(`device '${features[1]}' not found`);
    }
    const transport = /^host:transport:(.+)$/.exec(request);
    if (transport) {
      const d = this.devices.get(transport[1]);
      if (!d || !d.online) return fail(`device '${transport[1]}' not found`);
      okay();
      return { bind: d.serial };
    }
    return fail('unknown host service');
  }

  private service(socket: net.Socket, serial: string, service: string, okay: () => void, fail: (m: string) => Handled): Handled {
    const set = this.deviceSockets.get(serial) ?? new Set<net.Socket>();
    set.add(socket);
    this.deviceSockets.set(serial, set);
    if (service.startsWith('shell:')) {
      okay();
      socket.write(this.shell(serial, service.slice('shell:'.length)));
      socket.end();
      return { raw: () => {} };
    }
    if (service === 'echo:') {
      okay();
      return { raw: (chunk) => socket.write(chunk) };
    }
    if (service === 'hold:') {
      okay();
      return { raw: () => {} };
    }
    const flood = /^flood:(\d+)$/.exec(service);
    if (flood) {
      okay();
      this.flood(socket, Number(flood[1]));
      return { raw: () => {} };
    }
    return fail('unknown service');
  }

  private flood(socket: net.Socket, total: number): void {
    let remaining = total;
    const chunk = Buffer.alloc(65536, 'x');
    const pump = () => {
      while (remaining > 0) {
        const piece = remaining >= chunk.length ? chunk : chunk.subarray(0, remaining);
        remaining -= piece.length;
        if (!socket.write(piece)) {
          socket.once('drain', pump);
          return;
        }
      }
      socket.end();
    };
    pump();
  }
}
```

- [ ] **Step 2: Write the failing tests**

Create `backend/services/adb-proxy/testing/fake-adb-server.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { FakeAdbServer } from './fake-adb-server';

const frame = (s: string) => s.length.toString(16).padStart(4, '0') + s;

function readUntil(socket: net.Socket, predicate: (all: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let all = '';
    const timer = setTimeout(() => reject(new Error('timeout, got: ' + all)), 2000);
    socket.on('data', (c) => {
      all += c.toString();
      if (predicate(all)) {
        clearTimeout(timer);
        resolve(all);
      }
    });
  });
}

describe('FakeAdbServer', () => {
  let fake: FakeAdbServer;
  let port: number;

  beforeEach(async () => {
    fake = new FakeAdbServer([{ serial: 'SER1' }]);
    port = (await fake.start()).port;
  });
  afterEach(async () => {
    await fake.stop();
  });

  it('pushes a new device list to track-devices clients when a device goes offline', async () => {
    const client = net.connect(port, '127.0.0.1');
    client.write(frame('host:track-devices-l'));
    const first = await readUntil(client, (a) => a.includes('device product:'));
    expect(first.startsWith('OKAY')).toBe(true);
    fake.setOnline('SER1', false);
    const next = await readUntil(client, (a) => a.includes('offline'));
    expect(next).toContain('SER1');
    client.destroy();
  });

  it('records every request in order', async () => {
    const client = net.connect(port, '127.0.0.1');
    client.write(frame('host:version'));
    await readUntil(client, (a) => a.includes('0029'));
    expect(fake.requests).toEqual(['host:version']);
    client.destroy();
  });

  it('destroys bound service sockets when the device goes offline', async () => {
    const client = net.connect(port, '127.0.0.1');
    client.write(frame('host:transport:SER1'));
    await readUntil(client, (a) => a === 'OKAY');
    client.write(frame('hold:'));
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.activeServiceSockets()).toBe(1);
    const closed = new Promise<void>((r) => client.on('close', () => r()));
    fake.setOnline('SER1', false);
    await closed;
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.activeServiceSockets()).toBe(0);
  });
});
```

Create `backend/services/adb-proxy/host-client.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { FakeAdbServer } from './testing/fake-adb-server';
import { HostClient, HostProtocolError, resolveAdbServerAddress } from './host-client';

function readAll(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString()));
    socket.on('error', reject);
    socket.resume();
  });
}

describe('resolveAdbServerAddress', () => {
  it('defaults to 127.0.0.1:5037', () => {
    expect(resolveAdbServerAddress({})).toEqual({ host: '127.0.0.1', port: 5037 });
  });

  it('honours ANDROID_ADB_SERVER_ADDRESS and ANDROID_ADB_SERVER_PORT', () => {
    expect(resolveAdbServerAddress({ ANDROID_ADB_SERVER_ADDRESS: '10.0.0.2', ANDROID_ADB_SERVER_PORT: '15037' }))
      .toEqual({ host: '10.0.0.2', port: 15037 });
  });

  it('ignores a non-numeric port', () => {
    expect(resolveAdbServerAddress({ ANDROID_ADB_SERVER_PORT: 'abc' }).port).toBe(5037);
  });
});

describe('HostClient', () => {
  let fake: FakeAdbServer;
  let client: HostClient;

  beforeEach(async () => {
    fake = new FakeAdbServer([{ serial: 'SER1', features: 'cmd,stat_v2' }, { serial: 'OFF1', online: false }], {
      shell: (_serial, command) => {
        if (command.startsWith('getprop')) return 'prod\nmodel\ndev\n';
        if (command === 'big') return 'x'.repeat(200_000);
        return `ran: ${command}\n`;
      },
    });
    client = new HostClient(await fake.start(), 2000);
  });
  afterEach(async () => {
    await fake.stop();
  });

  it('queries a host service', async () => {
    expect(await client.query('host:version')).toBe('0029');
  });

  it('returns the device feature list', async () => {
    expect(await client.features('SER1')).toBe('cmd,stat_v2');
  });

  it('rejects a feature query for an unknown device', async () => {
    await expect(client.features('NOPE')).rejects.toThrow(HostProtocolError);
  });

  it('opens a bound service and streams its output', async () => {
    const socket = await client.openService('SER1', 'shell:echo hi');
    expect(await readAll(socket)).toBe('ran: echo hi\n');
  });

  it('does not lose bytes that arrive together with the service OKAY', async () => {
    const socket = await client.openService('SER1', 'shell:big');
    expect((await readAll(socket)).length).toBe(200_000);
  });

  it('relays both ways on an echo service', async () => {
    const socket = await client.openService('SER1', 'echo:');
    socket.write('abc');
    const got = await new Promise<string>((resolve) => {
      socket.once('data', (c) => resolve(c.toString()));
      socket.resume();
    });
    expect(got).toBe('abc');
    socket.destroy();
  });

  it('rejects opening a service on an offline device', async () => {
    await expect(client.openService('OFF1', 'shell:x')).rejects.toThrow(HostProtocolError);
  });

  it('builds the CNXN banner from properties and features', async () => {
    expect(await client.deviceBanner('SER1')).toBe(
      'device::ro.product.name=prod;ro.product.model=model;ro.product.device=dev;features=cmd,stat_v2',
    );
  });

  it('strips separators and control characters from property values', async () => {
    const dirty = new FakeAdbServer([{ serial: 'D1' }], { shell: () => 'a;b=c\nmo\u0001del\ndev\n' });
    const c = new HostClient(await dirty.start(), 2000);
    expect(await c.deviceBanner('D1')).toContain('ro.product.name=abc;ro.product.model=model;ro.product.device=dev');
    await dirty.stop();
  });

  it('rejects when nothing is listening', async () => {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    await expect(new HostClient({ host: '127.0.0.1', port }, 500).query('host:version')).rejects.toThrow();
  });

  it('times out against a server that never answers', async () => {
    const silent = net.createServer(() => {});
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
    const port = (silent.address() as net.AddressInfo).port;
    await expect(new HostClient({ host: '127.0.0.1', port }, 200).query('host:version')).rejects.toThrow(/timeout/);
    silent.close();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run backend/services/adb-proxy/host-client.test.ts backend/services/adb-proxy/testing/fake-adb-server.test.ts`
Expected: `host-client.test.ts` FAILS with "Failed to resolve import './host-client'"; the fake-server tests already pass, because the fake server is written first as test support.

- [ ] **Step 4: Write the implementation**

Create `backend/services/adb-proxy/host-client.ts`:

```ts
import net from 'node:net';

export interface AdbServerAddress {
  host: string;
  port: number;
}

export function resolveAdbServerAddress(env: NodeJS.ProcessEnv = process.env): AdbServerAddress {
  return {
    host: env.ANDROID_ADB_SERVER_ADDRESS || '127.0.0.1',
    port: Number(env.ANDROID_ADB_SERVER_PORT) || 5037,
  };
}

export class HostProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostProtocolError';
  }
}

function frame(service: string): Buffer {
  const body = Buffer.from(service, 'utf8');
  return Buffer.concat([Buffer.from(body.length.toString(16).padStart(4, '0'), 'ascii'), body]);
}

/** Read exactly n bytes; surplus bytes are pushed back so the next reader (or a pipe) sees them. */
function readExact(socket: net.Socket, n: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let have = Buffer.alloc(0);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('close', onEnd);
      socket.off('error', onError);
    };
    const onData = (chunk: Buffer) => {
      have = Buffer.concat([have, chunk]);
      if (have.length < n) return;
      cleanup();
      socket.pause();
      if (have.length > n) socket.unshift(have.subarray(n));
      resolve(have.subarray(0, n));
    };
    const onEnd = () => {
      cleanup();
      reject(new HostProtocolError('connection closed'));
    };
    const onError = (e: Error) => {
      cleanup();
      reject(e);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new HostProtocolError('timeout'));
    }, timeoutMs);
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('close', onEnd);
    socket.once('error', onError);
    socket.resume();
  });
}

async function sendRequest(socket: net.Socket, service: string, timeoutMs: number): Promise<void> {
  socket.write(frame(service));
  const status = (await readExact(socket, 4, timeoutMs)).toString('ascii');
  if (status === 'OKAY') return;
  if (status === 'FAIL') {
    const len = parseInt((await readExact(socket, 4, timeoutMs)).toString('ascii'), 16);
    const message = len > 0 ? (await readExact(socket, len, timeoutMs)).toString('utf8') : '';
    throw new HostProtocolError(message || 'FAIL');
  }
  throw new HostProtocolError(`unexpected status ${JSON.stringify(status)}`);
}

function cleanProp(value: string | undefined): string {
  return (value ?? '').replace(/[;=\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
}

export class HostClient {
  constructor(
    private readonly addr: AdbServerAddress = resolveAdbServerAddress(),
    private readonly timeoutMs = 5000,
  ) {}

  private dial(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.addr.host, port: this.addr.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new HostProtocolError('timeout'));
      }, this.timeoutMs);
      // Stays attached after connect: once the promise has settled, reject() is a no-op and this listener keeps a later reset from being unhandled.
      socket.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
    });
  }

  /** A raw pipe to a device service. The socket is returned paused. */
  async openService(serial: string, service: string): Promise<net.Socket> {
    const socket = await this.dial();
    try {
      await sendRequest(socket, `host:transport:${serial}`, this.timeoutMs);
      await sendRequest(socket, service, this.timeoutMs);
      return socket;
    } catch (e) {
      socket.destroy();
      throw e;
    }
  }

  async query(service: string): Promise<string> {
    const socket = await this.dial();
    try {
      await sendRequest(socket, service, this.timeoutMs);
      const len = parseInt((await readExact(socket, 4, this.timeoutMs)).toString('ascii'), 16);
      if (!Number.isFinite(len) || len < 0) throw new HostProtocolError('bad length');
      const body = len === 0 ? Buffer.alloc(0) : await readExact(socket, len, this.timeoutMs);
      return body.toString('utf8');
    } finally {
      socket.destroy();
    }
  }

  features(serial: string): Promise<string> {
    return this.query(`host-serial:${serial}:features`);
  }

  /** Run a service to completion and return its output, bounded in size and time. */
  async collect(serial: string, service: string, maxBytes = 65536): Promise<string> {
    const socket = await this.openService(serial, service);
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new HostProtocolError('timeout'));
      }, this.timeoutMs);
      socket.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          clearTimeout(timer);
          socket.destroy();
          reject(new HostProtocolError('output too large'));
          return;
        }
        chunks.push(c);
      });
      socket.on('end', () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      socket.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      socket.resume();
    });
  }

  /** The CNXN banner text: device identity plus the device's real feature list. */
  async deviceBanner(serial: string): Promise<string> {
    const [features, props] = await Promise.all([
      this.features(serial),
      this.collect(serial, 'shell:getprop ro.product.name; getprop ro.product.model; getprop ro.product.device').catch(() => ''),
    ]);
    const [name, model, device] = props.split(/\r?\n/);
    return `device::ro.product.name=${cleanProp(name)};ro.product.model=${cleanProp(model)};ro.product.device=${cleanProp(device)};features=${features.trim()}`;
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run backend/services/adb-proxy/host-client.test.ts backend/services/adb-proxy/testing/fake-adb-server.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 6: Commit**

```bash
git add backend/services/adb-proxy/host-client.ts backend/services/adb-proxy/host-client.test.ts backend/services/adb-proxy/testing/fake-adb-server.ts backend/services/adb-proxy/testing/fake-adb-server.test.ts
git commit -m "feat(adb-proxy): add ADB host-protocol client and a fake ADB server for tests

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Schema, migration and forget-device cleanup

**Files:**
- Modify: `backend/db/schema.ts` (add two tables after `passwordResetTokens`)
- Create: `migrations/0102_adb_proxy.sql`
- Modify: `migrations/meta/_journal.json` (one new entry)
- Modify: `backend/services/forget-device.ts`
- Test: `backend/db/migrations-adb-proxy.test.ts`
- Test: `backend/services/forget-device.adb-proxy.test.ts`

**Interfaces:**
- Consumes: existing `users`, `devices` tables.
- Produces: Drizzle tables `adbProxyKeys` and `adbProxyDevices` exported from `backend/db/schema.ts`; types `typeof adbProxyKeys.$inferSelect` (fields `id, keyId, publicKey, comment, status, deviceIds, firstSeenAt, lastSeenAt, lastSeenIp, lastDeviceId, decidedBy, decidedAt`) and `typeof adbProxyDevices.$inferSelect` (fields `deviceId, port, enabled, createdAt`). `forgetDeviceRow` also deletes the device's `adb_proxy_devices` row.

- [ ] **Step 1: Write the failing migration test**

Create `backend/db/migrations-adb-proxy.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const TAG = '0102_adb_proxy';

describe('migration 0102: ADB proxy keys and device ports', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT);`);
    db.exec(`CREATE TABLE devices (id TEXT PRIMARY KEY);`);
    const dir = path.resolve(__dirname, '../../migrations');
    const file = fs.readdirSync(dir).find((f) => f.startsWith(TAG));
    expect(file).toBeTruthy();
    const sql = fs.readFileSync(path.join(dir, file!), 'utf8');
    for (const stmt of sql.split('--> statement-breakpoint')) if (stmt.trim()) db.exec(stmt);
  });

  it('creates adb_proxy_keys with the expected columns', () => {
    const cols = (db.prepare('PRAGMA table_info(adb_proxy_keys)').all() as any[]).map((c) => c.name);
    expect(cols).toEqual([
      'id', 'key_id', 'public_key', 'comment', 'status', 'device_ids', 'first_seen_at',
      'last_seen_at', 'last_seen_ip', 'last_device_id', 'decided_by', 'decided_at',
    ]);
  });

  it('creates adb_proxy_devices with the expected columns', () => {
    const cols = (db.prepare('PRAGMA table_info(adb_proxy_devices)').all() as any[]).map((c) => c.name);
    expect(cols).toEqual(['device_id', 'port', 'enabled', 'created_at']);
  });

  it('rejects a status outside approved, denied and revoked', () => {
    expect(() =>
      db.prepare(`INSERT INTO adb_proxy_keys (key_id, public_key, status, first_seen_at, last_seen_at) VALUES ('k', 'p', 'pending', 1, 1)`).run(),
    ).toThrow();
  });

  it('rejects a duplicate key id', () => {
    const insert = () =>
      db.prepare(`INSERT INTO adb_proxy_keys (key_id, public_key, status, first_seen_at, last_seen_at) VALUES ('k', 'p', 'approved', 1, 1)`).run();
    insert();
    expect(insert).toThrow();
  });

  it('sets decided_by to NULL when the deciding user is deleted', () => {
    db.prepare(`INSERT INTO users (username) VALUES ('admin')`).run();
    db.prepare(
      `INSERT INTO adb_proxy_keys (key_id, public_key, status, first_seen_at, last_seen_at, decided_by) VALUES ('k', 'p', 'approved', 1, 1, 1)`,
    ).run();
    db.prepare('DELETE FROM users WHERE id = 1').run();
    expect((db.prepare('SELECT decided_by FROM adb_proxy_keys').get() as any).decided_by).toBeNull();
  });

  it('keeps one port per device and one device per port', () => {
    db.prepare(`INSERT INTO devices (id) VALUES ('A'), ('B')`).run();
    db.prepare(`INSERT INTO adb_proxy_devices (device_id, port, created_at) VALUES ('A', 6500, 1)`).run();
    expect(() => db.prepare(`INSERT INTO adb_proxy_devices (device_id, port, created_at) VALUES ('B', 6500, 1)`).run()).toThrow();
    expect(() => db.prepare(`INSERT INTO adb_proxy_devices (device_id, port, created_at) VALUES ('A', 6501, 1)`).run()).toThrow();
  });

  it('blocks deleting a device that still has a proxy row (the app must clear it first)', () => {
    db.prepare(`INSERT INTO devices (id) VALUES ('A')`).run();
    db.prepare(`INSERT INTO adb_proxy_devices (device_id, port, created_at) VALUES ('A', 6500, 1)`).run();
    expect(() => db.prepare(`DELETE FROM devices WHERE id = 'A'`).run()).toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run backend/db/migrations-adb-proxy.test.ts`
Expected: FAIL at the `expect(file).toBeTruthy()` in `beforeEach` (no migration file yet).

- [ ] **Step 3: Write the migration, schema and journal entry**

Create `migrations/0102_adb_proxy.sql`:

```sql
CREATE TABLE IF NOT EXISTS adb_proxy_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  comment TEXT,
  status TEXT NOT NULL CHECK (status IN ('approved', 'denied', 'revoked')),
  device_ids TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_seen_ip TEXT,
  last_device_id TEXT,
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at INTEGER
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS adb_proxy_devices (
  device_id TEXT PRIMARY KEY REFERENCES devices(id),
  port INTEGER NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
```

In `backend/db/schema.ts`, directly after the `passwordResetTokens` table definition, add:

```ts
export const adbProxyKeys = sqliteTable('adb_proxy_keys', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  keyId: text('key_id').notNull().unique(),
  publicKey: text('public_key').notNull(),
  comment: text('comment'),
  status: text('status', { enum: ['approved', 'denied', 'revoked'] as const }).notNull(),
  deviceIds: text('device_ids', { mode: 'json' }).$type<string[] | null>(),
  firstSeenAt: integer('first_seen_at', { mode: 'timestamp' }).notNull(),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }).notNull(),
  lastSeenIp: text('last_seen_ip'),
  lastDeviceId: text('last_device_id'),
  decidedBy: integer('decided_by').references(() => users.id, { onDelete: 'set null' }),
  decidedAt: integer('decided_at', { mode: 'timestamp' }),
});

export const adbProxyDevices = sqliteTable('adb_proxy_devices', {
  deviceId: text('device_id').primaryKey().references(() => devices.id),
  port: integer('port').notNull().unique(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});
```

Append the journal entry with a script that computes the next `idx` and a `when` above every existing one (the file has no trailing newline and round-trips through `JSON.stringify(j, null, 2)`):

```bash
node -e "
const fs = require('fs');
const p = 'migrations/meta/_journal.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
const idx = Math.max(...j.entries.map((e) => e.idx)) + 1;
const when = Math.max(...j.entries.map((e) => e.when)) + 1;
j.entries.push({ idx, version: '7', when, tag: '0102_adb_proxy', breakpoints: true });
fs.writeFileSync(p, JSON.stringify(j, null, 2));
console.log({ idx, when });
"
git diff --stat migrations/meta/_journal.json
```

Expected: prints `idx: 102` and a `when` one above `1791494784563`; the diff touches only the end of the journal. If the AI-pipelines branch has merged into your base in the meantime, the script still yields a `when` above its entry.

- [ ] **Step 4: Run the migration test to verify it passes**

Run: `npx vitest run backend/db/migrations-adb-proxy.test.ts`
Expected: PASS, 7 tests. Also run `npx vitest run backend/db/migrator.test.ts`; Expected: PASS (journal still consistent).

- [ ] **Step 5: Write the failing forget-device test**

Create `backend/services/forget-device.adb-proxy.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../test-utils/create-test-db';
import { adbProxyDevices, devices } from '../db/schema';
import { forgetDeviceRow } from './forget-device';

describe('forgetDeviceRow with an ADB proxy port', () => {
  it('removes the device and its proxy row without a foreign key error', () => {
    const db = createTestDb(undefined, { foreignKeys: true });
    db.insert(devices).values({ id: 'SER1' }).run();
    db.insert(adbProxyDevices).values({ deviceId: 'SER1', port: 6500, createdAt: new Date() }).run();
    expect(forgetDeviceRow(db, 'SER1')).toBe(true);
    expect(db.select().from(devices).where(eq(devices.id, 'SER1')).all()).toHaveLength(0);
    expect(db.select().from(adbProxyDevices).all()).toHaveLength(0);
  });

  it('leaves other devices proxy rows alone', () => {
    const db = createTestDb(undefined, { foreignKeys: true });
    db.insert(devices).values([{ id: 'A' }, { id: 'B' }]).run();
    db.insert(adbProxyDevices).values([
      { deviceId: 'A', port: 6500, createdAt: new Date() },
      { deviceId: 'B', port: 6501, createdAt: new Date() },
    ]).run();
    forgetDeviceRow(db, 'A');
    expect(db.select().from(adbProxyDevices).all().map((r) => r.deviceId)).toEqual(['B']);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run backend/services/forget-device.adb-proxy.test.ts`
Expected: FAIL with a `FOREIGN KEY constraint failed` error on the first test.

- [ ] **Step 7: Implement the cleanup**

In `backend/services/forget-device.ts`, add `adbProxyDevices` to the schema import and delete its row inside the transaction before the device delete:

```ts
import { devices, automationSessions, capturedTraffic, websocketMessages, adbProxyDevices } from '../db/schema';
```

```ts
    tx.delete(adbProxyDevices).where(eq(adbProxyDevices.deviceId, deviceId)).run();
    tx.delete(devices).where(eq(devices.id, deviceId)).run();
```

Update the doc comment above `forgetDeviceRow` to mention that the device's ADB proxy port row is deleted (it is derived data, unlike the kept child rows).

- [ ] **Step 8: Run both tests and the existing FK regression test**

Run: `npx vitest run backend/services/forget-device.adb-proxy.test.ts backend/api/__tests__/delete-fk-regressions.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/db/schema.ts backend/db/migrations-adb-proxy.test.ts migrations/0102_adb_proxy.sql migrations/meta/_journal.json backend/services/forget-device.ts backend/services/forget-device.adb-proxy.test.ts
git commit -m "feat(adb-proxy): add key and device-port tables

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Persisted key store

**Files:**
- Create: `backend/services/adb-proxy/key-store.ts`
- Test: `backend/services/adb-proxy/key-store.test.ts`

**Interfaces:**
- Consumes: `adbProxyKeys` (Task 5), `AppDatabase` from `backend/db/index`.
- Produces:
  - `type KeyRecord = typeof adbProxyKeys.$inferSelect`, `type KeyStatus = 'approved' | 'denied' | 'revoked'`
  - `interface DecisionInput { keyId: string; publicKey: string; comment: string; status: 'approved' | 'denied'; ip: string; deviceId: string; userId: number | null }`
  - `class KeyStore { constructor(db: AppDatabase, now?: () => Date); findByKeyId(keyId: string): KeyRecord | undefined; findById(id: number): KeyRecord | undefined; list(): KeyRecord[]; approvedFor(deviceId: string): KeyRecord[]; upsertDecision(input: DecisionInput): KeyRecord; setStatus(id: number, status: KeyStatus, userId: number | null): KeyRecord | undefined; setDeviceIds(id: number, ids: string[] | null): KeyRecord | undefined; touch(keyId: string, ip: string, deviceId: string): void; forget(id: number): boolean }`
  - Allow-list rule: `deviceIds` of `null` or `[]` means every device.

- [ ] **Step 1: Write the failing test**

Create `backend/services/adb-proxy/key-store.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../../test-utils/create-test-db';
import { adbProxyKeys, users } from '../../db/schema';
import { KeyStore } from './key-store';

function setup() {
  const db = createTestDb([users, adbProxyKeys]);
  const user = db.insert(users).values({ username: 'admin', providerId: 'local', createdAt: new Date(), updatedAt: new Date() }).returning({ id: users.id }).get();
  let clock = new Date('2026-10-11T10:00:00Z');
  const store = new KeyStore(db, () => clock);
  return { db, store, userId: user.id, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}

const base = { keyId: 'k1', publicKey: 'cHVi', comment: 'ci@runner', ip: '10.0.0.5', deviceId: 'DEV1' };

describe('KeyStore', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  it('records an approval with first and last seen set to now and no allow-list', () => {
    const rec = ctx.store.upsertDecision({ ...base, status: 'approved', userId: ctx.userId });
    expect(rec.status).toBe('approved');
    expect(rec.deviceIds).toBeNull();
    expect(rec.firstSeenAt).toEqual(new Date('2026-10-11T10:00:00Z'));
    expect(rec.lastSeenAt).toEqual(rec.firstSeenAt);
    expect(rec.lastSeenIp).toBe('10.0.0.5');
    expect(rec.lastDeviceId).toBe('DEV1');
    expect(rec.decidedBy).toBe(ctx.userId);
  });

  it('flips an existing key and keeps its first seen time', () => {
    ctx.store.upsertDecision({ ...base, status: 'denied', userId: ctx.userId });
    ctx.advance(60_000);
    const rec = ctx.store.upsertDecision({ ...base, status: 'approved', ip: '10.0.0.9', userId: ctx.userId });
    expect(rec.status).toBe('approved');
    expect(rec.firstSeenAt).toEqual(new Date('2026-10-11T10:00:00Z'));
    expect(rec.lastSeenAt).toEqual(new Date('2026-10-11T10:01:00Z'));
    expect(rec.lastSeenIp).toBe('10.0.0.9');
    expect(ctx.store.list()).toHaveLength(1);
  });

  it('finds by key id and by row id, and lists in insertion order', () => {
    const a = ctx.store.upsertDecision({ ...base, keyId: 'a', status: 'approved', userId: null });
    const b = ctx.store.upsertDecision({ ...base, keyId: 'b', status: 'denied', userId: null });
    expect(ctx.store.findByKeyId('b')?.id).toBe(b.id);
    expect(ctx.store.findById(a.id)?.keyId).toBe('a');
    expect(ctx.store.findByKeyId('missing')).toBeUndefined();
    expect(ctx.store.list().map((r) => r.keyId)).toEqual(['a', 'b']);
  });

  it('approvedFor returns only approved keys, honouring the allow-list', () => {
    const open = ctx.store.upsertDecision({ ...base, keyId: 'open', status: 'approved', userId: null });
    const listed = ctx.store.upsertDecision({ ...base, keyId: 'listed', status: 'approved', userId: null });
    const other = ctx.store.upsertDecision({ ...base, keyId: 'other', status: 'approved', userId: null });
    const empty = ctx.store.upsertDecision({ ...base, keyId: 'empty', status: 'approved', userId: null });
    ctx.store.upsertDecision({ ...base, keyId: 'denied', status: 'denied', userId: null });
    const revoked = ctx.store.upsertDecision({ ...base, keyId: 'revoked', status: 'approved', userId: null });
    ctx.store.setStatus(revoked.id, 'revoked', ctx.userId);
    ctx.store.setDeviceIds(listed.id, ['DEV1', 'DEV2']);
    ctx.store.setDeviceIds(other.id, ['DEV9']);
    ctx.store.setDeviceIds(empty.id, []);
    expect(ctx.store.approvedFor('DEV1').map((r) => r.keyId).sort()).toEqual(['empty', 'listed', 'open']);
    expect(open.status).toBe('approved');
  });

  it('setStatus records who decided and when', () => {
    const rec = ctx.store.upsertDecision({ ...base, status: 'approved', userId: null });
    ctx.advance(5_000);
    const revoked = ctx.store.setStatus(rec.id, 'revoked', ctx.userId);
    expect(revoked?.status).toBe('revoked');
    expect(revoked?.decidedBy).toBe(ctx.userId);
    expect(revoked?.decidedAt).toEqual(new Date('2026-10-11T10:00:05Z'));
    expect(ctx.store.setStatus(9999, 'revoked', null)).toBeUndefined();
  });

  it('setDeviceIds round-trips a list and null', () => {
    const rec = ctx.store.upsertDecision({ ...base, status: 'approved', userId: null });
    expect(ctx.store.setDeviceIds(rec.id, ['A', 'B'])?.deviceIds).toEqual(['A', 'B']);
    expect(ctx.store.setDeviceIds(rec.id, null)?.deviceIds).toBeNull();
    expect(ctx.store.setDeviceIds(9999, ['A'])).toBeUndefined();
  });

  it('touch updates last seen time, ip and device only', () => {
    const rec = ctx.store.upsertDecision({ ...base, status: 'approved', userId: ctx.userId });
    ctx.advance(30_000);
    ctx.store.touch('k1', '10.0.0.77', 'DEV2');
    const after = ctx.store.findById(rec.id)!;
    expect(after.lastSeenAt).toEqual(new Date('2026-10-11T10:00:30Z'));
    expect(after.lastSeenIp).toBe('10.0.0.77');
    expect(after.lastDeviceId).toBe('DEV2');
    expect(after.status).toBe('approved');
    expect(after.decidedAt).toEqual(rec.decidedAt);
    expect(() => ctx.store.touch('missing', 'x', 'y')).not.toThrow();
  });

  it('forget removes the record and reports whether it existed', () => {
    const rec = ctx.store.upsertDecision({ ...base, status: 'approved', userId: null });
    expect(ctx.store.forget(rec.id)).toBe(true);
    expect(ctx.store.forget(rec.id)).toBe(false);
    expect(ctx.store.list()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run backend/services/adb-proxy/key-store.test.ts`
Expected: FAIL with "Failed to resolve import './key-store'".

- [ ] **Step 3: Write the implementation**

Create `backend/services/adb-proxy/key-store.ts`:

```ts
import { asc, eq } from 'drizzle-orm';
import { adbProxyKeys } from '../../db/schema';
import type { AppDatabase } from '../../db/index';

export type KeyRecord = typeof adbProxyKeys.$inferSelect;
export type KeyStatus = KeyRecord['status'];

export interface DecisionInput {
  keyId: string;
  publicKey: string;
  comment: string;
  status: 'approved' | 'denied';
  ip: string;
  deviceId: string;
  userId: number | null;
}

export class KeyStore {
  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  findByKeyId(keyId: string): KeyRecord | undefined {
    return this.db.select().from(adbProxyKeys).where(eq(adbProxyKeys.keyId, keyId)).get();
  }

  findById(id: number): KeyRecord | undefined {
    return this.db.select().from(adbProxyKeys).where(eq(adbProxyKeys.id, id)).get();
  }

  list(): KeyRecord[] {
    return this.db.select().from(adbProxyKeys).orderBy(asc(adbProxyKeys.id)).all();
  }

  /** Approved keys that may reach this device; a null or empty allow-list means every device. */
  approvedFor(deviceId: string): KeyRecord[] {
    return this.db
      .select()
      .from(adbProxyKeys)
      .where(eq(adbProxyKeys.status, 'approved'))
      .all()
      .filter((r) => !r.deviceIds || r.deviceIds.length === 0 || r.deviceIds.includes(deviceId));
  }

  upsertDecision(input: DecisionInput): KeyRecord {
    const t = this.now();
    const existing = this.findByKeyId(input.keyId);
    if (existing) {
      this.db
        .update(adbProxyKeys)
        .set({
          status: input.status,
          comment: input.comment,
          lastSeenAt: t,
          lastSeenIp: input.ip,
          lastDeviceId: input.deviceId,
          decidedBy: input.userId,
          decidedAt: t,
        })
        .where(eq(adbProxyKeys.id, existing.id))
        .run();
    } else {
      this.db
        .insert(adbProxyKeys)
        .values({
          keyId: input.keyId,
          publicKey: input.publicKey,
          comment: input.comment,
          status: input.status,
          deviceIds: null,
          firstSeenAt: t,
          lastSeenAt: t,
          lastSeenIp: input.ip,
          lastDeviceId: input.deviceId,
          decidedBy: input.userId,
          decidedAt: t,
        })
        .run();
    }
    return this.findByKeyId(input.keyId)!;
  }

  setStatus(id: number, status: KeyStatus, userId: number | null): KeyRecord | undefined {
    if (!this.findById(id)) return undefined;
    this.db
      .update(adbProxyKeys)
      .set({ status, decidedBy: userId, decidedAt: this.now() })
      .where(eq(adbProxyKeys.id, id))
      .run();
    return this.findById(id);
  }

  setDeviceIds(id: number, ids: string[] | null): KeyRecord | undefined {
    if (!this.findById(id)) return undefined;
    this.db.update(adbProxyKeys).set({ deviceIds: ids }).where(eq(adbProxyKeys.id, id)).run();
    return this.findById(id);
  }

  touch(keyId: string, ip: string, deviceId: string): void {
    this.db
      .update(adbProxyKeys)
      .set({ lastSeenAt: this.now(), lastSeenIp: ip, lastDeviceId: deviceId })
      .where(eq(adbProxyKeys.keyId, keyId))
      .run();
  }

  forget(id: number): boolean {
    return this.db.delete(adbProxyKeys).where(eq(adbProxyKeys.id, id)).run().changes > 0;
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run backend/services/adb-proxy/key-store.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/services/adb-proxy/key-store.ts backend/services/adb-proxy/key-store.test.ts
git commit -m "feat(adb-proxy): add persisted client key store

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Settings and port allocation

**Files:**
- Create: `backend/services/adb-proxy/settings.ts`
- Create: `backend/services/adb-proxy/port-allocator.ts`
- Test: `backend/services/adb-proxy/settings.test.ts`
- Test: `backend/services/adb-proxy/port-allocator.test.ts`

**Interfaces:**
- Consumes: `settings` table (existing key/value), `adbProxyDevices` (Task 5), `AppDatabase`.
- Produces:
  - `interface AdbProxySettings { enabled: boolean; bindHost: string; portStart: number; portEnd: number }`, `DEFAULT_SETTINGS`, `class SettingsError extends Error`, `loadSettings(db: AppDatabase): AdbProxySettings`, `saveSettings(db: AppDatabase, patch: Partial<AdbProxySettings>): AdbProxySettings` (validates the merged result, throws `SettingsError`)
  - `type ProxyDeviceRow = typeof adbProxyDevices.$inferSelect`, `class PortError extends Error { code: 'out-of-range' | 'in-use' }`
  - `class PortAllocator { constructor(db: AppDatabase, range: () => { start: number; end: number }, now?: () => Date); get(deviceId: string): ProxyDeviceRow | undefined; all(): ProxyDeviceRow[]; ensure(deviceId: string): ProxyDeviceRow | { error: 'range-full' }; setPort(deviceId: string, port: number): ProxyDeviceRow; setEnabled(deviceId: string, enabled: boolean): ProxyDeviceRow | undefined }`

- [ ] **Step 1: Write the failing settings test**

Create `backend/services/adb-proxy/settings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../test-utils/create-test-db';
import { settings } from '../../db/schema';
import { DEFAULT_SETTINGS, SettingsError, loadSettings, saveSettings } from './settings';

const fresh = () => createTestDb([settings]);

describe('adb proxy settings', () => {
  it('returns the defaults when nothing is stored: disabled, all interfaces, 6500-6599', () => {
    expect(loadSettings(fresh())).toEqual({ enabled: false, bindHost: '0.0.0.0', portStart: 6500, portEnd: 6599 });
    expect(DEFAULT_SETTINGS.enabled).toBe(false);
  });

  it('saves and reloads a full change', () => {
    const db = fresh();
    const saved = saveSettings(db, { enabled: true, bindHost: '192.168.1.5', portStart: 7000, portEnd: 7009 });
    expect(saved).toEqual({ enabled: true, bindHost: '192.168.1.5', portStart: 7000, portEnd: 7009 });
    expect(loadSettings(db)).toEqual(saved);
  });

  it('merges a partial patch over the stored values', () => {
    const db = fresh();
    saveSettings(db, { portStart: 7000, portEnd: 7009 });
    expect(saveSettings(db, { enabled: true })).toEqual({ enabled: true, bindHost: '0.0.0.0', portStart: 7000, portEnd: 7009 });
  });

  it('accepts an IPv6 bind address', () => {
    expect(saveSettings(fresh(), { bindHost: '::' }).bindHost).toBe('::');
  });

  it.each([
    [{ bindHost: 'my-host.local' }],
    [{ bindHost: '' }],
    [{ portStart: 80 }],
    [{ portStart: 7000, portEnd: 6999 }],
    [{ portEnd: 70000 }],
    [{ portStart: 6500.5 }],
    [{ portStart: 2000, portEnd: 4000 }],
  ])('rejects %j', (patch) => {
    expect(() => saveSettings(fresh(), patch)).toThrow(SettingsError);
  });

  it('does not store anything when validation fails', () => {
    const db = fresh();
    expect(() => saveSettings(db, { enabled: true, bindHost: 'nope' })).toThrow(SettingsError);
    expect(loadSettings(db).enabled).toBe(false);
  });

  it('falls back to the default for a corrupt stored value', () => {
    const db = fresh();
    db.insert(settings).values([
      { key: 'adb_proxy.port_start', value: 'abc' },
      { key: 'adb_proxy.enabled', value: 'maybe' },
    ]).run();
    expect(loadSettings(db)).toEqual(DEFAULT_SETTINGS);
  });

  it('leaves unrelated settings untouched', () => {
    const db = fresh();
    db.insert(settings).values({ key: 'other', value: 'x' }).run();
    saveSettings(db, { enabled: true });
    expect(db.select().from(settings).all().find((r) => r.key === 'other')?.value).toBe('x');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run backend/services/adb-proxy/settings.test.ts`
Expected: FAIL with "Failed to resolve import './settings'".

- [ ] **Step 3: Write the settings implementation**

Create `backend/services/adb-proxy/settings.ts`:

```ts
import net from 'node:net';
import { inArray } from 'drizzle-orm';
import { settings } from '../../db/schema';
import type { AppDatabase } from '../../db/index';

export interface AdbProxySettings {
  enabled: boolean;
  bindHost: string;
  portStart: number;
  portEnd: number;
}

export const DEFAULT_SETTINGS: AdbProxySettings = {
  enabled: false,
  bindHost: '0.0.0.0',
  portStart: 6500,
  portEnd: 6599,
};

const KEYS = {
  enabled: 'adb_proxy.enabled',
  bindHost: 'adb_proxy.bind_host',
  portStart: 'adb_proxy.port_start',
  portEnd: 'adb_proxy.port_end',
} as const;

const MAX_RANGE = 1000;

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

function validate(s: AdbProxySettings): void {
  if (net.isIP(s.bindHost) === 0) throw new SettingsError('bind host must be an IP address');
  if (!Number.isInteger(s.portStart) || !Number.isInteger(s.portEnd)) throw new SettingsError('ports must be whole numbers');
  if (s.portStart < 1024 || s.portEnd > 65535) throw new SettingsError('ports must be between 1024 and 65535');
  if (s.portStart > s.portEnd) throw new SettingsError('port range start must not exceed its end');
  if (s.portEnd - s.portStart + 1 > MAX_RANGE) throw new SettingsError(`port range may not exceed ${MAX_RANGE} ports`);
}

function parseInt10(raw: string | undefined, fallback: number): number {
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : fallback;
}

export function loadSettings(db: AppDatabase): AdbProxySettings {
  const rows = db.select().from(settings).where(inArray(settings.key, Object.values(KEYS))).all();
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const enabled = byKey.get(KEYS.enabled);
  const host = byKey.get(KEYS.bindHost);
  return {
    enabled: enabled === 'true' ? true : enabled === 'false' ? false : DEFAULT_SETTINGS.enabled,
    bindHost: host !== undefined && net.isIP(host) !== 0 ? host : DEFAULT_SETTINGS.bindHost,
    portStart: parseInt10(byKey.get(KEYS.portStart), DEFAULT_SETTINGS.portStart),
    portEnd: parseInt10(byKey.get(KEYS.portEnd), DEFAULT_SETTINGS.portEnd),
  };
}

export function saveSettings(db: AppDatabase, patch: Partial<AdbProxySettings>): AdbProxySettings {
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const next: AdbProxySettings = { ...loadSettings(db), ...defined };
  validate(next);
  const values: Array<[string, string]> = [
    [KEYS.enabled, String(next.enabled)],
    [KEYS.bindHost, next.bindHost],
    [KEYS.portStart, String(next.portStart)],
    [KEYS.portEnd, String(next.portEnd)],
  ];
  for (const [key, value] of values) {
    db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
  }
  return next;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run backend/services/adb-proxy/settings.test.ts`
Expected: PASS, 14 tests (the `it.each` counts as 7).

- [ ] **Step 5: Write the failing port allocator test**

Create `backend/services/adb-proxy/port-allocator.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../../test-utils/create-test-db';
import { adbProxyDevices, devices } from '../../db/schema';
import { PortAllocator, PortError } from './port-allocator';

function setup(range = { start: 6500, end: 6502 }) {
  const db = createTestDb([devices, adbProxyDevices], { foreignKeys: true });
  for (const id of ['A', 'B', 'C', 'D']) db.insert(devices).values({ id }).run();
  let current = range;
  const alloc = new PortAllocator(db, () => current, () => new Date('2026-10-11T10:00:00Z'));
  return { db, alloc, setRange: (r: typeof range) => { current = r; } };
}

describe('PortAllocator', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  it('hands out the lowest free port and enables the device', () => {
    const a = ctx.alloc.ensure('A');
    expect(a).toMatchObject({ deviceId: 'A', port: 6500, enabled: true });
    expect(ctx.alloc.ensure('B')).toMatchObject({ port: 6501 });
  });

  it('returns the same port for the same device, including from a new allocator', () => {
    const first = ctx.alloc.ensure('A') as { port: number };
    expect((ctx.alloc.ensure('A') as { port: number }).port).toBe(first.port);
    const again = new PortAllocator(ctx.db, () => ({ start: 6500, end: 6502 }));
    expect((again.ensure('A') as { port: number }).port).toBe(first.port);
  });

  it('reports range-full when every port is taken', () => {
    ctx.alloc.ensure('A'); ctx.alloc.ensure('B'); ctx.alloc.ensure('C');
    expect(ctx.alloc.ensure('D')).toEqual({ error: 'range-full' });
    expect(ctx.alloc.get('D')).toBeUndefined();
  });

  it('keeps existing ports when the range later changes', () => {
    ctx.alloc.ensure('A');
    ctx.setRange({ start: 7000, end: 7001 });
    expect((ctx.alloc.ensure('A') as { port: number }).port).toBe(6500);
    expect((ctx.alloc.ensure('B') as { port: number }).port).toBe(7000);
  });

  it('setPort moves a device to a free in-range port', () => {
    ctx.alloc.ensure('A');
    expect(ctx.alloc.setPort('A', 6502).port).toBe(6502);
    expect(ctx.alloc.get('A')?.port).toBe(6502);
  });

  it('setPort accepts the device\'s own current port', () => {
    ctx.alloc.ensure('A');
    expect(ctx.alloc.setPort('A', 6500).port).toBe(6500);
  });

  it('setPort rejects a port outside the range and a port another device holds', () => {
    ctx.alloc.ensure('A'); ctx.alloc.ensure('B');
    const codeOf = (fn: () => void) => {
      try { fn(); } catch (e) { return e instanceof PortError ? e.code : 'other-error'; }
      return 'no-throw';
    };
    expect(codeOf(() => ctx.alloc.setPort('A', 6501))).toBe('in-use');
    expect(codeOf(() => ctx.alloc.setPort('A', 9000))).toBe('out-of-range');
    expect(ctx.alloc.get('A')?.port).toBe(6500);
  });

  it('setEnabled flips the flag and returns undefined for an unknown device', () => {
    ctx.alloc.ensure('A');
    expect(ctx.alloc.setEnabled('A', false)?.enabled).toBe(false);
    expect(ctx.alloc.setEnabled('NOPE', false)).toBeUndefined();
  });

  it('lists every row', () => {
    ctx.alloc.ensure('A'); ctx.alloc.ensure('B');
    expect(ctx.alloc.all().map((r) => r.deviceId)).toEqual(['A', 'B']);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run backend/services/adb-proxy/port-allocator.test.ts`
Expected: FAIL with "Failed to resolve import './port-allocator'".

- [ ] **Step 7: Write the port allocator**

Create `backend/services/adb-proxy/port-allocator.ts`:

```ts
import { asc, eq } from 'drizzle-orm';
import { adbProxyDevices } from '../../db/schema';
import type { AppDatabase } from '../../db/index';

export type ProxyDeviceRow = typeof adbProxyDevices.$inferSelect;

export class PortError extends Error {
  constructor(readonly code: 'out-of-range' | 'in-use', message: string) {
    super(message);
    this.name = 'PortError';
  }
}

export class PortAllocator {
  constructor(
    private readonly db: AppDatabase,
    private readonly range: () => { start: number; end: number },
    private readonly now: () => Date = () => new Date(),
  ) {}

  get(deviceId: string): ProxyDeviceRow | undefined {
    return this.db.select().from(adbProxyDevices).where(eq(adbProxyDevices.deviceId, deviceId)).get();
  }

  all(): ProxyDeviceRow[] {
    return this.db.select().from(adbProxyDevices).orderBy(asc(adbProxyDevices.createdAt), asc(adbProxyDevices.port)).all();
  }

  /** The device's row, creating it with the lowest free port in range if it has none. */
  ensure(deviceId: string): ProxyDeviceRow | { error: 'range-full' } {
    const existing = this.get(deviceId);
    if (existing) return existing;
    const { start, end } = this.range();
    const used = new Set(this.all().map((r) => r.port));
    for (let port = start; port <= end; port++) {
      if (used.has(port)) continue;
      this.db.insert(adbProxyDevices).values({ deviceId, port, enabled: true, createdAt: this.now() }).run();
      return this.get(deviceId)!;
    }
    return { error: 'range-full' };
  }

  setPort(deviceId: string, port: number): ProxyDeviceRow {
    const { start, end } = this.range();
    if (!Number.isInteger(port) || port < start || port > end) {
      throw new PortError('out-of-range', `port must be between ${start} and ${end}`);
    }
    const holder = this.all().find((r) => r.port === port);
    if (holder && holder.deviceId !== deviceId) throw new PortError('in-use', `port ${port} is used by another device`);
    this.db.update(adbProxyDevices).set({ port }).where(eq(adbProxyDevices.deviceId, deviceId)).run();
    return this.get(deviceId)!;
  }

  setEnabled(deviceId: string, enabled: boolean): ProxyDeviceRow | undefined {
    if (!this.get(deviceId)) return undefined;
    this.db.update(adbProxyDevices).set({ enabled }).where(eq(adbProxyDevices.deviceId, deviceId)).run();
    return this.get(deviceId);
  }
}
```

- [ ] **Step 8: Run both test files to verify they pass**

Run: `npx vitest run backend/services/adb-proxy/settings.test.ts backend/services/adb-proxy/port-allocator.test.ts`
Expected: PASS (settings 14, allocator 9).

- [ ] **Step 9: Commit**

```bash
git add backend/services/adb-proxy/settings.ts backend/services/adb-proxy/settings.test.ts backend/services/adb-proxy/port-allocator.ts backend/services/adb-proxy/port-allocator.test.ts
git commit -m "feat(adb-proxy): add settings and persistent port allocation

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Pending request registry, pre-auth limiter and log throttle

**Files:**
- Create: `backend/services/adb-proxy/pending.ts`
- Create: `backend/services/adb-proxy/limits.ts`
- Create: `backend/services/adb-proxy/throttle.ts`
- Test: `backend/services/adb-proxy/pending.test.ts`
- Test: `backend/services/adb-proxy/limits.test.ts`
- Test: `backend/services/adb-proxy/throttle.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface PendingEntry { requestId: string; keyId: string; publicKey: string; fingerprint: string; comment: string; deviceId: string; peerIp: string; createdAt: number }`
  - `type PendingDecision = 'approved' | 'denied' | 'replaced' | 'timeout' | 'cancelled'`
  - `type AddResult = { ok: true; entry: PendingEntry; decision: Promise<PendingDecision>; cancel(): void } | { ok: false; reason: 'cap' | 'rate' }`
  - `interface PendingOptions { maxPending?: number; perIpPerMinute?: number; timeoutMs?: number; onChange?: () => void }` (defaults 20, 3, 300000)
  - `class PendingRegistry { constructor(opts?: PendingOptions); add(input: Omit<PendingEntry, 'requestId' | 'createdAt'>): AddResult; list(): PendingEntry[]; get(requestId: string): PendingEntry | undefined; resolve(requestId: string, decision: 'approved' | 'denied'): boolean; resolveKey(keyId: string, decision: 'approved' | 'denied'): number; stop(): void }`
  - `class PreAuthLimiter { constructor(maxPerIp?: number, maxTotal?: number); acquire(ip: string): (() => void) | null; readonly active: number }` (defaults 8 and 64; the returned release is idempotent)
  - `onceEvery<A extends unknown[]>(intervalMs: number, fn: (...args: A) => void, now?: () => number): (...args: A) => void`: runs `fn` at most once per interval and drops calls inside it (used to log a down ADB server once per interval, not once per packet)

- [ ] **Step 1: Write the failing pending test**

Create `backend/services/adb-proxy/pending.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PendingRegistry } from './pending';

const input = (over: Partial<Parameters<PendingRegistry['add']>[0]> = {}) => ({
  keyId: 'k1', publicKey: 'cHVi', fingerprint: 'AA:BB', comment: 'ci@runner', deviceId: 'DEV1', peerIp: '10.0.0.5', ...over,
});

describe('PendingRegistry', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-11T10:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('adds an entry with an id and creation time and lists it', () => {
    const reg = new PendingRegistry();
    const r = reg.add(input());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.entry.createdAt).toBe(Date.parse('2026-10-11T10:00:00Z'));
    expect(reg.list()).toEqual([r.entry]);
    expect(reg.get(r.entry.requestId)).toEqual(r.entry);
  });

  it('resolve settles the decision promise and removes the entry', async () => {
    const reg = new PendingRegistry();
    const r = reg.add(input());
    if (!r.ok) throw new Error('add failed');
    expect(reg.resolve(r.entry.requestId, 'approved')).toBe(true);
    await expect(r.decision).resolves.toBe('approved');
    expect(reg.list()).toEqual([]);
    expect(reg.resolve(r.entry.requestId, 'approved')).toBe(false);
  });

  it('resolveKey settles every entry for a key across devices and returns the count', async () => {
    const reg = new PendingRegistry();
    const a = reg.add(input({ deviceId: 'DEV1' }));
    const b = reg.add(input({ deviceId: 'DEV2' }));
    const c = reg.add(input({ keyId: 'k2' }));
    if (!a.ok || !b.ok || !c.ok) throw new Error('add failed');
    expect(reg.resolveKey('k1', 'denied')).toBe(2);
    await expect(a.decision).resolves.toBe('denied');
    await expect(b.decision).resolves.toBe('denied');
    expect(reg.list()).toHaveLength(1);
    expect(reg.resolveKey('k1', 'denied')).toBe(0);
  });

  it('a repeat for the same key and device replaces the older entry without using the rate budget', async () => {
    const reg = new PendingRegistry({ perIpPerMinute: 1 });
    const first = reg.add(input());
    const second = reg.add(input());
    if (!first.ok || !second.ok) throw new Error('add failed');
    await expect(first.decision).resolves.toBe('replaced');
    expect(reg.list()).toEqual([second.entry]);
  });

  it('refuses a new entry past the total cap', () => {
    const reg = new PendingRegistry({ maxPending: 2, perIpPerMinute: 100 });
    expect(reg.add(input({ keyId: 'a' })).ok).toBe(true);
    expect(reg.add(input({ keyId: 'b' })).ok).toBe(true);
    expect(reg.add(input({ keyId: 'c' }))).toEqual({ ok: false, reason: 'cap' });
  });

  it('still allows a replacement when the registry is full', () => {
    const reg = new PendingRegistry({ maxPending: 1 });
    expect(reg.add(input()).ok).toBe(true);
    expect(reg.add(input()).ok).toBe(true);
  });

  it('limits new entries per IP per minute and lets the window slide', () => {
    const reg = new PendingRegistry({ perIpPerMinute: 3 });
    for (const k of ['a', 'b', 'c']) expect(reg.add(input({ keyId: k })).ok).toBe(true);
    expect(reg.add(input({ keyId: 'd' }))).toEqual({ ok: false, reason: 'rate' });
    expect(reg.add(input({ keyId: 'e', peerIp: '10.0.0.6' })).ok).toBe(true);
    vi.advanceTimersByTime(61_000);
    expect(reg.add(input({ keyId: 'd' })).ok).toBe(true);
  });

  it('times out after 5 minutes by default', async () => {
    const reg = new PendingRegistry();
    const r = reg.add(input());
    if (!r.ok) throw new Error('add failed');
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(reg.list()).toHaveLength(1);
    vi.advanceTimersByTime(2);
    await expect(r.decision).resolves.toBe('timeout');
    expect(reg.list()).toEqual([]);
  });

  it('cancel removes the entry, settles as cancelled and leaves no timer behind', async () => {
    const reg = new PendingRegistry();
    const r = reg.add(input());
    if (!r.ok) throw new Error('add failed');
    r.cancel();
    await expect(r.decision).resolves.toBe('cancelled');
    expect(reg.list()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolving a request whose client already cancelled is a clean no-op', () => {
    const reg = new PendingRegistry();
    const r = reg.add(input());
    if (!r.ok) throw new Error('add failed');
    r.cancel();
    expect(reg.resolve(r.entry.requestId, 'approved')).toBe(false);
    expect(reg.resolveKey('k1', 'approved')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop cancels everything', async () => {
    const reg = new PendingRegistry();
    const a = reg.add(input({ keyId: 'a' }));
    const b = reg.add(input({ keyId: 'b' }));
    if (!a.ok || !b.ok) throw new Error('add failed');
    reg.stop();
    await expect(a.decision).resolves.toBe('cancelled');
    await expect(b.decision).resolves.toBe('cancelled');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('calls onChange for add, resolve, replace, cancel and timeout', () => {
    const onChange = vi.fn();
    const reg = new PendingRegistry({ onChange });
    const r = reg.add(input());
    if (!r.ok) throw new Error('add failed');
    expect(onChange).toHaveBeenCalledTimes(1);
    reg.resolve(r.entry.requestId, 'approved');
    expect(onChange).toHaveBeenCalledTimes(2);
    const s = reg.add(input());
    if (!s.ok) throw new Error('add failed');
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(onChange).toHaveBeenCalledTimes(4);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run backend/services/adb-proxy/pending.test.ts`
Expected: FAIL with "Failed to resolve import './pending'".

- [ ] **Step 3: Write the pending registry**

Create `backend/services/adb-proxy/pending.ts`:

```ts
import { randomUUID } from 'node:crypto';

export interface PendingEntry {
  requestId: string;
  keyId: string;
  /** Base64 of the 524-byte key blob. */
  publicKey: string;
  fingerprint: string;
  comment: string;
  deviceId: string;
  peerIp: string;
  createdAt: number;
}

export type PendingDecision = 'approved' | 'denied' | 'replaced' | 'timeout' | 'cancelled';

export type AddResult =
  | { ok: true; entry: PendingEntry; decision: Promise<PendingDecision>; cancel(): void }
  | { ok: false; reason: 'cap' | 'rate' };

export interface PendingOptions {
  maxPending?: number;
  perIpPerMinute?: number;
  timeoutMs?: number;
  onChange?: () => void;
}

interface Slot {
  entry: PendingEntry;
  settle(decision: PendingDecision): void;
  timer: NodeJS.Timeout;
}

const WINDOW_MS = 60_000;

export class PendingRegistry {
  private readonly slots = new Map<string, Slot>();
  private readonly ipHits = new Map<string, number[]>();
  private readonly maxPending: number;
  private readonly perIpPerMinute: number;
  private readonly timeoutMs: number;
  private readonly onChange?: () => void;

  constructor(opts: PendingOptions = {}) {
    this.maxPending = opts.maxPending ?? 20;
    this.perIpPerMinute = opts.perIpPerMinute ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 5 * 60_000;
    this.onChange = opts.onChange;
  }

  add(input: Omit<PendingEntry, 'requestId' | 'createdAt'>): AddResult {
    const same = [...this.slots.values()].find((s) => s.entry.keyId === input.keyId && s.entry.deviceId === input.deviceId);
    if (!same) {
      if (this.slots.size >= this.maxPending) return { ok: false, reason: 'cap' };
      if (!this.takeRate(input.peerIp)) return { ok: false, reason: 'rate' };
    } else {
      this.finish(same.entry.requestId, 'replaced');
    }
    const entry: PendingEntry = { ...input, requestId: randomUUID(), createdAt: Date.now() };
    let settle!: (d: PendingDecision) => void;
    const decision = new Promise<PendingDecision>((resolve) => { settle = resolve; });
    const timer = setTimeout(() => this.finish(entry.requestId, 'timeout'), this.timeoutMs);
    timer.unref?.();
    this.slots.set(entry.requestId, { entry, settle, timer });
    this.onChange?.();
    return { ok: true, entry, decision, cancel: () => { this.finish(entry.requestId, 'cancelled'); } };
  }

  list(): PendingEntry[] {
    return [...this.slots.values()].map((s) => s.entry).sort((a, b) => a.createdAt - b.createdAt);
  }

  get(requestId: string): PendingEntry | undefined {
    return this.slots.get(requestId)?.entry;
  }

  resolve(requestId: string, decision: 'approved' | 'denied'): boolean {
    return this.finish(requestId, decision);
  }

  resolveKey(keyId: string, decision: 'approved' | 'denied'): number {
    const ids = [...this.slots.values()].filter((s) => s.entry.keyId === keyId).map((s) => s.entry.requestId);
    for (const id of ids) this.finish(id, decision);
    return ids.length;
  }

  stop(): void {
    for (const id of [...this.slots.keys()]) this.finish(id, 'cancelled');
  }

  private finish(requestId: string, decision: PendingDecision): boolean {
    const slot = this.slots.get(requestId);
    if (!slot) return false;
    clearTimeout(slot.timer);
    this.slots.delete(requestId);
    slot.settle(decision);
    this.onChange?.();
    return true;
  }

  private takeRate(ip: string): boolean {
    const now = Date.now();
    const hits = (this.ipHits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
    if (this.ipHits.size > 256) this.pruneRates(now);
    if (hits.length >= this.perIpPerMinute) {
      this.ipHits.set(ip, hits);
      return false;
    }
    hits.push(now);
    this.ipHits.set(ip, hits);
    return true;
  }

  private pruneRates(now: number): void {
    for (const [ip, hits] of this.ipHits) {
      if (hits.every((t) => now - t >= WINDOW_MS)) this.ipHits.delete(ip);
    }
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run backend/services/adb-proxy/pending.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Write the failing limiter test**

Create `backend/services/adb-proxy/limits.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PreAuthLimiter } from './limits';

describe('PreAuthLimiter', () => {
  it('allows 8 sockets per IP by default and refuses the ninth', () => {
    const l = new PreAuthLimiter();
    for (let i = 0; i < 8; i++) expect(l.acquire('10.0.0.1')).not.toBeNull();
    expect(l.acquire('10.0.0.1')).toBeNull();
  });

  it('counts IPs independently', () => {
    const l = new PreAuthLimiter(1, 10);
    expect(l.acquire('a')).not.toBeNull();
    expect(l.acquire('b')).not.toBeNull();
    expect(l.acquire('a')).toBeNull();
  });

  it('enforces the total cap across IPs', () => {
    const l = new PreAuthLimiter(10, 3);
    expect(l.acquire('a')).not.toBeNull();
    expect(l.acquire('b')).not.toBeNull();
    expect(l.acquire('c')).not.toBeNull();
    expect(l.acquire('d')).toBeNull();
  });

  it('gives the slot back on release so the same IP can connect again', () => {
    const l = new PreAuthLimiter(1, 10);
    const release = l.acquire('a')!;
    expect(l.acquire('a')).toBeNull();
    release();
    expect(l.active).toBe(0);
    expect(l.acquire('a')).not.toBeNull();
  });

  it('treats a second release of the same slot as a no-op', () => {
    const l = new PreAuthLimiter(2, 10);
    const first = l.acquire('a')!;
    l.acquire('a');
    first();
    first();
    expect(l.active).toBe(1);
    expect(l.acquire('a')).not.toBeNull();
    expect(l.acquire('a')).toBeNull();
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run backend/services/adb-proxy/limits.test.ts`
Expected: FAIL with "Failed to resolve import './limits'".

- [ ] **Step 7: Write the limiter**

Create `backend/services/adb-proxy/limits.ts`:

```ts
export class PreAuthLimiter {
  private readonly perIp = new Map<string, number>();
  private total = 0;

  constructor(
    private readonly maxPerIp = 8,
    private readonly maxTotal = 64,
  ) {}

  get active(): number {
    return this.total;
  }

  /** Reserve a pre-auth slot, or null when the IP or the whole proxy is at its cap. The release is idempotent. */
  acquire(ip: string): (() => void) | null {
    const current = this.perIp.get(ip) ?? 0;
    if (this.total >= this.maxTotal || current >= this.maxPerIp) return null;
    this.total++;
    this.perIp.set(ip, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total--;
      const left = (this.perIp.get(ip) ?? 1) - 1;
      if (left <= 0) this.perIp.delete(ip);
      else this.perIp.set(ip, left);
    };
  }
}
```

- [ ] **Step 8: Run both test files to verify they pass**

Run: `npx vitest run backend/services/adb-proxy/pending.test.ts backend/services/adb-proxy/limits.test.ts`
Expected: PASS (pending 12, limits 5).

- [ ] **Step 9: Write the failing throttle test**

Create `backend/services/adb-proxy/throttle.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { onceEvery } from './throttle';

describe('onceEvery', () => {
  it('runs the first call and drops calls inside the interval', () => {
    let clock = 1000;
    const fn = vi.fn();
    const throttled = onceEvery(30_000, fn, () => clock);
    throttled('a');
    clock += 29_999;
    throttled('b');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('a');
  });

  it('runs again once the interval has passed', () => {
    let clock = 0;
    const fn = vi.fn();
    const throttled = onceEvery(1000, fn, () => clock);
    throttled(1);
    clock = 1000;
    throttled(2);
    expect(fn.mock.calls).toEqual([[1], [2]]);
  });

  it('runs the very first call even when the clock starts at zero', () => {
    const fn = vi.fn();
    onceEvery(1000, fn, () => 0)();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 10: Run it to verify it fails, then implement**

Run: `npx vitest run backend/services/adb-proxy/throttle.test.ts`
Expected: FAIL with "Failed to resolve import './throttle'".

Create `backend/services/adb-proxy/throttle.ts`:

```ts
/** Wrap `fn` so it runs at most once per interval; calls inside the interval are dropped. */
export function onceEvery<A extends unknown[]>(
  intervalMs: number,
  fn: (...args: A) => void,
  now: () => number = Date.now,
): (...args: A) => void {
  let last = Number.NEGATIVE_INFINITY;
  return (...args: A) => {
    const t = now();
    if (t - last < intervalMs) return;
    last = t;
    fn(...args);
  };
}
```

Run: `npx vitest run backend/services/adb-proxy/throttle.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 11: Commit**

```bash
git add backend/services/adb-proxy/pending.ts backend/services/adb-proxy/pending.test.ts backend/services/adb-proxy/limits.ts backend/services/adb-proxy/limits.test.ts backend/services/adb-proxy/throttle.ts backend/services/adb-proxy/throttle.test.ts
git commit -m "feat(adb-proxy): add in-memory pending requests, the pre-auth limiter and a log throttle

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Session handshake

**Files:**
- Create: `backend/services/adb-proxy/testing/wire-client.ts`
- Create: `backend/services/adb-proxy/testing/session-server.ts`
- Create: `backend/services/adb-proxy/testing/stub-gate.ts`
- Create: `backend/services/adb-proxy/session.ts`
- Test: `backend/services/adb-proxy/session.handshake.test.ts`

**Interfaces:**
- Consumes: `packet.ts` (Task 2), `adb-key.ts` and `testing/test-keys.ts` (Task 3).
- Produces (in `session.ts`):
  - `type SessionState = 'await-cnxn' | 'await-auth' | 'pending' | 'finishing' | 'ready' | 'closed'`
  - `interface ApprovedKey { keyId: string; key: KeyObject }`
  - `type OfferOutcome = { kind: 'blocked' } | { kind: 'approved' } | { kind: 'pending'; requestId: string; decision: Promise<'approved' | 'denied'>; cancel(): void }`
  - `interface AuthGate { approvedKeys(deviceId: string): ApprovedKey[]; offer(o: { deviceId: string; parsed: ParsedAdbKey; peerIp: string }): OfferOutcome; authenticated(i: { deviceId: string; keyId: string; peerIp: string }): void }`
  - `interface BackendConnector { openService(serial: string, service: string): Promise<net.Socket>; deviceBanner(serial: string): Promise<string> }` (`HostClient` satisfies it)
  - `type SessionEvent = { kind: 'auth-failed' | 'authenticated' | 'pending' | 'blocked'; session: Session } | { kind: 'refused-service'; session: Session; service: string } | { kind: 'closed'; session: Session; reason: string }`
  - `interface SessionOptions { socket: net.Socket; deviceId: string; peerIp: string; gate: AuthGate; backend: BackendConnector; isDeviceOnline(): boolean; onEvent?(e: SessionEvent): void; onClose?(s: Session): void; onLeavePreAuth?(): void; preAuthTimeoutMs?: number }`
  - `class Session { readonly id: number; readonly createdAt: number; readonly deviceId: string; readonly peerIp: string; state: SessionState; keyId: string | null; keyComment: string | null; get isClosed(): boolean; destroy(reason: string): void }`
- Produces (test support): `WireClient` (`static connect(port)`, `send(command, arg0, arg1, data?)`, `next(timeoutMs?)`, `waitFor(predicate, timeoutMs?)`, `waitClosed(timeoutMs?)`, `quiet(ms?)`, `authenticate(key)`, `offerKey(key)`, `offerKeyWithoutProof(key)`, `openRaw(service, remoteId)`, `open(service, remoteId)`, `collectStream(remoteId, localId, until)`, `close()`, `readonly packets`), `startSessionServer(make)` returning `{ port, sessions, sockets, close() }`, and `StubGate`.

- [ ] **Step 1: Write the test support**

Create `backend/services/adb-proxy/testing/wire-client.ts`:

```ts
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import {
  A_AUTH, A_CLSE, A_CNXN, A_OKAY, A_OPEN, A_VERSION, A_WRTE,
  AUTH_RSAPUBLICKEY, AUTH_SIGNATURE, AUTH_TOKEN, MAX_DATA,
  PacketParser, encodePacket, type Packet,
} from '../packet';
import type { TestAdbKey } from './test-keys';

/** A minimal ADB client over the wire protocol, for driving the proxy in tests. */
export class WireClient {
  /** Every packet received, in order. */
  readonly packets: Packet[] = [];
  closed = false;
  private readonly parser = new PacketParser(MAX_DATA);
  private cursor = 0;
  private waiters: Array<() => void> = [];

  private constructor(readonly socket: net.Socket) {
    socket.on('data', (chunk) => {
      try {
        this.packets.push(...this.parser.push(chunk));
      } catch {
        socket.destroy();
      }
      this.wake();
    });
    socket.on('close', () => {
      this.closed = true;
      this.wake();
    });
    socket.on('error', () => {});
  }

  static connect(port: number): Promise<WireClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => resolve(new WireClient(socket)));
      socket.once('error', reject);
    });
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  private sleepUntilWoken(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  send(command: number, arg0: number, arg1: number, data?: Buffer | string): void {
    const payload = typeof data === 'string' ? Buffer.from(data) : data;
    this.socket.write(encodePacket({ command, arg0, arg1, data: payload }));
  }

  /** The next unread packet; rejects on timeout or when the socket closed with nothing left. */
  async next(timeoutMs = 2000): Promise<Packet> {
    const deadline = Date.now() + timeoutMs;
    while (this.cursor >= this.packets.length) {
      if (this.closed) throw new Error('socket closed');
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('timed out waiting for a packet');
      await this.sleepUntilWoken(left);
    }
    return this.packets[this.cursor++];
  }

  /** The first packet anywhere in the log that matches, waiting for it if needed. */
  async waitFor(predicate: (p: Packet) => boolean, timeoutMs = 2000): Promise<Packet> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.packets.find(predicate);
      if (hit) return hit;
      if (this.closed) throw new Error('socket closed before the packet arrived');
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('timed out waiting for a matching packet');
      await this.sleepUntilWoken(left);
    }
  }

  async waitClosed(timeoutMs = 2000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed && Date.now() < deadline) await this.sleepUntilWoken(deadline - Date.now());
    return this.closed;
  }

  /** True when no packet arrived during the window. */
  async quiet(ms = 100): Promise<boolean> {
    const before = this.packets.length;
    await new Promise((r) => setTimeout(r, ms));
    return this.packets.length === before;
  }

  sendHostCnxn(): void {
    this.send(A_CNXN, A_VERSION, MAX_DATA, 'host::features=cmd\0');
  }

  /** CNXN, then answer the AUTH token with a signature from `key`. Returns the proxy's next packet. */
  async authenticate(key: TestAdbKey): Promise<Packet> {
    this.sendHostCnxn();
    const token = await this.next();
    if (token.command !== A_AUTH || token.arg0 !== AUTH_TOKEN) throw new Error('expected an AUTH token');
    this.send(A_AUTH, AUTH_SIGNATURE, 0, key.sign(token.data));
    return this.next();
  }

  /** CNXN, a signature over the token made with `key` (a real client signs first), then offer the public key. */
  async offerKey(key: TestAdbKey): Promise<void> {
    this.sendHostCnxn();
    const token = await this.next();
    if (token.command !== A_AUTH || token.arg0 !== AUTH_TOKEN) throw new Error('expected an AUTH token');
    this.send(A_AUTH, AUTH_SIGNATURE, 0, key.sign(token.data));
    const again = await this.next();
    if (again.command !== A_AUTH || again.arg0 !== AUTH_TOKEN) throw new Error('expected a second AUTH token');
    this.send(A_AUTH, AUTH_RSAPUBLICKEY, 0, key.publicKeyText);
  }

  /** Like offerKey, but the signature is garbage: this client cannot show it holds the private key. */
  async offerKeyWithoutProof(key: TestAdbKey): Promise<void> {
    this.sendHostCnxn();
    const token = await this.next();
    if (token.command !== A_AUTH || token.arg0 !== AUTH_TOKEN) throw new Error('expected an AUTH token');
    this.send(A_AUTH, AUTH_SIGNATURE, 0, randomBytes(256));
    const again = await this.next();
    if (again.command !== A_AUTH || again.arg0 !== AUTH_TOKEN) throw new Error('expected a second AUTH token');
    this.send(A_AUTH, AUTH_RSAPUBLICKEY, 0, key.publicKeyText);
  }

  async openRaw(service: string, remoteId: number): Promise<Packet> {
    this.send(A_OPEN, remoteId, 0, service + '\0');
    return this.next();
  }

  async open(service: string, remoteId = 1): Promise<{ localId: number }> {
    const reply = await this.openRaw(service, remoteId);
    if (reply.command !== A_OKAY) throw new Error(`open ${service} was refused`);
    return { localId: reply.arg0 };
  }

  /** Read WRTE data for a stream, acknowledging each, until `until` bytes arrived or the stream closed. */
  async collectStream(remoteId: number, localId: number, until: number | 'close', timeoutMs = 3000): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (until !== 'close' && total >= until) return Buffer.concat(chunks);
      const p = await this.next(Math.max(1, deadline - Date.now()));
      if (p.command === A_WRTE && p.arg0 === localId && p.arg1 === remoteId) {
        chunks.push(p.data);
        total += p.data.length;
        this.send(A_OKAY, remoteId, localId);
      } else if (p.command === A_CLSE && p.arg0 === localId) {
        return Buffer.concat(chunks);
      }
    }
  }

  close(): void {
    this.socket.destroy();
  }
}
```

Create `backend/services/adb-proxy/testing/session-server.ts`:

```ts
import net from 'node:net';
import type { Session } from '../session';

export interface SessionServer {
  port: number;
  sessions: Session[];
  sockets: net.Socket[];
  close(): Promise<void>;
}

/** A throwaway TCP server that wraps every accepted socket in a Session built by `make`. */
export async function startSessionServer(make: (socket: net.Socket, index: number) => Session): Promise<SessionServer> {
  const sessions: Session[] = [];
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    sessions.push(make(socket, sessions.length));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    port: (server.address() as net.AddressInfo).port,
    sessions,
    sockets,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
```

Create `backend/services/adb-proxy/testing/stub-gate.ts`:

```ts
import type { ParsedAdbKey } from '../adb-key';
import type { ApprovedKey, AuthGate, OfferOutcome } from '../session';

export class StubGate implements AuthGate {
  approved: ApprovedKey[] = [];
  outcome: OfferOutcome = { kind: 'blocked' };
  offers: Array<{ deviceId: string; keyId: string; peerIp: string }> = [];
  authenticatedCalls: Array<{ deviceId: string; keyId: string; peerIp: string }> = [];

  approvedKeys(): ApprovedKey[] {
    return this.approved;
  }

  offer(o: { deviceId: string; parsed: ParsedAdbKey; peerIp: string }): OfferOutcome {
    this.offers.push({ deviceId: o.deviceId, keyId: o.parsed.keyId, peerIp: o.peerIp });
    return this.outcome;
  }

  authenticated(info: { deviceId: string; keyId: string; peerIp: string }): void {
    this.authenticatedCalls.push(info);
  }
}
```

- [ ] **Step 2: Write the failing handshake test**

Create `backend/services/adb-proxy/session.handshake.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { parseAdbPublicKey } from './adb-key';
import { A_AUTH, A_CNXN, A_OPEN, A_VERSION, AUTH_SIGNATURE, AUTH_TOKEN, MAX_DATA, encodePacket } from './packet';
import { Session, type SessionEvent } from './session';
import { makeTestAdbKey } from './testing/test-keys';
import { StubGate } from './testing/stub-gate';
import { startSessionServer, type SessionServer } from './testing/session-server';
import { WireClient } from './testing/wire-client';

const BANNER = 'device::ro.product.name=t;features=cmd';
const open: Array<{ close(): void | Promise<unknown> }> = [];

async function setup(opts: { preAuthTimeoutMs?: number; deviceOnline?: boolean; banner?: () => Promise<string> } = {}) {
  const gate = new StubGate();
  const key = makeTestAdbKey();
  gate.approved = [{ keyId: key.keyId, key: parseAdbPublicKey(key.publicKeyText).key }];
  const events: SessionEvent[] = [];
  const closed: Session[] = [];
  const state = { online: opts.deviceOnline ?? true, leaves: 0 };
  const backend = { openService: vi.fn(), deviceBanner: vi.fn(opts.banner ?? (async () => BANNER)) };
  const server: SessionServer = await startSessionServer((socket) =>
    new Session({
      socket, deviceId: 'DEV1', peerIp: '10.0.0.5', gate, backend,
      isDeviceOnline: () => state.online,
      onEvent: (e) => events.push(e),
      onClose: (s) => closed.push(s),
      onLeavePreAuth: () => { state.leaves++; },
      preAuthTimeoutMs: opts.preAuthTimeoutMs ?? 5000,
    }),
  );
  open.push(server);
  const connect = async () => {
    const c = await WireClient.connect(server.port);
    open.push(c);
    return c;
  };
  return { gate, key, events, closed, state, backend, server, connect };
}

afterEach(async () => {
  for (const o of open.splice(0)) await o.close();
});

describe('Session handshake', () => {
  it('accepts a client whose signature matches an approved key and answers with the device banner', async () => {
    const h = await setup();
    const client = await h.connect();
    const reply = await client.authenticate(h.key);
    expect(reply.command).toBe(A_CNXN);
    expect(reply.arg0).toBe(A_VERSION);
    expect(reply.arg1).toBe(MAX_DATA);
    expect(reply.data.toString()).toBe(BANNER + '\0');
    expect(h.gate.authenticatedCalls).toEqual([{ deviceId: 'DEV1', keyId: h.key.keyId, peerIp: '10.0.0.5' }]);
    expect(h.server.sessions[0].state).toBe('ready');
    expect(h.server.sessions[0].keyId).toBe(h.key.keyId);
    expect(h.state.leaves).toBe(1);
    expect(h.events.map((e) => e.kind)).toContain('authenticated');
  });

  it('closes without a banner when the device is offline', async () => {
    const h = await setup({ deviceOnline: false });
    const client = await h.connect();
    client.sendHostCnxn();
    expect(await client.waitClosed()).toBe(true);
    expect(client.packets).toHaveLength(0);
  });

  it('sends a fresh token after each unknown signature and drops the fourth attempt', async () => {
    const h = await setup();
    const client = await h.connect();
    client.sendHostCnxn();
    const tokens = [await client.next()];
    for (let i = 0; i < 3; i++) {
      client.send(A_AUTH, AUTH_SIGNATURE, 0, randomBytes(256));
      tokens.push(await client.next());
    }
    expect(tokens.every((t) => t.command === A_AUTH && t.arg0 === AUTH_TOKEN)).toBe(true);
    expect(new Set(tokens.map((t) => t.data.toString('hex'))).size).toBe(4);
    client.send(A_AUTH, AUTH_SIGNATURE, 0, randomBytes(256));
    expect(await client.waitClosed()).toBe(true);
    expect(h.events.filter((e) => e.kind === 'auth-failed')).toHaveLength(3);
  });

  it('holds an unknown key as pending and sends CNXN on the same connection once approved', async () => {
    const h = await setup();
    let approve!: (d: 'approved' | 'denied') => void;
    const decision = new Promise<'approved' | 'denied'>((r) => { approve = r; });
    h.gate.outcome = { kind: 'pending', requestId: 'r1', decision, cancel: vi.fn() };
    const other = makeTestAdbKey('someone@else');
    const client = await h.connect();
    await client.offerKey(other);
    await vi.waitFor(() => expect(h.gate.offers).toHaveLength(1));
    expect(h.gate.offers[0]).toEqual({ deviceId: 'DEV1', keyId: other.keyId, peerIp: '10.0.0.5' });
    expect(await client.quiet(100)).toBe(true);
    expect(h.server.sessions[0].state).toBe('pending');
    expect(h.server.sessions[0].keyComment).toBe('someone@else');
    expect(h.state.leaves).toBe(1);
    approve('approved');
    const reply = await client.next();
    expect(reply.command).toBe(A_CNXN);
    expect(h.server.sessions[0].state).toBe('ready');
    expect(h.gate.authenticatedCalls[0].keyId).toBe(other.keyId);
  });

  it('closes a pending connection that is denied', async () => {
    const h = await setup();
    let decide!: (d: 'approved' | 'denied') => void;
    h.gate.outcome = { kind: 'pending', requestId: 'r1', decision: new Promise((r) => { decide = r; }), cancel: vi.fn() };
    const client = await h.connect();
    await client.offerKey(makeTestAdbKey());
    await vi.waitFor(() => expect(h.gate.offers).toHaveLength(1));
    decide('denied');
    expect(await client.waitClosed()).toBe(true);
  });

  it('closes when the gate blocks the key', async () => {
    const h = await setup();
    h.gate.outcome = { kind: 'blocked' };
    const client = await h.connect();
    await client.offerKey(makeTestAdbKey());
    expect(await client.waitClosed()).toBe(true);
    expect(h.events.map((e) => e.kind)).toContain('blocked');
  });

  it('continues straight to CNXN when the gate reports the key as already approved', async () => {
    const h = await setup();
    h.gate.outcome = { kind: 'approved' };
    const client = await h.connect();
    await client.offerKey(makeTestAdbKey());
    expect((await client.next()).command).toBe(A_CNXN);
  });

  it('refuses an offered key the client never signed with, without asking the gate', async () => {
    const h = await setup();
    const client = await h.connect();
    await client.offerKeyWithoutProof(makeTestAdbKey());
    expect(await client.waitClosed()).toBe(true);
    expect(h.gate.offers).toHaveLength(0);
    expect(client.packets.some((p) => p.command === A_CNXN)).toBe(false);
  });

  it('does not let a copied approved public key through (no authentication by public key alone)', async () => {
    const h = await setup();
    h.gate.outcome = { kind: 'approved' };
    const client = await h.connect();
    await client.offerKeyWithoutProof(h.key);
    expect(await client.waitClosed()).toBe(true);
    expect(client.packets.some((p) => p.command === A_CNXN)).toBe(false);
    expect(h.gate.authenticatedCalls).toEqual([]);
  });

  it('refuses a key whose signature was made by a different key', async () => {
    const h = await setup();
    const offered = makeTestAdbKey();
    const other = makeTestAdbKey();
    const client = await h.connect();
    client.sendHostCnxn();
    const token = await client.next();
    client.send(A_AUTH, AUTH_SIGNATURE, 0, other.sign(token.data));
    await client.next();
    client.send(A_AUTH, AUTH_RSAPUBLICKEY, 0, offered.publicKeyText);
    expect(await client.waitClosed()).toBe(true);
    expect(h.gate.offers).toHaveLength(0);
  });

  it('refuses a signature made over a token this connection never issued', async () => {
    const h = await setup();
    const offered = makeTestAdbKey();
    const client = await h.connect();
    client.sendHostCnxn();
    await client.next();
    client.send(A_AUTH, AUTH_SIGNATURE, 0, offered.sign(randomBytes(20)));
    await client.next();
    client.send(A_AUTH, AUTH_RSAPUBLICKEY, 0, offered.publicKeyText);
    expect(await client.waitClosed()).toBe(true);
    expect(h.gate.offers).toHaveLength(0);
  });

  it('accepts the offer when one of several signatures came from the offered key', async () => {
    const h = await setup();
    const offered = makeTestAdbKey();
    const other = makeTestAdbKey();
    const client = await h.connect();
    client.sendHostCnxn();
    const first = await client.next();
    client.send(A_AUTH, AUTH_SIGNATURE, 0, other.sign(first.data));
    const second = await client.next();
    client.send(A_AUTH, AUTH_SIGNATURE, 0, offered.sign(second.data));
    await client.next();
    client.send(A_AUTH, AUTH_RSAPUBLICKEY, 0, offered.publicKeyText);
    await vi.waitFor(() => expect(h.gate.offers).toHaveLength(1));
    expect(h.gate.offers[0].keyId).toBe(offered.keyId);
  });

  it('cancels the pending request when the client disconnects', async () => {
    const h = await setup();
    const cancel = vi.fn();
    h.gate.outcome = { kind: 'pending', requestId: 'r1', decision: new Promise(() => {}), cancel };
    const client = await h.connect();
    await client.offerKey(makeTestAdbKey());
    await vi.waitFor(() => expect(h.gate.offers).toHaveLength(1));
    client.close();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });

  it('drops a client that connects and sends nothing, and gives its pre-auth slot back', async () => {
    const h = await setup({ preAuthTimeoutMs: 50 });
    const client = await h.connect();
    expect(await client.waitClosed(1000)).toBe(true);
    expect(h.closed).toHaveLength(1);
    expect(h.state.leaves).toBe(1);
    expect(h.events.find((e) => e.kind === 'closed')).toMatchObject({ reason: 'pre-auth timeout' });
  });

  it('drops a client that stalls after the first packet', async () => {
    const h = await setup({ preAuthTimeoutMs: 200 });
    const client = await h.connect();
    client.sendHostCnxn();
    await client.next();
    expect(await client.waitClosed(1500)).toBe(true);
    expect(h.state.leaves).toBe(1);
  });

  it('does not apply the pre-auth timeout to a held pending connection', async () => {
    const h = await setup({ preAuthTimeoutMs: 200 });
    let approve!: (d: 'approved' | 'denied') => void;
    h.gate.outcome = { kind: 'pending', requestId: 'r1', decision: new Promise((r) => { approve = r; }), cancel: vi.fn() };
    const client = await h.connect();
    await client.offerKey(makeTestAdbKey());
    await new Promise((r) => setTimeout(r, 500));
    expect(client.closed).toBe(false);
    approve('approved');
    expect((await client.next()).command).toBe(A_CNXN);
  });

  it('ignores packets that arrive while pending', async () => {
    const h = await setup();
    let approve!: (d: 'approved' | 'denied') => void;
    h.gate.outcome = { kind: 'pending', requestId: 'r1', decision: new Promise((r) => { approve = r; }), cancel: vi.fn() };
    const client = await h.connect();
    await client.offerKey(makeTestAdbKey());
    await vi.waitFor(() => expect(h.gate.offers).toHaveLength(1));
    client.send(A_OPEN, 1, 0, 'shell:id\0');
    expect(await client.quiet(100)).toBe(true);
    expect(client.closed).toBe(false);
    approve('approved');
    expect((await client.next()).command).toBe(A_CNXN);
  });

  it('closes on a payload larger than the pre-auth cap', async () => {
    const h = await setup();
    const client = await h.connect();
    client.socket.write(encodePacket({ command: A_CNXN, arg0: A_VERSION, arg1: MAX_DATA, data: Buffer.alloc(5000) }));
    expect(await client.waitClosed()).toBe(true);
  });

  it('closes on a bad magic', async () => {
    const h = await setup();
    const client = await h.connect();
    client.socket.write(Buffer.alloc(24));
    expect(await client.waitClosed()).toBe(true);
  });

  it('closes when the first packet is not CNXN', async () => {
    const h = await setup();
    const client = await h.connect();
    client.send(A_OPEN, 1, 0, 'shell:id\0');
    expect(await client.waitClosed()).toBe(true);
  });

  it('closes without CNXN when the banner cannot be fetched', async () => {
    const h = await setup({ banner: async () => { throw new Error('backend down'); } });
    const client = await h.connect();
    client.sendHostCnxn();
    const token = await client.next();
    client.send(A_AUTH, AUTH_SIGNATURE, 0, h.key.sign(token.data));
    expect(await client.waitClosed()).toBe(true);
    expect(client.packets.some((p) => p.command === A_CNXN)).toBe(false);
  });

  it('destroy() closes the connection and reports the reason once', async () => {
    const h = await setup();
    const client = await h.connect();
    await client.authenticate(h.key);
    h.server.sessions[0].destroy('revoked');
    h.server.sessions[0].destroy('again');
    expect(await client.waitClosed()).toBe(true);
    expect(h.events.filter((e) => e.kind === 'closed')).toHaveLength(1);
    expect(h.events.find((e) => e.kind === 'closed')).toMatchObject({ reason: 'revoked' });
    expect(h.closed).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run backend/services/adb-proxy/session.handshake.test.ts`
Expected: FAIL with "Failed to resolve import './session'".

- [ ] **Step 4: Write the session handshake**

Create `backend/services/adb-proxy/session.ts`:

```ts
import type net from 'node:net';
import { randomBytes, type KeyObject } from 'node:crypto';
import { createLoggers } from '../../logs';
import { parseAdbPublicKey, verifyAuthSignature, type ParsedAdbKey } from './adb-key';
import {
  A_AUTH, A_CNXN, A_VERSION, AUTH_RSAPUBLICKEY, AUTH_SIGNATURE, AUTH_TOKEN, MAX_DATA, PREAUTH_MAX_PAYLOAD,
  PacketError, PacketParser, commandName, encodePacket, type Packet,
} from './packet';

const { error: logError } = createLoggers('adb-proxy');

const MAX_SIGNATURE_ATTEMPTS = 3;
const DEFAULT_PREAUTH_TIMEOUT_MS = 10_000;

export type SessionState = 'await-cnxn' | 'await-auth' | 'pending' | 'finishing' | 'ready' | 'closed';

export interface ApprovedKey {
  keyId: string;
  key: KeyObject;
}

export type OfferOutcome =
  | { kind: 'blocked' }
  | { kind: 'approved' }
  | { kind: 'pending'; requestId: string; decision: Promise<'approved' | 'denied'>; cancel(): void };

export interface AuthGate {
  /** Approved keys that may reach this device. */
  approvedKeys(deviceId: string): ApprovedKey[];
  /** A client offered a key that no signature matched. */
  offer(o: { deviceId: string; parsed: ParsedAdbKey; peerIp: string }): OfferOutcome;
  /** A client proved possession of an approved key. */
  authenticated(i: { deviceId: string; keyId: string; peerIp: string }): void;
}

export interface BackendConnector {
  openService(serial: string, service: string): Promise<net.Socket>;
  deviceBanner(serial: string): Promise<string>;
}

export type SessionEvent =
  | { kind: 'auth-failed' | 'authenticated' | 'pending' | 'blocked'; session: Session }
  | { kind: 'refused-service'; session: Session; service: string }
  | { kind: 'closed'; session: Session; reason: string };

export interface SessionOptions {
  socket: net.Socket;
  deviceId: string;
  peerIp: string;
  gate: AuthGate;
  backend: BackendConnector;
  isDeviceOnline(): boolean;
  onEvent?(e: SessionEvent): void;
  onClose?(s: Session): void;
  /** Called once when the connection stops counting against the pre-auth limits (pending, ready or closed). */
  onLeavePreAuth?(): void;
  preAuthTimeoutMs?: number;
}

let sessionCounter = 0;

export class Session {
  readonly id = ++sessionCounter;
  readonly createdAt = Date.now();
  readonly deviceId: string;
  readonly peerIp: string;
  state: SessionState = 'await-cnxn';
  keyId: string | null = null;
  keyComment: string | null = null;

  private readonly parser = new PacketParser(PREAUTH_MAX_PAYLOAD);
  private token: Buffer | null = null;
  private signatureAttempts = 0;
  private proofs: Array<{ token: Buffer; signature: Buffer }> = [];
  private preAuthTimer: NodeJS.Timeout | null;
  private cancelPending: (() => void) | null = null;
  private preAuthLeft = false;
  private closed = false;

  constructor(private readonly opts: SessionOptions) {
    this.deviceId = opts.deviceId;
    this.peerIp = opts.peerIp;
    opts.socket.on('data', (chunk) => this.onData(chunk));
    opts.socket.on('error', () => this.close('socket error'));
    opts.socket.on('close', () => this.close('socket closed'));
    this.preAuthTimer = setTimeout(() => this.close('pre-auth timeout'), opts.preAuthTimeoutMs ?? DEFAULT_PREAUTH_TIMEOUT_MS);
    this.preAuthTimer.unref?.();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  destroy(reason: string): void {
    this.close(reason);
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    let packets: Packet[];
    try {
      packets = this.parser.push(chunk);
    } catch (e) {
      this.close(e instanceof PacketError ? e.message : 'parse error');
      return;
    }
    for (const p of packets) {
      if (this.closed) return;
      try {
        this.handlePacket(p);
      } catch (e: any) {
        logError(`session ${this.id} handler error: ${e?.message ?? e}`);
        this.close('handler error');
        return;
      }
    }
  }

  private handlePacket(p: Packet): void {
    switch (this.state) {
      case 'await-cnxn': return this.onCnxn(p);
      case 'await-auth': return this.onAuth(p);
      case 'pending': return;
      case 'ready': return;
      default: this.close(`unexpected ${commandName(p.command)} while ${this.state}`);
    }
  }

  private onCnxn(p: Packet): void {
    if (p.command !== A_CNXN) return this.close('expected CNXN');
    if (!this.opts.isDeviceOnline()) return this.close('device offline');
    this.sendToken();
    this.state = 'await-auth';
  }

  private sendToken(): void {
    this.token = randomBytes(20);
    this.send(A_AUTH, AUTH_TOKEN, 0, this.token);
  }

  private onAuth(p: Packet): void {
    if (p.command !== A_AUTH) return this.close('expected AUTH');
    if (p.arg0 === AUTH_SIGNATURE) return this.onSignature(p.data);
    if (p.arg0 === AUTH_RSAPUBLICKEY) return this.onPublicKey(p.data);
    this.close('bad AUTH type');
  }

  private onSignature(signature: Buffer): void {
    if (++this.signatureAttempts > MAX_SIGNATURE_ATTEMPTS) return this.close('too many signatures');
    const token = this.token;
    if (!token) return this.close('no token issued');
    for (const k of this.opts.gate.approvedKeys(this.deviceId)) {
      if (verifyAuthSignature(k.key, token, signature)) {
        this.keyId = k.keyId;
        this.opts.gate.authenticated({ deviceId: this.deviceId, keyId: k.keyId, peerIp: this.peerIp });
        void this.becomeReady();
        return;
      }
    }
    this.proofs.push({ token, signature });
    this.emit({ kind: 'auth-failed', session: this });
    this.sendToken();
  }

  private onPublicKey(data: Buffer): void {
    let parsed: ParsedAdbKey;
    try {
      parsed = parseAdbPublicKey(data);
    } catch {
      return this.close('bad public key');
    }
    // A public key is not secret; only a signature over a token issued on this connection shows the client holds the private key.
    if (!this.proofs.some((p) => verifyAuthSignature(parsed.key, p.token, p.signature))) return this.close('key not proven');
    this.keyId = parsed.keyId;
    this.keyComment = parsed.comment;
    const outcome = this.opts.gate.offer({ deviceId: this.deviceId, parsed, peerIp: this.peerIp });
    if (outcome.kind === 'blocked') {
      this.emit({ kind: 'blocked', session: this });
      return this.close('key blocked');
    }
    if (outcome.kind === 'approved') {
      this.opts.gate.authenticated({ deviceId: this.deviceId, keyId: parsed.keyId, peerIp: this.peerIp });
      void this.becomeReady();
      return;
    }
    this.state = 'pending';
    this.leavePreAuth();
    this.cancelPending = outcome.cancel;
    this.emit({ kind: 'pending', session: this });
    outcome.decision.then(
      (decision) => {
        if (this.closed) return;
        this.cancelPending = null;
        if (decision !== 'approved') return this.close('denied');
        this.opts.gate.authenticated({ deviceId: this.deviceId, keyId: parsed.keyId, peerIp: this.peerIp });
        void this.becomeReady();
      },
      () => this.close('decision error'),
    );
  }

  private async becomeReady(): Promise<void> {
    this.state = 'finishing';
    this.leavePreAuth();
    if (!this.opts.isDeviceOnline()) return this.close('device offline');
    let banner: string;
    try {
      banner = await this.opts.backend.deviceBanner(this.deviceId);
    } catch (e: any) {
      logError(`session ${this.id} banner failed: ${e?.message ?? e}`);
      return this.close('banner failed');
    }
    if (this.closed) return;
    this.send(A_CNXN, A_VERSION, MAX_DATA, Buffer.from(banner + '\0', 'utf8'));
    this.parser.setMaxPayload(MAX_DATA);
    this.state = 'ready';
    this.emit({ kind: 'authenticated', session: this });
  }

  private leavePreAuth(): void {
    if (this.preAuthLeft) return;
    this.preAuthLeft = true;
    if (this.preAuthTimer) clearTimeout(this.preAuthTimer);
    this.preAuthTimer = null;
    this.opts.onLeavePreAuth?.();
  }

  private send(command: number, arg0: number, arg1: number, data?: Buffer): void {
    if (this.closed || this.opts.socket.destroyed) return;
    this.opts.socket.write(encodePacket({ command, arg0, arg1, data }));
  }

  private emit(e: SessionEvent): void {
    try {
      this.opts.onEvent?.(e);
    } catch (err: any) {
      logError(`session ${this.id} event handler error: ${err?.message ?? err}`);
    }
  }

  private close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.state = 'closed';
    this.leavePreAuth();
    this.cancelPending?.();
    this.cancelPending = null;
    this.opts.socket.destroy();
    this.emit({ kind: 'closed', session: this, reason });
    this.opts.onClose?.(this);
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run backend/services/adb-proxy/session.handshake.test.ts`
Expected: PASS, 22 tests.

- [ ] **Step 6: Commit**

```bash
git add backend/services/adb-proxy/session.ts backend/services/adb-proxy/session.handshake.test.ts backend/services/adb-proxy/testing/wire-client.ts backend/services/adb-proxy/testing/session-server.ts backend/services/adb-proxy/testing/stub-gate.ts
git commit -m "feat(adb-proxy): add the session handshake state machine

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Session streams and the services policy

**Files:**
- Modify: `backend/services/adb-proxy/session.ts`
- Test: `backend/services/adb-proxy/session.streams.test.ts`

**Interfaces:**
- Consumes: Task 9's `Session`, `HostClient` and `FakeAdbServer` (Task 4), `WireClient`, `StubGate`.
- Produces (additions to `session.ts`):
  - `checkService(service: string): { allowed: true } | { allowed: false; reason: string }`
  - `SessionOptions.maxStreams?: number` (default 128)
  - on `Session`: `get streamCount(): number` and `info(): { id: number; deviceId: string; peerIp: string; state: SessionState; keyId: string | null; comment: string | null; since: number; streams: number }`

- [ ] **Step 1: Write the failing test**

Create `backend/services/adb-proxy/session.streams.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAdbPublicKey } from './adb-key';
import { A_CLSE, A_OKAY, A_OPEN, A_WRTE, MAX_DATA } from './packet';
import { HostClient } from './host-client';
import { Session, checkService, type SessionEvent } from './session';
import { FakeAdbServer } from './testing/fake-adb-server';
import { StubGate } from './testing/stub-gate';
import { makeTestAdbKey } from './testing/test-keys';
import { startSessionServer } from './testing/session-server';
import { WireClient } from './testing/wire-client';

const cleanups: Array<() => unknown> = [];

async function setup(opts: { maxStreams?: number } = {}) {
  const fake = new FakeAdbServer([{ serial: 'DEV1' }]);
  const backend = new HostClient(await fake.start(), 2000);
  const key = makeTestAdbKey();
  const gate = new StubGate();
  gate.approved = [{ keyId: key.keyId, key: parseAdbPublicKey(key.publicKeyText).key }];
  const events: SessionEvent[] = [];
  const server = await startSessionServer((socket) =>
    new Session({
      socket, deviceId: 'DEV1', peerIp: '10.0.0.5', gate, backend,
      isDeviceOnline: () => true, maxStreams: opts.maxStreams, onEvent: (e) => events.push(e),
    }),
  );
  const client = await WireClient.connect(server.port);
  cleanups.push(() => client.close(), () => server.close(), () => fake.stop());
  await client.authenticate(key);
  return { fake, server, client, events, baseline: [...fake.requests] };
}

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe('checkService', () => {
  it.each(['shell:ls', 'shell,v2,raw:ls', 'sync:', 'exec:cat', 'tcp:5555', 'localabstract:x', 'jdwp:12', 'abb_exec:x', 'framebuffer:', 'root:', 'reboot:'])(
    'allows %s', (s) => { expect(checkService(s)).toEqual({ allowed: true }); },
  );
  it.each(['host:kill', 'host:connect:1.2.3.4:5555', 'host-serial:X:features', 'host-usb:version', 'hostfoo', 'reverse:forward:tcp:1', 'tcpip:5555', 'usb:', '', 'a\0b'])(
    'refuses %j', (s) => { expect(checkService(s).allowed).toBe(false); },
  );
  it('refuses an oversize service', () => {
    expect(checkService('shell:' + 'x'.repeat(5000)).allowed).toBe(false);
  });
});

describe('Session streams', () => {
  it('forwards a shell service through the backend and delivers its output, then closes', async () => {
    const h = await setup();
    const reply = await h.client.openRaw('shell:echo hi', 1);
    expect(reply.command).toBe(A_OKAY);
    expect(reply.arg1).toBe(1);
    const out = await h.client.collectStream(1, reply.arg0, 'close');
    expect(out.toString()).toBe('ran: echo hi\n');
    expect(h.fake.requests).toContain('host:transport:DEV1');
    expect(h.fake.requests).toContain('shell:echo hi');
  });

  it('relays client writes to the backend, acks them, and returns the echo', async () => {
    const h = await setup();
    const { localId } = await h.client.open('echo:', 1);
    h.client.send(A_WRTE, 1, localId, 'abc');
    const echoed = await h.client.collectStream(1, localId, 3);
    expect(echoed.toString()).toBe('abc');
    const acks = h.client.packets.filter((p) => p.command === A_OKAY && p.arg0 === localId && p.arg1 === 1);
    expect(acks).toHaveLength(2);
  });

  it('echoes a 64 KiB write back whole', async () => {
    const h = await setup();
    const { localId } = await h.client.open('echo:', 1);
    h.client.send(A_WRTE, 1, localId, Buffer.alloc(65536, 'z'));
    const got = await h.client.collectStream(1, localId, 65536);
    expect(got.length).toBe(65536);
    expect(got.every((b) => b === 0x7a)).toBe(true);
  });

  it('keeps one WRTE in flight until the client acknowledges it', async () => {
    const h = await setup();
    const { localId } = await h.client.open('flood:300000', 1);
    await new Promise((r) => setTimeout(r, 200));
    const writes = h.client.packets.filter((p) => p.command === A_WRTE && p.arg0 === localId);
    expect(writes).toHaveLength(1);
    expect(writes[0].data.length).toBeLessThanOrEqual(MAX_DATA);
    const all = await h.client.collectStream(1, localId, 'close');
    expect(all.length).toBe(300000);
  });

  it('refuses host, reverse, tcpip and usb services without contacting the backend', async () => {
    const h = await setup();
    const services = ['host:kill', 'host:connect:1.2.3.4:5555', 'host-serial:DEV1:features', 'hostfoo', 'reverse:forward:tcp:1234', 'tcpip:5555', 'usb:'];
    for (const [i, service] of services.entries()) {
      const reply = await h.client.openRaw(service, 10 + i);
      expect(reply.command).toBe(A_CLSE);
      expect(reply.arg0).toBe(0);
      expect(reply.arg1).toBe(10 + i);
    }
    expect(h.fake.requests).toEqual(h.baseline);
    expect(h.events.filter((e) => e.kind === 'refused-service')).toHaveLength(services.length);
    expect(h.fake.requests.some((r) => r.startsWith('host:kill'))).toBe(false);
  });

  it('refuses an OPEN whose payload has bytes after the NUL', async () => {
    const h = await setup();
    h.client.send(A_OPEN, 5, 0, Buffer.from('shell:id\0extra'));
    const reply = await h.client.next();
    expect(reply.command).toBe(A_CLSE);
    expect(reply.arg1).toBe(5);
    expect(h.fake.requests).toEqual(h.baseline);
  });

  it('refuses a stream beyond maxStreams and a repeated remote id', async () => {
    const h = await setup({ maxStreams: 2 });
    await h.client.open('hold:', 1);
    await h.client.open('hold:', 2);
    expect((await h.client.openRaw('hold:', 3)).command).toBe(A_CLSE);
    expect((await h.client.openRaw('hold:', 2)).command).toBe(A_CLSE);
    expect(h.server.sessions[0].streamCount).toBe(2);
  });

  it('answers CLSE(0, id) when the backend rejects the service, and stays usable', async () => {
    const h = await setup();
    const refused = await h.client.openRaw('nosuch:', 5);
    expect(refused.command).toBe(A_CLSE);
    expect(refused.arg0).toBe(0);
    expect(refused.arg1).toBe(5);
    expect(h.server.sessions[0].streamCount).toBe(0);
    await h.client.open('hold:', 6);
  });

  it('ignores unknown commands and stray packets', async () => {
    const h = await setup();
    h.client.send(0x12345678, 0, 0);
    h.client.send(A_WRTE, 99, 98, 'x');
    h.client.send(A_OKAY, 99, 98);
    h.client.send(A_CLSE, 99, 98);
    expect(await h.client.quiet(100)).toBe(true);
    expect(h.client.closed).toBe(false);
    await h.client.open('echo:', 1);
  });

  it('closes the backend stream and answers when the client sends CLSE', async () => {
    const h = await setup();
    const { localId } = await h.client.open('hold:', 1);
    expect(h.fake.activeServiceSockets()).toBe(1);
    h.client.send(A_CLSE, 1, localId);
    const reply = await h.client.waitFor((p) => p.command === A_CLSE && p.arg0 === localId);
    expect(reply.arg1).toBe(1);
    await vi.waitFor(() => expect(h.fake.activeServiceSockets()).toBe(0));
    expect(h.server.sessions[0].streamCount).toBe(0);
  });

  it('sends CLSE for open streams when the device goes away', async () => {
    const h = await setup();
    const { localId } = await h.client.open('hold:', 1);
    h.fake.setOnline('DEV1', false);
    const closed = await h.client.waitFor((p) => p.command === A_CLSE && p.arg0 === localId);
    expect(closed.arg1).toBe(1);
  });

  it('destroys every backend stream when the client disappears', async () => {
    const h = await setup();
    await h.client.open('hold:', 1);
    await h.client.open('hold:', 2);
    expect(h.fake.activeServiceSockets()).toBe(2);
    h.client.close();
    await vi.waitFor(() => expect(h.fake.activeServiceSockets()).toBe(0));
  });

  it('reports its streams in info()', async () => {
    const h = await setup();
    await h.client.open('hold:', 1);
    expect(h.server.sessions[0].info()).toMatchObject({
      deviceId: 'DEV1', peerIp: '10.0.0.5', state: 'ready', streams: 1,
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run backend/services/adb-proxy/session.streams.test.ts`
Expected: FAIL: `checkService` is not exported and the stream tests time out.

- [ ] **Step 3: Implement streams in `session.ts`**

Apply these edits to `backend/services/adb-proxy/session.ts`.

(a) Extend the packet import:

```ts
import {
  A_AUTH, A_CLSE, A_CNXN, A_OKAY, A_OPEN, A_VERSION, A_WRTE, AUTH_RSAPUBLICKEY, AUTH_SIGNATURE, AUTH_TOKEN,
  MAX_DATA, PREAUTH_MAX_PAYLOAD, PacketError, PacketParser, commandName, encodePacket, type Packet,
} from './packet';
```

(b) Below the `DEFAULT_PREAUTH_TIMEOUT_MS` constant, add the policy and OPEN parsing helpers:

```ts
const DEFAULT_MAX_STREAMS = 128;
const MAX_SERVICE_LENGTH = 4096;
// The ADB server dispatches anything starting with "host" as a request to itself, even on a bound connection.
const REFUSED_PREFIXES = ['host', 'reverse:', 'tcpip:', 'usb:'];

export function checkService(service: string): { allowed: true } | { allowed: false; reason: string } {
  if (service.length === 0) return { allowed: false, reason: 'empty service' };
  if (service.length > MAX_SERVICE_LENGTH) return { allowed: false, reason: 'service too long' };
  if (service.includes('\0')) return { allowed: false, reason: 'NUL in service' };
  const prefix = REFUSED_PREFIXES.find((p) => service.startsWith(p));
  if (prefix) return { allowed: false, reason: `${prefix} services are not proxied` };
  return { allowed: true };
}

/** The service string of an OPEN payload (text plus one trailing NUL), or null when malformed. */
function parseService(data: Buffer): string | null {
  const nul = data.indexOf(0);
  if (nul !== -1 && nul !== data.length - 1) return null;
  const raw = nul === -1 ? data : data.subarray(0, nul);
  const text = raw.toString('utf8');
  return Buffer.from(text, 'utf8').equals(raw) ? text : null;
}

interface Stream {
  localId: number;
  remoteId: number;
  backend: net.Socket | null;
  windowOpen: boolean;
  outQueue: Buffer[];
  backendEnded: boolean;
}
```

(c) Add to `SessionOptions`:

```ts
  maxStreams?: number;
```

(d) Add fields and accessors to the class, next to the other private fields:

```ts
  private readonly streams = new Map<number, Stream>();
  private nextLocalId = 1;

  get streamCount(): number {
    return this.streams.size;
  }

  info() {
    return {
      id: this.id,
      deviceId: this.deviceId,
      peerIp: this.peerIp,
      state: this.state,
      keyId: this.keyId,
      comment: this.keyComment,
      since: this.createdAt,
      streams: this.streams.size,
    };
  }
```

(e) In `handlePacket`, route the ready state:

```ts
      case 'ready': return this.onReadyPacket(p);
```

(f) Add the stream handling methods to the class (before `leavePreAuth`):

```ts
  private onReadyPacket(p: Packet): void {
    switch (p.command) {
      case A_OPEN: return this.onOpen(p);
      case A_WRTE: return this.onWrite(p);
      case A_OKAY: return this.onOkay(p);
      case A_CLSE: return this.onPeerClose(p);
      default: return;
    }
  }

  private refuse(remoteId: number): void {
    if (remoteId !== 0) this.send(A_CLSE, 0, remoteId);
  }

  private onOpen(p: Packet): void {
    const remoteId = p.arg0;
    const service = remoteId === 0 ? null : parseService(p.data);
    if (service === null) return this.refuse(remoteId);
    if (!checkService(service).allowed) {
      this.emit({ kind: 'refused-service', session: this, service });
      return this.refuse(remoteId);
    }
    const duplicate = [...this.streams.values()].some((s) => s.remoteId === remoteId);
    if (duplicate || this.streams.size >= (this.opts.maxStreams ?? DEFAULT_MAX_STREAMS)) return this.refuse(remoteId);
    const stream: Stream = { localId: this.nextLocalId++, remoteId, backend: null, windowOpen: false, outQueue: [], backendEnded: false };
    this.streams.set(stream.localId, stream);
    this.opts.backend.openService(this.deviceId, service).then(
      (sock) => {
        if (this.closed || !this.streams.has(stream.localId)) {
          sock.destroy();
          return;
        }
        this.attach(stream, sock);
      },
      () => {
        if (this.streams.delete(stream.localId)) this.refuse(remoteId);
      },
    );
  }

  private attach(stream: Stream, sock: net.Socket): void {
    stream.backend = sock;
    stream.windowOpen = true;
    this.send(A_OKAY, stream.localId, stream.remoteId);
    sock.on('data', (chunk: Buffer) => {
      stream.outQueue.push(chunk);
      sock.pause();
      this.pump(stream);
    });
    const ended = () => {
      stream.backendEnded = true;
      this.pump(stream);
    };
    sock.on('end', ended);
    sock.on('close', ended);
    sock.on('error', () => this.closeStream(stream, true));
    sock.resume();
  }

  /** Send queued backend data one WRTE at a time; ADB allows a single unacknowledged WRTE per stream. */
  private pump(stream: Stream): void {
    if (this.closed || !this.streams.has(stream.localId)) return;
    if (stream.windowOpen && stream.outQueue.length > 0) {
      const head = stream.outQueue[0];
      let piece = head;
      if (head.length > MAX_DATA) {
        piece = head.subarray(0, MAX_DATA);
        stream.outQueue[0] = head.subarray(MAX_DATA);
      } else {
        stream.outQueue.shift();
      }
      stream.windowOpen = false;
      this.send(A_WRTE, stream.localId, stream.remoteId, piece);
    }
    if (stream.outQueue.length > 0) {
      stream.backend?.pause();
      return;
    }
    if (stream.backendEnded) {
      if (stream.windowOpen) this.closeStream(stream, true);
      return;
    }
    if (stream.windowOpen) stream.backend?.resume();
  }

  private onWrite(p: Packet): void {
    const stream = this.streams.get(p.arg1);
    if (!stream || stream.remoteId !== p.arg0 || !stream.backend) return;
    stream.backend.write(p.data, (err) => {
      if (this.closed || !this.streams.has(stream.localId)) return;
      if (err) return this.closeStream(stream, true);
      this.send(A_OKAY, stream.localId, stream.remoteId);
    });
  }

  private onOkay(p: Packet): void {
    const stream = this.streams.get(p.arg1);
    if (!stream || stream.remoteId !== p.arg0) return;
    stream.windowOpen = true;
    this.pump(stream);
  }

  private onPeerClose(p: Packet): void {
    const stream = this.streams.get(p.arg1);
    if (!stream || stream.remoteId !== p.arg0) return;
    this.closeStream(stream, true);
  }

  private closeStream(stream: Stream, notify: boolean): void {
    if (!this.streams.delete(stream.localId)) return;
    stream.backend?.destroy();
    if (notify) this.send(A_CLSE, stream.localId, stream.remoteId);
  }
```

(g) In `close`, destroy the backend streams before the client socket:

```ts
    for (const s of this.streams.values()) s.backend?.destroy();
    this.streams.clear();
    this.opts.socket.destroy();
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run backend/services/adb-proxy/session.streams.test.ts backend/services/adb-proxy/session.handshake.test.ts`
Expected: PASS (streams: 35 including the `it.each` cases; handshake 22).

- [ ] **Step 5: Commit**

```bash
git add backend/services/adb-proxy/session.ts backend/services/adb-proxy/session.streams.test.ts
git commit -m "feat(adb-proxy): proxy device streams with flow control and a services policy

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Listener, auth gate and device directory

**Files:**
- Create: `backend/services/adb-proxy/listener.ts`
- Create: `backend/services/adb-proxy/auth-gate.ts`
- Create: `backend/services/adb-proxy/device-directory.ts`
- Modify: `backend/services/device-manager.ts`
- Test: `backend/services/adb-proxy/listener.test.ts`
- Test: `backend/services/adb-proxy/auth-gate.test.ts`
- Test: `backend/services/adb-proxy/device-directory.test.ts`
- Test: `backend/services/device-manager.test.ts` (new `describe('online listeners')`)

**Interfaces:**
- Consumes: `AuthGate`, `OfferOutcome`, `ApprovedKey` (Task 9); `KeyStore` (Task 6); `PendingRegistry`, `PendingEntry` (Task 8); `parseAdbPublicKey`, `ParsedAdbKey` (Task 3).
- Produces:
  - `class ListenError extends Error { code: string }`, `class DeviceListener { constructor(opts: { host: string; port: number; accept(socket: net.Socket): void }); listen(): Promise<void>; close(): Promise<void>; get port(): number }` (`port` is the bound port, useful when constructed with 0)
  - `type GateEvent = { kind: 'blocked'; reason: 'denied' | 'revoked' | 'not-allowed'; keyId: string; deviceId: string; peerIp: string } | { kind: 'flood-drop'; reason: 'cap' | 'rate'; deviceId: string; peerIp: string } | { kind: 'requested'; entry: PendingEntry }`
  - `class KeyAuthGate implements AuthGate { constructor(keys: KeyStore, pending: PendingRegistry, onEvent?: (e: GateEvent) => void); invalidate(keyId: string): void }`
  - `interface DeviceDirectory { listOnlineAndroid(): Array<{ id: string; name: string | null }>; onOnline(fn: (id: string) => void): void; onOffline(fn: (id: string) => void): void }`, `createDeviceDirectory(dm: Pick<DeviceManager, 'getOnlineDeviceIds' | 'onDeviceOnline' | 'onDeviceOffline'>, db: AppDatabase): DeviceDirectory`
  - on `DeviceManager`: `getOnlineDeviceIds(): string[]` and `onDeviceOnline(fn: (deviceId: string) => void): void`, called once per offline-to-online transition after the `devices` row exists.

- [ ] **Step 1: Write the failing DeviceManager test**

In `backend/services/device-manager.test.ts`, inside `describe('DeviceManager', ...)` next to the other `describe` blocks (for example directly before `describe('singleton', ...)`), add:

```ts
  describe('online listeners', () => {
    function stubReconcileSideEffects() {
      vi.spyOn(manager as any, 'setStayAwake').mockResolvedValue(undefined);
      vi.spyOn(manager as any, 'reconcileOrphanTunnel').mockResolvedValue(undefined);
      vi.spyOn(manager as any, 'checkRooted').mockResolvedValue(false);
      vi.spyOn(manager as any, 'collectDeviceProperties').mockResolvedValue(undefined);
    }

    it('lists the ids of online devices only', async () => {
      stubReconcileSideEffects();
      await (manager as any).reconcileDiscovered([{ id: 'A', online: true }, { id: 'B', online: false }]);
      expect(manager.getOnlineDeviceIds()).toEqual(['A']);
    });

    it('notifies once per offline-to-online transition, after the device row exists', async () => {
      stubReconcileSideEffects();
      const seen: Array<{ id: string; rowExists: boolean }> = [];
      manager.onDeviceOnline((id) => {
        seen.push({ id, rowExists: db.select().from(devices).where(eq(devices.id, id)).all().length === 1 });
      });
      await (manager as any).reconcileDiscovered([{ id: 'A', online: true }]);
      await (manager as any).reconcileDiscovered([{ id: 'A', online: true }]);
      expect(seen).toEqual([{ id: 'A', rowExists: true }]);
      await (manager as any).reconcileDiscovered([]);
      await (manager as any).reconcileDiscovered([{ id: 'A', online: true }]);
      expect(seen).toHaveLength(2);
    });

    it('keeps notifying other listeners when one throws', async () => {
      stubReconcileSideEffects();
      const second = vi.fn();
      manager.onDeviceOnline(() => { throw new Error('boom'); });
      manager.onDeviceOnline(second);
      await (manager as any).reconcileDiscovered([{ id: 'A', online: true }]);
      expect(second).toHaveBeenCalledWith('A');
    });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run backend/services/device-manager.test.ts -t "online listeners"`
Expected: FAIL: `manager.getOnlineDeviceIds is not a function`.

- [ ] **Step 3: Add the DeviceManager accessors**

In `backend/services/device-manager.ts`:

(a) Next to `private offlineListeners` add:

```ts
  private onlineListeners: Array<(deviceId: string) => void> = [];
```

(b) Next to `onDeviceOffline` / `notifyOffline` add:

```ts
  /** Register a listener invoked when a device transitions from offline to online, after its row exists. */
  onDeviceOnline(fn: (deviceId: string) => void): void {
    this.onlineListeners.push(fn);
  }

  getOnlineDeviceIds(): string[] {
    return [...this.onlineDevices];
  }

  private notifyOnline(deviceId: string): void {
    for (const fn of this.onlineListeners) {
      try { fn(deviceId); } catch (err: any) {
        error(`onDeviceOnline listener failed for ${deviceId}: ${err.message}`);
      }
    }
  }
```

(c) In `reconcileDiscovered`, replace

```ts
      if (online) {
        const wasOnline = this.onlineDevices.has(id);
```

with

```ts
      let cameOnline = false;
      if (online) {
        const wasOnline = this.onlineDevices.has(id);
```

and inside `if (!wasOnline) {` add `cameOnline = true;` as its first line. Then replace

```ts
        // Backfill properties if any are missing (one-time per device)
        if (online && existing[0].manufacturer == null) {
          this.collectDeviceProperties(id).catch(() => {});
        }
      }
    }

    // Mark devices no longer seen as offline
```

with

```ts
        // Backfill properties if any are missing (one-time per device)
        if (online && existing[0].manufacturer == null) {
          this.collectDeviceProperties(id).catch(() => {});
        }
      }

      if (cameOnline) this.notifyOnline(id);
    }

    // Mark devices no longer seen as offline
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run backend/services/device-manager.test.ts`
Expected: PASS (whole file, including the 3 new tests).

- [ ] **Step 5: Write the failing device directory test**

Create `backend/services/adb-proxy/device-directory.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../../test-utils/create-test-db';
import { devices } from '../../db/schema';
import { createDeviceDirectory } from './device-directory';

describe('createDeviceDirectory', () => {
  it('lists online devices with a display name from the devices table', () => {
    const db = createTestDb([devices]);
    db.insert(devices).values([{ id: 'A', name: 'Desk phone' }, { id: 'B', model: 'Pixel 7' }, { id: 'C' }]).run();
    const dir = createDeviceDirectory(
      { getOnlineDeviceIds: () => ['A', 'B', 'C', 'D'], onDeviceOnline: vi.fn(), onDeviceOffline: vi.fn() },
      db,
    );
    expect(dir.listOnlineAndroid()).toEqual([
      { id: 'A', name: 'Desk phone' },
      { id: 'B', name: 'Pixel 7' },
      { id: 'C', name: null },
      { id: 'D', name: null },
    ]);
  });

  it('forwards the online and offline subscriptions', () => {
    const onDeviceOnline = vi.fn();
    const onDeviceOffline = vi.fn();
    const dir = createDeviceDirectory({ getOnlineDeviceIds: () => [], onDeviceOnline, onDeviceOffline }, createTestDb([devices]));
    const fn = () => {};
    dir.onOnline(fn);
    dir.onOffline(fn);
    expect(onDeviceOnline).toHaveBeenCalledWith(fn);
    expect(onDeviceOffline).toHaveBeenCalledWith(fn);
  });
});
```

- [ ] **Step 6: Run it to verify it fails, then implement**

Run: `npx vitest run backend/services/adb-proxy/device-directory.test.ts`
Expected: FAIL with "Failed to resolve import './device-directory'".

Create `backend/services/adb-proxy/device-directory.ts`:

```ts
import { eq } from 'drizzle-orm';
import { devices } from '../../db/schema';
import type { AppDatabase } from '../../db/index';
import type { DeviceManager } from '../device-manager';

export interface DeviceDirectory {
  listOnlineAndroid(): Array<{ id: string; name: string | null }>;
  onOnline(fn: (id: string) => void): void;
  onOffline(fn: (id: string) => void): void;
}

type DirectorySource = Pick<DeviceManager, 'getOnlineDeviceIds' | 'onDeviceOnline' | 'onDeviceOffline'>;

export function createDeviceDirectory(source: DirectorySource, db: AppDatabase): DeviceDirectory {
  return {
    listOnlineAndroid: () =>
      source.getOnlineDeviceIds().map((id) => {
        const row = db.select().from(devices).where(eq(devices.id, id)).get();
        return { id, name: row?.name ?? row?.model ?? null };
      }),
    onOnline: (fn) => source.onDeviceOnline(fn),
    onOffline: (fn) => source.onDeviceOffline(fn),
  };
}
```

Run: `npx vitest run backend/services/adb-proxy/device-directory.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 7: Write the failing listener test, then implement**

Create `backend/services/adb-proxy/listener.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import { DeviceListener, ListenError } from './listener';

const open: DeviceListener[] = [];
afterEach(async () => { for (const l of open.splice(0)) await l.close(); });

describe('DeviceListener', () => {
  it('hands each accepted socket to the callback and reports its bound port', async () => {
    const accepted: net.Socket[] = [];
    const l = new DeviceListener({ host: '127.0.0.1', port: 0, accept: (s) => accepted.push(s) });
    open.push(l);
    await l.listen();
    expect(l.port).toBeGreaterThan(0);
    const client = net.connect(l.port, '127.0.0.1');
    await vi.waitFor(() => expect(accepted).toHaveLength(1));
    client.destroy();
  });

  it('fails with a ListenError carrying the code when the port is taken', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const port = (blocker.address() as net.AddressInfo).port;
    const l = new DeviceListener({ host: '127.0.0.1', port, accept: () => {} });
    await expect(l.listen()).rejects.toMatchObject({ name: 'ListenError', code: 'EADDRINUSE' });
    await new Promise<void>((r) => blocker.close(() => r()));
    expect(new ListenError('X', 'y').code).toBe('X');
  });

  it('destroys a socket whose accept callback throws', async () => {
    const l = new DeviceListener({ host: '127.0.0.1', port: 0, accept: () => { throw new Error('nope'); } });
    open.push(l);
    await l.listen();
    const client = net.connect(l.port, '127.0.0.1');
    await new Promise<void>((r) => client.on('close', () => r()));
  });

  it('close() drops open connections and frees the port', async () => {
    const l = new DeviceListener({ host: '127.0.0.1', port: 0, accept: () => {} });
    await l.listen();
    const port = l.port;
    const client = net.connect(port, '127.0.0.1');
    await new Promise<void>((r) => client.on('connect', () => r()));
    const closed = new Promise<void>((r) => client.on('close', () => r()));
    await l.close();
    await closed;
    const again = new DeviceListener({ host: '127.0.0.1', port, accept: () => {} });
    open.push(again);
    await again.listen();
  });

  it('close() before listen() is harmless', async () => {
    await new DeviceListener({ host: '127.0.0.1', port: 0, accept: () => {} }).close();
  });
});
```

Run: `npx vitest run backend/services/adb-proxy/listener.test.ts`
Expected: FAIL with "Failed to resolve import './listener'".

Create `backend/services/adb-proxy/listener.ts`:

```ts
import net from 'node:net';

export class ListenError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ListenError';
  }
}

export class DeviceListener {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();

  constructor(private readonly opts: { host: string; port: number; accept(socket: net.Socket): void }) {}

  get port(): number {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.port : this.opts.port;
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
        socket.on('error', () => {});
        socket.setKeepAlive(true, 30_000);
        socket.setNoDelay(true);
        try {
          this.opts.accept(socket);
        } catch {
          socket.destroy();
        }
      });
      server.once('error', (err: NodeJS.ErrnoException) => reject(new ListenError(err.code ?? 'UNKNOWN', err.message)));
      server.listen(this.opts.port, this.opts.host, () => {
        server.removeAllListeners('error');
        server.on('error', () => {});
        this.server = server;
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
```

Run: `npx vitest run backend/services/adb-proxy/listener.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 8: Write the failing auth gate test**

Create `backend/services/adb-proxy/auth-gate.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../../test-utils/create-test-db';
import { adbProxyKeys, users } from '../../db/schema';
import { parseAdbPublicKey } from './adb-key';
import { KeyAuthGate, type GateEvent } from './auth-gate';
import { KeyStore } from './key-store';
import { PendingRegistry, type PendingOptions } from './pending';
import { makeTestAdbKey } from './testing/test-keys';

function setup(pendingOpts: PendingOptions = {}) {
  const db = createTestDb([users, adbProxyKeys]);
  const keys = new KeyStore(db);
  const pending = new PendingRegistry(pendingOpts);
  const events: GateEvent[] = [];
  const gate = new KeyAuthGate(keys, pending, (e) => events.push(e));
  return { keys, pending, gate, events };
}

const offered = (text: string, deviceId = 'DEV1', peerIp = '10.0.0.5') => ({ deviceId, parsed: parseAdbPublicKey(text), peerIp });

describe('KeyAuthGate', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => { ctx.pending.stop(); });

  const approve = (k = makeTestAdbKey(), deviceIds: string[] | null = null) => {
    const p = parseAdbPublicKey(k.publicKeyText);
    const rec = ctx.keys.upsertDecision({ keyId: p.keyId, publicKey: p.publicKey, comment: p.comment, status: 'approved', ip: '1.1.1.1', deviceId: 'DEV1', userId: null });
    if (deviceIds) ctx.keys.setDeviceIds(rec.id, deviceIds);
    return { k, p, rec };
  };

  it('offers approved keys for the device as usable key objects', () => {
    const { k } = approve();
    const list = ctx.gate.approvedKeys('DEV1');
    expect(list.map((a) => a.keyId)).toEqual([k.keyId]);
    expect(list[0].key.type).toBe('public');
  });

  it('leaves out keys whose allow-list excludes the device', () => {
    approve(makeTestAdbKey(), ['OTHER']);
    expect(ctx.gate.approvedKeys('DEV1')).toEqual([]);
    expect(ctx.gate.approvedKeys('OTHER')).toHaveLength(1);
  });

  it('turns an unknown key into a pending request', async () => {
    const k = makeTestAdbKey('ci@runner');
    const outcome = ctx.gate.offer(offered(k.publicKeyText));
    expect(outcome.kind).toBe('pending');
    expect(ctx.pending.list()).toHaveLength(1);
    expect(ctx.pending.list()[0]).toMatchObject({ keyId: k.keyId, comment: 'ci@runner', deviceId: 'DEV1', peerIp: '10.0.0.5' });
    expect(ctx.events[0]).toMatchObject({ kind: 'requested' });
    if (outcome.kind !== 'pending') return;
    ctx.pending.resolve(ctx.pending.list()[0].requestId, 'approved');
    await expect(outcome.decision).resolves.toBe('approved');
  });

  it('maps timeout, replacement and cancellation to denied', async () => {
    const k = makeTestAdbKey();
    const first = ctx.gate.offer(offered(k.publicKeyText));
    ctx.gate.offer(offered(k.publicKeyText));
    if (first.kind !== 'pending') throw new Error('expected pending');
    await expect(first.decision).resolves.toBe('denied');
  });

  it('cancel() on the outcome removes the pending request', () => {
    const outcome = ctx.gate.offer(offered(makeTestAdbKey().publicKeyText));
    if (outcome.kind !== 'pending') throw new Error('expected pending');
    outcome.cancel();
    expect(ctx.pending.list()).toEqual([]);
  });

  it('blocks a denied key and a revoked key without creating a request', () => {
    const denied = makeTestAdbKey();
    const dp = parseAdbPublicKey(denied.publicKeyText);
    ctx.keys.upsertDecision({ keyId: dp.keyId, publicKey: dp.publicKey, comment: '', status: 'denied', ip: 'x', deviceId: 'DEV1', userId: null });
    const { k, rec } = approve();
    ctx.keys.setStatus(rec.id, 'revoked', null);
    expect(ctx.gate.offer(offered(denied.publicKeyText))).toEqual({ kind: 'blocked' });
    expect(ctx.gate.offer(offered(k.publicKeyText))).toEqual({ kind: 'blocked' });
    expect(ctx.pending.list()).toEqual([]);
    expect(ctx.events.map((e) => (e.kind === 'blocked' ? e.reason : e.kind))).toEqual(['denied', 'revoked']);
  });

  it('blocks an approved key on a device outside its allow-list, with no pending request', () => {
    const { k } = approve(makeTestAdbKey(), ['ONLY-THIS']);
    expect(ctx.gate.offer(offered(k.publicKeyText, 'DEV1'))).toEqual({ kind: 'blocked' });
    expect(ctx.pending.list()).toEqual([]);
    expect(ctx.events[0]).toMatchObject({ kind: 'blocked', reason: 'not-allowed' });
  });

  it('reports an approved key on an allowed device as approved', () => {
    const { k } = approve();
    expect(ctx.gate.offer(offered(k.publicKeyText))).toEqual({ kind: 'approved' });
  });

  it('blocks and reports a flood drop when the pending registry refuses', () => {
    const tight = setup({ maxPending: 1 });
    tight.gate.offer(offered(makeTestAdbKey().publicKeyText));
    expect(tight.gate.offer(offered(makeTestAdbKey().publicKeyText))).toEqual({ kind: 'blocked' });
    expect(tight.events.at(-1)).toMatchObject({ kind: 'flood-drop', reason: 'cap' });
    tight.pending.stop();
  });

  it('authenticated() refreshes the key record', () => {
    const { p } = approve();
    ctx.gate.authenticated({ deviceId: 'DEV2', keyId: p.keyId, peerIp: '10.0.0.9' });
    expect(ctx.keys.findByKeyId(p.keyId)).toMatchObject({ lastSeenIp: '10.0.0.9', lastDeviceId: 'DEV2' });
  });

  it('stops offering a key after invalidate() and the key is revoked', () => {
    const { p, rec } = approve();
    ctx.gate.approvedKeys('DEV1');
    ctx.keys.setStatus(rec.id, 'revoked', null);
    ctx.gate.invalidate(p.keyId);
    expect(ctx.gate.approvedKeys('DEV1')).toEqual([]);
  });
});
```

- [ ] **Step 9: Run it to verify it fails, then implement**

Run: `npx vitest run backend/services/adb-proxy/auth-gate.test.ts`
Expected: FAIL with "Failed to resolve import './auth-gate'".

Create `backend/services/adb-proxy/auth-gate.ts`:

```ts
import type { KeyObject } from 'node:crypto';
import { parseAdbPublicKey, type ParsedAdbKey } from './adb-key';
import type { KeyStore } from './key-store';
import type { PendingEntry, PendingRegistry } from './pending';
import type { ApprovedKey, AuthGate, OfferOutcome } from './session';

export type GateEvent =
  | { kind: 'blocked'; reason: 'denied' | 'revoked' | 'not-allowed'; keyId: string; deviceId: string; peerIp: string }
  | { kind: 'flood-drop'; reason: 'cap' | 'rate'; deviceId: string; peerIp: string }
  | { kind: 'requested'; entry: PendingEntry };

export class KeyAuthGate implements AuthGate {
  private readonly parsed = new Map<string, KeyObject>();

  constructor(
    private readonly keys: KeyStore,
    private readonly pending: PendingRegistry,
    private readonly onEvent: (e: GateEvent) => void = () => {},
  ) {}

  approvedKeys(deviceId: string): ApprovedKey[] {
    return this.keys.approvedFor(deviceId).flatMap((r) => {
      const key = this.keyObject(r.keyId, r.publicKey);
      return key ? [{ keyId: r.keyId, key }] : [];
    });
  }

  offer(o: { deviceId: string; parsed: ParsedAdbKey; peerIp: string }): OfferOutcome {
    const { deviceId, parsed, peerIp } = o;
    const record = this.keys.findByKeyId(parsed.keyId);
    if (record) {
      if (record.status !== 'approved') {
        this.onEvent({ kind: 'blocked', reason: record.status, keyId: parsed.keyId, deviceId, peerIp });
        return { kind: 'blocked' };
      }
      if (record.deviceIds && record.deviceIds.length > 0 && !record.deviceIds.includes(deviceId)) {
        this.onEvent({ kind: 'blocked', reason: 'not-allowed', keyId: parsed.keyId, deviceId, peerIp });
        return { kind: 'blocked' };
      }
      return { kind: 'approved' };
    }
    const added = this.pending.add({
      keyId: parsed.keyId,
      publicKey: parsed.publicKey,
      fingerprint: parsed.fingerprint,
      comment: parsed.comment,
      deviceId,
      peerIp,
    });
    if (!added.ok) {
      this.onEvent({ kind: 'flood-drop', reason: added.reason, deviceId, peerIp });
      return { kind: 'blocked' };
    }
    this.onEvent({ kind: 'requested', entry: added.entry });
    return {
      kind: 'pending',
      requestId: added.entry.requestId,
      decision: added.decision.then((d) => (d === 'approved' ? 'approved' : 'denied')),
      cancel: added.cancel,
    };
  }

  authenticated(info: { deviceId: string; keyId: string; peerIp: string }): void {
    this.keys.touch(info.keyId, info.peerIp, info.deviceId);
  }

  /** Forget the cached key object after a revoke, forget or re-decision. */
  invalidate(keyId: string): void {
    this.parsed.delete(keyId);
  }

  private keyObject(keyId: string, publicKey: string): KeyObject | null {
    const cached = this.parsed.get(keyId);
    if (cached) return cached;
    try {
      const key = parseAdbPublicKey(publicKey).key;
      this.parsed.set(keyId, key);
      return key;
    } catch {
      return null;
    }
  }
}
```

Run: `npx vitest run backend/services/adb-proxy/auth-gate.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 10: Commit**

```bash
git add backend/services/device-manager.ts backend/services/device-manager.test.ts backend/services/adb-proxy/listener.ts backend/services/adb-proxy/listener.test.ts backend/services/adb-proxy/auth-gate.ts backend/services/adb-proxy/auth-gate.test.ts backend/services/adb-proxy/device-directory.ts backend/services/adb-proxy/device-directory.test.ts
git commit -m "feat(adb-proxy): add the device listener, key auth gate and device directory

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: The proxy service

**Files:**
- Create: `shared/types/adb-proxy.ts` (the status view types, shared with the frontend)
- Create: `backend/services/adb-proxy/testing/free-port.ts`
- Create: `backend/services/adb-proxy/testing/stub-directory.ts`
- Create: `backend/services/adb-proxy/adb-proxy-service.ts`
- Test: `backend/services/adb-proxy/adb-proxy-service.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3 to 11.
- Produces (defined in `shared/types/adb-proxy.ts`, re-exported from `adb-proxy-service.ts`; the frontend imports them from `shared/types/adb-proxy`):
  - `type DeviceProxyState = 'off' | 'disabled' | 'listening' | 'device-offline' | 'port-in-use' | 'range-full' | 'error'`
  - `interface DeviceStatusView { deviceId: string; name: string | null; port: number | null; enabled: boolean; online: boolean; state: DeviceProxyState }`
  - `interface ConnectionView { id: number; deviceId: string; peerIp: string; state: string; keyId: string | null; comment: string | null; since: number; streams: number }`
  - `interface PendingView { requestId: string; keyId: string; fingerprint: string; comment: string; deviceId: string; peerIp: string; createdAt: number }`
  - `interface KeyView { id: number; keyId: string; fingerprint: string; comment: string | null; status: 'approved' | 'denied' | 'revoked'; deviceIds: string[] | null; firstSeenAt: number; lastSeenAt: number; lastSeenIp: string | null; lastDeviceId: string | null; decidedAt: number | null }`
  - `interface Counters { connections: number; approvals: number; denials: number; authFailures: number; floodDrops: number }`
  - `interface StatusSnapshot { enabled: boolean; bindHost: string; portStart: number; portEnd: number; advertisedHost: string; devices: DeviceStatusView[]; connections: ConnectionView[]; pending: PendingView[]; keys: KeyView[]; counters: Counters }`
- Produces (from `adb-proxy-service.ts` itself):
  - `interface AdbProxyServiceDeps { db: AppDatabase; directory: DeviceDirectory; backend: BackendConnector; broadcast?: (message: Record<string, unknown>) => void; advertisedHost?: () => string; pending?: PendingOptions }`
  - `class AdbProxyService` with `start(): Promise<void>` (call once per process), `stop(): Promise<void>`, `snapshot(): StatusSnapshot`, `listKeys(): KeyView[]`, `updateSettings(patch: Partial<AdbProxySettings>): Promise<StatusSnapshot>` (throws `SettingsError`), `setDevice(deviceId: string, patch: { enabled?: boolean; port?: number }): Promise<{ ok: true } | { ok: false; error: 'unknown-device' | 'range-full' | 'out-of-range' | 'in-use' }>`, `approveRequest(requestId: string, userId: number | null)` and `denyRequest(requestId, userId)` returning `{ ok: true } | { ok: false; error: 'not-found' }`, `revokeKey(id: number, userId: number | null)` returning `{ ok: true } | { ok: false; error: 'not-found' | 'not-approved' }`, `forgetKey(id: number)` returning `{ ok: true } | { ok: false; error: 'not-found' }`, `setKeyDevices(id: number, ids: string[] | null)` returning `{ ok: true } | { ok: false; error: 'not-found' | 'invalid' }`.
  - The broadcast message is `{ type: 'adb-proxy', ...StatusSnapshot }`, sent at most once per 50 ms after any change.
- Produces (test support): `freePortBase(): Promise<number>`, `StubDirectory` (`constructor(ids: string[])`, `online: Set<string>`, `goOnline(id)`, `goOffline(id)`, plus the `DeviceDirectory` methods).

- [ ] **Step 1: Write the shared types and the test support**

Create `shared/types/adb-proxy.ts`:

```ts
export type DeviceProxyState = 'off' | 'disabled' | 'listening' | 'device-offline' | 'port-in-use' | 'range-full' | 'error';

export interface DeviceStatusView {
  deviceId: string;
  name: string | null;
  port: number | null;
  enabled: boolean;
  online: boolean;
  state: DeviceProxyState;
}

export interface ConnectionView {
  id: number;
  deviceId: string;
  peerIp: string;
  state: string;
  keyId: string | null;
  comment: string | null;
  since: number;
  streams: number;
}

export interface PendingView {
  requestId: string;
  keyId: string;
  fingerprint: string;
  comment: string;
  deviceId: string;
  peerIp: string;
  createdAt: number;
}

export interface KeyView {
  id: number;
  keyId: string;
  fingerprint: string;
  comment: string | null;
  status: 'approved' | 'denied' | 'revoked';
  deviceIds: string[] | null;
  firstSeenAt: number;
  lastSeenAt: number;
  lastSeenIp: string | null;
  lastDeviceId: string | null;
  decidedAt: number | null;
}

export interface Counters {
  connections: number;
  approvals: number;
  denials: number;
  authFailures: number;
  floodDrops: number;
}

export interface StatusSnapshot {
  enabled: boolean;
  bindHost: string;
  portStart: number;
  portEnd: number;
  advertisedHost: string;
  devices: DeviceStatusView[];
  connections: ConnectionView[];
  pending: PendingView[];
  keys: KeyView[];
  counters: Counters;
}
```

Create `backend/services/adb-proxy/testing/free-port.ts`:

```ts
import net from 'node:net';

/** A TCP port that was free a moment ago; callers use it as the start of a small range. */
export async function freePortBase(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port > 65000 ? 40000 : port;
}
```

Create `backend/services/adb-proxy/testing/stub-directory.ts`:

```ts
import type { DeviceDirectory } from '../device-directory';

export class StubDirectory implements DeviceDirectory {
  readonly online: Set<string>;
  private onlineFns: Array<(id: string) => void> = [];
  private offlineFns: Array<(id: string) => void> = [];

  constructor(ids: string[]) {
    this.online = new Set(ids);
  }

  listOnlineAndroid(): Array<{ id: string; name: string | null }> {
    return [...this.online].map((id) => ({ id, name: null }));
  }

  onOnline(fn: (id: string) => void): void {
    this.onlineFns.push(fn);
  }

  onOffline(fn: (id: string) => void): void {
    this.offlineFns.push(fn);
  }

  goOnline(id: string): void {
    this.online.add(id);
    for (const fn of this.onlineFns) fn(id);
  }

  goOffline(id: string): void {
    this.online.delete(id);
    for (const fn of this.offlineFns) fn(id);
  }
}
```

- [ ] **Step 2: Write the failing service test**

Create `backend/services/adb-proxy/adb-proxy-service.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import { createTestDb } from '../../test-utils/create-test-db';
import { adbProxyDevices, adbProxyKeys, devices, settings, users } from '../../db/schema';
import { AdbProxyService } from './adb-proxy-service';
import { HostClient } from './host-client';
import { A_AUTH, A_CLSE, A_CNXN, AUTH_RSAPUBLICKEY } from './packet';
import type { PendingOptions } from './pending';
import { SettingsError, saveSettings } from './settings';
import { FakeAdbServer } from './testing/fake-adb-server';
import { freePortBase } from './testing/free-port';
import { StubDirectory } from './testing/stub-directory';
import { makeTestAdbKey, type TestAdbKey } from './testing/test-keys';
import { WireClient } from './testing/wire-client';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface SetupOptions { enabled?: boolean; portCount?: number; online?: string[]; pending?: PendingOptions; blockFirstPort?: boolean }

async function setup(opts: SetupOptions = {}) {
  const fake = new FakeAdbServer([{ serial: 'DEV1' }, { serial: 'DEV2' }]);
  const backend = new HostClient(await fake.start(), 2000);
  const db = createTestDb([users, devices, settings, adbProxyKeys, adbProxyDevices], { foreignKeys: true });
  db.insert(users).values({ username: 'admin', providerId: 'local', createdAt: new Date(), updatedAt: new Date() }).run();
  db.insert(devices).values([{ id: 'DEV1', name: 'Phone 1' }, { id: 'DEV2', model: 'Pixel' }]).run();
  const base = await freePortBase();
  saveSettings(db, { enabled: opts.enabled ?? true, bindHost: '127.0.0.1', portStart: base, portEnd: base + (opts.portCount ?? 10) - 1 });
  if (opts.blockFirstPort) {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(base, '127.0.0.1', () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
  }
  const directory = new StubDirectory(opts.online ?? ['DEV1', 'DEV2']);
  const broadcasts: Array<Record<string, any>> = [];
  const service = new AdbProxyService({
    db, directory, backend, broadcast: (m) => broadcasts.push(m), advertisedHost: () => '192.168.1.10', pending: opts.pending,
  });
  await service.start();
  const clients: WireClient[] = [];
  const portOf = (deviceId: string) => service.snapshot().devices.find((d) => d.deviceId === deviceId)!.port!;
  const connect = async (deviceId = 'DEV1') => {
    const c = await WireClient.connect(portOf(deviceId));
    clients.push(c);
    return c;
  };
  cleanups.push(() => clients.forEach((c) => c.close()), () => service.stop(), () => fake.stop());
  return { fake, db, base, directory, service, broadcasts, connect, portOf };
}
type Harness = Awaited<ReturnType<typeof setup>>;

async function requestApproval(h: Harness, key: TestAdbKey, deviceId = 'DEV1') {
  const client = await h.connect(deviceId);
  await client.offerKey(key);
  await vi.waitFor(() =>
    expect(h.service.snapshot().pending.some((p) => p.keyId === key.keyId && p.deviceId === deviceId)).toBe(true),
  );
  return client;
}

async function approveKey(h: Harness, key: TestAdbKey, deviceId = 'DEV1') {
  const client = await requestApproval(h, key, deviceId);
  const req = h.service.snapshot().pending.find((p) => p.keyId === key.keyId)!;
  expect(h.service.approveRequest(req.requestId, 1)).toEqual({ ok: true });
  expect((await client.next()).command).toBe(A_CNXN);
  client.close();
}

const stateOf = (h: Harness, id: string) => h.service.snapshot().devices.find((d) => d.deviceId === id)?.state;

describe('AdbProxyService startup', () => {
  it('listens on nothing while disabled', async () => {
    const h = await setup({ enabled: false });
    const snap = h.service.snapshot();
    expect(snap.enabled).toBe(false);
    expect(snap.devices.map((d) => [d.deviceId, d.state, d.port])).toEqual([['DEV1', 'off', null], ['DEV2', 'off', null]]);
  });

  it('allocates the lowest free ports and listens for every online device once enabled', async () => {
    const h = await setup();
    const snap = h.service.snapshot();
    expect(snap.devices.map((d) => [d.deviceId, d.state, d.port])).toEqual([
      ['DEV1', 'listening', h.base], ['DEV2', 'listening', h.base + 1],
    ]);
    expect(snap.devices[0].name).toBe('Phone 1');
    expect(snap.advertisedHost).toBe('192.168.1.10');
  });

  it('reports a port held by another process without disturbing the other devices', async () => {
    const h = await setup({ blockFirstPort: true });
    expect(stateOf(h, 'DEV1')).toBe('port-in-use');
    expect(stateOf(h, 'DEV2')).toBe('listening');
  });

  it('reports range-full for a device that cannot get a port', async () => {
    const h = await setup({ portCount: 1 });
    expect(stateOf(h, 'DEV1')).toBe('listening');
    expect(stateOf(h, 'DEV2')).toBe('range-full');
  });
});

describe('AdbProxyService approval flow', () => {
  it('holds an unknown key, approves it, then accepts the key by signature and proxies a shell', async () => {
    const h = await setup();
    const key = makeTestAdbKey('ci@runner');
    const waiting = await requestApproval(h, key);
    const [req] = h.service.snapshot().pending;
    expect(req).toMatchObject({ comment: 'ci@runner', deviceId: 'DEV1', peerIp: '127.0.0.1' });
    expect(req.fingerprint).toMatch(/^([0-9A-F]{2}:){15}[0-9A-F]{2}$/);
    expect(h.service.approveRequest(req.requestId, 1)).toEqual({ ok: true });
    expect((await waiting.next()).command).toBe(A_CNXN);

    const again = await h.connect();
    expect((await again.authenticate(key)).command).toBe(A_CNXN);
    const { localId } = await again.open('shell:echo hi', 1);
    expect((await again.collectStream(1, localId, 'close')).toString()).toBe('ran: echo hi\n');

    const snap = h.service.snapshot();
    expect(snap.counters).toMatchObject({ approvals: 1, connections: 2 });
    expect(snap.keys).toHaveLength(1);
    expect(snap.keys[0]).toMatchObject({ status: 'approved', comment: 'ci@runner' });
    expect(snap.connections.filter((c) => c.state === 'ready')).toHaveLength(2);
  });

  it('denies a request, closes the client, and then ignores the key without a new request', async () => {
    const h = await setup();
    const key = makeTestAdbKey();
    const client = await requestApproval(h, key);
    const [req] = h.service.snapshot().pending;
    expect(h.service.denyRequest(req.requestId, 1)).toEqual({ ok: true });
    expect(await client.waitClosed()).toBe(true);
    expect(h.service.snapshot().keys[0].status).toBe('denied');
    const again = await h.connect();
    await again.offerKey(key);
    expect(await again.waitClosed()).toBe(true);
    expect(h.service.snapshot().pending).toEqual([]);
    expect(h.service.snapshot().counters.denials).toBe(1);
  });

  it('revokes an approved key: live sessions close and the key is refused afterwards', async () => {
    const h = await setup();
    const key = makeTestAdbKey();
    await approveKey(h, key);
    const live = await h.connect();
    await live.authenticate(key);
    const rec = h.service.listKeys()[0];
    expect(h.service.revokeKey(rec.id, 1)).toEqual({ ok: true });
    expect(await live.waitClosed()).toBe(true);
    const again = await h.connect();
    await again.offerKey(key);
    expect(await again.waitClosed()).toBe(true);
    expect(h.service.revokeKey(rec.id, 1)).toEqual({ ok: false, error: 'not-approved' });
    expect(h.service.revokeKey(9999, 1)).toEqual({ ok: false, error: 'not-found' });
  });

  it('forgets a key: live sessions close and the machine can ask again', async () => {
    const h = await setup();
    const key = makeTestAdbKey();
    await approveKey(h, key);
    const live = await h.connect();
    await live.authenticate(key);
    expect(h.service.forgetKey(h.service.listKeys()[0].id)).toEqual({ ok: true });
    expect(await live.waitClosed()).toBe(true);
    expect(h.service.listKeys()).toEqual([]);
    await requestApproval(h, key);
    expect(h.service.forgetKey(9999)).toEqual({ ok: false, error: 'not-found' });
  });

  it('one approval resolves the same key waiting on two devices', async () => {
    const h = await setup();
    const key = makeTestAdbKey();
    const a = await requestApproval(h, key, 'DEV1');
    const b = await requestApproval(h, key, 'DEV2');
    expect(h.service.snapshot().pending).toHaveLength(2);
    h.service.approveRequest(h.service.snapshot().pending[0].requestId, 1);
    expect((await a.next()).command).toBe(A_CNXN);
    expect((await b.next()).command).toBe(A_CNXN);
    expect(h.service.listKeys()).toHaveLength(1);
  });

  it('answers not-found when approving a request whose client already left', async () => {
    const h = await setup();
    const client = await requestApproval(h, makeTestAdbKey());
    const [req] = h.service.snapshot().pending;
    client.close();
    await vi.waitFor(() => expect(h.service.snapshot().pending).toEqual([]));
    expect(h.service.approveRequest(req.requestId, 1)).toEqual({ ok: false, error: 'not-found' });
    expect(h.service.denyRequest(req.requestId, 1)).toEqual({ ok: false, error: 'not-found' });
    expect(h.service.listKeys()).toEqual([]);
  });

  it('counts a failed signature as an auth failure', async () => {
    const h = await setup();
    await requestApproval(h, makeTestAdbKey());
    expect(h.service.snapshot().counters.authFailures).toBe(1);
  });

  it('creates no pending request for a key the client cannot prove it holds', async () => {
    const h = await setup();
    const client = await h.connect();
    await client.offerKeyWithoutProof(makeTestAdbKey('thief@elsewhere'));
    expect(await client.waitClosed()).toBe(true);
    expect(h.service.snapshot().pending).toEqual([]);
  });

  it('refuses a stranger who copies an approved key public blob', async () => {
    const h = await setup();
    const key = makeTestAdbKey();
    await approveKey(h, key);
    const stranger = await h.connect();
    await stranger.offerKeyWithoutProof(key);
    expect(await stranger.waitClosed()).toBe(true);
    expect(stranger.packets.some((p) => p.command === A_CNXN)).toBe(false);
    expect(h.service.snapshot().connections.filter((c) => c.state === 'ready')).toHaveLength(0);
  });

  it('does not let a stranger take over a waiting request by presenting its public blob', async () => {
    const h = await setup();
    const key = makeTestAdbKey('legit@runner');
    const legit = await requestApproval(h, key);
    const stranger = await h.connect();
    await stranger.offerKeyWithoutProof(key);
    expect(await stranger.waitClosed()).toBe(true);
    const [req] = h.service.snapshot().pending;
    expect(req.comment).toBe('legit@runner');
    expect(h.service.approveRequest(req.requestId, 1)).toEqual({ ok: true });
    expect((await legit.next()).command).toBe(A_CNXN);
  });
});

describe('AdbProxyService device lifecycle', () => {
  it('closes sessions when a device goes offline, keeps its port, and accepts clients again after replug', async () => {
    const h = await setup();
    const key = makeTestAdbKey();
    await approveKey(h, key);
    const port = h.portOf('DEV1');
    const live = await h.connect();
    await live.authenticate(key);

    h.directory.goOffline('DEV1');
    expect(await live.waitClosed()).toBe(true);
    expect(h.service.snapshot().devices.find((d) => d.deviceId === 'DEV1')).toMatchObject({ state: 'device-offline', port, online: false });
    const refused = await WireClient.connect(port);
    expect(await refused.waitClosed()).toBe(true);

    h.directory.goOnline('DEV1');
    await vi.waitFor(() => expect(stateOf(h, 'DEV1')).toBe('listening'));
    expect(h.portOf('DEV1')).toBe(port);
    const back = await h.connect();
    expect((await back.authenticate(key)).command).toBe(A_CNXN);
  });

  it('allocates a port when a new device comes online', async () => {
    const h = await setup({ online: ['DEV1'] });
    expect(h.service.snapshot().devices.map((d) => d.deviceId)).toEqual(['DEV1']);
    h.directory.goOnline('DEV2');
    await vi.waitFor(() => expect(stateOf(h, 'DEV2')).toBe('listening'));
  });

  it('refuses streams but keeps the session when the host ADB server goes away', async () => {
    const h = await setup();
    const key = makeTestAdbKey();
    await approveKey(h, key);
    const live = await h.connect();
    await live.authenticate(key);
    await h.fake.stop();
    expect((await live.openRaw('shell:id', 1)).command).toBe(A_CLSE);
    expect((await live.openRaw('shell:id', 2)).command).toBe(A_CLSE);
    expect(live.closed).toBe(false);
  });
});

describe('AdbProxyService key allow-lists', () => {
  it('refuses an approved key on a device outside its list without a pending request', async () => {
    const h = await setup();
    const key = makeTestAdbKey();
    await approveKey(h, key);
    const rec = h.service.listKeys()[0];
    expect(h.service.setKeyDevices(rec.id, ['DEV2'])).toEqual({ ok: true });

    const outside = await h.connect('DEV1');
    expect((await outside.authenticate(key)).command).toBe(A_AUTH);
    outside.send(A_AUTH, AUTH_RSAPUBLICKEY, 0, key.publicKeyText);
    expect(await outside.waitClosed()).toBe(true);
    expect(h.service.snapshot().pending).toEqual([]);

    const inside = await h.connect('DEV2');
    expect((await inside.authenticate(key)).command).toBe(A_CNXN);
  });

  it('closes live sessions on devices a restriction removes', async () => {
    const h = await setup();
    const key = makeTestAdbKey();
    await approveKey(h, key);
    const live = await h.connect('DEV1');
    await live.authenticate(key);
    h.service.setKeyDevices(h.service.listKeys()[0].id, ['DEV2']);
    expect(await live.waitClosed()).toBe(true);
  });

  it('normalises an empty list to unrestricted and rejects malformed input', async () => {
    const h = await setup();
    await approveKey(h, makeTestAdbKey());
    const id = h.service.listKeys()[0].id;
    expect(h.service.setKeyDevices(id, ['DEV1'])).toEqual({ ok: true });
    expect(h.service.setKeyDevices(id, [])).toEqual({ ok: true });
    expect(h.service.listKeys()[0].deviceIds).toBeNull();
    expect(h.service.setKeyDevices(id, [5 as unknown as string])).toEqual({ ok: false, error: 'invalid' });
    expect(h.service.setKeyDevices(9999, null)).toEqual({ ok: false, error: 'not-found' });
  });
});

describe('AdbProxyService settings and device options', () => {
  it('starts listeners when enabled at runtime and closes everything when disabled', async () => {
    const h = await setup({ enabled: false });
    await h.service.updateSettings({ enabled: true });
    expect(h.service.snapshot().devices.map((d) => d.state)).toEqual(['listening', 'listening']);
    const client = await h.connect();
    await h.service.updateSettings({ enabled: false });
    expect(await client.waitClosed()).toBe(true);
    expect(h.service.snapshot().devices.map((d) => d.state)).toEqual(['off', 'off']);
  });

  it('rejects invalid settings and leaves the running state alone', async () => {
    const h = await setup();
    await expect(h.service.updateSettings({ bindHost: 'nope' })).rejects.toBeInstanceOf(SettingsError);
    expect(h.service.snapshot().enabled).toBe(true);
    expect(stateOf(h, 'DEV1')).toBe('listening');
  });

  it('moves a device to a new port and rejects bad ports', async () => {
    const h = await setup();
    const old = h.portOf('DEV1');
    expect(await h.service.setDevice('DEV1', { port: old + 5 })).toEqual({ ok: true });
    expect(h.portOf('DEV1')).toBe(old + 5);
    await expect(WireClient.connect(old)).rejects.toBeTruthy();
    const moved = await WireClient.connect(old + 5);
    moved.close();
    expect(await h.service.setDevice('DEV1', { port: 80 })).toEqual({ ok: false, error: 'out-of-range' });
    expect(await h.service.setDevice('DEV1', { port: h.portOf('DEV2') })).toEqual({ ok: false, error: 'in-use' });
    expect(await h.service.setDevice('NOPE', {})).toEqual({ ok: false, error: 'unknown-device' });
  });

  it('disables and re-enables a single device', async () => {
    const h = await setup();
    expect(await h.service.setDevice('DEV2', { enabled: false })).toEqual({ ok: true });
    expect(stateOf(h, 'DEV2')).toBe('disabled');
    expect(stateOf(h, 'DEV1')).toBe('listening');
    expect(await h.service.setDevice('DEV2', { enabled: true })).toEqual({ ok: true });
    expect(stateOf(h, 'DEV2')).toBe('listening');
  });
});

describe('AdbProxyService limits and reporting', () => {
  it('drops the ninth unauthenticated socket from one IP and counts it', async () => {
    const h = await setup();
    const port = h.portOf('DEV1');
    const open = async () => {
      const s = net.connect(port, '127.0.0.1');
      const closed = new Promise<void>((resolve) => s.once('close', () => resolve()));
      s.on('error', () => {});
      await new Promise<void>((resolve) => s.once('connect', () => resolve()));
      cleanups.push(() => s.destroy());
      return { s, closed };
    };
    const first = await Promise.all(Array.from({ length: 8 }, open));
    const ninth = await open();
    await ninth.closed;
    expect(h.service.snapshot().counters.floodDrops).toBe(1);
    first[0].s.destroy();
    await new Promise((r) => setTimeout(r, 100));
    const again = await open();
    await new Promise((r) => setTimeout(r, 100));
    expect(again.s.destroyed).toBe(false);
  });

  it('broadcasts a snapshot message after a change', async () => {
    const h = await setup();
    await requestApproval(h, makeTestAdbKey());
    await vi.waitFor(() => expect(h.broadcasts.some((m) => m.type === 'adb-proxy' && m.pending.length === 1)).toBe(true));
    const last = h.broadcasts.at(-1)!;
    expect(last.advertisedHost).toBe('192.168.1.10');
    expect(last.devices).toHaveLength(2);
  });

  it('stop() closes sessions and frees the ports', async () => {
    const h = await setup();
    const port = h.portOf('DEV1');
    const client = await h.connect();
    await h.service.stop();
    expect(await client.waitClosed()).toBe(true);
    const probe = net.createServer();
    await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', () => resolve()); });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run backend/services/adb-proxy/adb-proxy-service.test.ts`
Expected: FAIL with "Failed to resolve import './adb-proxy-service'".

- [ ] **Step 4: Write the service**

Create `backend/services/adb-proxy/adb-proxy-service.ts`:

```ts
import type net from 'node:net';
import { eq, inArray } from 'drizzle-orm';
import { devices } from '../../db/schema';
import type { AppDatabase } from '../../db/index';
import { createLoggers } from '../../logs';
import type {
  ConnectionView, Counters, DeviceProxyState, DeviceStatusView, KeyView, PendingView, StatusSnapshot,
} from '../../../shared/types/adb-proxy';
import { fingerprintOf } from './adb-key';
import { KeyAuthGate, type GateEvent } from './auth-gate';
import type { DeviceDirectory } from './device-directory';
import { PreAuthLimiter } from './limits';
import { KeyStore } from './key-store';
import { DeviceListener, ListenError } from './listener';
import { PendingRegistry, type PendingOptions } from './pending';
import { PortAllocator, PortError } from './port-allocator';
import { Session, type BackendConnector, type SessionEvent } from './session';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type AdbProxySettings } from './settings';
import { onceEvery } from './throttle';

const { log, error: logError } = createLoggers('adb-proxy');

export type {
  ConnectionView, Counters, DeviceProxyState, DeviceStatusView, KeyView, PendingView, StatusSnapshot,
};

export interface AdbProxyServiceDeps {
  db: AppDatabase;
  directory: DeviceDirectory;
  backend: BackendConnector;
  broadcast?: (message: Record<string, unknown>) => void;
  advertisedHost?: () => string;
  pending?: PendingOptions;
}

type Failure<E extends string> = { ok: false; error: E };
type Done = { ok: true };

const NOTIFY_DELAY_MS = 50;
const short = (keyId: string) => keyId.slice(0, 12);
const normaliseIp = (addr?: string) => (addr ?? 'unknown').replace(/^::ffff:/, '');

export class AdbProxyService {
  private settings: AdbProxySettings = { ...DEFAULT_SETTINGS };
  private readonly keys: KeyStore;
  private readonly ports: PortAllocator;
  private readonly pending: PendingRegistry;
  private readonly gate: KeyAuthGate;
  private readonly limiter = new PreAuthLimiter();
  private readonly listeners = new Map<string, DeviceListener>();
  private readonly starting = new Set<string>();
  private readonly deviceErrors = new Map<string, DeviceProxyState>();
  private readonly online = new Set<string>();
  private readonly sessions = new Set<Session>();
  private readonly counters: Counters = { connections: 0, approvals: 0, denials: 0, authFailures: 0, floodDrops: 0 };
  private started = false;
  private notifyTimer: NodeJS.Timeout | null = null;
  private readonly backend: BackendConnector;
  private readonly logBackendFailure = onceEvery(30_000, (message: string) => logError(message));

  constructor(private readonly deps: AdbProxyServiceDeps) {
    // A dead host ADB server is logged once per interval, not once per stream.
    this.backend = {
      openService: async (serial, service) => {
        try {
          return await deps.backend.openService(serial, service);
        } catch (e: any) {
          this.logBackendFailure(`ADB server request failed for ${serial}: ${e?.message ?? e}`);
          throw e;
        }
      },
      deviceBanner: async (serial) => {
        try {
          return await deps.backend.deviceBanner(serial);
        } catch (e: any) {
          this.logBackendFailure(`ADB server request failed for ${serial}: ${e?.message ?? e}`);
          throw e;
        }
      },
    };
    this.keys = new KeyStore(deps.db);
    this.ports = new PortAllocator(deps.db, () => ({ start: this.settings.portStart, end: this.settings.portEnd }));
    this.pending = new PendingRegistry({ ...deps.pending, onChange: () => this.notifyChanged() });
    this.gate = new KeyAuthGate(this.keys, this.pending, (e) => this.onGateEvent(e));
  }

  /** Call once per process: the directory has no way to unsubscribe. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.settings = loadSettings(this.deps.db);
    for (const d of this.deps.directory.listOnlineAndroid()) this.online.add(d.id);
    this.deps.directory.onOnline((id) => { if (this.started) void this.deviceOnline(id); });
    this.deps.directory.onOffline((id) => { if (this.started) this.deviceOffline(id); });
    if (this.settings.enabled) await this.startAll();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.notifyTimer = null;
    this.pending.stop();
    for (const s of [...this.sessions]) s.destroy('service stopping');
    await this.stopAllDevices();
  }

  snapshot(): StatusSnapshot {
    const rows = this.ports.all();
    const ids = [...new Set<string>([...this.online, ...rows.map((r) => r.deviceId)])].sort();
    const names = this.deviceNames(ids);
    return {
      enabled: this.settings.enabled,
      bindHost: this.settings.bindHost,
      portStart: this.settings.portStart,
      portEnd: this.settings.portEnd,
      advertisedHost: this.deps.advertisedHost?.() ?? '',
      devices: ids.map((id) => {
        const row = rows.find((r) => r.deviceId === id);
        const online = this.online.has(id);
        return {
          deviceId: id,
          name: names.get(id) ?? null,
          port: row?.port ?? null,
          enabled: row?.enabled ?? true,
          online,
          state: this.stateFor(id, row?.enabled, online),
        };
      }),
      connections: [...this.sessions].map((s) => s.info()),
      pending: this.pending.list().map((p) => ({
        requestId: p.requestId, keyId: p.keyId, fingerprint: p.fingerprint, comment: p.comment,
        deviceId: p.deviceId, peerIp: p.peerIp, createdAt: p.createdAt,
      })),
      keys: this.listKeys(),
      counters: { ...this.counters },
    };
  }

  listKeys(): KeyView[] {
    return this.keys.list().map((r) => ({
      id: r.id,
      keyId: r.keyId,
      fingerprint: fingerprintOf(Buffer.from(r.publicKey, 'base64')),
      comment: r.comment,
      status: r.status,
      deviceIds: r.deviceIds && r.deviceIds.length > 0 ? r.deviceIds : null,
      firstSeenAt: r.firstSeenAt.getTime(),
      lastSeenAt: r.lastSeenAt.getTime(),
      lastSeenIp: r.lastSeenIp,
      lastDeviceId: r.lastDeviceId,
      decidedAt: r.decidedAt ? r.decidedAt.getTime() : null,
    }));
  }

  async updateSettings(patch: Partial<AdbProxySettings>): Promise<StatusSnapshot> {
    const before = this.settings;
    const after = saveSettings(this.deps.db, patch);
    this.settings = after;
    if (before.enabled && !after.enabled) {
      await this.stopAllDevices();
    } else if (!before.enabled && after.enabled) {
      await this.startAll();
    } else if (after.enabled && before.bindHost !== after.bindHost) {
      await this.stopAllDevices();
      await this.startAll();
    }
    this.notifyChanged();
    return this.snapshot();
  }

  async setDevice(
    deviceId: string,
    patch: { enabled?: boolean; port?: number },
  ): Promise<Done | Failure<'unknown-device' | 'range-full' | 'out-of-range' | 'in-use'>> {
    const known = this.deps.db.select({ id: devices.id }).from(devices).where(eq(devices.id, deviceId)).get();
    if (!known) return { ok: false, error: 'unknown-device' };
    const row = this.ports.ensure(deviceId);
    if ('error' in row) return { ok: false, error: 'range-full' };
    try {
      if (patch.port !== undefined && patch.port !== row.port) {
        this.ports.setPort(deviceId, patch.port);
        await this.stopDevice(deviceId);
      }
      if (patch.enabled !== undefined) {
        this.ports.setEnabled(deviceId, patch.enabled);
        if (!patch.enabled) await this.stopDevice(deviceId);
      }
    } catch (e) {
      if (e instanceof PortError) return { ok: false, error: e.code };
      throw e;
    }
    await this.startDevice(deviceId);
    this.notifyChanged();
    return { ok: true };
  }

  approveRequest(requestId: string, userId: number | null): Done | Failure<'not-found'> {
    const entry = this.pending.get(requestId);
    if (!entry) return { ok: false, error: 'not-found' };
    this.keys.upsertDecision({
      keyId: entry.keyId, publicKey: entry.publicKey, comment: entry.comment, status: 'approved',
      ip: entry.peerIp, deviceId: entry.deviceId, userId,
    });
    this.gate.invalidate(entry.keyId);
    this.pending.resolveKey(entry.keyId, 'approved');
    this.counters.approvals++;
    log(`approved key ${short(entry.keyId)} (${entry.comment}) first seen from ${entry.peerIp}`);
    this.notifyChanged();
    return { ok: true };
  }

  denyRequest(requestId: string, userId: number | null): Done | Failure<'not-found'> {
    const entry = this.pending.get(requestId);
    if (!entry) return { ok: false, error: 'not-found' };
    this.keys.upsertDecision({
      keyId: entry.keyId, publicKey: entry.publicKey, comment: entry.comment, status: 'denied',
      ip: entry.peerIp, deviceId: entry.deviceId, userId,
    });
    this.gate.invalidate(entry.keyId);
    this.pending.resolveKey(entry.keyId, 'denied');
    this.counters.denials++;
    log(`denied key ${short(entry.keyId)} (${entry.comment}) from ${entry.peerIp}`);
    this.notifyChanged();
    return { ok: true };
  }

  revokeKey(id: number, userId: number | null): Done | Failure<'not-found' | 'not-approved'> {
    const rec = this.keys.findById(id);
    if (!rec) return { ok: false, error: 'not-found' };
    if (rec.status !== 'approved') return { ok: false, error: 'not-approved' };
    this.keys.setStatus(id, 'revoked', userId);
    this.gate.invalidate(rec.keyId);
    this.closeSessions((s) => s.keyId === rec.keyId, 'key revoked');
    log(`revoked key ${short(rec.keyId)} (${rec.comment ?? ''})`);
    this.notifyChanged();
    return { ok: true };
  }

  forgetKey(id: number): Done | Failure<'not-found'> {
    const rec = this.keys.findById(id);
    if (!rec) return { ok: false, error: 'not-found' };
    this.keys.forget(id);
    this.gate.invalidate(rec.keyId);
    this.closeSessions((s) => s.keyId === rec.keyId, 'key forgotten');
    log(`forgot key ${short(rec.keyId)} (${rec.comment ?? ''})`);
    this.notifyChanged();
    return { ok: true };
  }

  setKeyDevices(id: number, ids: string[] | null): Done | Failure<'not-found' | 'invalid'> {
    const rec = this.keys.findById(id);
    if (!rec) return { ok: false, error: 'not-found' };
    if (ids !== null && !(Array.isArray(ids) && ids.every((s) => typeof s === 'string' && s.length > 0 && s.length <= 128))) {
      return { ok: false, error: 'invalid' };
    }
    const list = ids && ids.length > 0 ? ids : null;
    this.keys.setDeviceIds(id, list);
    if (list) this.closeSessions((s) => s.keyId === rec.keyId && !list.includes(s.deviceId), 'key restricted');
    this.notifyChanged();
    return { ok: true };
  }

  private stateFor(id: string, enabled: boolean | undefined, online: boolean): DeviceProxyState {
    if (!this.settings.enabled) return 'off';
    if (enabled === false) return 'disabled';
    const failed = this.deviceErrors.get(id);
    if (failed) return failed;
    if (this.listeners.has(id)) return online ? 'listening' : 'device-offline';
    return 'off';
  }

  private deviceNames(ids: string[]): Map<string, string | null> {
    const map = new Map<string, string | null>();
    if (ids.length === 0) return map;
    const rows = this.deps.db
      .select({ id: devices.id, name: devices.name, model: devices.model })
      .from(devices)
      .where(inArray(devices.id, ids))
      .all();
    for (const r of rows) map.set(r.id, r.name ?? r.model ?? null);
    return map;
  }

  private async startAll(): Promise<void> {
    await Promise.all([...this.online].map((id) => this.startDevice(id)));
  }

  private async stopAllDevices(): Promise<void> {
    await Promise.all([...this.listeners.keys()].map((id) => this.stopDevice(id)));
    this.deviceErrors.clear();
  }

  private async startDevice(deviceId: string): Promise<void> {
    if (!this.started || !this.settings.enabled || this.listeners.has(deviceId) || this.starting.has(deviceId)) return;
    this.starting.add(deviceId);
    try {
      const row = this.ports.ensure(deviceId);
      if ('error' in row) {
        this.deviceErrors.set(deviceId, 'range-full');
        return;
      }
      if (!row.enabled) {
        this.deviceErrors.delete(deviceId);
        return;
      }
      const listener = new DeviceListener({
        host: this.settings.bindHost,
        port: row.port,
        accept: (socket) => this.accept(deviceId, socket),
      });
      try {
        await listener.listen();
      } catch (e: any) {
        this.deviceErrors.set(deviceId, e instanceof ListenError && e.code === 'EADDRINUSE' ? 'port-in-use' : 'error');
        logError(`cannot listen for ${deviceId} on port ${row.port}: ${e?.message ?? e}`);
        return;
      }
      if (!this.started) {
        await listener.close();
        return;
      }
      this.listeners.set(deviceId, listener);
      this.deviceErrors.delete(deviceId);
      log(`listening for ${deviceId} on ${this.settings.bindHost}:${row.port}`);
    } catch (e: any) {
      this.deviceErrors.set(deviceId, 'error');
      logError(`cannot start proxy for ${deviceId}: ${e?.message ?? e}`);
    } finally {
      this.starting.delete(deviceId);
      this.notifyChanged();
    }
  }

  private async stopDevice(deviceId: string): Promise<void> {
    this.closeSessions((s) => s.deviceId === deviceId, 'listener stopped');
    const listener = this.listeners.get(deviceId);
    this.listeners.delete(deviceId);
    this.deviceErrors.delete(deviceId);
    if (listener) await listener.close();
    this.notifyChanged();
  }

  private async deviceOnline(deviceId: string): Promise<void> {
    this.online.add(deviceId);
    await this.startDevice(deviceId);
    this.notifyChanged();
  }

  private deviceOffline(deviceId: string): void {
    this.online.delete(deviceId);
    this.closeSessions((s) => s.deviceId === deviceId, 'device offline');
    this.notifyChanged();
  }

  private closeSessions(match: (s: Session) => boolean, reason: string): void {
    for (const s of [...this.sessions]) if (match(s)) s.destroy(reason);
  }

  private accept(deviceId: string, socket: net.Socket): void {
    const ip = normaliseIp(socket.remoteAddress);
    if (!this.online.has(deviceId)) {
      socket.destroy();
      return;
    }
    const release = this.limiter.acquire(ip);
    if (!release) {
      this.counters.floodDrops++;
      socket.destroy();
      return;
    }
    this.counters.connections++;
    const session = new Session({
      socket,
      deviceId,
      peerIp: ip,
      gate: this.gate,
      backend: this.backend,
      isDeviceOnline: () => this.online.has(deviceId),
      onLeavePreAuth: release,
      onEvent: (e) => this.onSessionEvent(e),
      onClose: (s) => {
        this.sessions.delete(s);
        this.notifyChanged();
      },
    });
    this.sessions.add(session);
    this.notifyChanged();
  }

  private onSessionEvent(e: SessionEvent): void {
    const who = `device=${e.session.deviceId} ip=${e.session.peerIp} key=${e.session.keyId ? short(e.session.keyId) : '-'}`;
    switch (e.kind) {
      case 'auth-failed': this.counters.authFailures++; return;
      case 'authenticated': log(`session ${e.session.id} authenticated ${who}`); break;
      case 'refused-service': log(`session ${e.session.id} refused service ${JSON.stringify(e.service.slice(0, 60))} ${who}`); break;
      case 'closed': log(`session ${e.session.id} closed (${e.reason}) ${who}`); break;
      default: break;
    }
    this.notifyChanged();
  }

  private onGateEvent(e: GateEvent): void {
    switch (e.kind) {
      case 'requested':
        log(`key ${short(e.entry.keyId)} (${e.entry.comment}) is waiting for approval for device=${e.entry.deviceId} ip=${e.entry.peerIp}`);
        break;
      case 'blocked':
        log(`blocked key ${short(e.keyId)} (${e.reason}) device=${e.deviceId} ip=${e.peerIp}`);
        break;
      case 'flood-drop':
        this.counters.floodDrops++;
        log(`dropped an approval request (${e.reason} limit) device=${e.deviceId} ip=${e.peerIp}`);
        break;
    }
  }

  private notifyChanged(): void {
    if (!this.started || !this.deps.broadcast || this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      if (!this.started) return;
      try {
        this.deps.broadcast!({ type: 'adb-proxy', ...this.snapshot() });
      } catch (e: any) {
        logError(`broadcast failed: ${e?.message ?? e}`);
      }
    }, NOTIFY_DELAY_MS);
    this.notifyTimer.unref?.();
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run backend/services/adb-proxy/adb-proxy-service.test.ts`
Expected: PASS, 27 tests. If the flood-limit test is flaky on a slow machine, raise its two 100 ms sleeps, not the production limits.

- [ ] **Step 6: Run the whole module to catch cross-file breakage**

Run: `npx vitest run backend/services/adb-proxy --maxWorkers=2`
Expected: PASS for every file in the directory.

- [ ] **Step 7: Commit**

```bash
git add shared/types/adb-proxy.ts backend/services/adb-proxy/adb-proxy-service.ts backend/services/adb-proxy/adb-proxy-service.test.ts backend/services/adb-proxy/testing/free-port.ts backend/services/adb-proxy/testing/stub-directory.ts
git commit -m "feat(adb-proxy): add the proxy service that ties listeners, keys and approvals together

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 13: REST API, scopes, live channel and server wiring

**Files:**
- Modify: `backend/auth/scopes-registry.ts`
- Create: `backend/api/adb-proxy.ts`
- Modify: `backend/index.ts`
- Modify: `docs/specs/2026-10-11-adb-proxy-design.md` (the `/status` row lists `keys`)
- Test: `backend/auth/scopes-registry.adb-proxy.test.ts`
- Test: `backend/api/adb-proxy.test.ts`

**Interfaces:**
- Consumes: `AdbProxyService` (Task 12), `registerEndpoint`, `registerFilteredChannel`.
- Produces: `registerAdbProxyEndpoints(service: AdbProxyService): void` and `ADB_PROXY_CHANNEL = 'adb-proxy'` from `backend/api/adb-proxy.ts`. Endpoints (all respond `{ success: true, data }` or `{ success: false, error }`):
  - `GET /v1/adb-proxy/status` (read) returns the snapshot
  - `PUT /v1/adb-proxy/settings` (manage), body `{ enabled?: boolean, bindHost?: string, portStart?: number, portEnd?: number }`, returns the snapshot; 400 on a body of the wrong shape or a `SettingsError`
  - `PATCH /v1/adb-proxy/devices/:id` (manage), body `{ enabled?: boolean, port?: number }`; 404 `unknown-device`, 400 `out-of-range`, 409 `in-use` or `range-full`
  - `GET /v1/adb-proxy/keys` (read) returns `KeyView[]`
  - `POST /v1/adb-proxy/requests/:requestId/approve` and `/deny` (manage); 404 when the request is gone
  - `POST /v1/adb-proxy/keys/:id/revoke` (manage); 404 `not-found`, 409 `not-approved`
  - `PATCH /v1/adb-proxy/keys/:id` (manage), body `{ deviceIds: string[] | null }`; 404, 400
  - `DELETE /v1/adb-proxy/keys/:id` (manage); 404
  - scopes `core.adb-proxy:read` and `core.adb-proxy:manage` in the registry

- [ ] **Step 1: Write the failing scopes test**

Create `backend/auth/scopes-registry.adb-proxy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getScopeMetadata, isSupportedScope } from './scopes-registry';

describe('ADB proxy scopes', () => {
  it.each(['core.adb-proxy:read', 'core.adb-proxy:manage'])('registers %s under Devices', (key) => {
    expect(isSupportedScope(key)).toBe(true);
    expect(getScopeMetadata(key)?.category).toBe('Devices');
  });
});
```

Run: `npx vitest run backend/auth/scopes-registry.adb-proxy.test.ts`
Expected: FAIL (`isSupportedScope` returns false).

- [ ] **Step 2: Register the scopes**

In `backend/auth/scopes-registry.ts`, after the `core.devices:shell` entry add:

```ts
  { key: 'core.adb-proxy:read', label: 'Read ADB proxy', description: 'See ADB proxy ports, pending approval requests, approved machines and live connections.', category: 'Devices' },
  { key: 'core.adb-proxy:manage', label: 'Manage ADB proxy', description: 'Turn the ADB proxy on or off, approve, deny and revoke remote machines, and change device ports.', category: 'Devices' },
```

Run: `npx vitest run backend/auth/scopes-registry.adb-proxy.test.ts backend/auth/scopes-registry.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the failing API test**

Create `backend/api/adb-proxy.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { clearEndpoints, getApiRouter } from './api-service';
import { __resetChannelRegistryForTest, getRequiredScopes, isFilteredChannel } from '../websocket/channel-registry';
import { SettingsError } from '../services/adb-proxy/settings';
import type { AdbProxyService } from '../services/adb-proxy/adb-proxy-service';
import { ADB_PROXY_CHANNEL, registerAdbProxyEndpoints } from './adb-proxy';

const SNAPSHOT = { enabled: true, devices: [], pending: [], keys: [], connections: [], counters: {} };

function makeService(over: Record<string, unknown> = {}) {
  return {
    snapshot: vi.fn().mockReturnValue(SNAPSHOT),
    listKeys: vi.fn().mockReturnValue([{ id: 1 }]),
    updateSettings: vi.fn().mockResolvedValue(SNAPSHOT),
    setDevice: vi.fn().mockResolvedValue({ ok: true }),
    approveRequest: vi.fn().mockReturnValue({ ok: true }),
    denyRequest: vi.fn().mockReturnValue({ ok: true }),
    revokeKey: vi.fn().mockReturnValue({ ok: true }),
    forgetKey: vi.fn().mockReturnValue({ ok: true }),
    setKeyDevices: vi.fn().mockReturnValue({ ok: true }),
    ...over,
  };
}

function appFor(service: ReturnType<typeof makeService>, scopes?: string[]) {
  clearEndpoints();
  __resetChannelRegistryForTest();
  registerAdbProxyEndpoints(service as unknown as AdbProxyService);
  const app = express();
  app.use(express.json());
  if (scopes) {
    app.use((req, _res, next) => {
      (req as any).authUser = { userId: 7, effectiveScopes: new Set(scopes) };
      next();
    });
  }
  app.use(getApiRouter());
  return app;
}

const READ = ['core.adb-proxy:read'];
const MANAGE = ['core.adb-proxy:read', 'core.adb-proxy:manage'];

describe('ADB proxy API', () => {
  let service: ReturnType<typeof makeService>;
  beforeEach(() => { service = makeService(); });

  it('registers the live channel behind the read scope', () => {
    appFor(service);
    expect(isFilteredChannel(ADB_PROXY_CHANNEL)).toBe(true);
    expect(getRequiredScopes(ADB_PROXY_CHANNEL)).toEqual(['core.adb-proxy:read']);
  });

  describe('scope enforcement', () => {
    it('lets a read-only user read and refuses every write with 403', async () => {
      const app = appFor(service, READ);
      expect((await request(app).get('/v1/adb-proxy/status')).status).toBe(200);
      expect((await request(app).get('/v1/adb-proxy/keys')).status).toBe(200);
      const writes: Array<[string, string]> = [
        ['put', '/v1/adb-proxy/settings'], ['patch', '/v1/adb-proxy/devices/DEV1'],
        ['post', '/v1/adb-proxy/requests/r1/approve'], ['post', '/v1/adb-proxy/requests/r1/deny'],
        ['post', '/v1/adb-proxy/keys/1/revoke'], ['patch', '/v1/adb-proxy/keys/1'], ['delete', '/v1/adb-proxy/keys/1'],
      ];
      for (const [method, path] of writes) {
        const res = await (request(app) as any)[method](path).send({});
        expect(res.status, `${method} ${path}`).toBe(403);
      }
      expect(service.approveRequest).not.toHaveBeenCalled();
    });

    it('refuses a user with no ADB proxy scope', async () => {
      const app = appFor(service, ['core.devices:read']);
      expect((await request(app).get('/v1/adb-proxy/status')).status).toBe(403);
    });
  });

  it('GET /status returns the snapshot', async () => {
    const res = await request(appFor(service, READ)).get('/v1/adb-proxy/status');
    expect(res.body).toEqual({ success: true, data: SNAPSHOT });
  });

  it('GET /keys returns the key list', async () => {
    const res = await request(appFor(service, READ)).get('/v1/adb-proxy/keys');
    expect(res.body).toEqual({ success: true, data: [{ id: 1 }] });
  });

  describe('PUT /settings', () => {
    it('passes only the known, correctly typed fields to the service', async () => {
      const res = await request(appFor(service, MANAGE)).put('/v1/adb-proxy/settings')
        .send({ enabled: true, bindHost: '10.0.0.2', portStart: 7000, portEnd: 7010, other: 'x' });
      expect(res.status).toBe(200);
      expect(service.updateSettings).toHaveBeenCalledWith({ enabled: true, bindHost: '10.0.0.2', portStart: 7000, portEnd: 7010 });
    });

    it.each([[{ enabled: 'yes' }], [{ bindHost: 5 }], [{ portStart: '7000' }], [{}]])('rejects %j with 400', async (body) => {
      const res = await request(appFor(service, MANAGE)).put('/v1/adb-proxy/settings').send(body);
      expect(res.status).toBe(400);
      expect(service.updateSettings).not.toHaveBeenCalled();
    });

    it('maps a settings validation error to 400 with its message', async () => {
      service = makeService({ updateSettings: vi.fn().mockRejectedValue(new SettingsError('bind host must be an IP address')) });
      const res = await request(appFor(service, MANAGE)).put('/v1/adb-proxy/settings').send({ bindHost: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('bind host must be an IP address');
    });
  });

  describe('PATCH /devices/:id', () => {
    it('forwards enabled and port', async () => {
      const res = await request(appFor(service, MANAGE)).patch('/v1/adb-proxy/devices/DEV1').send({ enabled: false, port: 6501 });
      expect(res.status).toBe(200);
      expect(service.setDevice).toHaveBeenCalledWith('DEV1', { enabled: false, port: 6501 });
    });

    it.each([
      ['unknown-device', 404], ['out-of-range', 400], ['in-use', 409], ['range-full', 409],
    ])('maps %s to %i', async (error, status) => {
      service = makeService({ setDevice: vi.fn().mockResolvedValue({ ok: false, error }) });
      const res = await request(appFor(service, MANAGE)).patch('/v1/adb-proxy/devices/DEV1').send({ port: 1 });
      expect(res.status).toBe(status);
      expect(res.body).toEqual({ success: false, error });
    });

    it('rejects a body of the wrong shape', async () => {
      const res = await request(appFor(service, MANAGE)).patch('/v1/adb-proxy/devices/DEV1').send({ port: 'x' });
      expect(res.status).toBe(400);
    });
  });

  describe('requests and keys', () => {
    it('approve and deny pass the request id and the acting user', async () => {
      const app = appFor(service, MANAGE);
      expect((await request(app).post('/v1/adb-proxy/requests/r1/approve')).status).toBe(200);
      expect(service.approveRequest).toHaveBeenCalledWith('r1', 7);
      expect((await request(app).post('/v1/adb-proxy/requests/r2/deny')).status).toBe(200);
      expect(service.denyRequest).toHaveBeenCalledWith('r2', 7);
    });

    it('answers 404 when the request is gone', async () => {
      service = makeService({ approveRequest: vi.fn().mockReturnValue({ ok: false, error: 'not-found' }) });
      const res = await request(appFor(service, MANAGE)).post('/v1/adb-proxy/requests/r1/approve');
      expect(res.status).toBe(404);
    });

    it('revoke maps not-found to 404 and not-approved to 409', async () => {
      service = makeService({ revokeKey: vi.fn().mockReturnValueOnce({ ok: false, error: 'not-found' }).mockReturnValueOnce({ ok: false, error: 'not-approved' }) });
      const app = appFor(service, MANAGE);
      expect((await request(app).post('/v1/adb-proxy/keys/1/revoke')).status).toBe(404);
      expect((await request(app).post('/v1/adb-proxy/keys/1/revoke')).status).toBe(409);
    });

    it('PATCH /keys/:id sets the device list, and DELETE forgets the key', async () => {
      const app = appFor(service, MANAGE);
      expect((await request(app).patch('/v1/adb-proxy/keys/3').send({ deviceIds: ['A'] })).status).toBe(200);
      expect(service.setKeyDevices).toHaveBeenCalledWith(3, ['A']);
      expect((await request(app).patch('/v1/adb-proxy/keys/3').send({ deviceIds: null })).status).toBe(200);
      expect(service.setKeyDevices).toHaveBeenLastCalledWith(3, null);
      expect((await request(app).delete('/v1/adb-proxy/keys/3')).status).toBe(200);
      expect(service.forgetKey).toHaveBeenCalledWith(3);
    });

    it('PATCH /keys/:id rejects a missing or malformed deviceIds', async () => {
      const app = appFor(service, MANAGE);
      expect((await request(app).patch('/v1/adb-proxy/keys/3').send({})).status).toBe(400);
      service = makeService({ setKeyDevices: vi.fn().mockReturnValue({ ok: false, error: 'invalid' }) });
      expect((await request(appFor(service, MANAGE)).patch('/v1/adb-proxy/keys/3').send({ deviceIds: [1] })).status).toBe(400);
    });

    it.each(['abc', '1.5', '-2'])('rejects the key id %s with 400', async (id) => {
      const app = appFor(service, MANAGE);
      expect((await request(app).post(`/v1/adb-proxy/keys/${id}/revoke`)).status).toBe(400);
      expect((await request(app).delete(`/v1/adb-proxy/keys/${id}`)).status).toBe(400);
    });
  });
});
```

Run: `npx vitest run backend/api/adb-proxy.test.ts`
Expected: FAIL with "Failed to resolve import './adb-proxy'".

- [ ] **Step 4: Write the API**

Create `backend/api/adb-proxy.ts`:

```ts
import type { Request, Response } from 'express';
import { registerEndpoint } from './api-service';
import { registerFilteredChannel } from '../websocket/channel-registry';
import { SettingsError } from '../services/adb-proxy/settings';
import type { AdbProxyService } from '../services/adb-proxy/adb-proxy-service';

export const ADB_PROXY_CHANNEL = 'adb-proxy';

const READ = ['core.adb-proxy:read'];
const MANAGE = ['core.adb-proxy:manage'];

const STATUS_FOR: Record<string, number> = {
  'not-found': 404,
  'unknown-device': 404,
  'not-approved': 409,
  'in-use': 409,
  'range-full': 409,
  'out-of-range': 400,
  invalid: 400,
};

function fail(res: Response, error: string): void {
  res.status(STATUS_FOR[error] ?? 400).json({ success: false, error });
}

function keyId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!/^\d+$/.test(req.params.id) || !Number.isSafeInteger(id)) {
    fail(res, 'invalid');
    return null;
  }
  return id;
}

function settingsPatch(body: any): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  const rules: Array<[string, string]> = [['enabled', 'boolean'], ['bindHost', 'string'], ['portStart', 'number'], ['portEnd', 'number']];
  for (const [name, type] of rules) {
    if (body?.[name] === undefined) continue;
    if (typeof body[name] !== type) return null;
    patch[name] = body[name];
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

export function registerAdbProxyEndpoints(service: AdbProxyService): void {
  registerFilteredChannel(ADB_PROXY_CHANNEL, { requires: READ });
  const acting = (req: Request) => req.authUser?.userId ?? null;

  registerEndpoint('GET', '/v1/adb-proxy/status', (_req, res) => {
    res.json({ success: true, data: service.snapshot() });
  }, { requires: READ });

  registerEndpoint('GET', '/v1/adb-proxy/keys', (_req, res) => {
    res.json({ success: true, data: service.listKeys() });
  }, { requires: READ });

  registerEndpoint('PUT', '/v1/adb-proxy/settings', async (req, res) => {
    const patch = settingsPatch(req.body);
    if (!patch) return fail(res, 'invalid');
    try {
      res.json({ success: true, data: await service.updateSettings(patch) });
    } catch (e) {
      if (e instanceof SettingsError) {
        res.status(400).json({ success: false, error: e.message });
        return;
      }
      throw e;
    }
  }, { requires: MANAGE });

  registerEndpoint('PATCH', '/v1/adb-proxy/devices/:id', async (req, res) => {
    const { enabled, port } = req.body ?? {};
    if ((enabled !== undefined && typeof enabled !== 'boolean') || (port !== undefined && typeof port !== 'number')) {
      return fail(res, 'invalid');
    }
    const result = await service.setDevice(req.params.id, { enabled, port });
    if (!result.ok) return fail(res, result.error);
    res.json({ success: true, data: service.snapshot() });
  }, { requires: MANAGE });

  registerEndpoint('POST', '/v1/adb-proxy/requests/:requestId/approve', (req, res) => {
    const result = service.approveRequest(req.params.requestId, acting(req));
    if (!result.ok) return fail(res, result.error);
    res.json({ success: true, data: service.snapshot() });
  }, { requires: MANAGE });

  registerEndpoint('POST', '/v1/adb-proxy/requests/:requestId/deny', (req, res) => {
    const result = service.denyRequest(req.params.requestId, acting(req));
    if (!result.ok) return fail(res, result.error);
    res.json({ success: true, data: service.snapshot() });
  }, { requires: MANAGE });

  registerEndpoint('POST', '/v1/adb-proxy/keys/:id/revoke', (req, res) => {
    const id = keyId(req, res);
    if (id === null) return;
    const result = service.revokeKey(id, acting(req));
    if (!result.ok) return fail(res, result.error);
    res.json({ success: true, data: service.snapshot() });
  }, { requires: MANAGE });

  registerEndpoint('PATCH', '/v1/adb-proxy/keys/:id', (req, res) => {
    const id = keyId(req, res);
    if (id === null) return;
    if (req.body?.deviceIds === undefined) return fail(res, 'invalid');
    const result = service.setKeyDevices(id, req.body.deviceIds);
    if (!result.ok) return fail(res, result.error);
    res.json({ success: true, data: service.snapshot() });
  }, { requires: MANAGE });

  registerEndpoint('DELETE', '/v1/adb-proxy/keys/:id', (req, res) => {
    const id = keyId(req, res);
    if (id === null) return;
    const result = service.forgetKey(id);
    if (!result.ok) return fail(res, result.error);
    res.json({ success: true, data: service.snapshot() });
  }, { requires: MANAGE });
}
```

Run: `npx vitest run backend/api/adb-proxy.test.ts`
Expected: PASS, 25 tests (counting each `it.each` row).

- [ ] **Step 5: Wire the service into the server**

In `backend/index.ts`:

(a) Next to the other service imports add:

```ts
import { AdbProxyService } from './services/adb-proxy/adb-proxy-service';
import { createDeviceDirectory } from './services/adb-proxy/device-directory';
import { HostClient } from './services/adb-proxy/host-client';
import { registerAdbProxyEndpoints } from './api/adb-proxy';
```

and extend the existing wireguard import: `import { ensureConfigs, getDeviceLanIp, getServerIp } from './services/wireguard-config';`

(b) Directly after `registerDeviceEndpoints(deviceManager, db, iosDeviceManager);` add:

```ts
const adbProxyService = new AdbProxyService({
  db,
  directory: createDeviceDirectory(deviceManager, db),
  backend: new HostClient(),
  broadcast: broadcastToAll,
  advertisedHost: () => getServerIp(),
});
registerAdbProxyEndpoints(adbProxyService);
```

(c) In the "Phase 2: Start services" block, before `deviceManager.start();` add:

```ts
  adbProxyService.start().catch((err: any) => error(`ADB proxy failed to start: ${err?.message ?? err}`));
```

(d) In `shutdown()`, before `deviceManager.stop();` add:

```ts
  try { await adbProxyService.stop(); } catch (err: any) { error(`ADB proxy cleanup: ${err.message}`); }
```

- [ ] **Step 6: Typecheck and run the backend suites that touch these files**

Run: `npm run typecheck`
Expected: exits 0 with no errors.

Run: `npx vitest run backend/api backend/auth backend/services/adb-proxy backend/services/device-manager.test.ts --maxWorkers=2`
Expected: PASS.

- [ ] **Step 7: Update the spec's status row**

In `docs/specs/2026-10-11-adb-proxy-design.md`, in the API table change the `GET /status` purpose cell to: `enabled, bind, range, per-device state and port, advertised host, live connections, pending requests, approved/denied/revoked keys, counters`, and add one bullet to "Revisions after approval": `- **Status snapshot includes keys**, so the page renders from one message.`

- [ ] **Step 8: Commit**

```bash
git add backend/auth/scopes-registry.ts backend/auth/scopes-registry.adb-proxy.test.ts backend/api/adb-proxy.ts backend/api/adb-proxy.test.ts backend/index.ts docs/specs/2026-10-11-adb-proxy-design.md
git commit -m "feat(adb-proxy): add the REST API, scopes, live channel and server wiring

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Conformance lane against the real `adb`

The spec's eval equivalent: this feature has no LLM, so the slower lane drives the real `adb` binary at the proxy, backed by a fake ADB server. It runs once per client in `ADB_BINS`. If a real-client assertion fails, treat it as a finding: compare with the Task 1 logs before changing production code or the assertion.

**Files:**
- Modify: `backend/services/adb-proxy/testing/fake-adb-server.ts` (add `sync:` v1, `tcp:` echo and `exec:`)
- Test: `backend/services/adb-proxy/testing/fake-adb-server.test.ts` (new cases)
- Create: `vitest.adb-proxy.config.ts`
- Modify: `vitest.config.ts` (exclude `tests/conformance/**`)
- Modify: `package.json` (script `test:adb-proxy-conformance`)
- Create: `tests/conformance/support/real-adb.ts`
- Test: `tests/conformance/adb-proxy.conformance.test.ts`

**Interfaces:**
- Consumes: `AdbProxyService`, `FakeAdbServer`, `StubDirectory`, `freePortBase`, `HostClient`, `fingerprintOf`.
- Produces: `FakeAdbServer.files: Map<string, Buffer>` (what was pushed over `sync:`); services `exec:<cmd>` (same as `shell:`), `tcp:<port>` (echo) and `sync:` (STAT, SEND, RECV, QUIT of the v1 protocol); `IsolatedAdb` (`static create(bin)`, `run(args, timeoutMs?)`, `devices()`, `waitForState(serial, state, timeoutMs?)`, `stop()`, `readonly home`), `adbBins()`, `adbAvailable(bin)`.

- [ ] **Step 1: Write the failing fake-server tests**

In `backend/services/adb-proxy/testing/fake-adb-server.test.ts`, add this block after the existing `describe` (it reuses the file's `frame` helper):

```ts
function recorder(socket: net.Socket) {
  let all = Buffer.alloc(0);
  socket.on('data', (c) => { all = Buffer.concat([all, c]); });
  return {
    get data() { return all; },
    async until(predicate: (b: Buffer) => boolean) {
      const end = Date.now() + 2000;
      while (!predicate(all)) {
        if (Date.now() > end) throw new Error('timed out, got ' + all.toString('latin1'));
        await new Promise((r) => setTimeout(r, 5));
      }
    },
  };
}

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const sync = (id: string, body: Buffer) => Buffer.concat([Buffer.from(id), u32(body.length), body]);

describe('FakeAdbServer extra services', () => {
  let fake: FakeAdbServer;
  let port: number;

  beforeEach(async () => {
    fake = new FakeAdbServer([{ serial: 'SER1' }]);
    port = (await fake.start()).port;
  });
  afterEach(async () => { await fake.stop(); });

  async function bound(service: string) {
    const client = net.connect(port, '127.0.0.1');
    const rec = recorder(client);
    client.write(frame('host:transport:SER1'));
    client.write(frame(service));
    await rec.until((b) => b.toString('latin1').startsWith('OKAYOKAY'));
    return { client, rec };
  }

  it('runs exec: like shell:', async () => {
    const { client, rec } = await bound('exec:id');
    await rec.until((b) => b.toString().includes('ran: id'));
    client.destroy();
  });

  it('echoes on tcp:<port>', async () => {
    const { client, rec } = await bound('tcp:9999');
    client.write('ping');
    await rec.until((b) => b.length >= 12);
    expect(rec.data.subarray(8).toString()).toBe('ping');
    client.destroy();
  });

  it('stores a pushed file and serves it back over sync v1', async () => {
    const { client, rec } = await bound('sync:');
    const payload = Buffer.from('hello sync');
    client.write(sync('STAT', Buffer.from('/data/x')));
    await rec.until((b) => b.length >= 8 + 16);
    expect(rec.data.subarray(8, 12).toString()).toBe('STAT');
    expect(rec.data.readUInt32LE(12)).toBe(0);

    client.write(Buffer.concat([sync('SEND', Buffer.from('/data/x,33188')), sync('DATA', payload), Buffer.concat([Buffer.from('DONE'), u32(1)])]));
    await rec.until((b) => b.length >= 8 + 16 + 8);
    expect(rec.data.subarray(24, 28).toString()).toBe('OKAY');
    expect(fake.files.get('/data/x')?.toString()).toBe('hello sync');

    client.write(sync('STAT', Buffer.from('/data/x')));
    await rec.until((b) => b.length >= 8 + 16 + 8 + 16);
    expect(rec.data.readUInt32LE(8 + 16 + 8 + 8)).toBe(payload.length);

    client.write(sync('RECV', Buffer.from('/data/x')));
    await rec.until((b) => b.toString('latin1').endsWith('DONE\0\0\0\0'));
    expect(rec.data.toString('latin1')).toContain('hello sync');

    client.write(sync('RECV', Buffer.from('/data/missing')));
    await rec.until((b) => b.toString('latin1').includes('FAIL'));
    client.destroy();
  });
});
```

Run: `npx vitest run backend/services/adb-proxy/testing/fake-adb-server.test.ts`
Expected: the three new tests FAIL (unknown service).

- [ ] **Step 2: Extend the fake server**

In `backend/services/adb-proxy/testing/fake-adb-server.ts`:

(a) Add a field next to `requests`:

```ts
  /** Files pushed over `sync:` (path to contents). */
  readonly files = new Map<string, Buffer>();
```

(b) In `service(...)`, replace the existing `shell:` block with one that also serves `exec:`, replace the `echo:` block so `tcp:` echoes too, and add `sync:`:

```ts
    if (service.startsWith('shell:') || service.startsWith('exec:')) {
      okay();
      socket.write(this.shell(serial, service.slice(service.indexOf(':') + 1)));
      socket.end();
      return { raw: () => {} };
    }
    if (service === 'echo:' || service.startsWith('tcp:')) {
      okay();
      return { raw: (chunk) => socket.write(chunk) };
    }
    if (service === 'sync:') {
      okay();
      return { raw: this.syncHandler(socket) };
    }
```

(c) Add the handler method to the class:

```ts
  /** The device side of the adb sync v1 protocol: STAT, SEND (with DATA and DONE), RECV and QUIT. */
  private syncHandler(socket: net.Socket): (chunk: Buffer) => void {
    let buf = Buffer.alloc(0);
    let sending: { path: string; chunks: Buffer[] } | null = null;
    const u32 = (n: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(n >>> 0);
      return b;
    };
    return (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 8) return;
        const id = buf.toString('ascii', 0, 4);
        const len = buf.readUInt32LE(4);
        if (id === 'DONE') {
          // The length field carries the mtime; no body follows.
          if (sending) {
            this.files.set(sending.path, Buffer.concat(sending.chunks));
            sending = null;
            socket.write(Buffer.concat([Buffer.from('OKAY'), u32(0)]));
          }
          buf = buf.subarray(8);
          continue;
        }
        if (id === 'QUIT') {
          socket.end();
          return;
        }
        if (buf.length < 8 + len) return;
        const body = Buffer.from(buf.subarray(8, 8 + len));
        buf = buf.subarray(8 + len);
        if (id === 'STAT') {
          const file = this.files.get(body.toString());
          socket.write(Buffer.concat([Buffer.from('STAT'), u32(file ? 0x81a4 : 0), u32(file?.length ?? 0), u32(file ? 1 : 0)]));
        } else if (id === 'RECV') {
          const file = this.files.get(body.toString());
          if (!file) {
            const msg = Buffer.from('No such file');
            socket.write(Buffer.concat([Buffer.from('FAIL'), u32(msg.length), msg]));
            continue;
          }
          for (let off = 0; off < file.length; off += 65536) {
            const piece = file.subarray(off, off + 65536);
            socket.write(Buffer.concat([Buffer.from('DATA'), u32(piece.length), piece]));
          }
          socket.write(Buffer.concat([Buffer.from('DONE'), u32(0)]));
        } else if (id === 'SEND') {
          const spec = body.toString();
          sending = { path: spec.slice(0, spec.lastIndexOf(',')), chunks: [] };
        } else if (id === 'DATA' && sending) {
          sending.chunks.push(body);
        }
      }
    };
  }
```

- [ ] **Step 3: Run the fake-server tests**

Run: `npx vitest run backend/services/adb-proxy/testing/fake-adb-server.test.ts backend/services/adb-proxy/host-client.test.ts backend/services/adb-proxy/session.streams.test.ts`
Expected: PASS (the earlier suites still pass with the extended fake).

- [ ] **Step 4: Add the lane config, script and default-lane exclusion**

Create `vitest.adb-proxy.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

// Opt-in lane that drives the real `adb` binary at the proxy. The default vitest.config.ts excludes
// `tests/conformance/**`; run this on purpose with `npm run test:adb-proxy-conformance`.
// ADB_BINS is a comma-separated list of clients to test, for example:
//   ADB_BINS=adb,/home/me/android-sdk/platform-tools/adb npm run test:adb-proxy-conformance
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/conformance/**/*.conformance.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    retry: 0,
    pool: 'forks',
    poolOptions: { forks: { maxForks: 1 } },
  },
});
```

In `vitest.config.ts`, add to the `exclude` list after `'tests/live/**'`:

```ts
      // Real-adb conformance checks run only through `npm run test:adb-proxy-conformance`
      // (vitest.adb-proxy.config.ts), never in the default suite.
      'tests/conformance/**',
```

In `package.json` scripts, after `"test:ai-live"` add:

```json
    "test:adb-proxy-conformance": "vitest run --config vitest.adb-proxy.config.ts",
```

- [ ] **Step 5: Write the isolated adb helper**

Create `tests/conformance/support/real-adb.ts`:

```ts
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePortBase } from '../../../backend/services/adb-proxy/testing/free-port';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Clients to test: ADB_BINS (comma-separated), else ADB_BIN, else `adb` on PATH. */
export function adbBins(): string[] {
  const raw = process.env.ADB_BINS ?? process.env.ADB_BIN ?? 'adb';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function adbAvailable(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(bin, ['version'], { timeout: 10_000 }, (err) => resolve(!err));
  });
}

/**
 * A real adb client with its own HOME (so its own key pair) and its own ADB server port, so it can
 * never touch the developer's running ADB server or keys.
 */
export class IsolatedAdb {
  private constructor(
    readonly bin: string,
    readonly home: string,
    private readonly serverPort: number,
  ) {}

  static async create(bin: string): Promise<IsolatedAdb> {
    const serverPort = await freePortBase();
    if (serverPort === 5037) throw new Error('refusing to use the default ADB server port');
    const adb = new IsolatedAdb(bin, mkdtempSync(join(tmpdir(), 'adb-proxy-client-')), serverPort);
    await adb.run(['start-server']);
    return adb;
  }

  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: this.home, ANDROID_ADB_SERVER_PORT: String(this.serverPort) };
    for (const k of ['ANDROID_USER_HOME', 'ANDROID_SDK_HOME', 'ADB_VENDOR_KEYS', 'ANDROID_ADB_SERVER_ADDRESS', 'ANDROID_SERIAL', 'ADB_TRACE']) {
      delete env[k];
    }
    return env;
  }

  run(args: string[], timeoutMs = 20_000): Promise<RunResult> {
    return new Promise((resolve) => {
      execFile(this.bin, args, { env: this.env(), timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
        const code = err ? ((err as NodeJS.ErrnoException & { code?: unknown }).code) : 0;
        resolve({ code: typeof code === 'number' ? code : err ? 1 : 0, stdout, stderr });
      });
    });
  }

  /** Serial to state, from `adb devices`. */
  async devices(): Promise<Map<string, string>> {
    const out = await this.run(['devices']);
    const map = new Map<string, string>();
    for (const line of out.stdout.split('\n').slice(1)) {
      const [serial, state] = line.trim().split(/\s+/);
      if (serial && state) map.set(serial, state);
    }
    return map;
  }

  async waitForState(serial: string, state: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = 'absent';
    while (Date.now() < deadline) {
      last = (await this.devices()).get(serial) ?? 'absent';
      if (last === state) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`expected ${serial} to be ${state} within ${timeoutMs} ms, last state was ${last}`);
  }

  async stop(): Promise<void> {
    await this.run(['kill-server']);
    rmSync(this.home, { recursive: true, force: true });
  }
}
```

- [ ] **Step 6: Write the conformance test**

Create `tests/conformance/adb-proxy.conformance.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from '../../backend/test-utils/create-test-db';
import { adbProxyDevices, adbProxyKeys, devices, settings, users } from '../../backend/db/schema';
import { fingerprintOf } from '../../backend/services/adb-proxy/adb-key';
import { AdbProxyService } from '../../backend/services/adb-proxy/adb-proxy-service';
import { HostClient } from '../../backend/services/adb-proxy/host-client';
import { saveSettings } from '../../backend/services/adb-proxy/settings';
import { FakeAdbServer } from '../../backend/services/adb-proxy/testing/fake-adb-server';
import { freePortBase } from '../../backend/services/adb-proxy/testing/free-port';
import { StubDirectory } from '../../backend/services/adb-proxy/testing/stub-directory';
import { IsolatedAdb, adbAvailable, adbBins } from './support/real-adb';

async function startProxy() {
  const fake = new FakeAdbServer([{ serial: 'FAKE1', features: 'cmd' }], {
    shell: (_serial, command) => {
      if (command.startsWith('getprop')) return 'fakeprod\nFakeModel\nfakedev\n';
      if (command === 'big') return 'x'.repeat(1_000_000);
      return `ran: ${command}\n`;
    },
  });
  const backend = new HostClient(await fake.start(), 5000);
  const db = createTestDb([users, devices, settings, adbProxyKeys, adbProxyDevices], { foreignKeys: true });
  db.insert(devices).values({ id: 'FAKE1' }).run();
  const base = await freePortBase();
  saveSettings(db, { enabled: true, bindHost: '127.0.0.1', portStart: base, portEnd: base + 4 });
  const service = new AdbProxyService({ db, directory: new StubDirectory(['FAKE1']), backend });
  await service.start();
  const port = service.snapshot().devices[0].port as number;
  return { fake, service, port, stop: async () => { await service.stop(); await fake.stop(); } };
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

for (const bin of adbBins()) {
  const usable = await adbAvailable(bin);
  describe.skipIf(!usable)(`real adb client: ${bin}`, () => {
    let proxy: Awaited<ReturnType<typeof startProxy>>;
    let adb: IsolatedAdb;
    let serial: string;
    let work: string;

    beforeAll(async () => {
      proxy = await startProxy();
      adb = await IsolatedAdb.create(bin);
      serial = `127.0.0.1:${proxy.port}`;
      work = mkdtempSync(join(tmpdir(), 'adb-proxy-conformance-'));
    });

    afterAll(async () => {
      await adb?.stop();
      await proxy?.stop();
      if (work) rmSync(work, { recursive: true, force: true });
    });

    it('shows unauthorized and files an approval request that carries the client key', async () => {
      const connect = await adb.run(['connect', serial]);
      expect(connect.stdout).toContain('connected to');
      await adb.waitForState(serial, 'unauthorized');
      await vi.waitFor(() => expect(proxy.service.snapshot().pending).toHaveLength(1));

      const [req] = proxy.service.snapshot().pending;
      const pub = readFileSync(join(adb.home, '.android', 'adbkey.pub'), 'utf8').trim();
      const [b64, ...rest] = pub.split(/\s+/);
      expect(req.comment).toBe(rest.join(' '));
      expect(req.fingerprint).toBe(fingerprintOf(Buffer.from(b64, 'base64')));
      expect(req.deviceId).toBe('FAKE1');
    });

    it('becomes a device once the request is approved, with no tap on the phone', async () => {
      const [req] = proxy.service.snapshot().pending;
      expect(proxy.service.approveRequest(req.requestId, null)).toEqual({ ok: true });
      await adb.waitForState(serial, 'device');
    });

    it('runs a shell command', async () => {
      const out = await adb.run(['-s', serial, 'shell', 'echo', 'hi']);
      expect(out.code, out.stderr).toBe(0);
      expect(out.stdout).toContain('ran: echo hi');
    });

    it('streams a megabyte of output intact', async () => {
      const out = await adb.run(['-s', serial, 'shell', 'big'], 30_000);
      expect(out.code, out.stderr).toBe(0);
      expect(out.stdout.length).toBeGreaterThanOrEqual(1_000_000);
    });

    it('pushes and pulls a file byte for byte', async () => {
      const data = randomBytes(300_000);
      const local = join(work, 'in.bin');
      writeFileSync(local, data);
      const push = await adb.run(['-s', serial, 'push', local, '/data/local/tmp/in.bin'], 30_000);
      expect(push.code, push.stderr).toBe(0);
      const back = join(work, 'out.bin');
      const pull = await adb.run(['-s', serial, 'pull', '/data/local/tmp/in.bin', back], 30_000);
      expect(pull.code, pull.stderr).toBe(0);
      expect(sha(readFileSync(back))).toBe(sha(data));
    });

    it('forwards a TCP port to the device', async () => {
      const local = await freePortBase();
      const forward = await adb.run(['-s', serial, 'forward', `tcp:${local}`, 'tcp:9999']);
      expect(forward.code, forward.stderr).toBe(0);
      const echoed = await new Promise<string>((resolve, reject) => {
        const s = net.connect(local, '127.0.0.1');
        s.on('error', reject);
        s.on('connect', () => s.write('ping'));
        s.once('data', (d) => {
          s.destroy();
          resolve(d.toString());
        });
      });
      expect(echoed).toBe('ping');
    });

    it('never offers a host service to the ADB server behind the proxy', () => {
      const hostRequests = proxy.fake.requests.filter(
        (r) => r.startsWith('host') && !r.startsWith('host:transport:') && !r.startsWith('host-serial:'),
      );
      expect(hostRequests).toEqual([]);
    });

    it('drops the connection when the key is revoked and never returns to device', async () => {
      const rec = proxy.service.listKeys()[0];
      expect(proxy.service.revokeKey(rec.id, null)).toEqual({ ok: true });
      await vi.waitFor(async () => {
        expect((await adb.devices()).get(serial)).not.toBe('device');
      }, { timeout: 10_000, interval: 250 });
      await adb.run(['connect', serial]);
      await new Promise((r) => setTimeout(r, 2000));
      expect((await adb.devices()).get(serial)).not.toBe('device');
      expect(proxy.service.snapshot().pending).toEqual([]);
    });
  });
}

describe.skipIf(!process.env.ADB_PROXY_LIVE_SERIAL)('live device through the proxy', () => {
  it('reports the same model as a direct adb call', async () => {
    const liveSerial = process.env.ADB_PROXY_LIVE_SERIAL as string;
    const bin = adbBins()[0];
    const db = createTestDb([users, devices, settings, adbProxyKeys, adbProxyDevices], { foreignKeys: true });
    db.insert(devices).values({ id: liveSerial }).run();
    const base = await freePortBase();
    saveSettings(db, { enabled: true, bindHost: '127.0.0.1', portStart: base, portEnd: base + 4 });
    const service = new AdbProxyService({ db, directory: new StubDirectory([liveSerial]), backend: new HostClient() });
    await service.start();
    const adb = await IsolatedAdb.create(bin);
    try {
      const serial = `127.0.0.1:${service.snapshot().devices[0].port}`;
      await adb.run(['connect', serial]);
      await vi.waitFor(() => expect(service.snapshot().pending).toHaveLength(1));
      service.approveRequest(service.snapshot().pending[0].requestId, null);
      await adb.waitForState(serial, 'device');
      const viaProxy = await adb.run(['-s', serial, 'shell', 'getprop', 'ro.product.model']);
      const direct = await new Promise<string>((resolve) => {
        execFile(bin, ['-s', liveSerial, 'shell', 'getprop', 'ro.product.model'], { encoding: 'utf8' }, (_e, out) => resolve(out));
      });
      expect(viaProxy.stdout.trim()).toBe(direct.trim());
      expect(viaProxy.stdout.trim().length).toBeGreaterThan(0);
    } finally {
      await adb.stop();
      await service.stop();
    }
  });
});
```

- [ ] **Step 7: Run the lane against every client you have**

Run: `ADB_BINS=adb,$ADB_ALT npm run test:adb-proxy-conformance`
Expected: PASS, 8 tests per client (16 in total), plus the live test skipped. Also run `npx vitest run backend/services/adb-proxy --maxWorkers=2`; Expected: PASS (the lane is not collected by the default config).

If a client cannot be started, its `describe` is skipped, not failed; check the output names both clients.

- [ ] **Step 8: Commit**

```bash
git add backend/services/adb-proxy/testing/fake-adb-server.ts backend/services/adb-proxy/testing/fake-adb-server.test.ts vitest.adb-proxy.config.ts vitest.config.ts package.json tests/conformance
git commit -m "test(adb-proxy): add a conformance lane that drives the real adb client

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Settings page, live status hook and sidebar badge

**Files:**
- Create: `frontend/hooks/useAdbProxyStatus.ts`
- Create: `frontend/components/settings/AdbProxyPendingBadge.tsx`
- Create: `frontend/pages/settings/AdbProxyPage.tsx`
- Modify: `frontend/components/settings/SettingsSidebar.tsx`
- Modify: `frontend/App.tsx`
- Test: `frontend/hooks/useAdbProxyStatus.test.tsx`
- Test: `frontend/pages/settings/AdbProxyPage.test.tsx`
- Test: `frontend/components/settings/__tests__/SettingsSidebar.adb-proxy.test.tsx`

**Interfaces:**
- Consumes: the REST API and the `adb-proxy` WS message from Task 13; `StatusSnapshot` and friends from `shared/types/adb-proxy`; `useWebSocket`, `useAuthOptional`, `useDocumentTitle`, `AuthContext`, `WebSocketContext` from `@darkrideapp/plugin-sdk/react`.
- Produces: `useAdbProxyStatus(): { status: StatusSnapshot | null; error: string | null; refresh(): Promise<void> }`; `AdbProxyPendingBadge` (renders the pending count, nothing at zero); `AdbProxyPage` at `/ui/settings/adb-proxy`; a sidebar link `ADB Proxy` in the Advanced group, with the badge for users holding `core.adb-proxy:read`.

- [ ] **Step 1: Write the failing hook test**

Create `frontend/hooks/useAdbProxyStatus.test.tsx`:

```tsx
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { WebSocketContext, type WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import type { StatusSnapshot } from '../../shared/types/adb-proxy';
import { useAdbProxyStatus } from './useAdbProxyStatus';

const SNAP = { enabled: true, devices: [], pending: [], keys: [], connections: [] } as unknown as StatusSnapshot;

function makeWs(body: unknown) {
  const handlers = new Map<string, (m: any) => void>();
  const unsubscribe = vi.fn();
  const ws: WebSocketContextValue = {
    connected: true, serverReady: true, startupMessage: '', sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockResolvedValue({ type: 'restapi', id: '1', status: 200, body }),
    subscribe: vi.fn((type: string, cb: (m: any) => void) => { handlers.set(type, cb); return unsubscribe; }),
    subscribeBinary: vi.fn(() => () => {}),
  };
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <WebSocketContext.Provider value={ws}>{children}</WebSocketContext.Provider>
  );
  return { ws, handlers, unsubscribe, wrapper };
}

describe('useAdbProxyStatus', () => {
  it('loads the status and then follows pushed snapshots', async () => {
    const { handlers, wrapper } = makeWs({ success: true, data: SNAP });
    const { result } = renderHook(() => useAdbProxyStatus(), { wrapper });
    await waitFor(() => expect(result.current.status).toEqual(SNAP));
    act(() => handlers.get('adb-proxy')!({ type: 'adb-proxy', enabled: false, devices: [], pending: [], keys: [], connections: [] }));
    expect(result.current.status?.enabled).toBe(false);
    expect((result.current.status as any).type).toBeUndefined();
  });

  it('reports an error when the request fails', async () => {
    const { wrapper } = makeWs({ success: false, error: 'Insufficient scope' });
    const { result } = renderHook(() => useAdbProxyStatus(), { wrapper });
    await waitFor(() => expect(result.current.error).toBe('Insufficient scope'));
    expect(result.current.status).toBeNull();
  });

  it('unsubscribes on unmount', async () => {
    const { unsubscribe, wrapper } = makeWs({ success: true, data: SNAP });
    const { unmount, result } = renderHook(() => useAdbProxyStatus(), { wrapper });
    await waitFor(() => expect(result.current.status).not.toBeNull());
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then implement**

Run: `npm run test:frontend -- frontend/hooks/useAdbProxyStatus.test.tsx`
Expected: FAIL with "Failed to resolve import './useAdbProxyStatus'".

Create `frontend/hooks/useAdbProxyStatus.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import type { StatusSnapshot } from '../../shared/types/adb-proxy';

/** The ADB proxy status: fetched once, then replaced by every snapshot the server pushes. */
export function useAdbProxyStatus(): { status: StatusSnapshot | null; error: string | null; refresh: () => Promise<void> } {
  const ws = useWebSocket();
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/adb-proxy/status');
      if (res.body?.success) {
        setStatus(res.body.data as StatusSnapshot);
        setError(null);
      } else {
        setError(res.body?.error ?? 'Could not load the ADB proxy status.');
      }
    } catch {
      setError('Could not load the ADB proxy status.');
    }
  }, [ws]);

  useEffect(() => {
    void refresh();
  }, [refresh, ws.connected]);

  useEffect(
    () =>
      ws.subscribe('adb-proxy', (msg) => {
        const { type: _type, ...snapshot } = msg;
        setStatus(snapshot as StatusSnapshot);
      }),
    [ws],
  );

  return { status, error, refresh };
}
```

Run: `npm run test:frontend -- frontend/hooks/useAdbProxyStatus.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 3: Write the failing page test**

Create `frontend/pages/settings/AdbProxyPage.test.tsx`:

```tsx
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AuthContext, WebSocketContext, type WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import type { KeyView, PendingView, StatusSnapshot } from '../../../shared/types/adb-proxy';
import { AdbProxyPage } from './AdbProxyPage';

afterEach(cleanup);

const FP = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';

function snapshot(over: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    enabled: true, bindHost: '0.0.0.0', portStart: 6500, portEnd: 6599, advertisedHost: '192.168.1.10',
    devices: [{ deviceId: 'DEV1', name: 'Phone 1', port: 6500, enabled: true, online: true, state: 'listening' }],
    connections: [], pending: [], keys: [],
    counters: { connections: 0, approvals: 0, denials: 0, authFailures: 0, floodDrops: 0 },
    ...over,
  };
}
const pendingReq = (over: Partial<PendingView> = {}): PendingView => ({
  requestId: 'r1', keyId: 'k1', fingerprint: FP, comment: 'ci@runner', deviceId: 'DEV1', peerIp: '10.0.0.5', createdAt: Date.now() - 120_000, ...over,
});
const keyRow = (over: Partial<KeyView> = {}): KeyView => ({
  id: 1, keyId: 'k1', fingerprint: FP, comment: 'dev@laptop', status: 'approved', deviceIds: null,
  firstSeenAt: 1, lastSeenAt: Date.now() - 60_000, lastSeenIp: '10.0.0.7', lastDeviceId: 'DEV1', decidedAt: 1, ...over,
});

const MANAGE = ['core.adb-proxy:read', 'core.adb-proxy:manage'];

function mount(opts: { snapshot?: StatusSnapshot; scopes?: string[]; failWith?: string } = {}) {
  const current = opts.snapshot ?? snapshot();
  const handlers = new Map<string, (m: any) => void>();
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const ws: WebSocketContextValue = {
    connected: true, serverReady: true, startupMessage: '', sendMessage: vi.fn(),
    sendRestApi: vi.fn(async (method: string, path: string, body?: any) => {
      calls.push({ method, path, body });
      if (method !== 'GET' && opts.failWith) {
        return { type: 'restapi' as const, id: '1', status: 409, body: { success: false, error: opts.failWith } };
      }
      return { type: 'restapi' as const, id: '1', status: 200, body: { success: true, data: current } };
    }),
    subscribe: vi.fn((type: string, cb: (m: any) => void) => { handlers.set(type, cb); return () => { handlers.delete(type); }; }),
    subscribeBinary: vi.fn(() => () => {}),
  };
  const scopes = opts.scopes ?? MANAGE;
  const auth = { hasScope: (s: string) => scopes.includes(s) } as any;
  render(
    <AuthContext.Provider value={auth}>
      <WebSocketContext.Provider value={ws}>
        <AdbProxyPage />
      </WebSocketContext.Provider>
    </AuthContext.Provider>,
  );
  return { calls, push: (s: StatusSnapshot) => act(() => handlers.get('adb-proxy')!({ type: 'adb-proxy', ...s })) };
}

const writes = (calls: Array<{ method: string }>) => calls.filter((c) => c.method !== 'GET');

describe('AdbProxyPage', () => {
  it('denies access without the read scope', async () => {
    mount({ scopes: [] });
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(screen.getByText('core.adb-proxy:read')).toBeInTheDocument();
  });

  it('explains the feature and the plaintext caveat', async () => {
    mount();
    expect(await screen.findByRole('heading', { name: 'ADB Proxy' })).toBeInTheDocument();
    expect(screen.getByText(/not encrypted/i)).toBeInTheDocument();
  });

  it('shows the disabled state and enables the proxy', async () => {
    const { calls } = mount({ snapshot: snapshot({ enabled: false }) });
    expect(await screen.findByText('Disabled')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('adb-proxy-toggle'));
    await waitFor(() => expect(writes(calls)).toEqual([{ method: 'PUT', path: '/v1/adb-proxy/settings', body: { enabled: true } }]));
  });

  it('lists a pending request with its machine, fingerprint, source and device', async () => {
    mount({ snapshot: snapshot({ pending: [pendingReq()] }) });
    const row = await screen.findByTestId('adb-proxy-request');
    expect(within(row).getByText('ci@runner')).toBeInTheDocument();
    expect(within(row).getByText(FP)).toBeInTheDocument();
    expect(within(row).getByText('10.0.0.5')).toBeInTheDocument();
    expect(within(row).getByText('Phone 1')).toBeInTheDocument();
  });

  it('approves and denies a request', async () => {
    const { calls } = mount({ snapshot: snapshot({ pending: [pendingReq(), pendingReq({ requestId: 'r2', keyId: 'k2', comment: 'other@box' })] }) });
    const rows = await screen.findAllByTestId('adb-proxy-request');
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Approve' }));
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(writes(calls)).toEqual([
      { method: 'POST', path: '/v1/adb-proxy/requests/r1/approve', body: undefined },
      { method: 'POST', path: '/v1/adb-proxy/requests/r2/deny', body: undefined },
    ]));
  });

  it('renders a hostile key comment as plain text', async () => {
    const evil = '<img src=x onerror=alert(1)>@host';
    mount({ snapshot: snapshot({ pending: [pendingReq({ comment: evil })], keys: [keyRow({ comment: evil })] }) });
    await screen.findByTestId('adb-proxy-request');
    expect(screen.getAllByText(evil).length).toBeGreaterThanOrEqual(2);
    expect(document.querySelector('img')).toBeNull();
  });

  it('hides every action from a read-only user', async () => {
    mount({ scopes: ['core.adb-proxy:read'], snapshot: snapshot({ pending: [pendingReq()], keys: [keyRow()] }) });
    await screen.findByTestId('adb-proxy-request');
    for (const name of ['Approve', 'Deny', 'Revoke', 'Disable', 'Enable', 'Save']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.queryByTestId('adb-proxy-toggle')).toBeNull();
  });

  it('revokes an approved machine and forgets a denied one', async () => {
    const { calls } = mount({
      snapshot: snapshot({ keys: [keyRow(), keyRow({ id: 2, keyId: 'k2', comment: 'old@box', status: 'denied' }), keyRow({ id: 3, keyId: 'k3', comment: 'gone@box', status: 'revoked' })] }),
    });
    const approved = await screen.findByTestId('adb-proxy-approved');
    expect(within(approved).getByText('dev@laptop')).toBeInTheDocument();
    expect(within(approved).queryByText('old@box')).toBeNull();
    fireEvent.click(within(approved).getByRole('button', { name: 'Revoke' }));
    const blocked = screen.getByTestId('adb-proxy-blocked');
    expect(within(blocked).getByText('old@box')).toBeInTheDocument();
    expect(within(blocked).getByText('gone@box')).toBeInTheDocument();
    fireEvent.click(within(blocked).getAllByRole('button', { name: 'Forget', hidden: true })[0]);
    await waitFor(() => expect(writes(calls)).toEqual([
      { method: 'POST', path: '/v1/adb-proxy/keys/1/revoke', body: undefined },
      { method: 'DELETE', path: '/v1/adb-proxy/keys/2', body: undefined },
    ]));
  });

  it('shows each device with its connect command and copies it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mount();
    const row = await screen.findByTestId('adb-proxy-device-DEV1');
    expect(within(row).getByText('adb connect 192.168.1.10:6500')).toBeInTheDocument();
    expect(within(row).getByText('Listening')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('adb connect 192.168.1.10:6500');
  });

  it('changes a device port and toggles a device', async () => {
    const { calls } = mount();
    const row = await screen.findByTestId('adb-proxy-device-DEV1');
    fireEvent.change(within(row).getByLabelText('Port for Phone 1'), { target: { value: '6510' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save port' }));
    fireEvent.click(within(row).getByLabelText('Proxy Phone 1'));
    await waitFor(() => expect(writes(calls)).toEqual([
      { method: 'PATCH', path: '/v1/adb-proxy/devices/DEV1', body: { port: 6510 } },
      { method: 'PATCH', path: '/v1/adb-proxy/devices/DEV1', body: { enabled: false } },
    ]));
  });

  it('shows a readable message when the server refuses a port', async () => {
    mount({ failWith: 'in-use' });
    const row = await screen.findByTestId('adb-proxy-device-DEV1');
    fireEvent.change(within(row).getByLabelText('Port for Phone 1'), { target: { value: '6501' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save port' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That port is used by another device.');
  });

  it('saves the bind address and port range as numbers', async () => {
    const { calls } = mount();
    fireEvent.change(await screen.findByLabelText('Bind address'), { target: { value: '192.168.1.10' } });
    fireEvent.change(screen.getByLabelText('First port'), { target: { value: '7000' } });
    fireEvent.change(screen.getByLabelText('Last port'), { target: { value: '7009' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes(calls)).toEqual([
      { method: 'PUT', path: '/v1/adb-proxy/settings', body: { bindHost: '192.168.1.10', portStart: 7000, portEnd: 7009 } },
    ]));
  });

  it('lists only live connections', async () => {
    mount({
      snapshot: snapshot({
        connections: [
          { id: 1, deviceId: 'DEV1', peerIp: '10.0.0.7', state: 'ready', keyId: 'k1', comment: 'dev@laptop', since: Date.now() - 90_000, streams: 2 },
          { id: 2, deviceId: 'DEV1', peerIp: '10.0.0.8', state: 'pending', keyId: 'k2', comment: 'wait@box', since: Date.now(), streams: 0 },
        ],
      }),
    });
    const live = await screen.findByTestId('adb-proxy-connections');
    expect(within(live).getByText('10.0.0.7')).toBeInTheDocument();
    expect(within(live).queryByText('10.0.0.8')).toBeNull();
  });

  it('shows empty states', async () => {
    mount();
    expect(await screen.findByText('No machines are waiting for approval.')).toBeInTheDocument();
    expect(screen.getByText('No machines have been approved yet.')).toBeInTheDocument();
    expect(screen.getByText('No machines are connected.')).toBeInTheDocument();
  });

  it('updates when the server pushes a snapshot', async () => {
    const { push } = mount();
    await screen.findByText('No machines are waiting for approval.');
    push(snapshot({ pending: [pendingReq({ comment: 'fresh@box' })] }));
    expect(await screen.findByText('fresh@box')).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npm run test:frontend -- frontend/pages/settings/AdbProxyPage.test.tsx`
Expected: FAIL with "Failed to resolve import './AdbProxyPage'".

- [ ] **Step 5: Write the page**

Create `frontend/pages/settings/AdbProxyPage.tsx`:

```tsx
import React, { useCallback, useEffect, useState } from 'react';
import { useAuthOptional, useDocumentTitle, useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { AccessDenied } from '../../components/auth/AccessDenied';
import { useAdbProxyStatus } from '../../hooks/useAdbProxyStatus';
import type { DeviceProxyState, DeviceStatusView, KeyView, PendingView } from '../../../shared/types/adb-proxy';

const API_ERRORS: Record<string, string> = {
  'not-found': 'That item no longer exists. The list has been refreshed.',
  'not-approved': 'Only approved machines can be revoked.',
  'in-use': 'That port is used by another device.',
  'out-of-range': 'That port is outside the configured range.',
  'range-full': 'There is no free port left in the range.',
  'unknown-device': 'DarkRide does not know that device.',
  invalid: 'That value is not valid.',
};

const STATE_BADGES: Record<DeviceProxyState, { label: string; className: string }> = {
  listening: { label: 'Listening', className: 'badge badge-success' },
  'device-offline': { label: 'Device offline', className: 'badge badge-offline' },
  disabled: { label: 'Disabled', className: 'badge badge-offline' },
  off: { label: 'Off', className: 'badge badge-offline' },
  'port-in-use': { label: 'Port in use', className: 'badge badge-error' },
  'range-full': { label: 'No free port', className: 'badge badge-error' },
  error: { label: 'Error', className: 'badge badge-error' },
};

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}

const machine = (comment: string | null) => comment || '(no name)';

export function AdbProxyPage() {
  useDocumentTitle('ADB Proxy');
  const ws = useWebSocket();
  const auth = useAuthOptional();
  const { status, error: loadError, refresh } = useAdbProxyStatus();
  const [actionError, setActionError] = useState<string | null>(null);
  const [net, setNet] = useState<{ bindHost: string; portStart: string; portEnd: string } | null>(null);
  const [portDrafts, setPortDrafts] = useState<Record<string, string>>({});
  const canManage = auth?.hasScope('core.adb-proxy:manage') ?? true;

  useEffect(() => {
    if (status && net === null) {
      setNet({ bindHost: status.bindHost, portStart: String(status.portStart), portEnd: String(status.portEnd) });
    }
  }, [status, net]);

  const call = useCallback(
    async (method: string, path: string, body?: unknown): Promise<boolean> => {
      try {
        const res = await ws.sendRestApi(method, path, body);
        if (res.body?.success) {
          setActionError(null);
          await refresh();
          return true;
        }
        const code = res.body?.error as string | undefined;
        setActionError((code && API_ERRORS[code]) || code || 'The request failed.');
      } catch {
        setActionError('The request failed.');
      }
      await refresh();
      return false;
    },
    [ws, refresh],
  );

  if (auth && !auth.hasScope('core.adb-proxy:read')) return <AccessDenied scope="core.adb-proxy:read" />;

  const netDirty = !!status && !!net && (
    net.bindHost !== status.bindHost || net.portStart !== String(status.portStart) || net.portEnd !== String(status.portEnd)
  );
  const approved = (status?.keys ?? []).filter((k) => k.status === 'approved');
  const blocked = (status?.keys ?? []).filter((k) => k.status !== 'approved');
  const live = (status?.connections ?? []).filter((c) => c.state === 'ready');
  const deviceName = (id: string) => status?.devices.find((d) => d.deviceId === id)?.name ?? id;

  const saveNetwork = () => {
    if (!net) return;
    void call('PUT', '/v1/adb-proxy/settings', {
      bindHost: net.bindHost.trim(),
      portStart: Number(net.portStart),
      portEnd: Number(net.portEnd),
    });
  };

  const renderPending = (p: PendingView) => (
    <tr key={p.requestId} data-testid="adb-proxy-request">
      <td>{machine(p.comment)}</td>
      <td><code>{p.fingerprint}</code></td>
      <td>{p.peerIp}</td>
      <td>{deviceName(p.deviceId)}</td>
      <td>{ago(p.createdAt)}</td>
      <td>
        {canManage && (
          <>
            <button className="btn btn-sm btn-primary" onClick={() => void call('POST', `/v1/adb-proxy/requests/${p.requestId}/approve`)}>Approve</button>{' '}
            <button className="btn btn-sm btn-danger" onClick={() => void call('POST', `/v1/adb-proxy/requests/${p.requestId}/deny`)}>Deny</button>
          </>
        )}
      </td>
    </tr>
  );

  const renderApproved = (k: KeyView) => (
    <tr key={k.id}>
      <td>{machine(k.comment)}</td>
      <td><code>{k.fingerprint}</code></td>
      <td>{ago(k.lastSeenAt)}{k.lastSeenIp ? ` from ${k.lastSeenIp}` : ''}</td>
      <td>
        {canManage && <button className="btn btn-sm btn-danger" onClick={() => void call('POST', `/v1/adb-proxy/keys/${k.id}/revoke`)}>Revoke</button>}
      </td>
    </tr>
  );

  const renderBlocked = (k: KeyView) => (
    <tr key={k.id}>
      <td>{machine(k.comment)}</td>
      <td><code>{k.fingerprint}</code></td>
      <td><span className="badge badge-error">{k.status === 'denied' ? 'Denied' : 'Revoked'}</span></td>
      <td>
        {canManage && <button className="btn btn-sm" onClick={() => void call('DELETE', `/v1/adb-proxy/keys/${k.id}`)}>Forget</button>}
      </td>
    </tr>
  );

  const renderDevice = (d: DeviceStatusView) => {
    const label = d.name ?? d.deviceId;
    const draft = portDrafts[d.deviceId] ?? (d.port === null ? '' : String(d.port));
    const command = d.port === null ? null : `adb connect ${status?.advertisedHost}:${d.port}`;
    const badge = STATE_BADGES[d.state];
    return (
      <tr key={d.deviceId} data-testid={`adb-proxy-device-${d.deviceId}`}>
        <td>{label}{d.name ? <div className="form-hint">{d.deviceId}</div> : null}</td>
        <td>
          <input
            className="form-input"
            type="number"
            style={{ width: 90 }}
            aria-label={`Port for ${label}`}
            value={draft}
            disabled={!canManage}
            onChange={(e) => setPortDrafts({ ...portDrafts, [d.deviceId]: e.target.value })}
          />
          {canManage && draft !== (d.port === null ? '' : String(d.port)) && (
            <button
              className="btn btn-sm"
              onClick={() => void call('PATCH', `/v1/adb-proxy/devices/${encodeURIComponent(d.deviceId)}`, { port: Number(draft) })}
            >
              Save port
            </button>
          )}
        </td>
        <td><span className={badge.className}>{badge.label}</span></td>
        <td>
          <input
            type="checkbox"
            aria-label={`Proxy ${label}`}
            checked={d.enabled}
            disabled={!canManage}
            onChange={(e) => void call('PATCH', `/v1/adb-proxy/devices/${encodeURIComponent(d.deviceId)}`, { enabled: e.target.checked })}
          />
        </td>
        <td>
          {command && (
            <>
              <code>{command}</code>{' '}
              <button className="btn btn-sm" onClick={() => void navigator.clipboard?.writeText(command)}>Copy</button>
            </>
          )}
        </td>
      </tr>
    );
  };

  return (
    <div data-testid="adb-proxy-page">
      <header className="settings-page-header">
        <h1>ADB Proxy</h1>
      </header>
      <p className="form-hint">
        Let other machines use <code>adb</code> with the devices attached to this server. A machine can only connect after you approve
        it here. Traffic is not encrypted, so on an untrusted network put the port range behind a VPN or WireGuard.
      </p>

      {loadError && <div className="status-strip status-strip-error" role="alert">{loadError}</div>}
      {actionError && <div className="status-strip status-strip-error" role="alert">{actionError}</div>}
      {!status && !loadError && <p>Loading…</p>}

      {status && (
        <>
          <div className="mcp-toggle-card">
            <div className="mcp-toggle-info">
              <h3>ADB proxy</h3>
              <p>Nothing listens until you turn this on.</p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className={status.enabled ? 'mcp-status mcp-status-active' : 'mcp-status mcp-status-disabled'}>
                {status.enabled ? 'Enabled' : 'Disabled'}
              </span>
              {canManage && (
                <button
                  className="btn btn-sm"
                  data-testid="adb-proxy-toggle"
                  onClick={() => void call('PUT', '/v1/adb-proxy/settings', { enabled: !status.enabled })}
                >
                  {status.enabled ? 'Disable' : 'Enable'}
                </button>
              )}
            </div>
          </div>

          {net && (
            <div className="card" style={{ marginBottom: 24 }}>
              <h3>Network</h3>
              <div className="form-group">
                <label htmlFor="adb-proxy-bind">Bind address</label>
                <input id="adb-proxy-bind" className="form-input" value={net.bindHost} disabled={!canManage}
                  onChange={(e) => setNet({ ...net, bindHost: e.target.value })} />
                <div className="form-hint">0.0.0.0 listens on every interface.</div>
              </div>
              <div className="form-group" style={{ display: 'flex', gap: 12 }}>
                <div>
                  <label htmlFor="adb-proxy-first">First port</label>
                  <input id="adb-proxy-first" className="form-input" type="number" value={net.portStart} disabled={!canManage}
                    onChange={(e) => setNet({ ...net, portStart: e.target.value })} />
                </div>
                <div>
                  <label htmlFor="adb-proxy-last">Last port</label>
                  <input id="adb-proxy-last" className="form-input" type="number" value={net.portEnd} disabled={!canManage}
                    onChange={(e) => setNet({ ...net, portEnd: e.target.value })} />
                </div>
              </div>
              {canManage && <button className="btn btn-primary" disabled={!netDirty} onClick={saveNetwork}>Save</button>}
              <div className="form-hint">Open this port range on the host firewall. A new range only applies to devices that get a port afterwards.</div>
            </div>
          )}

          <h3>Waiting for approval ({status.pending.length})</h3>
          <div className="table-card" data-testid="adb-proxy-pending">
            {status.pending.length === 0 ? (
              <div className="empty-state"><div className="empty-message">No machines are waiting for approval.</div></div>
            ) : (
              <table className="data-table">
                <thead><tr><th>Machine</th><th>Key fingerprint</th><th>From</th><th>Device</th><th>Waiting</th><th /></tr></thead>
                <tbody>{status.pending.map(renderPending)}</tbody>
              </table>
            )}
          </div>
          <p className="form-hint">
            Compare the fingerprint with the one shown by <code>adb</code> on the other machine before approving. The machine
            runs <code>adb connect host:port</code>; until you approve it, its <code>adb devices</code> shows <code>unauthorized</code>.
          </p>

          <h3>Approved machines</h3>
          <div className="table-card" data-testid="adb-proxy-approved">
            {approved.length === 0 ? (
              <div className="empty-state"><div className="empty-message">No machines have been approved yet.</div></div>
            ) : (
              <table className="data-table">
                <thead><tr><th>Machine</th><th>Key fingerprint</th><th>Last seen</th><th /></tr></thead>
                <tbody>{approved.map(renderApproved)}</tbody>
              </table>
            )}
          </div>
          {blocked.length > 0 && (
            <details data-testid="adb-proxy-blocked" style={{ marginTop: 12 }}>
              <summary>Denied and revoked ({blocked.length})</summary>
              <div className="table-card">
                <table className="data-table">
                  <thead><tr><th>Machine</th><th>Key fingerprint</th><th>State</th><th /></tr></thead>
                  <tbody>{blocked.map(renderBlocked)}</tbody>
                </table>
              </div>
            </details>
          )}

          <h3>Devices</h3>
          <div className="table-card">
            {status.devices.length === 0 ? (
              <div className="empty-state"><div className="empty-message">No Android devices are attached.</div></div>
            ) : (
              <table className="data-table">
                <thead><tr><th>Device</th><th>Port</th><th>Status</th><th>Proxy</th><th>Connect command</th></tr></thead>
                <tbody>{status.devices.map(renderDevice)}</tbody>
              </table>
            )}
          </div>

          <h3>Live connections</h3>
          <div className="table-card" data-testid="adb-proxy-connections">
            {live.length === 0 ? (
              <div className="empty-state"><div className="empty-message">No machines are connected.</div></div>
            ) : (
              <table className="data-table">
                <thead><tr><th>Machine</th><th>From</th><th>Device</th><th>Connected for</th><th>Streams</th></tr></thead>
                <tbody>
                  {live.map((c) => (
                    <tr key={c.id}>
                      <td>{machine(c.comment)}</td>
                      <td>{c.peerIp}</td>
                      <td>{deviceName(c.deviceId)}</td>
                      <td>{duration(c.since)}</td>
                      <td>{c.streams}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Run the page test and fix mismatches against the existing components**

Run: `npm run test:frontend -- frontend/pages/settings/AdbProxyPage.test.tsx frontend/hooks/useAdbProxyStatus.test.tsx`
Expected: PASS, 15 page tests and 3 hook tests. If `useAuthOptional` returns a different shape than `{ hasScope }`, align the test's fake `auth` with `frontend/pages/McpSettings.tsx` usage, not the page.

- [ ] **Step 7: Write the failing sidebar test**

Create `frontend/components/settings/__tests__/SettingsSidebar.adb-proxy.test.tsx`:

```tsx
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext, WebSocketContext, type WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import { SettingsSidebar } from '../SettingsSidebar';

afterEach(cleanup);

function renderSidebar(scopes: string[], pending: number) {
  const ws: WebSocketContextValue = {
    connected: true, serverReady: true, startupMessage: '', sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockResolvedValue({ type: 'restapi', id: '1', status: 200, body: { success: true, data: { pending: new Array(pending).fill({}) } } }),
    subscribe: vi.fn(() => () => {}),
    subscribeBinary: vi.fn(() => () => {}),
  };
  render(
    <MemoryRouter initialEntries={['/ui/settings/notifications']}>
      <AuthContext.Provider value={{ hasScope: (s: string) => scopes.includes(s) } as any}>
        <WebSocketContext.Provider value={ws}>
          <SettingsSidebar />
        </WebSocketContext.Provider>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
  return ws;
}

describe('SettingsSidebar ADB Proxy entry', () => {
  it('links to the ADB Proxy page', () => {
    renderSidebar([], 0);
    expect(screen.getByRole('link', { name: /ADB Proxy/ })).toHaveAttribute('href', '/ui/settings/adb-proxy');
  });

  it('shows the pending request count for users who can read the proxy', async () => {
    renderSidebar(['core.adb-proxy:read'], 2);
    expect(await screen.findByTestId('adb-proxy-pending-badge')).toHaveTextContent('2');
  });

  it('shows no badge at zero pending requests', async () => {
    const ws = renderSidebar(['core.adb-proxy:read'], 0);
    await waitFor(() => expect(ws.sendRestApi).toHaveBeenCalled());
    expect(screen.queryByTestId('adb-proxy-pending-badge')).toBeNull();
  });

  it('does not contact the proxy API for users without the read scope', () => {
    const ws = renderSidebar([], 3);
    expect(ws.sendRestApi).not.toHaveBeenCalled();
    expect(screen.queryByTestId('adb-proxy-pending-badge')).toBeNull();
  });
});
```

Run: `npm run test:frontend -- frontend/components/settings/__tests__/SettingsSidebar.adb-proxy.test.tsx`
Expected: FAIL (no ADB Proxy link yet).

- [ ] **Step 8: Implement the badge, sidebar entry and route**

Create `frontend/components/settings/AdbProxyPendingBadge.tsx`:

```tsx
import React from 'react';
import { useAdbProxyStatus } from '../../hooks/useAdbProxyStatus';

/** Number of machines waiting for approval; renders nothing when there are none. */
export function AdbProxyPendingBadge() {
  const { status } = useAdbProxyStatus();
  const count = status?.pending.length ?? 0;
  if (count === 0) return null;
  return (
    <span className="badge badge-warning badge-sm" data-testid="adb-proxy-pending-badge" style={{ marginLeft: 6 }}>
      {count}
    </span>
  );
}
```

In `frontend/components/settings/SettingsSidebar.tsx`:

(a) Import the badge: `import { AdbProxyPendingBadge } from './AdbProxyPendingBadge';`

(b) Extend `SidebarItem` with `badge?: React.ReactNode;`.

(c) Add the item to `ADVANCED` directly after `Proxies`:

```ts
  { label: 'ADB Proxy', path: '/ui/settings/adb-proxy' },
```

(d) In `Group`, render the badge after the label:

```tsx
          {item.label}
          {item.badge}
```

(e) Inside `SettingsSidebar`, before the `return`, derive the advanced items and use them:

```tsx
  const canSeeAdbProxy = auth?.hasScope?.('core.adb-proxy:read') ?? false;
  const advancedItems = ADVANCED.map((item) =>
    item.path === '/ui/settings/adb-proxy' && canSeeAdbProxy ? { ...item, badge: <AdbProxyPendingBadge /> } : item,
  );
```

and change `<Group label="Advanced" items={ADVANCED} />` to `<Group label="Advanced" items={advancedItems} />`.

In `frontend/App.tsx`: add `import { AdbProxyPage } from './pages/settings/AdbProxyPage';` next to the other settings page imports, and inside the `settings` route group, after `<Route path="mcp" element={<McpSettings />} />` add:

```tsx
              <Route path="adb-proxy" element={<AdbProxyPage />} />
```

- [ ] **Step 9: Run the frontend tests**

Run: `npm run test:frontend -- frontend/components/settings frontend/pages/settings frontend/hooks --maxWorkers=2`
Expected: PASS, including the existing `SettingsSidebar.test.tsx` (those render without a WebSocket provider and without the read scope, so the badge component never mounts).

- [ ] **Step 10: Type-check the new frontend files (the build does not)**

Create `/tmp/tsconfig.adb-proxy-check.json` outside the repo? It must live in the repo root to resolve paths, so create `tsconfig.adb-proxy-check.json` there and delete it afterwards (do not commit it):

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "declaration": false,
    "declarationMap": false,
    "sourceMap": false
  },
  "include": [
    "frontend/pages/settings/AdbProxyPage.tsx",
    "frontend/hooks/useAdbProxyStatus.ts",
    "frontend/components/settings/AdbProxyPendingBadge.tsx",
    "shared/types/adb-proxy.ts"
  ],
  "exclude": []
}
```

Run: `npx tsc -p tsconfig.adb-proxy-check.json`
Expected: no errors in the four files. Errors reported in other files that these import (for example SDK internals) are not yours to fix. Then `rm tsconfig.adb-proxy-check.json`.

- [ ] **Step 11: Commit**

```bash
git add frontend/hooks/useAdbProxyStatus.ts frontend/hooks/useAdbProxyStatus.test.tsx frontend/components/settings/AdbProxyPendingBadge.tsx frontend/components/settings/SettingsSidebar.tsx frontend/components/settings/__tests__/SettingsSidebar.adb-proxy.test.tsx frontend/pages/settings/AdbProxyPage.tsx frontend/pages/settings/AdbProxyPage.test.tsx frontend/App.tsx
git commit -m "feat(adb-proxy): add the ADB Proxy settings page with live approvals

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Playwright end-to-end flow

The backend needs an online device, so this spec runs under its own config. A fake ADB server (the one the gate tests use) plays the host's ADB server; the real backend finds the device through the real `adb` CLI, because the config sets `ANDROID_ADB_SERVER_PORT` to the fake. The spec reuses the default e2e ports and helpers, so run it on its own, never alongside the default e2e run.

**Files:**
- Create: `tests/e2e-adb-proxy/fake-adb-main.ts`
- Create: `playwright.adb-proxy.config.ts`
- Test: `tests/e2e-adb-proxy/adb-proxy.spec.ts`
- Modify: `package.json` (script `test:e2e:adb-proxy`)

**Interfaces:**
- Consumes: Tasks 13 and 15 (API, page, test ids `adb-proxy-toggle`, `adb-proxy-device-<serial>`, `adb-proxy-request`, `adb-proxy-approved`, `adb-proxy-blocked`, `adb-proxy-connections`, `adb-proxy-pending-badge`); `WireClient`, `makeTestAdbKey`, `FakeAdbServer`; `loginAsAdmin`, `waitForBackend` from `tests/e2e/helpers/auth`.
- Produces: `npm run test:e2e:adb-proxy`.

- [ ] **Step 1: Write the spec**

Create `tests/e2e-adb-proxy/adb-proxy.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { loginAsAdmin, waitForBackend } from '../e2e/helpers/auth';
import { fingerprintOf } from '../../backend/services/adb-proxy/adb-key';
import { A_CNXN } from '../../backend/services/adb-proxy/packet';
import { makeTestAdbKey } from '../../backend/services/adb-proxy/testing/test-keys';
import { WireClient } from '../../backend/services/adb-proxy/testing/wire-client';

const SERIAL = 'FAKE-E2E-1';
const PORT = 16500;
const LAST_PORT = 16509;
const runner = makeTestAdbKey('e2e@runner');

test.describe.configure({ mode: 'serial' });

test.describe('ADB proxy', () => {
  test.beforeAll(async ({ request }) => {
    await waitForBackend(request);
  });

  test('an admin turns the proxy on and the attached device gets a port', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/settings/adb-proxy');
    await expect(page.getByRole('heading', { name: 'ADB Proxy' })).toBeVisible();
    const row = page.getByTestId(`adb-proxy-device-${SERIAL}`);
    await expect(row).toBeVisible({ timeout: 60_000 });

    await page.getByLabel('Bind address').fill('127.0.0.1');
    await page.getByLabel('First port').fill(String(PORT));
    await page.getByLabel('Last port').fill(String(LAST_PORT));
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByTestId('adb-proxy-toggle').click();

    await expect(page.getByText('Enabled', { exact: true })).toBeVisible();
    await expect(row.getByText('Listening')).toBeVisible();
    await expect(row).toContainText(`adb connect`);
    await expect(row).toContainText(`:${PORT}`);
  });

  test('a new machine shows up live and works after an admin approves it', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/settings/adb-proxy');
    await expect(page.getByTestId('adb-proxy-pending')).toContainText('No machines are waiting for approval.');

    const waiting = await WireClient.connect(PORT);
    await waiting.offerKey(runner);

    const request = page.getByTestId('adb-proxy-request');
    await expect(request).toContainText('e2e@runner');
    await expect(request).toContainText(fingerprintOf(runner.blob));
    await expect(page.getByTestId('adb-proxy-pending-badge')).toHaveText('1');

    await request.getByRole('button', { name: 'Approve' }).click();
    expect((await waiting.next()).command).toBe(A_CNXN);
    await expect(request).toHaveCount(0);
    await expect(page.getByTestId('adb-proxy-approved')).toContainText('e2e@runner');
    waiting.close();

    const session = await WireClient.connect(PORT);
    expect((await session.authenticate(runner)).command).toBe(A_CNXN);
    const { localId } = await session.open('shell:echo e2e', 1);
    expect((await session.collectStream(1, localId, 'close')).toString()).toContain('ran: echo e2e');
    await expect(page.getByTestId('adb-proxy-connections')).toContainText('e2e@runner');
    session.close();
  });

  test('revoking drops a live session, blocks the key, and forgetting lets it ask again', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/settings/adb-proxy');
    const live = await WireClient.connect(PORT);
    expect((await live.authenticate(runner)).command).toBe(A_CNXN);

    await page.getByTestId('adb-proxy-approved').getByRole('button', { name: 'Revoke' }).click();
    expect(await live.waitClosed(5000)).toBe(true);
    await expect(page.getByTestId('adb-proxy-approved')).toContainText('No machines have been approved yet.');

    await page.getByText(/Denied and revoked \(1\)/).click();
    const blocked = page.getByTestId('adb-proxy-blocked');
    await expect(blocked).toContainText('e2e@runner');

    const refused = await WireClient.connect(PORT);
    await refused.offerKey(runner);
    expect(await refused.waitClosed(5000)).toBe(true);

    await blocked.getByRole('button', { name: 'Forget' }).click();
    const retry = await WireClient.connect(PORT);
    await retry.offerKey(runner);
    await expect(page.getByTestId('adb-proxy-request')).toContainText('e2e@runner');
    retry.close();
    await expect(page.getByTestId('adb-proxy-request')).toHaveCount(0);
  });

  test('an admin can deny a request', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/settings/adb-proxy');
    const stranger = makeTestAdbKey('stranger@box');
    const waiting = await WireClient.connect(PORT);
    await waiting.offerKey(stranger);
    await page.getByTestId('adb-proxy-request').getByRole('button', { name: 'Deny' }).click();
    expect(await waiting.waitClosed(5000)).toBe(true);
    await page.getByText(/Denied and revoked \(1\)/).click();
    await expect(page.getByTestId('adb-proxy-blocked')).toContainText('stranger@box');
  });

  test('turning the proxy off closes the port', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/settings/adb-proxy');
    await page.getByTestId('adb-proxy-toggle').click();
    await expect(page.getByText('Disabled', { exact: true }).first()).toBeVisible();
    await expect(WireClient.connect(PORT)).rejects.toBeTruthy();
  });
});
```

- [ ] **Step 2: Write the harness**

Create `tests/e2e-adb-proxy/fake-adb-main.ts`:

```ts
import { FakeAdbServer } from '../../backend/services/adb-proxy/testing/fake-adb-server';

const port = Number(process.env.FAKE_ADB_PORT || 15299);
const fake = new FakeAdbServer([{ serial: 'FAKE-E2E-1', features: 'cmd' }], {
  shell: (_serial, command) => (command.startsWith('getprop') ? 'e2eprod\nE2EModel\ne2edev\n' : `ran: ${command}\n`),
});

fake.start(port).then(
  () => console.log(`fake adb server listening on ${port}`),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    fake.stop().finally(() => process.exit(0));
  });
}
```

Create `playwright.adb-proxy.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test';
import path from 'path';

// End-to-end config for the ADB proxy. It reuses the default e2e ports and helpers, so never run it
// at the same time as playwright.config.ts. A fake ADB server stands in for the host's ADB server:
// the backend finds its device through the real `adb` CLI because ANDROID_ADB_SERVER_PORT points at it.
const TEST_DB = path.join('/tmp', `darkride-e2e-adb-proxy-${process.pid}.db`);
const FAKE_ADB_PORT = '15299';

export default defineConfig({
  testDir: '.',
  testMatch: ['tests/e2e-adb-proxy/**/*.spec.ts'],
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  timeout: 90_000,
  use: {
    baseURL: 'http://localhost:5199',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npx tsx tests/e2e-adb-proxy/fake-adb-main.ts',
      port: Number(FAKE_ADB_PORT),
      timeout: 60_000,
      reuseExistingServer: false,
      env: { FAKE_ADB_PORT },
    },
    {
      command: 'npx concurrently "tsx watch backend/index.ts" "npx vite --port 5199"',
      url: 'http://localhost:5199/ui/',
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        DATABASE_PATH: TEST_DB,
        DARKRIDE_BOOTSTRAP_ADMIN_USERNAME: 'e2e-admin',
        DARKRIDE_BOOTSTRAP_ADMIN_PASSWORD: 'e2e-test-password-123',
        PORT: '3199',
        WEBSOCKET_ALLOWED_ORIGINS: 'http://localhost:5199',
        ANDROID_ADB_SERVER_PORT: FAKE_ADB_PORT,
      },
    },
  ],
});
```

In `package.json` scripts, after `test:adb-proxy-conformance`, add:

```json
    "test:e2e:adb-proxy": "playwright test --config playwright.adb-proxy.config.ts",
```

- [ ] **Step 3: Check the harness against the real `adb` CLI before running Playwright**

```bash
npx tsx tests/e2e-adb-proxy/fake-adb-main.ts &
sleep 3
ANDROID_ADB_SERVER_PORT=15299 adb devices
kill %1
```

Expected: the second command prints `FAKE-E2E-1	device`. This is the same call the backend's device provider makes. If the real `adb` rejects the fake (version mismatch, or it tries to restart the server), fix the fake in `fake-adb-server.ts` (the `host:version` reply must equal the client's server version, 41 for the 1.0.41 clients) and add a test for the change to `fake-adb-server.test.ts` before continuing.

- [ ] **Step 4: Run the end-to-end spec**

Run: `npm run test:e2e:adb-proxy -- --retries=2`
Expected: PASS, 5 tests. The first run on a fresh temp DB can time out on "Finalising installation..."; the retries cover that known warm-up (see the repo notes on e2e first runs). If the device row never appears in the first test, hit `http://localhost:3199/v1/device/list` with the admin session to see whether the backend found `FAKE-E2E-1`; the cause is then the fake server or `ANDROID_ADB_SERVER_PORT`, not the page.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e-adb-proxy playwright.adb-proxy.config.ts package.json
git commit -m "test(adb-proxy): add a Playwright flow for approve, deny, revoke and forget

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Documentation and closing verification

**Files:**
- Create: `docs/adb-proxy.md`
- Modify: `docs/ARCHITECTURE.md` (new section after "Device Management")
- Modify: `CHANGELOG.md` (entry under `[Unreleased]` / `Added`)
- Modify: `docs/specs/2026-10-11-adb-proxy-design.md` (status line)

**Interfaces:**
- Consumes: the finished feature.
- Produces: user docs, an architecture section, a changelog entry, and the pull request.

- [ ] **Step 1: Write the user guide**

Create `docs/adb-proxy.md`:

````markdown
# ADB proxy

The ADB proxy lets other machines on your network run `adb` against the Android devices attached to the DarkRide host, with no cable and nothing to install on those machines. Each machine has to be approved in DarkRide before it can reach a device, the same way Android asks you to allow USB debugging.

It is **off by default**. Nothing listens until you turn it on.

## Set it up

1. Open **Settings → ADB Proxy** and switch the proxy on.
2. Check the **bind address** and **port range**. The default range is 6500 to 6599; each attached device gets one fixed port from it and keeps that port across restarts and reconnects.
3. Open that port range on the host's firewall.
4. On the other machine, connect to a device using the command shown in the Devices table:

   ```bash
   adb connect 192.168.1.10:6500
   adb devices        # shows "unauthorized" until you approve the machine
   ```

5. In DarkRide the machine appears under **Waiting for approval** straight away, with its name, source address and key fingerprint. Compare the fingerprint with the one on the other machine, then press **Approve**.
6. The other machine's `adb devices` changes to `device`. From then on it uses the device like any attached one: `adb shell`, `adb push`, `adb pull`, `adb forward`, `adb logcat`.

A machine is identified by its adb key (`~/.android/adbkey`). Approving a key lets that machine reach every proxied device. Approval survives restarts; revoke it at any time.

## Managing machines

- **Revoke** an approved machine: its live sessions close at once and it is refused from then on. It appears under *Denied and revoked*.
- **Forget** a denied or revoked machine to let it ask again.
- **Deny** a waiting request to close it and ignore that key until you forget it.
- Waiting requests are held for 5 minutes. They live in memory only, so a restart clears them; the other machine simply asks again.
- Each device row lets you change its port, or switch proxying off for that device.

Viewing needs the scope `core.adb-proxy:read`; approving, revoking and changing settings needs `core.adb-proxy:manage`.

## What is not supported

- **Encryption.** The ADB protocol is plain text once a machine is approved. On a network you do not trust, put the port range behind a VPN or WireGuard.
- **`adb -H host -P port`.** That form of the protocol has no authentication step, so it is not offered. Use `adb connect`.
- **`adb reverse`, `adb tcpip` and `adb usb`**, and anything addressed to the host's own ADB server (`host:` services). These are refused.
- **`adb pair` and wireless debugging pairing.**
- iOS devices.

## Limits

- At most 8 unauthenticated connections per source address and 64 in total; a connection that has not finished the handshake after 10 seconds is dropped.
- At most 20 waiting requests, and 3 new ones per source address per minute. Extra requests are dropped and counted.
- At most 128 open streams per connection.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `adb devices` stays `unauthorized` | The machine is waiting for approval. Open Settings → ADB Proxy. If nothing is listed, the request timed out after 5 minutes: run `adb connect` again. |
| `adb connect` says connection refused | The proxy is off, the device is disabled, or the firewall blocks the port. |
| The device shows **Port in use** | Another program holds that port. Pick a different port in the Devices table. |
| The device shows **No free port** | The port range is full. Widen it in the Network card. |
| The device shows **Device offline** | The phone is unplugged or unauthorised on the host. Its port stays reserved and works again when it returns. |
| A machine that was approved keeps being refused on one device | Its key has a device allow-list that excludes that device (set through the API). |

## For developers

Design: `docs/specs/2026-10-11-adb-proxy-design.md`. Code: `backend/services/adb-proxy/`. API (all under `/v1/adb-proxy`): `GET /status`, `PUT /settings`, `PATCH /devices/:id`, `GET /keys`, `POST /requests/:requestId/approve`, `POST /requests/:requestId/deny`, `POST /keys/:id/revoke`, `PATCH /keys/:id`, `DELETE /keys/:id`. Live updates arrive on the `adb-proxy` WebSocket channel, which needs `core.adb-proxy:read`.

Tests:

- `npx vitest run backend/services/adb-proxy backend/api/adb-proxy.test.ts` runs the unit tests.
- `ADB_BINS=adb,/path/to/other/adb npm run test:adb-proxy-conformance` drives real `adb` clients at the proxy.
- `npm run test:e2e:adb-proxy` runs the browser flow (do not run it beside the default e2e suite).
````

- [ ] **Step 2: Add the architecture section and the changelog entry**

In `docs/ARCHITECTURE.md`, directly after the "Setup Flow" subsection of "Device Management" (before "## Python Bridge"), add:

```markdown
## ADB Proxy

`AdbProxyService` (`backend/services/adb-proxy/`) lets other machines run `adb connect` against devices attached to this host. It is off by default.

- **One port per device.** Each online Android device gets a persistent TCP port from a configurable range. The port speaks the ADB wire protocol as a device would.
- **Authentication.** A client proves possession of its adb key. Unknown keys become in-memory pending requests, shown live in Settings → ADB Proxy and held for up to 5 minutes; an admin with `core.adb-proxy:manage` approves or denies them. Approved and denied keys are stored in `adb_proxy_keys`; ports in `adb_proxy_devices`.
- **Forwarding.** Each client stream becomes a fresh connection to the host's ADB server (`host:transport:<serial>` plus the service string). Services starting with `host`, and `reverse:`, `tcpip:` and `usb:`, are refused.
- **Live updates** go to subscribed clients holding `core.adb-proxy:read` on the `adb-proxy` WebSocket channel.

User guide: [`adb-proxy.md`](adb-proxy.md). Design: [`specs/2026-10-11-adb-proxy-design.md`](specs/2026-10-11-adb-proxy-design.md).
```

In `CHANGELOG.md`, under `## [Unreleased]` / `### Added`, add as the first bullet:

```markdown
- **ADB proxy.** Other machines can run `adb connect <host>:<port>` against Android devices attached to the DarkRide host, with no cable and nothing to install. Each machine's adb key must be approved in Settings → ADB Proxy first, and approvals can be revoked at any time. Off by default; the traffic is not encrypted, so use a VPN on untrusted networks. Needs a backend restart for the new migration and the port range opened on the host firewall. See `docs/adb-proxy.md`.
```

In `docs/specs/2026-10-11-adb-proxy-design.md`, change the Status line to start `Status: **Implemented** on branch worktree-adb-proxy (plan: docs/specs/2026-10-11-adb-proxy-plan.md).` and keep the rest of the sentence.

- [ ] **Step 3: Run the full verification**

Run each, one at a time, and keep the output:

```bash
npm run typecheck
npx vitest run --maxWorkers=2
npm run test:frontend -- --maxWorkers=2
npm run lint
ADB_BINS=adb,$ADB_ALT npm run test:adb-proxy-conformance
npm run test:e2e:adb-proxy -- --retries=2
```

Expected:
- typecheck: exits 0.
- backend vitest: all pass. The only acceptable failure is `backend/services/__tests__/file-serving-live.test.ts`, which hits a real server on port 3000 when one is running and answers 401; it is unrelated.
- frontend vitest: all pass.
- lint: no errors in the new files.
- conformance: 8 tests per client pass.
- e2e: 5 pass.

Then confirm the default e2e suite is unaffected by the new settings entry: `npx playwright test tests/e2e/settings.spec.ts tests/e2e/navigation.spec.ts` (Expected: same result as on `main`).

- [ ] **Step 4: Scan the diff for things that must not be there**

```bash
git diff origin/main...HEAD > /tmp/adb-proxy.diff
grep -nP '^\+.*\x{2014}' /tmp/adb-proxy.diff || echo "no em dashes added"
grep -inE "claude\.ai/code|session_" /tmp/adb-proxy.diff || echo "no session links"
grep -nE "BEGIN [A-Z ]*PRIVATE KEY" /tmp/adb-proxy.diff || echo "no private key material"
rm /tmp/adb-proxy.diff
```

Expected output: the three `no ...` lines. Fix anything that prints a match in a new commit, then re-run.

- [ ] **Step 5: Commit the docs and push**

```bash
git add docs/adb-proxy.md docs/ARCHITECTURE.md CHANGELOG.md docs/specs/2026-10-11-adb-proxy-design.md
git commit -m "docs(adb-proxy): add the user guide, architecture section and changelog entry

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
git push origin worktree-adb-proxy
```

- [ ] **Step 6: Open the pull request**

The repo is public, so the body must not contain session links, private tracker references or operational detail.

```bash
gh pr create --repo DarkRideApp/DarkRide --base main --head worktree-adb-proxy \
  --title "feat: ADB proxy with per-machine key approval" \
  --body "$(cat <<'EOF'
## Summary

Other machines can run `adb connect <host>:<port>` against Android devices attached to the DarkRide host. Each machine's adb key must be approved in Settings → ADB Proxy before it can reach a device. Off by default.

- One persistent TCP port per device; the port speaks the ADB wire protocol and forwards each stream to the host's ADB server.
- Unknown keys become in-memory pending requests, shown live and held for 5 minutes.
- Approve, deny, revoke and forget from the UI; scopes `core.adb-proxy:read` and `core.adb-proxy:manage`.
- Refuses `host…`, `reverse:`, `tcpip:` and `usb:` services.
- Design: `docs/specs/2026-10-11-adb-proxy-design.md`. User guide: `docs/adb-proxy.md`.

## Deploy notes

- Backend restart needed (migration `0102_adb_proxy`). If the AI pipelines branch merges first, renumber this migration and set its journal `when` above every existing entry.
- Open the chosen port range on the host firewall.
- The ADB traffic is not encrypted; use a VPN or WireGuard on untrusted networks.

## Test plan

- [x] `npm run typecheck`, backend and frontend vitest, lint
- [x] `npm run test:adb-proxy-conformance` against two real `adb` clients
- [x] `npm run test:e2e:adb-proxy`
- [ ] Live check with a physical device: `ADB_PROXY_LIVE_SERIAL=<serial> npm run test:adb-proxy-conformance`, and compare the key fingerprint with the one Android shows

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: prints the PR URL. Do not tick the live-device box unless it was run.

- [ ] **Step 7: Report**

Report one of DONE, DONE_WITH_CONCERNS, BLOCKED or NEEDS_CONTEXT per the repo completion protocol, with the output from Step 3 as evidence. State plainly that the live-device check and the fingerprint comparison against a real phone's dialog are still open unless they were run, and list what needs restarting: the backend (migration), plus the firewall change.

