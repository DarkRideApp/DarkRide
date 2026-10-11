# ADB proxy: design

Date: 2026-10-11
Status: **Approved 2026-10-11**, revised the same day while writing the implementation plan (see "Revisions after approval" at the end). Approach, auth model, hosting and grant scope were decided with Cube in the design discussion.

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
- Host-level services (`host:kill`, `host:connect`, ...) must stay unreachable. The ADB server dispatches any request starting with `host` as a host request, even on a connection already bound to a device, so the proxy refuses every service string starting with `host` (see Services policy) instead of relying on the transport binding.
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
| `listener.ts` | Thin `net.Server` wrapper per device: bind, TCP keepalive, hand each socket to a callback, close. | `node:net` |
| `port-allocator.ts` | Persistent port per device from a configurable range. | DB |
| `key-store.ts` | Persisted key records (approved, denied, revoked). | DB |
| `pending.ts` | In-memory pending requests: caps, per-IP rate limit, timeouts, decision promises. | nothing |
| `auth-gate.ts` | Implements the session's `AuthGate` over `key-store.ts` and `pending.ts`; caches parsed keys. | the two above |
| `limits.ts` | Pre-auth connection limiter (per IP and total). | nothing |
| `throttle.ts` | Run a function at most once per interval, used to log a dead ADB server once per interval. | nothing |
| `settings.ts` | Load, validate and save the `adb_proxy.*` settings. | DB |
| `device-directory.ts` | `DeviceDirectory` adapter over `DeviceManager`. | `DeviceManager` |
| `adb-proxy-service.ts` | Orchestrator: starts and stops listeners from device lifecycle, applies settings changes live, owns the live-session registry, closes sessions on revoke, owns the counters and the status snapshot. | `DeviceDirectory`, the above |

`DeviceDirectory` is a narrow interface the service depends on instead of `DeviceManager` internals:

```ts
interface DeviceDirectory {
  listOnlineAndroid(): { id: string; name: string | null }[];
  onOnline(fn: (id: string) => void): void;
  onOffline(fn: (id: string) => void): void;
}
```

A small adapter (`device-directory.ts`) implements it over `DeviceManager`, which gains two public methods because its online set is private: `getOnlineDeviceIds()` and `onDeviceOnline(fn)` (mirroring the existing `onDeviceOffline`). Outside the module: `backend/api/adb-proxy.ts` (REST), a migration, scope entries in `backend/auth/scopes-registry.ts`, and the frontend page.

## Wire protocol behavior

**Packet.** Commands are ASCII little-endian: `CNXN`, `AUTH`, `OPEN`, `OKAY`, `CLSE`, `WRTE`. `magic` must equal `command ^ 0xffffffff`. The data checksum is not verified (modern clients negotiate skipping it).

**Handshake.**

1. Client sends `CNXN` (`host::features=...`). The proxy replies with nothing yet.
2. If the device is not online, the proxy closes the socket. It never sends a banner it cannot back, because a client reads the banner as "this device is usable".
3. Proxy sends `AUTH` type TOKEN with 20 bytes from `crypto.randomBytes`.
4. Client answers `AUTH` type SIGNATURE. The proxy tries each approved key whose allow-list includes this device. A match means `CNXN` back (banner below). No match means a fresh TOKEN, up to 3 attempts.
5. Client then sends `AUTH` type RSAPUBLICKEY (base64 key blob plus `user@host`). A public key is not secret, so the proxy first checks that one of the signatures this client already sent on this connection verifies, over the token the proxy issued for it, under the offered key. If none does, it closes without creating anything and without asking the gate. Real clients sign first and offer the key second, so this costs them nothing. Then the proxy:
   - key is denied or revoked: close, no new request;
   - key is unknown: create or refresh an in-memory pending request and **hold the connection**. The client keeps `unauthorized`, as it does for a phone waiting on its dialog;
   - on approve, send `CNXN` on the held connection; on deny, timeout or disconnect, close.

