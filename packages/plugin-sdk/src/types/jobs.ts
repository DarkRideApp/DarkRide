export interface PluginJob {
  id: string;
  name: string;
  description: string;
  category: 'maintenance' | 'sync' | 'analysis';
  defaultSchedule: string;
  canRunManually?: boolean;
  run: () => Promise<void>;
  getLastRunAt?: () => number | null;
}
