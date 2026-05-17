import type { AutomationsApi, AutomationRow } from '@darkrideapp/plugin-sdk';
import type { AppDatabase } from '../../db/index';
import { automations } from '../../db/schema';

/**
 * AutomationsApi — read-only listing of host automations.
 *
 * The SDK `AutomationRow` mirrors the `automations` table from
 * backend/db/schema.ts. We map nullable booleans / counts straight through;
 * `enabled` defaults to `true` when null in the DB.
 */
export function createAutomationsApi(db: AppDatabase): AutomationsApi {
  return {
    async list(): Promise<AutomationRow[]> {
      const rows = db.select().from(automations).all();
      return rows.map((r): AutomationRow => ({
        id: r.id,
        name: r.name,
        code: r.code,
        passcode: r.passcode,
        requiresDevice: r.requiresDevice,
        requiresHttpsCapture: r.requiresHttpsCapture,
        timeoutMs: r.timeoutMs,
        isRule: r.isRule,
        isCaptureRule: r.isCaptureRule,
        priority: r.priority,
        enabled: r.enabled,
        schedule: r.schedule,
        deviceFilter: r.deviceFilter,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
    },
  };
}
