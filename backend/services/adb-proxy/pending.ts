import { randomUUID } from 'node:crypto';
import { createLoggers } from '../../logs';

const { error: logError } = createLoggers('adb-proxy');

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
const MAX_TRACKED_IPS = 4096;

export class PendingRegistry {
  private readonly slots = new Map<string, Slot>();
  private readonly ipHits = new Map<string, number[]>();
  private stopped = false;
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
    if (this.stopped) return { ok: false, reason: 'cap' };
    const same = [...this.slots.values()].find((s) => s.entry.keyId === input.keyId && s.entry.deviceId === input.deviceId);
    if (!same) {
      if (this.slots.size >= this.maxPending) return { ok: false, reason: 'cap' };
      if (!this.takeRate(input.peerIp)) return { ok: false, reason: 'rate' };
    } else {
      this.detach(same.entry.requestId, 'replaced');
    }
    const entry: PendingEntry = { ...input, requestId: randomUUID(), createdAt: Date.now() };
    let settle!: (d: PendingDecision) => void;
    const decision = new Promise<PendingDecision>((resolve) => { settle = resolve; });
    const timer = setTimeout(() => this.finish(entry.requestId, 'timeout'), this.timeoutMs);
    timer.unref?.();
    this.slots.set(entry.requestId, { entry, settle, timer });
    this.notify();
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
    this.stopped = true;
    for (const id of [...this.slots.keys()]) this.finish(id, 'cancelled');
  }

  /** Remove a slot and settle its promise without notifying, so a replacement can notify once. */
  private detach(requestId: string, decision: PendingDecision): boolean {
    const slot = this.slots.get(requestId);
    if (!slot) return false;
    clearTimeout(slot.timer);
    this.slots.delete(requestId);
    slot.settle(decision);
    return true;
  }

  private finish(requestId: string, decision: PendingDecision): boolean {
    if (!this.detach(requestId, decision)) return false;
    this.notify();
    return true;
  }

  /** A throwing listener must not unwind out of a timer callback or leave the registry half updated. */
  private notify(): void {
    try {
      this.onChange?.();
    } catch (err) {
      logError(`pending onChange threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private takeRate(ip: string): boolean {
    const now = Date.now();
    const hits = (this.ipHits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
    if (this.ipHits.size > 256) this.pruneRates(now);
    if (!this.ipHits.has(ip) && this.ipHits.size >= MAX_TRACKED_IPS) return false;
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
