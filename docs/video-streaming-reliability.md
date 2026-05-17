# Device Video Streaming — Reliability Design

**Status:** in progress (step 2.7 landing)
**Owners:** core
**Code:** `backend/websocket/h264/`, `backend/websocket/live-stream.ts`, `frontend/lib/video/`, `frontend/components/devices/DeviceViewer.tsx`

## Problem

The device viewer's H.264 video feed renders smoothly but periodically corrupts: rectangular blocks of stale colour overlay the correct image, and the corruption persists for seconds at a time before clearing. The pattern is the textbook signature of H.264 **reference frame loss** — a P-frame's motion vectors are being applied against missing or wrong reference data because an earlier frame in the GOP did not arrive at the decoder.

The corruption is not a decode bug or a bandwidth bug per se. It is the consequence of feeding the WebCodecs decoder a P-frame whose required reference frame was dropped somewhere upstream, with no mechanism to detect or recover from the broken reference chain.

## Pipeline today

```
Android device  →  scrcpy-server (raw H.264 Annex-B)  →  adb forward  →  TCP socket
                                                                              │
                                                              StreamBroadcaster
                                                              (parses NAL units,
                                                               caches SPS/PPS,
                                                               per-viewer backpressure)
                                                                              │
                                                              binary WebSocket
                                                                              │
                                                              decodeFrame()
                                                                              │
                                                              H264Decoder
                                                              (WebCodecs Annex-B)
                                                                              │
                                                              canvas.drawImage()
```

Wire format today (`backend/websocket/h264/wire-format.ts`):

```
[0]      msgType (uint8) — CONFIG=0, KEYFRAME=1, DELTA=2
[1..8]   captureTimestamp (uint64 BE, ms)
[9..]    NAL data (Annex-B, with start code prefix)
```

scrcpy is started with `control=false` and `raw_stream=true` (`live-stream.ts:783-796`), so there is no upstream control channel and no per-frame metadata header from scrcpy.

## Failure modes

These are the concrete ways the reference chain breaks today. Each has to be addressed for the feed to be reliably correct, not just usually correct.

### F1. P-frame drops without keyframe recovery
[`backend/websocket/h264/backpressure.ts:71-72`](../backend/websocket/h264/backpressure.ts#L71-L72) — when a viewer's WebSocket `bufferedAmount` exceeds `HIGH_WATER` (2 MB), the broadcaster drops individual DELTA frames until the buffer drains below `LOW_WATER` (256 KB). Subsequent DELTAs (with broken references) are still sent. The decoder has no way to know a reference is missing; it produces corrupt output until the next IDR, which is on scrcpy's encoder schedule (seconds away).

### F2. Decoder errors swallowed
[`frontend/lib/video/h264-decoder.ts:62-66`](../frontend/lib/video/h264-decoder.ts#L62-L66) — when `VideoDecoder.decode()` throws, the error goes to `onError` which logs to console. The decoder is not reset, no IDR is requested, the next chunk is fed in regardless.

### F3. No upstream keyframe channel
scrcpy is started with `control=false`. There is no way for the backend, let alone the frontend, to ask the encoder for an immediate IDR. The system waits for the next scheduled keyframe.

### F4. SPS/PPS staleness on reset
[`stream-broadcaster.ts:31-44`](../backend/websocket/h264/stream-broadcaster.ts#L31-L44) — the broadcaster sends cached SPS/PPS to a new viewer on join. But during normal streaming, CONFIG is only re-emitted when scrcpy itself emits new SPS/PPS or when a fresh viewer joins. If the frontend decoder ever needs to reset mid-stream, it has to wait for the next CONFIG, which may not come for many seconds. (Current code has no path that resets the decoder, but every recovery scheme proposed below needs this to work.)

### F5. No visibility
There are no metrics for dropped frames, decoder errors, or gap counts. Corruption events are invisible unless a human is watching a feed and reports it. There is no way to measure whether a fix worked.

## Design principles

1. **Never feed the decoder a frame whose reference chain is broken.** If we can't guarantee the chain, we wait for the next clean IDR.
2. **Drops must be observable, not silent.** Every drop — backend backpressure, network, decoder error — produces a logged event that ends up in metrics.
3. **Recovery is bounded.** Every failure mode has a defined path back to a clean stream within a known time bound (target: <2s after detection).
4. **No constant bandwidth tax.** We do not solve this by shortening the keyframe interval; that costs bandwidth on every healthy stream to mitigate a fault that occurs occasionally.
5. **Pure functions where possible, integration points kept thin.** Decision logic stays unit-testable; only the wire-up (sockets, scrcpy spawn, WebSocket forwarding) touches I/O.

## Step 1 — Sequence numbers + passive gap detection

The passive instrumentation layer everything else builds on. Extend the wire format with a per-viewer monotonic frame ID. The broadcaster increments the ID for **every** frame it considers, even ones it drops. The frontend tracks the last received ID and detects gaps directly: any time `received.frameId > lastReceived.frameId + 1`, a gap of `received.frameId - lastReceived.frameId - 1` frames occurred between us and the broadcaster.

This is purely observational. No frames are dropped or recovered differently than today. The point of step 1 is to put a number on the problem before we change anything else, so steps 2–4 can be evaluated against a measured baseline.

**Wire format v2:**

```
[0]      version (uint8) = 2          ← new
[1]      msgType (uint8)
[2..9]   captureTimestamp (uint64 BE)
[10..13] frameId (uint32 BE)          ← new, per-viewer monotonic
[14..]   NAL data
```

Header grows from 9 to 14 bytes. The version byte lets a frontend detect a backend that is older or newer than it expects (e.g. during dev-time HMR drift) and surface a clear error rather than mis-parsing as garbage NAL data.

**Per-viewer counter:** `frameId` is per-viewer because the backpressure and "has received keyframe" gating is per-viewer; a single global counter would create gaps across viewers that share a stream which are not semantically meaningful to any individual viewer's decoder.

**Increment on every decision, send or drop:** if we only incremented on send, the frontend would see a clean sequence and be unable to distinguish "no drops" from "drops we hid from you". Incrementing on drop is what makes the counter useful.

Subsequent workstreams (bidirectional keyframe requests, bounded encoder-side corruption recovery, GOP-aware backpressure, SPS/PPS re-emission, in-UI metrics) are tracked in [`ROADMAP.md`](../ROADMAP.md#video-streaming-reliability). To verify changes that touch this pipeline before merging, work through [`testing-video-pipeline.md`](testing-video-pipeline.md).

## Non-goals

- **CRC / frame integrity validation.** TCP+WebSocket already cover bit integrity. Our problem is missing bytes, not wrong bytes. CRCs would catch a class of failures we have no evidence of seeing.
- **Codec change.** H.264 is fine; AV1/HEVC do not solve reference-chain loss.
- ~~**Shorter keyframe interval as the fix.**~~ Originally listed as a non-goal under the assumption that all corruption was caused by our drops. Step 2.5 (2026-05-02) accepted a 4 s interval after field testing showed encoder-side corruption that the gap detector cannot see. Bandwidth cost is bounded (+10–20% on the chosen bitrate) and only applies to a stream the user already chose to receive.
- **Forward error correction.** Reasonable for unreliable transports; we have a reliable transport (WebSocket over TCP). The drops are at the application layer (our backpressure), not the transport layer.

