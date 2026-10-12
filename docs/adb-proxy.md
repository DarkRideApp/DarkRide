# ADB proxy

The ADB proxy lets other machines on your network run `adb` against the Android devices attached to the DarkRide host, with no cable and nothing to install on those machines. Each machine has to be approved in DarkRide before it can reach a device. The approval happens in DarkRide, not on the phone: Android's own "Allow USB debugging" dialog is not involved.

It is off by default. Nothing listens until you turn it on, and while it is off its periodic device check does not run.

## Set it up

1. Open **Settings → ADB Proxy** (in the Advanced group) and switch **Remote access** on.
2. In the **Network** card, check the **Bind address** and the **First port** and **Last port**. If you change any of them, press **Save** (it stays disabled until a value changes). The defaults are `0.0.0.0` (every IPv4 interface) and 6500 to 6599. The bind address must be an IP address, and the range must lie between 1024 and 65535 and hold at most 1000 ports. Once the proxy is on, each online Android device gets one port from the range, the lowest free one, and keeps it across restarts and reconnects. The one case where a device loses its port is described under **No free port** in Troubleshooting.
3. Open that port range on the host's firewall. In Docker, publish it instead (see [Running in Docker](#running-in-docker)).
4. On the other machine, run the command from the **Connect command** column of the Devices table (the **Copy** button copies it):

   ```bash
   adb connect 192.168.1.10:6500
   adb devices        # shows "unauthorized" until you approve the machine
   ```

   If the **Bind address** is a specific address rather than `0.0.0.0` or `::`, the command names that address. An IPv6 address is shown in brackets, for example `adb connect [fd00::5]:6500`.

   The first `adb connect` from a key DarkRide has not seen can print `failed to authenticate` and still exit with status 0. That is expected. `adb devices` shows the real state.
5. In DarkRide the machine appears under **Waiting for approval** straight away, with its machine name, the device, the source address and the key fingerprint. The sidebar item shows how many requests are waiting. Decide from the source address and the fingerprint. The machine name is the `user@host` text stored in the connecting machine's key, so the connecting machine chooses it and it proves nothing.

   The fingerprint identifies the key: it is the MD5 of the decoded 524-byte key, shown as uppercase pairs separated by colons. `adb` does not print it, but you can compute it on the other machine, as the account that runs `adb` there (Linux or macOS):

   ```bash
   awk '{print $1}' ~/.android/adbkey.pub | base64 -d | md5sum
   # example output:  78c45c9438f4815eccbd5f22acca93ff  -
   # DarkRide shows:  78:C4:5C:94:38:F4:81:5E:CC:BD:5F:22:AC:CA:93:FF
   ```

   `md5sum` prints the digest followed by `  -`, which is not part of it. Compare the digest with the fingerprint ignoring case and colons. On macOS, `base64 -d` works on current versions (older ones use `-D`), and if `md5sum` is not installed, `md5` prints the same digest. This fingerprint is not compared with anything a phone shows. Press **Approve** once it matches. A confirmation then repeats the source address, the full fingerprint and the device, says how many proxied devices the machine will get a shell on, and only then shows the name the machine gave itself, as the last sentence. Press **Approve** in it to finish.
6. On the other machine, `adb devices` changes from `unauthorized` to `device` without a reconnect. From then on it can use the device like one attached by USB, for example `adb shell`, `adb push`, `adb pull` and `adb forward`.

A machine is identified by its adb key, whose public half is the file `adbkey.pub` in the `.android` folder of the home directory of the account that runs `adb` on that machine. A different account, or `sudo adb`, can use a different key, and then the recipe above will not match it. Approving a key gives that machine a shell on every proxied device, including devices attached later, and it approves the key's waiting requests for the other devices at the same time. Approval survives restarts. Revoke it at any time.

## Running in Docker

The proxy listens inside the container, so other machines can only reach it if the range is published. Publish each port on the same number it has inside, because the **Connect command** shows the port the container listens on. Also set `WG_SERVER_IP` to the host's address, because the command otherwise names the address DarkRide finds inside the container, which is internal to Docker:

