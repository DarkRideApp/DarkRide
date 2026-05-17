import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { interceptRules, clientCerts } from '../db/schema';
import { eq, asc } from 'drizzle-orm';
import type { AppDatabase } from '../db';

export function getInterceptConfigPath(): string {
  return path.resolve('./data/intercept-config.json');
}

export function syncInterceptConfig(db: AppDatabase): string {
  const ruleRows = db
    .select()
    .from(interceptRules)
    .where(eq(interceptRules.enabled, true))
    .orderBy(asc(interceptRules.priority))
    .all();

  const certRows = db
    .select()
    .from(clientCerts)
    .where(eq(clientCerts.enabled, true))
    .all();

  // Normalize action types from frontend convention (underscore) to Python bridge convention (hyphen)
  const ACTION_TYPE_MAP: Record<string, string> = {
    json_patch: 'json-patch',
    set_header: 'header-set',
    remove_header: 'header-remove',
    status_code: 'status-code',
    replace_body: 'replace-body',
    rewrite_url: 'rewrite-url',
  };

  const FIELD_MAP: Record<string, (a: any) => any> = {
    'status-code': (a) => {
      if ('code' in a && !('value' in a)) return { ...a, value: a.code };
      return a;
    },
  };

  function normalizeActions(actions: any[]): any[] {
    return actions.map((a) => {
      const mapped = { ...a, type: ACTION_TYPE_MAP[a.type] || a.type };
      const fieldFn = FIELD_MAP[mapped.type];
      return fieldFn ? fieldFn(mapped) : mapped;
    });
  }

  const rules = ruleRows.map(r => ({
    id: r.id,
    name: r.name,
    matchHostname: r.matchHostname,
    matchPath: r.matchPath ?? null,
    matchMethod: r.matchMethod ?? null,
    matchStatusCode: r.matchStatusCode ?? null,
    matchHeader: r.matchHeader ?? null,
    matchBody: r.matchBody ?? null,
    phase: r.phase,
    actions: normalizeActions(JSON.parse(r.actions)),
    deviceFilter: r.deviceFilter ? JSON.parse(r.deviceFilter) : null,
    priority: r.priority,
  }));

  const certs = certRows.map(c => ({
    id: c.id,
    name: c.name,
    hostnames: JSON.parse(c.hostnames),
    certPem: c.certPem,
    keyPem: c.keyPem,
  }));

  const config = { rules, clientCerts: certs };
  const filePath = getInterceptConfigPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(config));
  return filePath;
}
