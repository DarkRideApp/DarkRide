import { readFileSync } from 'fs';
import { eq } from 'drizzle-orm';
import type {
  DeviceHTTP,
  TrafficFilter,
  RequestHookCallback,
  ResponseHookCallback,
} from '../../shared/types/automation';
import type { TrafficHookRegistry } from './traffic-hook-registry';
import type { AppDatabase } from '../db';
import { interceptRules, clientCerts } from '../db/schema';
import { syncInterceptConfig } from './intercept-config-writer';

export class DeviceHTTPImpl implements DeviceHTTP {
  private hookIds: string[] = [];

  constructor(
    private deviceId: string,
    private registry: TrafficHookRegistry,
    private db?: AppDatabase,
    private sessionId?: number | null,
  ) {}

  hook(
    filter: TrafficFilter,
    onRequest?: RequestHookCallback,
    onResponse?: ResponseHookCallback,
  ): string {
    const id = this.registry.registerHook(this.deviceId, filter, onRequest, onResponse);
    this.hookIds.push(id);
    return id;
  }

  hookRequest(filter: TrafficFilter, onRequest: RequestHookCallback): string {
    return this.hook(filter, onRequest, undefined);
  }

  hookResponse(filter: TrafficFilter, onResponse: ResponseHookCallback): string {
    return this.hook(filter, undefined, onResponse);
  }

  unhook(hookId: string): void {
    this.registry.removeHook(this.deviceId, hookId);
    this.hookIds = this.hookIds.filter((id) => id !== hookId);
  }

  unhookAll(): void {
    for (const hookId of this.hookIds) {
      this.registry.removeHook(this.deviceId, hookId);
    }
    this.hookIds = [];
  }

  intercept(options: {
    hostname: string;
    path?: string;
    method?: string;
    phase: 'request' | 'response';
    actions: Array<{ type: string; [key: string]: any }>;
  }): number {
    if (!this.db) {
      throw new Error('intercept() requires a database connection (HTTPS capture must be active)');
    }

    const result = this.db.insert(interceptRules).values({
      name: `Script: ${options.hostname}${options.path || ''}`,
      enabled: true,
      matchHostname: options.hostname,
      matchPath: options.path || null,
      matchMethod: options.method || null,
      phase: options.phase,
      actions: JSON.stringify(options.actions),
      deviceFilter: this.deviceId,
      priority: 0,
      sessionId: this.sessionId ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).run();

    syncInterceptConfig(this.db);
    return Number(result.lastInsertRowid);
  }

  useClientCert(options: {
    hostnames: string[];
    certPath: string;
    keyPath: string;
  }): number {
    if (!this.db) {
      throw new Error('useClientCert() requires a database connection (HTTPS capture must be active)');
    }

    const certPem = readFileSync(options.certPath, 'utf8');
    const keyPem = readFileSync(options.keyPath, 'utf8');

    const result = this.db.insert(clientCerts).values({
      name: `Script: ${options.hostnames.join(', ')}`,
      hostnames: JSON.stringify(options.hostnames),
      certPem,
      keyPem,
      enabled: true,
      sessionId: this.sessionId ?? null,
      createdAt: new Date(),
    }).run();

    syncInterceptConfig(this.db);
    return Number(result.lastInsertRowid);
  }
}

export class NoopDeviceHTTP implements DeviceHTTP {
  hook(): string {
    throw new Error('Traffic hooks require HTTPS capture');
  }

  hookRequest(): string {
    throw new Error('Traffic hooks require HTTPS capture');
  }

  hookResponse(): string {
    throw new Error('Traffic hooks require HTTPS capture');
  }

  unhook(): void {
    throw new Error('Traffic hooks require HTTPS capture');
  }

  unhookAll(): void {
    // No-op: nothing to unhook
  }

  intercept(): number {
    throw new Error('intercept() requires HTTPS capture');
  }

  useClientCert(): number {
    throw new Error('useClientCert() requires HTTPS capture');
  }
}
