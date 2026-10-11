import { randomUUID } from 'node:crypto';

export interface PendingEntry {
  requestId: string;
  keyId: string;
  /** Base64 of the 524-byte key blob. */
  publicKey: string;
  fingerprint: string;
  comment: string;
  deviceId: string;
  peerIp: string;
  createdAt: number;
}

export type PendingDecision = 'approved' | 'denied' | 'replaced' | 'timeout' | 'cancelled';

export type AddResult =
  | { ok: true; entry: PendingEntry; decision: Promise<PendingDecision>; cancel(): void }
  | { ok: false; reason: 'cap' | 'rate' };

export interface PendingOptions {
  maxPending?: number;
  perIpPerMinute?: number;
  timeoutMs?: number;
  onChange?: () => void;
}

interface Slot {
  entry: PendingEntry;
  settle(decision: PendingDecision): void;
  timer: NodeJS.Timeout;
}

const WINDOW_MS = 60_000;

export class PendingRegistry {
  private readonly slots = new Map<string, Slot>();
  private readonly ipHits = new Map<string, number[]>();
  private readonly maxPending: number;
  private readonly perIpPerMinute: number;
  private readonly timeoutMs: number;
  private readonly onChange?: () => void;

  constructor(opts: PendingOptions = {}) {
    this.maxPending = opts.maxPending ?? 20;
    this.perIpPerMinute = opts.perIpPerMinute ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 5 * 60_000;
    this.onChange = opts.onChange;
  }

  add(input: Omit<PendingEntry, 'requestId' | 'createdAt'>): AddResult {
    const same = [...this.slots.values()].find((s) => s.entry.keyId === input.keyId && s.entry.deviceId === input.deviceId);
    if (!same) {
      if (this.slots.size >= this.maxPending) return { ok: false, reason: 'cap' };
      if (!this.takeRate(input.peerIp)) return { ok: false, reason: 'rate' };
    } else {
      this.finish(same.entry.requestId, 'replaced');
    }
    const entry: PendingEntry = { ...input, requestId: randomUUID(), createdAt: Date.now() };
    let settle!: (d: PendingDecision) => void;
    const decision = new Promise<PendingDecision>((resolve) => { settle = resolve; });
    const timer = setTimeout(() => this.finish(entry.requestId, 'timeout'), this.timeoutMs);
    timer.unref?.();
    this.slots.set(entry.requestId, { entry, settle, timer });
    this.onChange?.();
    return { ok: true, entry, decision, cancel: () => { this.finish(entry.requestId, 'cancelled'); } };
  }

  list(): PendingEntry[] {
    return [...this.slots.values()].map((s) => s.entry).sort((a, b) => a.createdAt - b.createdAt);
  }

  get(requestId: string): PendingEntry | undefined {
    return this.slots.get(requestId)?.entry;
  }

  resolve(requestId: string, decision: 'approved' | 'denied'): boolean {
    return this.finish(requestId, decision);
  }

  resolveKey(keyId: string, decision: 'approved' | 'denied'): number {
    const ids = [...this.slots.values()].filter((s) => s.entry.keyId === keyId).map((s) => s.entry.requestId);
    for (const id of ids) this.finish(id, decision);
    return ids.length;
  }

  stop(): void {
    for (const id of [...this.slots.keys()]) this.finish(id, 'cancelled');
  }

  private finish(requestId: string, decision: PendingDecision): boolean {
    const slot = this.slots.get(requestId);
    if (!slot) return false;
    clearTimeout(slot.timer);
    this.slots.delete(requestId);
    slot.settle(decision);
    this.onChange?.();
    return true;
  }

  private takeRate(ip: string): boolean {
    const now = Date.now();
    const hits = (this.ipHits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
    if (this.ipHits.size > 256) this.pruneRates(now);
    if (hits.length >= this.perIpPerMinute) {
      this.ipHits.set(ip, hits);
      return false;
    }
    hits.push(now);
    this.ipHits.set(ip, hits);
    return true;
  }

  private pruneRates(now: number): void {
    for (const [ip, hits] of this.ipHits) {
      if (hits.every((t) => now - t >= WINDOW_MS)) this.ipHits.delete(ip);
    }
  }
}
