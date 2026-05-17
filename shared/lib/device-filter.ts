import type { DeviceFilterRule, DeviceFilter } from '../types/api';

/**
 * Evaluate a single filter rule against a device value.
 */
export function evaluateRule(deviceValue: any, operator: DeviceFilterRule['operator'], filterValue: any): boolean {
  if (deviceValue == null) return false;

  switch (operator) {
    case 'eq':
      if (typeof deviceValue === 'string' && typeof filterValue === 'string') {
        return deviceValue.toLowerCase() === filterValue.toLowerCase();
      }
      return deviceValue === filterValue;
    case 'neq':
      if (typeof deviceValue === 'string' && typeof filterValue === 'string') {
        return deviceValue.toLowerCase() !== filterValue.toLowerCase();
      }
      return deviceValue !== filterValue;
    case 'gt':
      return deviceValue > filterValue;
    case 'gte':
      return deviceValue >= filterValue;
    case 'lt':
      return deviceValue < filterValue;
    case 'lte':
      return deviceValue <= filterValue;
    case 'in':
      if (!Array.isArray(filterValue)) return false;
      if (typeof deviceValue === 'string') {
        const lower = deviceValue.toLowerCase();
        return filterValue.some(v => typeof v === 'string' ? v.toLowerCase() === lower : v === deviceValue);
      }
      return filterValue.includes(deviceValue);
    case 'contains':
      return String(deviceValue).toLowerCase().includes(String(filterValue).toLowerCase());
    default:
      return false;
  }
}

/**
 * Check whether a device matches all rules in a DeviceFilter.
 */
export function matchesDeviceFilter(device: Record<string, any>, filter: DeviceFilter): boolean {
  if (filter.deviceIds?.length && !filter.deviceIds.includes(device.id)) return false;
  for (const rule of filter.rules) {
    const deviceValue = device[rule.field];
    if (!evaluateRule(deviceValue, rule.operator, rule.value)) return false;
  }
  return true;
}

/**
 * Generate human-readable warnings for a device that doesn't match filter rules.
 */
export function getFilterWarnings(device: Record<string, any>, filter: DeviceFilter): string[] {
  const warnings: string[] = [];
  if (filter.deviceIds?.length && !filter.deviceIds.includes(device.id)) {
    warnings.push('Not in allowed device list');
  }
  for (const rule of filter.rules) {
    const deviceValue = device[rule.field];
    if (!evaluateRule(deviceValue, rule.operator, rule.value)) {
      const fieldLabel = rule.field;
      const actual = deviceValue ?? 'unknown';
      warnings.push(`${fieldLabel} ${rule.operator} ${JSON.stringify(rule.value)} (actual: ${actual})`);
    }
  }
  return warnings;
}

/**
 * Migrate old-format DeviceFilter to new rule-based format.
 * Old format: { rooted?: boolean, minBattery?: number, deviceIds?, bootloaderLocked?, minApiLevel? }
 * New format: { rules: DeviceFilterRule[], deviceIds?: string[] }
 */
export function migrateDeviceFilter(raw: any): DeviceFilter {
  if (!raw || typeof raw !== 'object') return { rules: [] };
  // Already new format
  if (Array.isArray(raw.rules)) return raw as DeviceFilter;

  // Convert old format
  const rules: DeviceFilterRule[] = [];
  if (raw.rooted === true) {
    rules.push({ field: 'isRooted', operator: 'eq', value: true });
  }
  if (raw.minBattery != null && raw.minBattery > 0) {
    rules.push({ field: 'batteryLevel', operator: 'gte', value: raw.minBattery });
  }
  if (raw.bootloaderLocked !== undefined && raw.bootloaderLocked !== null) {
    rules.push({ field: 'bootloaderLocked', operator: 'eq', value: raw.bootloaderLocked });
  }
  if (raw.minApiLevel != null && raw.minApiLevel > 0) {
    rules.push({ field: 'apiLevel', operator: 'gte', value: raw.minApiLevel });
  }
  return { rules, deviceIds: raw.deviceIds };
}
