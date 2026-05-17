export interface RawFrame {
  id: number;
  direction: 'send' | 'receive';
  opcode: string;
  payload: string | null;  // base64 for binary
  isBinary: boolean;
  payloadSize: number;
  timestamp: string;
}

export interface DecodedMessage {
  messageNumber: number;
  type: string;             // 'request' | 'response' | 'error' | 'ack'
  typeLabel: string;        // 'REQ' | 'RPY' | 'ERR' | 'ACK'
  direction: 'send' | 'receive';
  properties: Record<string, string>;
  body: string | null;
  bodySize: number;
  timestamp: string;        // from first frame
  flags: string[];          // ['urgent', 'noreply', 'compressed']
  rawFrameIds: number[];    // frame IDs this message was assembled from
  error?: string;           // decode error if any
}

export interface ProtocolDecoder {
  id: string;           // e.g. 'blip'
  name: string;         // e.g. 'My Protocol Decoder'
  detect(headers: Record<string, string>): boolean;
  decodeFrames(frames: RawFrame[]): DecodedMessage[];
}
