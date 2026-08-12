/**
 * Shared contract for remote APK sources (network app stores).
 *
 * A "remote source" answers two questions about a package name: what's the
 * latest version, and give me the APK file. Device scraping is deliberately
 * NOT a RemoteApkSource — it operates per connected device via ADB rather than
 * a package query, so it stays a dedicated path in ApkTracker. Device is still
 * a known source *id* for provenance + labelling (see SOURCE_LABELS).
 */

export interface VersionCheckResult {
  /** Display version, e.g. "6.0.28". Always present. */
  versionName: string;
  /** Store's display name for the app, if known. */
  appName?: string;
  /** Android versionCode, when the source exposes it (QQ does; gplay does not). */
  versionCode?: number;
  /** Expected file size in bytes, when known. */
  fileSize?: number;
  /** Expected sha256 (hex), when the source publishes one (QQ does). */
  sha256?: string;
  /**
   * Store-listing metadata, when the source's version check happens to carry it.
   *
   * These exist so a consumer can describe a release without a second request:
   * the Play check already receives icon, release notes, size and an updated
   * timestamp in the same response it reads the version from, and used to throw
   * them away. All optional — a source that does not publish release notes just
   * leaves them undefined, and nothing downstream should require them.
   */
  /** Store listing icon URL. */
  iconUrl?: string;
  /** "What's new" text for this version. */
  releaseNotes?: string;
  /** Download size as the store DISPLAYS it (e.g. "24M"), not bytes. */
  sizeLabel?: string;
  /** When the STORE says the listing was last updated. */
  storeUpdatedAt?: Date;
}

export interface DownloadResult {
  success: boolean;
  /** Absolute path to a single staged `.apk` file (the non-bundle case). */
  filePath?: string;
  /**
   * Absolute path to a staged DIRECTORY holding `base.apk` + its config/density/
   * ABI splits, produced when the source served an XAPK/APKS bundle. Mutually
   * exclusive with `filePath`. The ingest path renames this directory into the
   * package store and tracks each child APK individually (native libs ship in
   * the splits, so the whole set must survive — not just `base.apk`).
   */
  splitDir?: string;
  versionCode?: number;
  versionName?: string;
  fileSize?: number;
  error?: string;
}

export interface RemoteApkSource {
  /** Stable id stored in app_sources.source + apk_versions.source. */
  readonly id: string;
  /** Human label for the UI. */
  readonly label: string;
  /** Whether the source is usable (e.g. has required credentials). */
  isConfigured(): boolean;
  /** Default `enabled` for a freshly-tracked app's app_sources row. */
  defaultEnabled(): boolean;
  /**
   * Latest version for a package. Returns null when the app simply isn't
   * available on this source (a normal, non-error outcome). Throws on
   * transient/unexpected failures (network, HTTP, parse) so the caller can
   * record a per-source lastError.
   */
  checkVersion(packageName: string): Promise<VersionCheckResult | null>;
  /** Download the latest APK to disk under data/apks/<package>/. */
  downloadApk(packageName: string, appName?: string): Promise<DownloadResult>;
  /** Best-effort: fetch an app icon to data/apks/<package>/icon.png. */
  fetchIcon?(packageName: string): Promise<boolean>;
  /**
   * Public web URL for this package's listing on the store, for a "view on
   * store" link. Pure string-building (no network); the page may 404 if the
   * app isn't actually listed — pair it with checkVersion() for availability.
   */
  storeUrl?(packageName: string): string;
}

/** Display labels for every known source id (remote + device + upload). */
export const SOURCE_LABELS: Record<string, string> = {
  device: 'Device',
  playstore: 'Play Store',
  qq: 'QQ App Store (应用宝)',
  huawei: 'Huawei AppGallery',
  apkpure: 'APKPure',
  xiaomi: 'Xiaomi GetApps (小米应用商店)',
  upload: 'Upload',
};

export function sourceLabel(id: string): string {
  return SOURCE_LABELS[id] ?? id;
}
