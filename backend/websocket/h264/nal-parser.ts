export enum NalType {
  NON_IDR = 1,
  IDR = 5,
  SEI = 6,
  SPS = 7,
  PPS = 8,
  AUD = 9,
}

export interface NalUnit {
  type: NalType | number;
  data: Buffer; // NAL header byte + RBSP, no start code
}

/**
 * Parse Annex-B framed H.264 into individual NAL units.
 * Splits on 0x000001 / 0x00000001 start codes.
 */
export function parseNalUnits(stream: Buffer): NalUnit[] {
  const units: NalUnit[] = [];
  if (stream.length < 4) return units;

  const offsets: number[] = [];
  let i = 0;
  while (i < stream.length - 2) {
    if (stream[i] === 0 && stream[i + 1] === 0) {
      if (stream[i + 2] === 1) {
        offsets.push(i + 3);
        i += 3;
        continue;
      }
      if (i + 3 < stream.length && stream[i + 2] === 0 && stream[i + 3] === 1) {
        offsets.push(i + 4);
        i += 4;
        continue;
      }
    }
    i += 1;
  }

  for (let k = 0; k < offsets.length; k++) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? findStartCodeEnd(stream, offsets[k + 1]) : stream.length;
    if (end <= start) continue;
    const data = stream.subarray(start, end);
    const type = data[0] & 0x1f;
    units.push({ type, data });
  }

  return units;
}

function findStartCodeEnd(stream: Buffer, nextNalStart: number): number {
  // The start code preceding nextNalStart is either 3 or 4 bytes.
  // Walk back to find where it began.
  let p = nextNalStart - 3;
  if (p > 0 && stream[p - 1] === 0) p -= 1;
  return p;
}