```bash
docker run -d --name darkride \
  -p 3000:3000 \
  -p 6500-6599:6500-6599 \
  -e WG_SERVER_IP=192.168.1.10 \
  ...                      # the other options from the README
```

In Compose:

```yaml
services:
  darkride:
    ports:
      - "3000:3000"
      - "6500-6599:6500-6599"
    environment:
      WG_SERVER_IP: 192.168.1.10
```

- **The range is fixed when the container is created.** If you change **First port** or **Last port** in the Network card, recreate the container with the new range: Docker cannot add published ports to a running one. Leave the **Bind address** at `0.0.0.0` inside the container and choose the exposed address when you publish.
- **By default, a host firewall such as `ufw` does not filter published ports.** Docker adds its own rules and sends the traffic around them, so opening or closing the range in `ufw` changes nothing. To limit who can connect, publish on one host address, for example `-p 192.168.1.10:6500-6599:6500-6599`, or put the host behind a network firewall or VPN.
- **Only devices the container's own ADB server can see are proxied.** See the Docker section of the README for passing devices in.
- On Linux, `--network host` instead of `-p` skips publishing. The ports then belong to the host, and the host firewall applies as described above.

## Managing machines

- **Revoke** an approved machine under *Approved machines*. Its live connections close at once and it is refused from then on. It moves to *Denied and revoked*.
- **Deny** a waiting request to close it. DarkRide then ignores that key, with no new request, until you forget it.
- **Forget** a machine under *Denied and revoked* to let it ask again. If it connects again it waits for approval like a new machine. A machine that was denied or revoked cannot ask again until you do this.
- A waiting request is held for 5 minutes. It lives in memory only, so a restart clears it. When a request times out or is cleared, the waiting connection closes and the other machine runs `adb connect` again. A machine that asks again for the same device replaces its waiting request instead of adding a second one.
- In the Devices table you can change a device's port (type a new port and press **Save port**; it must be inside the range and not used by another device) or clear its **Proxy** checkbox to stop proxying that device. Changing a port, clearing the checkbox, changing the bind address and switching **Remote access** off each close the live connections they affect.

Viewing needs the scope `core.adb-proxy:read`. Denying, revoking, forgetting and changing settings need `core.adb-proxy:manage`. Approving needs `core.adb-proxy:manage` and `core.devices:shell` (Device shell access), because an approved machine gets a shell on every proxied device. A user with manage but without shell access can deny a request but not approve it, and the page hides **Approve** from them. `core.adb-proxy:*` does not include `core.devices:shell`; `core.admin:*` covers all of these. See Security notes before you grant any of them.

## What is not supported

- **`adb -H host -P port`.** That form of the protocol has no authentication step, so it is not offered. Use `adb connect`.
- **`adb reverse`, `adb tcpip` and `adb usb`**, and anything addressed to the host's own ADB server (services starting with `host`). These are refused.
- **`adb connect` to the proxy from the DarkRide host itself.** DarkRide registers every device that `adb devices` lists, so the connection appears as a second device next to the phone. The proxy recognises its own endpoints and does not proxy them again, but the extra entry stays in DarkRide's device list until you forget it. Connect from another machine.
- **`adb pair` and wireless debugging pairing.**
- **Keys other than the 2048-bit RSA keys that `adb` generates.**
- iOS devices.

## Security notes

