# Testing the video pipeline

Manual verification checklist for changes that touch the device-viewer H.264 / WebCodecs path. Walk through each scenario before merging anything that affects the stream broadcaster, gap detector, keyframe coordinator, or bitrate tier logic, and document any anomalies in the PR.

Design rationale and known failure modes are in [`video-streaming-reliability.md`](video-streaming-reliability.md).

## 1. LAN baseline
- Connect a real Android device on the same network as the server.
- Open the Device Viewer.
- **Expected:** smooth video, health dot is green, tier 1 (4 Mbps) by default. Tier may upstep to 0 (8 Mbps) after ~90s of healthy streaming.

## 2. Throttled connection
- On the server host: `sudo tc qdisc add dev <iface> root netem rate 1mbit delay 200ms`.
- Open the Device Viewer.
- **Expected:** initial frames may stutter, then auto-reset triggers ("Reconnecting…" overlay), tier downsteps to 2 then 3 until stable. Health dot turns yellow/red during transitions, settles to yellow.

## 3. Recovery
- After scenario 2, remove the throttle: `sudo tc qdisc del dev <iface> root`.
- Wait ≥90 seconds (30s lockout + 60s healthy).
- **Expected:** tier upsteps gradually back toward 1. Each upstep triggers a brief reconnect.

## 4. Multi-viewer divergence
- Open two browser tabs of the same device.
- On one tab, throttle just the tab via DevTools Network throttle (Slow 3G).
- **Expected:** throttled tab stutters and may auto-reset; other tab stays smooth at original tier. (Note: on persistent congestion, the throttled viewer's reset will downstep the shared scrcpy bitrate and affect both tabs.)

## 5. Browser fallback
- Open the Device Viewer in a browser without WebCodecs (e.g. Firefox < 130 if available, or use DevTools to delete `window.VideoDecoder` before navigating).
- **Expected:** "Live video requires a modern browser…" empty-state. Touch input and screenshot still work.

## 6. Stream restart
- Click "Retry stream" from the overflow menu.
- **Expected:** brief Reconnecting… overlay, video resumes. Tier remains the same (manual restart is not congestion).