**Banner.** `device::ro.product.name=<..>;ro.product.model=<..>;ro.product.device=<..>;features=<..>`, NUL-terminated. `features` is the device's real list from the ADB server (`host-serial:<serial>:features`), passed through unchanged except for `delayed_ack`, which is removed. Almost every feature is carried inside opaque stream bytes (`shell_v2` framing, sync, `abb`, `sendrecv_v2*`) and needs nothing from the proxy. `delayed_ack` (burst mode) is the exception: it changes the wire framing (`OPEN` carries a window in `arg1`, `OKAY` carries a 4-byte payload, several `WRTE`s can be in flight), which the proxy does not implement, so it is never offered to a client. Advertised version `0x01000001`, max data 1 MiB.

**Streams.**

- `OPEN` (arg0 = client id, payload = service plus NUL): apply the services policy, open the backend socket, send the 4-hex-length-prefixed service, wait for the server's `OKAY`. Success: reply `OKAY`. Failure: reply `CLSE`.
- `WRTE` from client: write to the backend socket and send `OKAY` once the write has drained. A second `WRTE` on a stream before that `OKAY` is a protocol error and closes the stream, so inbound data never queues without bound.
- Backend data: send `WRTE`, then pause that socket until the client's `OKAY`. This is ADB's own flow control; no extra windowing.
- `CLSE` either way tears down that stream and its backend socket.
- Caps: 128 open streams per session; payloads at most the advertised max data. Backend data is split into `WRTE`s of at most the smaller of the client's `CNXN` max data and ours (never below 4096). The session stops reading from a client socket while more than 4 MiB is queued to be written to it, and resumes on `drain`, so a client that sends but never reads cannot grow the buffer without limit.

**Services policy.** Refuse with `CLSE`:

- anything starting with `host` (`host:kill`, `host:connect:...`, `host-serial:...`), because the ADB server would treat it as a request to itself and a remote client could stop or reconfigure the host's ADB server;
- `reverse:*`, because device-initiated streams would go to the local ADB server, bypassing the proxy and the grant;
- `tcpip:*` and `usb:`, because they flip the phone's `adbd` between USB and network and can strand it where DarkRide cannot reach it.

Everything else passes through, including `root:`, `remount:` and `reboot:`. Approval is full trust in the device, which is what was asked for.

## Security model

- **Off by default.** `adb_proxy.enabled` is false; nothing listens. Then a per-device toggle (default on). Bind address and port range are settings.
- **Possession is proven before anything is created.** Presenting a public key, even an approved one, never authenticates a connection and never creates or replaces a pending request; only a signature over this connection's token does. Without this, anyone on the LAN who copied an approved key's public blob from the wire or from a file would be let in, and could take over another machine's waiting request.
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

`forget-device.ts` must delete the `adb_proxy_devices` row explicitly: with foreign keys on, parent deletes must clear non-cascading children first, and the test DB helper's DDL drops `ON DELETE CASCADE`. Tests build the tables with `createTestDb([...])`; one test applies the real migration with `applyMigrations`.

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

Live updates are one WebSocket message type, `adb-proxy`, carrying the full status snapshot (small). It goes through `broadcastToAll` on a filtered channel registered with `requires: ['core.adb-proxy:read']`, so only subscribed clients holding that scope receive pending fingerprints and IPs. The page uses `ws.subscribe('adb-proxy', ...)`, which also sends the server-side subscription. The advertised host in `/status` comes from the existing LAN-preferring server IP logic, so a VPN interface is never shown.

## UI

A settings page at `settings/adb-proxy` (`frontend/pages/settings/AdbProxyPage.tsx`), with a pending-count badge on its sidebar item. Layout and components follow the nearest existing list-with-actions screens (the table, badge and button classes of `AdminUsersPage`, and the enable-switch card of `McpSettings`) rather than a new pattern.

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

