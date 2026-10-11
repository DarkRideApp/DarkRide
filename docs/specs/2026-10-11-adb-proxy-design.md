# ADB proxy: design

Date: 2026-10-11
Status: **Draft for review.** Approach, auth model, hosting and grant scope were decided with Cube in the design discussion; the open points at the end are small calls for the reviewer.

## The problem

Devices attached to a DarkRide host can only be driven by `adb` on that host. A second machine (a build box, a colleague's laptop, a CI runner) cannot run `adb shell`, `adb install` or `adb logcat` against them without being physically attached or sharing a login on the host.

The obvious fix, exposing the host's ADB server or each phone's own `adbd` on the network, has no gate. The ADB host protocol (`adb -H host -P port`) has no authentication step at all, so anyone who can reach the port controls the device. Forwarding to the phone's `adbd` moves the gate onto the phone, where every new client needs a tap on the screen and nothing can be approved or revoked centrally.

## Goal and measurable outcome

A remote machine runs plain `adb connect <host>:<port>` and then uses the device with stock `adb`, with nothing installed on the client. DarkRide stays the only machine that holds USB-debugging trust with the phone.

Outcomes the tests assert:

1. A client whose key has not been approved reaches **zero** device services. Its `adb devices` shows `unauthorized`.
2. After one approval in the DarkRide UI, the same client moves from `unauthorized` to `device` with no tap on the phone and no reconnect by the user.
3. Revoking a key closes that machine's live sessions immediately and a reconnect is refused.

## Non-goals

- **Encryption in transit.** The ADB wire protocol is plaintext after auth. On an untrusted network, put the port range behind WireGuard or a VPN. The docs say so plainly.
- **`adb -H host -P port` (host protocol).** It has no auth hook, so it is not offered.
- **`adb reverse`**, `tcpip:` and `usb:` (see Services policy).
- **TLS pairing** (`adb pair`, the STLS upgrade). The proxy speaks classic RSA-key AUTH only.
- **iOS devices.** Android only.
- **A separate audit table, mDNS advertising, multi-host federation, a per-key device editor in the UI.** The device allow-list column exists and is enforced; only the UI control is deferred.
- **Making remote ADB activity count as "busy" in `DeviceManager`.** Remote sessions are shown in the UI; they do not block automations or capture.

## Decisions made in discussion

| Decision | Chosen | Why |
|---|---|---|
| Client auth | `adb connect` wire protocol with client-key approval | The only stock-`adb` flow with a real auth step. Same trust model as Android's "Allow USB debugging". |
| Grant scope | Approving a key unlocks every proxied device; the key record has an optional device allow-list (null = all) | Fewest clicks now; restricting later needs no migration. |
| Hosting | In-process service in the backend | Reuses DB, hooks and auth; no extra process to package or supervise on Linux and Windows. |
| Pending requests | In memory only | Unauthenticated network clients must not be able to write to the DB. |
| Pending timeout | 5 minutes | Long enough to walk to a screen. |

Alternatives rejected: gating the host protocol by source IP (spoofable, NAT collapses identity), a client helper tunnel with an API key (strongest, but every client must install it; revisit if internet exposure becomes a goal), a separate daemon (IPC and packaging cost for isolation we get by hardening the parser), forwarding to the phone's own `adbd` (see problem statement).

## How it works

```
remote adb ──TCP :port──▶ listener (one per device)
                              │ session: handshake, auth, stream mux
                              ▼
                    fresh socket per stream ──▶ local ADB server
                    host:transport:<serial>          │
                    <service>                        ▼
                                                   phone
```

- Each proxied Android device gets its own TCP listener on a persistent port. One wire connection is one transport is one device, so the port is how a client picks a device.
- The proxy acts as a device (`adbd`) towards the client. For each stream the client opens, it makes a fresh connection to the local ADB server, binds it with `host:transport:<serial>`, sends the service string and then pipes bytes both ways.
- Host-level services (`host:kill`, `host:connect`, ...) are unreachable by construction: the proxy only ever sends device services, after the transport is bound.
- The ADB server address is the same one DarkRide's own `adb` calls use (`ANDROID_ADB_SERVER_ADDRESS` and `ANDROID_ADB_SERVER_PORT`, default `127.0.0.1:5037`).
- `devices.id` is the ADB serial for Android devices, so it is the transport name.

## Components

All under `backend/services/adb-proxy/`. Each file has one job and can be tested alone.

| File | Job | Depends on |
|---|---|---|
| `packet.ts` | Wire codec: 24-byte header (six little-endian u32: command, arg0, arg1, data length, data check, magic) encode and decode, plus a stream parser that handles fragmentation and enforces length caps. Pure, no I/O. | nothing |
| `adb-key.ts` | Parse the Android public-key blob, build a Node `KeyObject`, compute the display fingerprint and the identity hash, verify a token signature. | `node:crypto` |
| `host-client.ts` | ADB host-protocol client for the local ADB server: open a bound transport plus service as a socket, fetch the device feature list. Injectable so tests use a fake. | `net` |
| `session.ts` | One per client connection: handshake state machine, stream table, per-stream flow control. | the three above |
| `listener.ts` | One `net.Server` per device: connection limits, live-session registry, TCP keepalive. | `session.ts` |
| `port-allocator.ts` | Persistent port per device from a configurable range. | DB |
| `key-store.ts` | Key records (approved, denied, revoked) and the in-memory pending map. | DB |
| `adb-proxy-service.ts` | Orchestrator: starts and stops listeners from device lifecycle, applies settings changes live, closes sessions on revoke, owns counters and WS events. | `DeviceDirectory`, the above |

`DeviceDirectory` is a narrow interface the service depends on instead of `DeviceManager` internals:

```ts
interface DeviceDirectory {
  listOnlineAndroid(): { id: string; name: string | null }[];
  onOnline(fn: (id: string) => void): void;
  onOffline(fn: (id: string) => void): void;
}
```

A small adapter implements it over `DeviceManager` (its online set, the `device:connected` hook and `onDeviceOffline`). Outside the module: `backend/api/adb-proxy.ts` (REST), a migration, scope entries in `backend/auth/scopes-registry.ts`, and the frontend page.

## Wire protocol behavior

**Packet.** Commands are ASCII little-endian: `CNXN`, `AUTH`, `OPEN`, `OKAY`, `CLSE`, `WRTE`. `magic` must equal `command ^ 0xffffffff`. The data checksum is not verified (modern clients negotiate skipping it).

**Handshake.**

1. Client sends `CNXN` (`host::features=...`). The proxy replies with nothing yet.
2. If the device is not online, the proxy closes the socket. It never sends a banner it cannot back, because a client reads the banner as "this device is usable".
3. Proxy sends `AUTH` type TOKEN with 20 bytes from `crypto.randomBytes`.
4. Client answers `AUTH` type SIGNATURE. The proxy tries each approved key whose allow-list includes this device. A match means `CNXN` back (banner below). No match means a fresh TOKEN, up to 3 attempts.
5. Client then sends `AUTH` type RSAPUBLICKEY (base64 key blob plus `user@host`). The proxy:
   - key is denied or revoked: close, no new request;
   - key is unknown: create or refresh an in-memory pending request and **hold the connection**. The client keeps `unauthorized`, as it does for a phone waiting on its dialog;
   - on approve, send `CNXN` on the held connection; on deny, timeout or disconnect, close.

**Banner.** `device::ro.product.name=<..>;ro.product.model=<..>;ro.product.device=<..>;features=<..>`, NUL-terminated. `features` is the device's real list from the ADB server (`host-serial:<serial>:features`), passed through unchanged. That is safe because every feature is carried inside opaque stream bytes (`shell_v2` framing, sync, `abb`, `sendrecv_v2*`); none changes the wire framing. Advertised version `0x01000001`, max data 1 MiB.

**Streams.**

- `OPEN` (arg0 = client id, payload = service plus NUL): apply the services policy, open the backend socket, send the 4-hex-length-prefixed service, wait for the server's `OKAY`. Success: reply `OKAY`. Failure: reply `CLSE`.
- `WRTE` from client: write to the backend socket and send `OKAY` once the write has drained.
- Backend data: send `WRTE`, then pause that socket until the client's `OKAY`. This is ADB's own flow control; no extra windowing.
- `CLSE` either way tears down that stream and its backend socket.
- Caps: 128 open streams per session; payloads at most the advertised max data.

**Services policy.** Refuse with `CLSE`:

- `reverse:*`, because device-initiated streams would go to the local ADB server, bypassing the proxy and the grant;
- `tcpip:*` and `usb:`, because they flip the phone's `adbd` between USB and network and can strand it where DarkRide cannot reach it.

Everything else passes through, including `root:`, `remount:` and `reboot:`. Approval is full trust in the device, which is what was asked for.

## Security model

- **Off by default.** `adb_proxy.enabled` is false; nothing listens. Then a per-device toggle (default on). Bind address and port range are settings.
- **Identity** is the client's ADB key: `key_id` is SHA-256 over the decoded key blob. The display fingerprint is MD5 over the same bytes as uppercase colon-separated hex, matching what Android's USB-debugging dialog shows so a human can compare.
- **Pre-auth surface** is deliberately tiny: fixed 24-byte headers, a 4 KiB payload cap before auth, at most 8 unauthenticated sockets per IP and 64 total, a 10 second budget from accept to a decided handshake (held pending connections are exempt, see below), no parsing of anything past the header until the magic checks out. Every socket handler is wrapped so an exception closes that socket and never reaches the process.
- **Verification cost.** The SIGNATURE reply names no key, so the proxy tries each approved key. Parsed keys are cached in memory; attempts are capped at 3 per connection; the per-IP connection and pending-rate limits bound the rest.
- **Pending requests:** memory only. At most 20 in total and 3 new per IP per minute; excess is dropped and counted. One entry per (key, device); a repeat attempt replaces the older held connection. Approving a key resolves all of its pending entries across devices at once. A held connection waits up to 5 minutes.
- **Denied and revoked keys** are stored (key id and metadata only) so repeat attempts are closed silently with no new pending entry, until an admin forgets the record.
- **Revoke** closes every live session for that key immediately.
- **Untrusted text.** The key comment (`user@host`) is attacker-controlled: capped at 128 chars, control characters stripped, rendered as text, never as HTML.
- **Who can do what:** `core.adb-proxy:read` (view) and `core.adb-proxy:manage` (approve, deny, revoke, change settings), through the existing scope matcher and API-key/session middleware.
- **Audit:** structured log lines (`createLoggers('adb-proxy')`) for connect, request, approve, deny, revoke, forget and session end, carrying short key id, IP and device. The key row keeps first seen, last seen and last IP. In-memory counters since start (connections, approvals, denials, auth failures, flood drops) are returned by the status endpoint.

## Data model

Migration `0102_adb_proxy` (see Rollout for the numbering note).

`adb_proxy_keys`

| Column | Type | Notes |
|---|---|---|
| `id` | integer PK autoincrement | |
| `key_id` | text unique not null | SHA-256 hex of the key blob |
| `public_key` | text not null | base64 key blob as sent |
| `comment` | text | sanitised, max 128 |
| `status` | text not null | `approved` \| `denied` \| `revoked` |
| `device_ids` | text (JSON array) null | allow-list; null = all devices |
| `first_seen_at`, `last_seen_at` | integer timestamp | |
| `last_seen_ip` | text | |
| `last_device_id` | text | |
| `decided_by` | integer null | `users.id`, `ON DELETE SET NULL` |
| `decided_at` | integer timestamp null | |

`adb_proxy_devices`

| Column | Type | Notes |
|---|---|---|
| `device_id` | text PK | references `devices.id` |
| `port` | integer unique not null | persistent across restarts |
| `enabled` | integer boolean not null default 1 | |
| `created_at` | integer timestamp | |

`forget-device.ts` must delete the `adb_proxy_devices` row explicitly: with foreign keys on, parent deletes must clear non-cascading children first, and the test DB helper's DDL drops `ON DELETE CASCADE`. The new tables need DDL in that helper.

Settings (existing `settings` key/value table): `adb_proxy.enabled` (default `false`), `adb_proxy.bind_host` (default `0.0.0.0`), `adb_proxy.port_start` and `adb_proxy.port_end` (default `6500` to `6599`). Changes apply live: toggling starts or stops listeners; a new range only affects ports allocated afterwards.

## API and events

REST under `/v1/adb-proxy`, also reachable over the WS `restapi` action like the rest of the API.

| Method and path | Scope | Purpose |
|---|---|---|
| `GET /status` | read | enabled, bind, range, per-device state and port, advertised host, live connections, pending requests, counters |
| `PUT /settings` | manage | enabled, bind host, port range (validated) |
| `PATCH /devices/:id` | manage | `enabled`, `port` (rejects ports in use or out of range) |
| `GET /keys` | read | approved, denied and revoked keys |
| `POST /requests/:requestId/approve` | manage | approve the key behind a pending request, resolve all its pending entries |
| `POST /requests/:requestId/deny` | manage | deny and close |
| `POST /keys/:id/revoke` | manage | approved to revoked, close live sessions |
| `PATCH /keys/:id` | manage | set the `device_ids` allow-list |
| `DELETE /keys/:id` | manage | forget the record so the machine can request again |

Live updates use `broadcastToAll` with full small snapshots (`adb-proxy:requests`, `adb-proxy:connections`, `adb-proxy:state`), following the existing message conventions. The advertised host in `/status` comes from the existing LAN-preferring server IP logic, so a VPN interface is never shown.

## UI

A settings page at `settings/adb-proxy` (`frontend/pages/settings/AdbProxyPage.tsx`), with a pending-count badge on its sidebar item. Layout and components follow the nearest existing approve/revoke screens (`CertificatesPage`) rather than a new pattern.

1. **Switch and network:** enable toggle, bind host, port range.
2. **Pending requests** at the top: comment, fingerprint, source IP, device, age, Approve and Deny.
3. **Approved machines:** comment, fingerprint, last seen, last IP, Revoke. Denied and revoked records sit in a collapsed list with Forget.
4. **Devices:** name, serial, editable port, per-device toggle, status (`listening`, `device offline`, `port in use`, `range full`) and a copy button for `adb connect <host>:<port>`.
5. **Live connections:** peer IP, device, key comment, age.

## Failure handling

| Situation | Behavior |
|---|---|
| Device unplugged mid-session | `CLSE` for open streams, close the client socket. Port stays reserved; new connections are closed until the device is back. |
| Client disappears | The session owns its backend sockets and destroys them. TCP keepalive (30 s) reaps half-open peers. |
| Local ADB server down | New streams get `CLSE`; sessions stay; the error is logged once per interval, not per packet. |
| Bad magic, oversize length, unknown pre-auth command | Close with no reply. Post-auth unknown commands are ignored. |
| Port range full, or a persisted port taken by another process | The device shows the error. A port is never silently reassigned, because client scripts depend on it. Change it by hand. |
| Backend restart | Pending entries are dropped; held clients retry and re-request. Approved keys persist. |
| Key revoked while a stream is mid-transfer | Session closed at once; the client sees a reset. |

## Testing

**Gate tests** (vitest, deterministic, no real `adb`, each file under 2 s), next to the code:

- `packet.test.ts`: round trip, byte-at-a-time fragmentation, bad magic, oversize length.
- `adb-key.test.ts`: parse, fingerprint and signature verification against fixtures generated once with the real `adb` tooling; malformed and wrong-size blobs rejected.
- `session.test.ts` against an in-memory fake ADB server: approved key gets `CNXN`; unknown key is held then approved, denied, timed out or dropped; denied key closed with no new pending entry; revoke closes live streams; flood caps; services policy; flow control under a slow client; device going offline.
- `key-store`, `port-allocator`, REST (401 without credentials, 403 without the right scope, validation errors) and `AdbProxyPage.test.tsx`.

**Conformance lane** (`npm run test:adb-proxy-conformance`, `vitest.adb-proxy.config.ts`, files named `*.conformance.test.ts`, excluded from the default lane like the live AI config). This feature has no LLM, so this slower lane is its equivalent of the eval suite: it drives the **real `adb` binary** at the proxy, backed by a fake ADB server presenting a canned device. It checks `connect` then `unauthorized`, approval then `device`, and `shell`, `push`/`pull`, `forward`, `install` and `logcat`; a live mode against a physical device is opt-in. It skips when `adb` is missing. Isolation is mandatory: the test client uses its own `HOME`/`ANDROID_USER_HOME` (own key pair) and its own `ANDROID_ADB_SERVER_PORT`, so it can never touch the developer's running ADB server or keys. Runs before ship, not on commit.

**Playwright E2E:** approve, deny, revoke and forget from the UI, with a small Node test client built on `packet.ts` standing in for a remote machine.

## Rollout

- Ships disabled. Nothing listens until an admin turns it on.
- Docs: `docs/adb-proxy.md` (usage, security model, plaintext caveat, services policy, firewall note), an `ARCHITECTURE.md` section, a `CHANGELOG` entry.
- **Backend restart** needed for the migration. The admin opens the chosen port range on the host firewall.
- **Migration numbering:** the AI-pipelines branch already adds `0102_ai_pipelines`. Whichever branch merges second renumbers its migration and sets its journal `when` above the maximum of all existing entries; the journal is not sorted by `when`, so scan every entry.
- Work happens on branch `worktree-adb-proxy`, based on `main` at `399dc15`.

## Risks and things to verify first

1. **SIGNATURE format.** The client signs the 20-byte token as a SHA-1 PKCS#1 v1.5 DigestInfo, so Node's `crypto.verify` (which hashes again) is wrong; verification has to compare the `publicDecrypt` output with `DigestInfo(sha1) || token`. Confirm against the AOSP `adb_auth_host` source and the real `adb` client before building on it. The first implementation task is a spike that gets a real `adb connect` to reach `device`.
2. **Fingerprint format.** MD5 over the decoded blob, uppercase colon hex, compared against a real device's dialog during the live conformance run.
3. **Client version spread.** Older and newer `adb` clients differ in banner expectations and in whether they offer STLS. Run the conformance lane against at least the oldest and newest platform-tools in use.
4. **Public-key blob size.** Only 2048-bit keys (524-byte blob) are accepted, which is all `adb` generates.

## Open points for the reviewer

- **Services deny-list** (`reverse:`, `tcpip:`, `usb:`): defaults chosen to protect the host's ability to reach the phone; say if you want any of them allowed.
- **Default port range** `6500` to `6599`: chosen to avoid ports already used by DarkRide (3000, 5173, 9100-9399, 49160-49200, 51820) and ADB itself (5037, 5554-5585).
- **Default bind** `0.0.0.0` once enabled: needed for remote machines; narrow it with `adb_proxy.bind_host`.
