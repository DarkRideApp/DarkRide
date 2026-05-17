import { eq } from 'drizzle-orm';
import { systemState, type RestartRequiredState } from '../db/schema';
import type { AppDatabase } from '../db/index';

const RESTART_REQUIRED_KEY = 'restart_required';

type Broadcast = (message: Record<string, any>) => void;

export type { RestartRequiredState };

export class SystemStateService {
  constructor(private db: AppDatabase, private broadcast: Broadcast) {}

  getRestartRequired(): RestartRequiredState | null {
    const row = this.db
      .select()
      .from(systemState)
      .where(eq(systemState.key, RESTART_REQUIRED_KEY))
      .get();
    if (!row) return null;
    return row.value;
  }

  setRestartRequired(reason: string): void {
    const wasUnset = this.getRestartRequired() === null;
    const value: RestartRequiredState = { reason, since: Math.floor(Date.now() / 1000) };
    const now = new Date();
    this.db
      .insert(systemState)
      .values({ key: RESTART_REQUIRED_KEY, value, updatedAt: now })
      .onConflictDoUpdate({
        target: systemState.key,
        set: { value, updatedAt: now },
      })
      .run();
    if (wasUnset) {
      this.broadcast({ type: 'system:restart-required', reason, since: value.since });
    }
  }

  clearRestartRequired(): void {
    const current = this.getRestartRequired();
    if (!current) return;
    this.db.delete(systemState).where(eq(systemState.key, RESTART_REQUIRED_KEY)).run();
    this.broadcast({ type: 'system:restart-cleared' });
  }
}