**Conformance lane** (`npm run test:adb-proxy-conformance`, `vitest.adb-proxy.config.ts`, files named `*.conformance.test.ts`, excluded from the default lane like the live AI config). This feature has no LLM, so this slower lane is its equivalent of the eval suite: it drives the **real `adb` binary** at the proxy, backed by a fake ADB server presenting a canned device. It checks `connect` then `unauthorized`, approval then `device`, and `shell`, `push`/`pull`, `forward`, `install` and `logcat`; a live mode against a physical device is opt-in. It skips when `adb` is missing, and runs once per client listed in `ADB_BINS` (default: `adb` on PATH), so an older and a newer platform-tools build are both covered. Isolation is mandatory: the test client uses its own `HOME`/`ANDROID_USER_HOME` (own key pair) and its own `ANDROID_ADB_SERVER_PORT`, so it can never touch the developer's running ADB server or keys. Runs before ship, not on commit.

**Playwright E2E:** approve, deny, revoke and forget from the UI, with a small Node test client built on `packet.ts` standing in for a remote machine. It runs under its own config (`playwright.adb-proxy.config.ts`, own ports and DB) because the backend needs an online device: the config starts a fake ADB server (the one the gate tests use) and points the backend at it with `ANDROID_ADB_SERVER_PORT`.

## Rollout

- Ships disabled. Nothing listens until an admin turns it on.
- Docs: `docs/adb-proxy.md` (usage, security model, plaintext caveat, services policy, firewall note), an `ARCHITECTURE.md` section, a `CHANGELOG` entry.
- **Backend restart** needed for the migration. The admin opens the chosen port range on the host firewall.
- **Migration numbering:** the AI-pipelines branch already adds `0102_ai_pipelines`. Whichever branch merges second renumbers its migration and sets its journal `when` above the maximum of all existing entries; the journal is not sorted by `when`, so scan every entry.
- Work happens on branch `worktree-adb-proxy`, based on `main` at `399dc15`.

## Risks and things to verify first

1. **SIGNATURE format. Confirmed (2026-10-11).** The client signs the 20-byte token as a SHA-1 PKCS#1 v1.5 DigestInfo, so Node's `crypto.verify` (which hashes again) is wrong; verification has to compare the `publicDecrypt` output with `DigestInfo(sha1) || token`. On 2026-10-11 a signature made with `openssl pkeyutl -pkeyopt digest:sha1` over a random token, using a key from a real `adb keygen`, decrypted to exactly the SHA-1 DigestInfo prefix plus the token, and the `.pub` blob parsed as described above. The spike then showed that both real clients (34.0.4 and 37.0.0) sign identically: the probe accepted their signatures with exactly that comparison and a real `adb connect` reached `device`. See "Spike results" below.
2. **Fingerprint format.** MD5 over the decoded blob, uppercase colon hex, compared against a real device's dialog during the live conformance run.
3. **Client version spread. Partly settled (2026-10-11).** Older and newer `adb` clients differ in banner expectations and in whether they offer STLS. The two clients tried (34.0.4 and 37.0.0) ran the same handshake and differed only in the `features` list inside their `CNXN`. STLS never appeared, but the probe never offered it (it answered every `CNXN` with an `AUTH` token and advertised version `0x01000001`), so how a client reacts to an STLS offer is untested. Run the conformance lane against at least the oldest and newest platform-tools in use.
4. **Public-key blob size.** Only 2048-bit keys (524-byte blob) are accepted, which is all `adb` generates. Both clients sent a 524-byte blob.
5. **Held-connection patience. Confirmed (2026-10-11).** Both real clients kept an `unauthorized` transport open for the full 330 s the spike held it, so the 5 minute pending hold stands and the pending timeout stays at 5 minutes.

### Spike results (2026-10-11)

A throwaway probe played the proxy's side of the handshake on loopback. On `CNXN` it sent an `AUTH` token; it checked a returned signature with the comparison from risk 1; for an unrecognised key it held the connection before sending `CNXN`; it answered every `OPEN` with `CLSE`. Clients: the Debian package `adb` 34.0.4 and Android SDK platform-tools `adb` 37.0.0-14910828, each against its own isolated ADB server and home directory. Everything below is read from the probe logs and the clients' own output.

