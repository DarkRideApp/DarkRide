/**
 * Row shapes for host tables that plugins read/write through ctx wrappers.
 * Stable structural types — backend can refactor the underlying schema as long
 * as the row shape stays compatible.
 */

export interface CloudFileRow {
  id: number;
  namespace: string;
  relativePath: string;
  cloudKey: string;
  fileType: string;
  fileSize: number;
  syncState: string;
  syncError: string | null;
  retain: boolean;
  lastAccessed: Date;
  createdAt: Date;
}

export interface AutomationRow {
  id: number;
  name: string;
  code: string;
  passcode: string;
  requiresDevice: boolean;
  requiresHttpsCapture: boolean | null;
  timeoutMs: number | null;
  isRule: boolean | null;
  isCaptureRule: boolean | null;
  priority: number | null;
  enabled: boolean | null;
  /** JSON-stringified ScheduleConfig | null. */
  schedule: string | null;
  /** JSON-stringified DeviceFilter | null. */
  deviceFilter: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApkHandle {
  versionId: number;
  /** Pass to ctx.apks.* methods. Treat as opaque — fields beyond versionId
   *  are host-implementation-defined. */
}

export interface ApkVersionMeta {
  versionId: number;
  packageName: string;
  versionName: string;
  versionCode: number;
}
