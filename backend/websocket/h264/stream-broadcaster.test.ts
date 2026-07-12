import { describe, it, expect, vi } from 'vitest';
import { StreamBroadcaster } from './stream-broadcaster';
import { FrameMsgType, WIRE_VERSION } from './wire-format';

interface FakeWS {
  bufferedAmount: number;
  readyState: number;
  send: ReturnType<typeof vi.fn>;
}

function makeWS(bufferedAmount = 0): FakeWS {
  return { bufferedAmount, readyState: 1, send: vi.fn() };
}

const sc4 = Buffer.from([0x00, 0x00, 0x00, 0x01]);
function nalHeader(type: number): Buffer {
  return Buffer.from([(0x60 | (type & 0x1f))]);
}

function frameIdOf(buf: Buffer): number {
  return buf.readUInt32BE(10);
}
function msgTypeOf(buf: Buffer): number {
  return buf[1];
}

describe('StreamBroadcaster', () => {
  it('forwards SPS+PPS+IDR as config + keyframe to a fresh viewer', () => {
    const bc = new StreamBroadcaster(() => 1000);
    const ws = makeWS();
    bc.addViewer('v1', ws as any);

    const stream = Buffer.concat([
      sc4, nalHeader(7), Buffer.from([0xaa]),
      sc4, nalHeader(8), Buffer.from([0xbb]),
      sc4, nalHeader(5), Buffer.from([0xcc]),
    ]);
    bc.ingest(stream);

    expect(ws.send.mock.calls.length).toBeGreaterThanOrEqual(2);
    const firstCall = ws.send.mock.calls[0][0] as Buffer;
    expect(firstCall[0]).toBe(WIRE_VERSION);
    expect(msgTypeOf(firstCall)).toBe(FrameMsgType.CONFIG);
  });

  it('caches SPS/PPS so a viewer joining after config gets it on connect', () => {
    const bc = new StreamBroadcaster(() => 1000);

    bc.ingest(Buffer.concat([
      sc4, nalHeader(7), Buffer.from([0xaa]),
      sc4, nalHeader(8), Buffer.from([0xbb]),
    ]));

    const ws = makeWS();
    bc.addViewer('v2', ws as any);

    expect(ws.send).toHaveBeenCalledTimes(1);
    const sent = ws.send.mock.calls[0][0] as Buffer;
    expect(msgTypeOf(sent)).toBe(FrameMsgType.CONFIG);
  });

  it('drops delta frames to a viewer with bufferedAmount above HIGH', () => {
    const bc = new StreamBroadcaster(() => 1000);
    const ws = makeWS(3 * 1024 * 1024); // above HIGH_WATER
    bc.addViewer('v1', ws as any);

    bc.ingest(Buffer.concat([
      sc4, nalHeader(7), Buffer.from([0xaa]),
      sc4, nalHeader(8), Buffer.from([0xbb]),
      sc4, nalHeader(5), Buffer.from([0xcc]),
    ]));
    ws.send.mockClear();

    bc.ingest(Buffer.concat([sc4, nalHeader(1), Buffer.from([0xdd])]));
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('drops (never resets the stream) for a viewer buried past hard cap', () => {
    // A single slow viewer must not restart the shared encoder — it just gets
    // its frames dropped until it catches up and resyncs on a keyframe.
    const onReset = vi.fn();
    const bc = new StreamBroadcaster(() => 1000, { onResetRequested: onReset });
    const ws = makeWS(9 * 1024 * 1024); // way above HARD_CAP
    bc.addViewer('v1', ws as any);
    ws.send.mockClear();

    bc.ingest(Buffer.concat([sc4, nalHeader(1), Buffer.from([0xdd])]));
    expect(onReset).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('removeViewer stops sending to that viewer', () => {
    const bc = new StreamBroadcaster(() => 1000);
    const ws = makeWS();
    bc.addViewer('v1', ws as any);
    bc.removeViewer('v1');

    bc.ingest(Buffer.concat([
      sc4, nalHeader(7), Buffer.from([0xaa]),
      sc4, nalHeader(5), Buffer.from([0xbb]),
    ]));
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('reset() clears cached SPS/PPS and viewer states', () => {
    const bc = new StreamBroadcaster(() => 1000);
    bc.ingest(Buffer.concat([sc4, nalHeader(7), Buffer.from([0xaa])]));
    bc.reset();

    const ws = makeWS();
    bc.addViewer('v1', ws as any);
    expect(ws.send).not.toHaveBeenCalled(); // no cached config
  });

  it('isHealthy returns false when there are no viewers', () => {
    const bc = new StreamBroadcaster(() => 1000);
    expect(bc.isHealthy()).toBe(false);
  });

  it('isHealthy returns true when all viewers are in NORMAL state', () => {
    const bc = new StreamBroadcaster(() => 1000);
    bc.addViewer('v1', makeWS() as any);
    expect(bc.isHealthy()).toBe(true);
  });

  describe('ingest stats', () => {
    it('reports ingested video-frame fps via onIngestStats about once per interval', () => {
      let t = 0;
      const onIngestStats = vi.fn();
      const bc = new StreamBroadcaster(() => t, { onIngestStats });

      // Two video frames (IDR + delta) inside the first window.
      bc.ingest(Buffer.concat([sc4, nalHeader(5), Buffer.from([0xaa])])); // IDR
      bc.ingest(Buffer.concat([sc4, nalHeader(1), Buffer.from([0xbb])])); // delta
      expect(onIngestStats).not.toHaveBeenCalled();

      t = 2001;
      bc.ingest(Buffer.concat([sc4, nalHeader(1), Buffer.from([0xcc])])); // delta → crosses window
      expect(onIngestStats).toHaveBeenCalledTimes(1);
      const info = onIngestStats.mock.calls[0][0];
      expect(info.frames).toBe(3);
      expect(info.fps).toBeGreaterThan(0);
    });

    it('does not count SPS/PPS/SEI as video frames', () => {
      let t = 0;
      const onIngestStats = vi.fn();
      const bc = new StreamBroadcaster(() => t, { onIngestStats });
      bc.ingest(Buffer.concat([
        sc4, nalHeader(7), Buffer.from([0xaa]), // SPS
        sc4, nalHeader(8), Buffer.from([0xbb]), // PPS
        sc4, nalHeader(5), Buffer.from([0xcc]), // IDR (counts)
      ]));
      t = 2001;
      bc.ingest(Buffer.concat([sc4, nalHeader(1), Buffer.from([0xdd])])); // delta (counts) → fires
      expect(onIngestStats.mock.calls[0][0].frames).toBe(2);
    });
  });

  describe('join keyframe', () => {
    it('invokes onKeyframeWanted with the viewer id when a viewer joins', () => {
      const onKeyframeWanted = vi.fn();
      const bc = new StreamBroadcaster(() => 1000, { onKeyframeWanted });
      bc.addViewer('v1', makeWS() as any);
      expect(onKeyframeWanted).toHaveBeenCalledWith('v1');
    });

    it('requests a join keyframe even before any SPS/PPS is cached', () => {
      // A viewer joining a just-started stream (no config cached yet) should
      // still trigger a keyframe request so the first decodable frame lands
      // fast rather than waiting a full GOP.
      const onKeyframeWanted = vi.fn();
      const bc = new StreamBroadcaster(() => 1000, { onKeyframeWanted });
      const ws = makeWS();
      bc.addViewer('v1', ws as any);
      expect(ws.send).not.toHaveBeenCalled(); // no cached config
      expect(onKeyframeWanted).toHaveBeenCalledTimes(1);
    });

    it('does not throw when onKeyframeWanted is not provided', () => {
      const bc = new StreamBroadcaster(() => 1000);
      expect(() => bc.addViewer('v1', makeWS() as any)).not.toThrow();
    });
  });

  describe('frameId', () => {
    it('first frame sent to a fresh viewer has frameId=1', () => {
      const bc = new StreamBroadcaster(() => 1000);
      const ws = makeWS();
      bc.addViewer('v1', ws as any);

      bc.ingest(Buffer.concat([
        sc4, nalHeader(7), Buffer.from([0xaa]),
        sc4, nalHeader(8), Buffer.from([0xbb]),
        sc4, nalHeader(5), Buffer.from([0xcc]),
      ]));

      const first = ws.send.mock.calls[0][0] as Buffer;
      expect(frameIdOf(first)).toBe(1);
    });

    it('frameId increments monotonically across frames sent to one viewer', () => {
      const bc = new StreamBroadcaster(() => 1000);
      const ws = makeWS();
      bc.addViewer('v1', ws as any);

      bc.ingest(Buffer.concat([
        sc4, nalHeader(7), Buffer.from([0xaa]),
        sc4, nalHeader(8), Buffer.from([0xbb]),
        sc4, nalHeader(5), Buffer.from([0xcc]),  // IDR  → CONFIG + KEYFRAME
        sc4, nalHeader(1), Buffer.from([0xdd]),  // delta
        sc4, nalHeader(1), Buffer.from([0xee]),  // delta
      ]));

      const ids = ws.send.mock.calls.map((c: any[]) => frameIdOf(c[0] as Buffer));
      // Strictly increasing
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i]).toBeGreaterThan(ids[i - 1]);
      }
    });

    it('drops still consume frameIds — gap appears in the next sent frame', () => {
      const bc = new StreamBroadcaster(() => 1000);

      // Bring viewer to a state where deltas are dropped (above HIGH_WATER).
      const ws = makeWS(3 * 1024 * 1024);
      bc.addViewer('v1', ws as any);

      // Send SPS+PPS+IDR while bufferedAmount is high — first send transitions
      // the viewer to DROPPING; subsequent deltas are silently dropped.
      bc.ingest(Buffer.concat([
        sc4, nalHeader(7), Buffer.from([0xaa]),  // SPS — config (always sent)
        sc4, nalHeader(8), Buffer.from([0xbb]),  // PPS — config (always sent)
        sc4, nalHeader(5), Buffer.from([0xcc]),  // IDR — config (allocated 3) + keyframe (allocated 4, dropped at HIGH_WATER)
      ]));

      // Now drain the buffer and feed deltas. Each delta still consumes a
      // frameId on the broadcaster side — when bufferedAmount drops and the
      // next keyframe is delivered, its frameId should reflect the consumed
      // (dropped) IDs in between.
      ws.bufferedAmount = 0;
      ws.send.mockClear();

      bc.ingest(Buffer.concat([
        sc4, nalHeader(1), Buffer.from([0xdd]),  // delta (dropped — DROPPING + bufferedAmount low only releases on keyframe)
        sc4, nalHeader(1), Buffer.from([0xee]),  // delta (dropped)
        sc4, nalHeader(7), Buffer.from([0xaa]),  // SPS
        sc4, nalHeader(8), Buffer.from([0xbb]),  // PPS
        sc4, nalHeader(5), Buffer.from([0xff]),  // IDR — should emit
      ]));

      // The next sent frame's ID should be > the previous-sent ID + 1, proving
      // that the backpressure-dropped frames consumed IDs.
      const sentAfter = ws.send.mock.calls.map((c: any[]) => frameIdOf(c[0] as Buffer));
      expect(sentAfter.length).toBeGreaterThan(0);
      // Earlier we sent up to id=3 (or thereabouts). Next sent should not be id=4.
      expect(sentAfter[0]).toBeGreaterThan(4);
    });

    it('different viewers maintain independent frameId counters', () => {
      const bc = new StreamBroadcaster(() => 1000);
      const wsA = makeWS();
      const wsB = makeWS();
      bc.addViewer('a', wsA as any);

      bc.ingest(Buffer.concat([
        sc4, nalHeader(7), Buffer.from([0xaa]),
        sc4, nalHeader(8), Buffer.from([0xbb]),
        sc4, nalHeader(5), Buffer.from([0xcc]),
      ]));

      // Now add a second viewer mid-stream; their counter should still start at 1.
      bc.addViewer('b', wsB as any);
      const firstSentToB = wsB.send.mock.calls[0][0] as Buffer;
      expect(frameIdOf(firstSentToB)).toBe(1);

      // And a's counter is well past 1.
      const lastSentToA = wsA.send.mock.calls[wsA.send.mock.calls.length - 1][0] as Buffer;
      expect(frameIdOf(lastSentToA)).toBeGreaterThan(1);
    });

    it('all sent frames carry the wire version byte', () => {
      const bc = new StreamBroadcaster(() => 1000);
      const ws = makeWS();
      bc.addViewer('v1', ws as any);

      bc.ingest(Buffer.concat([
        sc4, nalHeader(7), Buffer.from([0xaa]),
        sc4, nalHeader(8), Buffer.from([0xbb]),
        sc4, nalHeader(5), Buffer.from([0xcc]),
        sc4, nalHeader(1), Buffer.from([0xdd]),
      ]));

      for (const call of ws.send.mock.calls) {
        const buf = call[0] as Buffer;
        expect(buf[0]).toBe(WIRE_VERSION);
      }
    });
  });
});
