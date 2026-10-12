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
