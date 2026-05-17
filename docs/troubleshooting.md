# Troubleshooting

## Device Not Appearing

**Symptoms:** Device connected via USB but not shown in DarkRide.

1. Check ADB sees the device: `adb devices` — should show your device as "device" (not "unauthorized" or "offline")
2. Enable USB debugging on the device: Settings > Developer Options > USB Debugging
3. Accept the RSA fingerprint prompt on the device
4. If device shows as "unauthorized": `adb kill-server && adb start-server`, then re-authorize
5. Check DarkRide server logs for errors related to device detection

## HTTPS Capture Not Working

**Symptoms:** Capture starts but no traffic appears.

1. **WireGuard not installed on device:** The WireGuard Android app must be installed. DarkRide pushes a config to it.
2. **Wrong server IP:** If the server has multiple network interfaces (VPN, Docker), `WG_SERVER_IP` may auto-detect the wrong one. Set it manually to your LAN IP.
3. **mitmproxy CA not trusted:** On Android 7+, user CAs aren't trusted by default. Root the device and install the CA as a system cert, or use the Frida Gadget approach for non-rooted devices.
4. **Firewall blocking WireGuard ports:** Ensure UDP ports 51820-51920 are open between the server and device.
5. **IPv6 issues:** WireGuard mode routes IPv4 only. Apps using IPv6-only endpoints won't be captured.

## Python Bridge Fails to Start

**Symptoms:** "Python bridge not available" errors, automations fail immediately.

1. Check the venv exists: `ls .venv/bin/python`
2. Reinstall deps: `.venv/bin/pip install uiautomator2 mitmproxy frida-tools`
3. The bridge resolves the venv relative to `process.cwd()` — make sure the server runs from the project root
4. Check bridge health: the server logs show `[python-bridge] Bridge started on port XXXX`

## Frida Server Won't Start

**Symptoms:** "Failed to start Frida server" when clicking Start in the IDE.

1. Device must be rooted for frida-server mode. For non-rooted devices, use Gadget mode.
2. Frida version mismatch: the frida-server binary must match the frida Python package version. Use "auto" version (default) to auto-match.
3. SELinux may block execution: `adb shell su -c setenforce 0` (temporary, resets on reboot)
4. Check if another frida-server is already running: `adb shell ps | grep frida`

## Frida Gadget Injection Fails

**Symptoms:** "Injection failed" when using Inject & Install on a non-rooted device.

1. **No source APK:** Pull the APK from the device first using the Apps page
2. **keytool not found:** Install a JDK (`apt install default-jdk` on Ubuntu)
3. **APK uses native protection:** Some apps with anti-tampering (e.g., SafetyNet, Play Integrity) may crash after injection
4. **Wrong architecture:** Gadget injection currently supports arm64 only

## Live Stream / Video

**Symptoms:** Device screen shows as black, frozen, or never loads in the Device View.

1. **Browser lacks WebCodecs support:** The H.264 stream is decoded in the browser using the WebCodecs API. Chrome 94+ and Edge 94+ support it; Firefox support is still partial — check [caniuse.com/webcodecs](https://caniuse.com/webcodecs) for the latest browser matrix. Use a Chromium-based browser if your Firefox version doesn't work.
2. **Scrcpy server not pushed:** On first connect, DarkRide pushes the scrcpy-server JAR to the device. If that failed (check server logs for `vendor-manager` errors), re-trigger device setup: device page → Setup.
3. **Fallback polling mode:** For devices where scrcpy is unavailable (some older devices, emulators), DarkRide falls back to `adb screencap` polling. This is slower (~1 fps) but functional. Check logs for `[live-stream] falling back to screencap polling`.
4. **Bitrate too high:** If the stream connects but is choppy or drops frames, try a lower manual bitrate. The bitrate selector is in the Device View toolbar. Auto mode adapts over time; manual lets you lock to a specific tier (500 kbps to 8 Mbps).

## Database Issues

**Symptoms:** Server crashes on startup with SQLite errors.

1. **WAL corruption:** Stop the server, then: `sqlite3 data/darkride.db "PRAGMA wal_checkpoint(TRUNCATE);"`
2. **Migration errors:** If a migration fails, check `migrations/meta/_journal.json` for the last applied migration. Multi-statement migrations need `--> statement-breakpoint` between statements.
3. **better-sqlite3 build issues on Node 24:** Try `rm -rf node_modules/better-sqlite3 && npm install better-sqlite3`

## Build Errors

**Symptoms:** `npm run build` fails.

1. **TypeScript errors:** Run `npx tsc --noEmit` to see type errors without building
2. **better-sqlite3 native module:** If prebuilt binaries aren't available for your Node version, you need build tools: `apt install python3 make g++`

## Device Goes to Sleep During Automation

**Symptoms:** Automation starts but device screen turns off mid-run.

DarkRide puts idle devices to sleep after 60 seconds. Devices are marked "busy" during automations, capture sessions, and Frida sessions. If the device still sleeps:

1. Check the automation is running (not queued/waiting)
2. Manual interactions reset the busy timer — interact with the device in the UI
3. The busy timeout is 10 minutes without interaction, with a 2-minute warning