- **The connection is not encrypted.** Anyone on the network path can read or change an approved machine's traffic. Approval keeps unknown machines out, not eavesdroppers. On a network you do not trust, put the port range behind a VPN or WireGuard.
- **Authentication is not tied to the connection.** The proxy sends a random token and the client signs it with its key. ADB's authentication has no channel binding, so nothing in the exchange ties that signature to this connection or this proxy. A malicious adb server that an approved machine connects to, and that can also reach the proxy, can relay the proxy's token to that machine's `adb`, get it signed, and use the signature to sign in as that machine. Treat approved machines as trusted, and keep them off hostile networks.
- **Approval is per key and covers every proxied device**, unless an allow-list set through the API restricts the key (`PATCH /v1/adb-proxy/keys/:id`; the page has no control for it). Treat an approved machine as having a shell on every attached phone. That is why approving also needs `core.devices:shell`.
- **Only the first request for each stream is checked.** Services starting with `host`, and `reverse:`, `tcpip:` and `usb:`, are refused, as is a request with a NUL byte inside it unless it starts with `abb_exec:` or `abb:` (which `adb install` uses). Everything else passes through, including `shell:`, `root:`, `remount:` and `reboot:`, and the data on an open stream is not inspected. A `reboot:` service always closes the session once its stream ends, and `root:` or `unroot:` closes it when the device answers that adbd is restarting, because a real device drops its connection then too. On a production build `root:` is refused and the session, with its other streams, stays open. Run `adb connect` again if the client does not reconnect by itself once the device is back.
- **The default bind address is every IPv4 interface.** To limit exposure, bind to a LAN or VPN address and open only the port range you chose.
- **Changing the port range does not move devices that already have a port, whether the proxy is on or off.** The range applies to new allocations only, and a device keeps its port, even one outside the range, until you change it.
- **Connections that have not finished the handshake can be exhausted.** They are limited to 8 per source address and 64 in total across all device ports. An attacker who controls eight IPv4 addresses, or eight IPv6 /64 networks (any /56 holds 256 of them), can hold all 64 slots by reopening connections every 10 seconds, and while it does, new connections from everyone else are refused. This is an accepted limit. Use a firewall in front of the port range.
- **`core.adb-proxy:manage` does not include `core.adb-proxy:read`.** Grant both to administrators (`core.adb-proxy:*` and `core.admin:*` cover both). A user with only manage cannot open the page. They can still read the same data in the responses to their write calls. Approving a key is the stronger permission and also needs `core.devices:shell`, so grant manage together with shell access only to people you would trust with a shell on every attached phone (`core.adb-proxy:*` does not include shell access; `core.admin:*` does).
- **An open browser tab keeps receiving live updates after its user loses the read scope.** The scope is checked when the tab subscribes, and every filtered WebSocket channel works this way. Removing the scope does not stop a tab that is already open: ask the user to close it, or restart the DarkRide server to end every connection.
- **ADB proxy log lines contain source addresses and key comments** and go to the normal server log. Lines caused by machines without an approved key are rate limited to about 6 lines a minute in total (5 in full, then one summary). Lines about refused services come from approved machines and have a separate limit of the same size.

## Limits