- **Signature scheme: confirmed for both clients.** A known key was accepted on the first `AUTH` SIGNATURE (arg0=2, 256 bytes) using the `publicDecrypt` comparison against `DigestInfo(sha1) || token`, for both clients. A key generated and first offered through the 37.0.0 client was later accepted when signed through the 34.0.4 client.
- **Sequence per connection, identical for both clients.** Unknown key: `CNXN`, one `AUTH` SIGNATURE, then (after the probe answered with a new token) `AUTH` RSAPUBLICKEY (arg0=3). The client made no second signature attempt. Known key: `CNXN`, `AUTH` SIGNATURE, accepted. The RSAPUBLICKEY payload was 712 bytes and decoded to a 524-byte blob.
- **`CNXN` each client sends.** Both: arg0 `0x01000001`, arg1 `1048576` (max data 1 MiB), payload `host::features=<list>` with no trailing NUL. 34.0.4 (234 bytes): `shell_v2,cmd,stat_v2,ls_v2,fixed_push_mkdir,apex,abb,fixed_push_symlink_timestamp,abb_exec,remount_shell,track_app,sendrecv_v2,sendrecv_v2_brotli,sendrecv_v2_lz4,sendrecv_v2_zstd,sendrecv_v2_dry_run_send,openscreen_mdns`. 37.0.0 (302 bytes): the same list plus `devicetracker_proto_format,devraw,app_info,server_status,track_mdns`.
- **STLS and other commands.** None. Only `CNXN`, `AUTH` and `OPEN` arrived from either client (see risk 3 for the caveat).
- **`adb connect` and `adb devices`.** With an unknown key, `adb connect` returns within about 30 ms with exit status 0 and prints `failed to authenticate to 127.0.0.1:16500` (both clients), while the transport stays held. `adb devices` then shows `unauthorized` (37.0.0 shows `authorizing` for the first few milliseconds) and flips to `device` when the probe sends `CNXN`: with a 3 s hold, `unauthorized` was seen from 0.5 s to 2.6 s and `device` at 3.1 s. With a known key, `adb connect` prints `connected to 127.0.0.1:16500` and the first `adb devices` already shows `device`. So the `failed to authenticate` text is the normal first-connect response, and anything scripting this (tests, the UI's instructions) must poll `adb devices` rather than trust `adb connect`'s output.
- **Service strings.** Every `OPEN` payload ends with a NUL, counted in its length. Both clients sent the same strings except where a cell names the client(s) it was read from.

  | Command | Banner without `shell_v2` (`features=cmd,stat_v2,ls_v2`) | Banner with `shell_v2`, `abb_exec`, `sendrecv_v2` |
  |---|---|---|
  | `adb shell echo hi` | `shell:echo hi` | `shell,v2,TERM=<term>,raw:echo hi` |
  | `adb shell` (no command) | `shell:` | `shell,v2,TERM=<term>,raw:` |
  | `adb shell -t ls` | not run | `shell,v2,TERM=<term>,raw:ls` |
  | `adb exec-out echo hi` | not run | `exec:echo 'hi'` |
  | `adb push`, `adb pull` (and `adb ls` on the right) | `sync:` | `sync:` |
  | `adb logcat -d` | `shell:export ANDROID_LOG_TAGS=''; exec logcat '-d'` (37.0.0) | `shell,v2,TERM=<term>:export ANDROID_LOG_TAGS="''"; exec logcat '-d'` (34.0.4) |
  | `adb install x.apk` (a 0-byte file) | not run | `abb_exec:settings\0get\0enable_adb_incremental_install_default\0` (37.0.0: `...\0get\0global\0enable_...\0`), then `abb_exec:package\0install\0-S\00\0` |
  | `adb reverse tcp:17002 tcp:17003` | `reverse:forward:tcp:17002;tcp:17003` | not run |
  | `adb tcpip 5555`, `adb usb`, `adb root` | `tcpip:5555`, `usb:`, `root:` | not run |

  Every `shell,v2` string carried a `TERM=` field; its value is omitted here (`<term>`). `adb shell -t ls` printed `Remote PTY will not be allocated because stdin is not a terminal.` and sent the `raw:` form. `adb push`, `pull` and `ls` opened the same `sync:` string (`ls` was tried on the `shell_v2` banner only), so the `OPEN` alone does not say which of them it came from. `adb forward tcp:17000 tcp:17001` sent no `OPEN` to the probe; the client printed `17000` and `adb forward --list` then listed `127.0.0.1:16500 tcp:17000 tcp:17001`. The first connection to local port 17000 then produced `OPEN tcp:17001`.
- **Refused `OPEN`s.** Answering an `OPEN` with `CLSE` made `adb shell`, `push`, `pull`, `reverse`, `tcpip`, `usb` and `root` fail at once (client output such as `error: closed`, `adb: error: connect failed: closed` or `adb: unable to connect for root: closed`, exit status 1 each time). `adb logcat -d` instead kept sending the same `OPEN` again and printed `- waiting for device -`: 37.0.0 on the plain banner sent 13,159 `OPEN`s in about 11 s (about 1,200 per second) before the client was killed. On the `shell_v2` banner both clients printed `- waiting for device -`, and the probe logged 19,527 such `OPEN`s across the two 8 s runs. A refusal path (services deny-list, stream cap) can be driven at that rate by an unmodified client, so a refused `OPEN` must cost almost nothing.
- **Held connection.** Both clients ran side by side against a probe that held for 330 s. Every poll (every 5 s, 0 to 326 s) showed `unauthorized`. Neither client sent any ADB message or closed the TCP connection during the hold. The probe sent `CNXN` at 330.0 s; the next poll (331 s) showed `device` for both, and `adb shell echo hi` arrived as an `OPEN` on the same held connection 16 s later. Longest hold observed: 330 s, which is the hold the spike set, not a client limit.
- **Not covered.** Reaction to an STLS offer, a client holding several keys (more than one signature attempt), and holds longer than 330 s.

## Defaults accepted at approval

- **Services deny-list** (`reverse:`, `tcpip:`, `usb:`): defaults chosen to protect the host's ability to reach the phone; say if you want any of them allowed.
- **Default port range** `6500` to `6599`: chosen to avoid ports already used by DarkRide (3000, 5173, 9100-9399, 49160-49200, 51820) and ADB itself (5037, 5554-5585).
- **Default bind** `0.0.0.0` once enabled: needed for remote machines; narrow it with `adb_proxy.bind_host`.

## Revisions after approval

Made on 2026-10-11 while grounding the implementation plan in the code. None changes a decision Cube made.

- **Security fix: every service starting with `host` is refused.** The first draft said host services were unreachable by construction because the transport is bound first. The ADB server dispatches `host…` requests on any connection, including a bound one, so a remote client could have sent `host:kill`. The Services policy and "How it works" now say so, and the gate tests assert the fake ADB server never sees a `host…` request from a remote stream.
- **Live updates** use a filtered WebSocket channel with a scope requirement instead of an unfiltered broadcast, so pending fingerprints and IPs only reach clients holding `core.adb-proxy:read`.
- **UI pattern reference** corrected: `CertificatesPage` is only a redirect stub. The page follows `AdminUsersPage` and `McpSettings`.
- **Components** gained `pending.ts`, `auth-gate.ts`, `limits.ts`, `settings.ts` and `device-directory.ts`, and `listener.ts` shrank to a thin socket wrapper, so each unit has one job. `DeviceManager` gains `getOnlineDeviceIds()` and `onDeviceOnline()`.
- **E2E** runs under its own Playwright config with a fake ADB server, and the conformance lane runs once per client in `ADB_BINS`.
- **Risk 5** added: the real client's patience with a long-held `unauthorized` transport is unverified.
- **Security fix: possession of the offered key is proven first.** Found by the Task 8 review while the session code was still only a plan. The first draft passed any offered public key to the gate, and an already-approved key went straight to `CNXN`, so a copied public blob was enough to connect. The session now keeps the signatures a client sends and requires one to verify under the offered key before the gate is asked.