- At most 8 connections per source address and 64 in total may be unauthenticated at once. A source address is an IPv4 address or an IPv6 /64 network, and an IPv4-mapped IPv6 address counts as its IPv4 address. A connection that has not finished the handshake after 10 seconds is dropped. The handshake lasts until the proxy sends its `CNXN`, so the time spent fetching the device's banner from the ADB server counts, and the connection keeps its slot until then. A connection that is waiting for approval is exempt.
- A connection can send at most 8 signatures, and a ninth closes it. `adb` signs once with each key it holds (the key in its `.android` folder and each key in `ADB_VENDOR_KEYS`) before it offers its public key, in an order the client chooses. So a machine with more than 8 keys cannot ask for approval, and an approved key gets in only if `adb` tries it within the first 8.
- At most 20 requests wait at once, and a source address can create 3 new ones per minute. A machine that asks again for a device it already has a waiting request for does not use that allowance. Extra requests are dropped. Each dropped request is logged, within the log rate limit, and counted in `counters.floodDrops` in the response of `GET /v1/adb-proxy/status`. Connections refused at the unauthenticated limit are counted in the same counter but not logged individually. The page does not show the count.
- A waiting request is held for at most 5 minutes.
- At most 128 streams may be open on one connection. Further streams are refused.
- One key may have at most 8 authenticated connections to one device and 32 across all devices. Connections that have proved the key and are still being set up count toward both limits. A connection beyond either limit is closed right after its signature is accepted (for a key that was waiting, right after it is approved), before any banner is sent, and the existing ones keep working. The refusal is logged at most once a minute per key. Each `adb` client normally holds one connection per device, so only scripts that run many separate adb servers with the same key reach this.
- A key's machine name has control characters and invisible format characters (such as zero-width and text-direction marks) removed, and is cut to 128 characters.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `adb connect` prints `failed to authenticate` | Normal for a key DarkRide has not approved yet, and the command still exits 0. Run `adb devices`: it shows `unauthorized` until you approve the machine. |
| `adb devices` stays `unauthorized` | The machine is waiting for approval. Open Settings → ADB Proxy and look under **Waiting for approval**. |
| Nothing is listed under **Waiting for approval** | The request timed out after 5 minutes, or the rate limit of 3 new requests per source address per minute was reached (wait a minute and run `adb connect` again), or 20 requests are already waiting (approve or deny some first; each also expires after 5 minutes). Dropped requests are logged and counted. If the machine was denied or revoked, see the next row. If `adb connect` never reached DarkRide, see the rows about refused connections and device badges. |
| A machine that was denied or revoked cannot ask again | DarkRide ignores its key. Press **Forget** on it under *Denied and revoked*, then run `adb connect` again. |
| `adb connect` is refused or times out | The proxy is off, the device is **Disabled**, the firewall blocks the port range, or, in Docker, the container does not publish it. Check the device's badge in the Devices table. |
| The Connect command shows the wrong address | With a specific **Bind address** the command names that address. With `0.0.0.0` or `::`, DarkRide picks the address of a LAN interface and skips virtual and VPN adapters by name. In Docker that is an address inside the container. Set `WG_SERVER_IP` to the address clients should use and restart. It is the same variable WireGuard capture uses. |
| The device shows **Off** | **Remote access** is switched off, or the listener is still starting. |
| The device shows **Disabled** | The **Proxy** checkbox for that device is cleared. |
| The device shows **Device offline** | DarkRide does not see the device as online: it is unplugged, offline, or unauthorized on the host. Its port stays reserved and works again when the device returns. Connections to it are closed meanwhile. |
| The device shows **Port in use** | Another program holds that port. DarkRide tries again every 5 seconds, so the device starts listening by itself once the port is free, and it logs the failure at most once every 5 minutes. To stop waiting, type a different port in the Devices table and press **Save port**. |
| The device shows **No free port** | The port range is full and no device can give up its port. Ports stay reserved for devices that are unplugged, with one exception: when a device that has no port needs one and the range is full, DarkRide takes the port of the offline device whose port row is oldest and writes a log line saying so. That device gets a new port, possibly a different number, when it returns. A device whose **Proxy** checkbox is cleared keeps its port. Widen the range in the Network card, or forget a stale device on the Devices page. Forgetting frees its port, and the waiting device gets it within about 5 seconds. |
| The device shows **Error** | The proxy could not listen for a reason other than a busy port, for example a bind address that does not belong to this host. The server log has a `cannot listen for` line with the reason. |
| An approved machine keeps being refused on one device | Its key has a device allow-list that excludes that device. Clear it with `PATCH /v1/adb-proxy/keys/:id` and `{ "deviceIds": null }`. |
| The page says **Access denied** | Your account lacks `core.adb-proxy:read`. Changing anything also needs `core.adb-proxy:manage`, and approving a machine also needs `core.devices:shell`. |
| There is no **Approve** button, only **Deny** | Your account has `core.adb-proxy:manage` but not `core.devices:shell`. The page shows a hint under the waiting list. Ask an administrator to approve the machine or to grant you Device shell access. |

## For developers

Design: `docs/specs/2026-10-11-adb-proxy-design.md`. Code: `backend/services/adb-proxy/`, the API in `backend/api/adb-proxy.ts`, the page in `frontend/pages/settings/AdbProxyPage.tsx`.

Settings are stored in the `settings` table: `adb_proxy.enabled` (`false`), `adb_proxy.bind_host` (`0.0.0.0`), `adb_proxy.port_start` (`6500`) and `adb_proxy.port_end` (`6599`). The proxy reaches the host's ADB server at `ANDROID_ADB_SERVER_ADDRESS` and `ANDROID_ADB_SERVER_PORT`, defaulting to `127.0.0.1:5037`. It does not read `ADB_SERVER_SOCKET`, which `adb` itself honours, so if that variable is set where DarkRide runs, set the two variables to the same server. The banner it sends to clients is built from that server's answers (cached for 5 seconds per device), leaves out the `delayed_ack` feature and has no trailing NUL. On the wire it advertises protocol version `0x01000001` and a maximum payload of 256 KiB, accepts payloads of at most 4 KiB before a connection is authenticated and of at most 256 KiB after, and sets TCP keepalive to 30 seconds.

API, all under `/v1/adb-proxy`. In the table, read means the scope `core.adb-proxy:read` and manage means `core.adb-proxy:manage`. `:id` on `/devices` is the device serial; `:id` on `/keys` is the key's numeric `id` from `GET /keys`; `:requestId` is the `requestId` of an entry in `pending`.

| Method and path | Scope | Body | Purpose |
|---|---|---|---|
| `GET /status` | read | | The status snapshot: settings, devices, live connections, waiting requests, keys and counters. |
| `GET /keys` | read | | Approved, denied and revoked keys. |
| `PUT /settings` | manage | any of `enabled`, `bindHost`, `portStart`, `portEnd` | Change settings. They apply at once. |
| `PATCH /devices/:id` | manage | `enabled` and/or `port` | Turn proxying on or off for a device, or move it to another port. |
| `POST /requests/:requestId/approve` | manage and `core.devices:shell` | | Approve the key behind a waiting request. |
| `POST /requests/:requestId/deny` | manage | | Deny it and close the connection. |
| `POST /keys/:id/revoke` | manage | | Revoke an approved key and close its connections. |
| `PATCH /keys/:id` | manage | `deviceIds`: an array of device serials, or `null` for all devices | Set the key's allow-list. |
| `DELETE /keys/:id` | manage | | Forget a key of any status and close its live connections. |

Responses are `{ "success": true, "data": ... }`, where write calls return the status snapshot. Errors are `{ "success": false, "error": "<code>" }` with status 404 for `not-found` and `unknown-device`, 409 for `not-approved`, `in-use` and `range-full`, and 400 for `out-of-range` and `invalid`. A rejected `PUT /settings` returns status 400 with the reason as `error`.

Live updates are `adb-proxy` messages carrying the full status snapshot. Send `{ "action": "__ws:subscribe", "channels": ["adb-proxy"] }` on `/ws`. Without `core.adb-proxy:read` the subscription is silently ignored: the client gets no error and no messages.

Tests:

- `npx vitest run backend/services/adb-proxy backend/api/adb-proxy.test.ts` runs the backend unit tests, and `npm run test:frontend -- frontend/pages/settings/AdbProxyPage.test.tsx` the page tests.
- `ADB_BINS=adb,/path/to/other/adb npm run test:adb-proxy-conformance` is a lane that drives real `adb` clients at the proxy, once per client in `ADB_BINS` (default: `adb` on the path). Each client gets its own home directory and ADB server port, so it never touches your keys or your running server. The private servers also scan USB, so run the lane while your own adb server is running, or with no phone attached. `ADB_PROXY_LIVE_SERIAL=<serial>` adds a check against a physical device on your ADB server: it compares a property read through the proxy with the same read made directly.
- `npm run test:e2e:adb-proxy` runs the browser flow against a fake ADB server, under its own Playwright config and database. It needs `adb` on the PATH, because the backend finds the fake device through the `adb` command. It uses the same ports as the default e2e suite, so do not run the two together. The config pins `ANDROID_ADB_SERVER_ADDRESS`, `ANDROID_ADB_SERVER_PORT` and `ADB_SERVER_SOCKET` to the fake server for the backend it starts.
