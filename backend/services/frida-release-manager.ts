import { eq, desc } from 'drizzle-orm';
import path from 'path';
import fs from 'fs';
import { execSync, execFileSync } from 'child_process';
import { fridaReleases, settings } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { createLoggers } from '../logs';

const isWindows = process.platform === 'win32';
const venvPython = isWindows
  ? path.resolve(process.cwd(), '.venv', 'Scripts', 'python.exe')
  : path.resolve(process.cwd(), '.venv', 'bin', 'python3');

const { log, error } = createLoggers('frida-release');

const GITHUB_API_URL = 'https://api.github.com/repos/frida/frida/releases';
const MAX_RELEASES = 20;
const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const ARM64_ASSET_PATTERN = /frida-server-[\d.]+-android-arm64\.xz$/;
const ARM64_GADGET_PATTERN = /frida-gadget-[\d.]+-android-arm64\.so\.xz$/;

interface GitHubRelease {
  tag_name: string;
  published_at: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
  }>;
}

export class FridaReleaseManager {
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;

  constructor(
    private db: AppDatabase,
    private dataDir: string = './data/frida-server',
  ) {}

  private cachedClientVersion: string | null | undefined = undefined;

  async start(): Promise<void> {
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.syncTimer = setInterval(() => {
      this.syncIfStale().catch(err => error(`Periodic sync failed: ${err.message}`));
    }, SYNC_INTERVAL_MS);
    await this.syncIfStale();
  }

  stop(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  async syncIfStale(): Promise<void> {
    const lastSync = this.getLastSyncTime();
    if (lastSync && Date.now() - lastSync.getTime() < SYNC_INTERVAL_MS) {
      return;
    }
    await this.syncReleases();
  }

  async syncReleases(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      log('Syncing Frida releases from GitHub...');
      const response = await fetch(`${GITHUB_API_URL}?per_page=${MAX_RELEASES}`, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!response.ok) {
        throw new Error(`GitHub API returned ${response.status}`);
      }
      const releases: GitHubRelease[] = await response.json() as GitHubRelease[];
      let added = 0;
      for (const release of releases) {
        const version = release.tag_name.replace(/^frida-/, '');
        const arm64Asset = release.assets.find(a => ARM64_ASSET_PATTERN.test(a.name));
        if (!arm64Asset) continue;

        const gadgetAsset = release.assets.find((a: any) => ARM64_GADGET_PATTERN.test(a.name));

        const existing = this.db.select().from(fridaReleases).where(eq(fridaReleases.version, version)).all()[0];
        if (existing) continue;

        this.db.insert(fridaReleases).values({
          version,
          downloadUrl: arm64Asset.browser_download_url,
          releaseDate: new Date(release.published_at),
          isDownloaded: false,
          gadgetDownloadUrl: gadgetAsset?.browser_download_url ?? null,
        }).run();
        added++;
      }
      this.upsertSetting('frida_last_sync', new Date().toISOString());
      log(`Frida release sync complete: ${added} new, ${releases.length} total from GitHub`);
    } catch (err: any) {
      error(`Failed to sync Frida releases: ${err.message}`);
    } finally {
      this.syncing = false;
    }
  }

  getReleases(): Array<typeof fridaReleases.$inferSelect> {
    return this.db.select().from(fridaReleases).orderBy(desc(fridaReleases.id)).all();
  }

  getRelease(version: string): typeof fridaReleases.$inferSelect | undefined {
    return this.db.select().from(fridaReleases).where(eq(fridaReleases.version, version)).all()[0];
  }

  getDefaultVersion(): string {
    const row = this.db.select().from(settings).where(eq(settings.key, 'frida_default_version')).all()[0];
    return row?.value ?? 'auto';
  }

  /**
   * Get the version of the Python frida package installed in the venv.
   * Returns null if frida is not installed.
   */
  getInstalledClientVersion(): string | null {
    if (this.cachedClientVersion !== undefined) return this.cachedClientVersion;
    try {
      const result = execSync(
        `"${venvPython}" -c "import frida; print(frida.__version__)"`,
        { timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const version = result.toString().trim();
      if (version) {
        log(`Installed frida Python package: ${version}`);
        this.cachedClientVersion = version;
        return version;
      }
    } catch {
      log('frida Python package not installed in venv');
    }
    this.cachedClientVersion = null;
    return null;
  }

  resolveVersion(version: string): string | null {
    // 'auto' matches the installed Python frida package version
    if (version === 'auto') {
      const clientVersion = this.getInstalledClientVersion();
      if (clientVersion) return clientVersion;
      // Fall back to latest if we can't determine client version
      const newest = this.db.select().from(fridaReleases).orderBy(desc(fridaReleases.id)).all()[0];
      return newest?.version ?? null;
    }
    if (version === 'latest') {
      const newest = this.db.select().from(fridaReleases).orderBy(desc(fridaReleases.id)).all()[0];
      return newest?.version ?? null;
    }
    const release = this.getRelease(version);
    return release?.version ?? null;
  }

  /**
   * Ensure a specific version exists in the DB and is downloaded.
   * If the version isn't in the DB (e.g. auto-resolved from Python client),
   * creates the release entry with a constructed download URL and downloads it.
   */
  async ensureVersion(version: string): Promise<string> {
    let release = this.getRelease(version);
    if (!release) {
      // Version not in DB — construct the GitHub download URL directly
      const url = `https://github.com/frida/frida/releases/download/${version}/frida-server-${version}-android-arm64.xz`;
      log(`Adding Frida ${version} to release DB (auto-resolved from Python client)`);
      this.db.insert(fridaReleases).values({
        version,
        downloadUrl: url,
        releaseDate: new Date(),
        isDownloaded: false,
      }).run();
    }
    if (!this.isDownloaded(version)) {
      log(`Downloading Frida server ${version}...`);
      await this.downloadVersion(version);
    }
    return this.getBinaryPath(version);
  }

  async downloadVersion(version: string): Promise<string> {
    const release = this.getRelease(version);
    if (!release) throw new Error(`Unknown Frida version: ${version}`);
    if (release.isDownloaded) return this.getBinaryPath(version);

    const versionDir = path.join(this.dataDir, version);
    fs.mkdirSync(versionDir, { recursive: true });

    const xzPath = path.join(versionDir, 'frida-server-arm64.xz');
    const binPath = path.join(versionDir, 'frida-server-arm64');

    log(`Downloading Frida server ${version}...`);
    const response = await fetch(release.downloadUrl, { redirect: 'follow' });
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(xzPath, buffer);

    this.decompressXz(xzPath, binPath);
    fs.chmodSync(binPath, 0o755);

    const fileSize = fs.statSync(binPath).size;
    this.db.update(fridaReleases)
      .set({ isDownloaded: true, fileSize })
      .where(eq(fridaReleases.version, version))
      .run();

    log(`Frida server ${version} downloaded (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);
    return binPath;
  }

  getBinaryPath(version: string): string {
    return path.join(this.dataDir, version, 'frida-server-arm64');
  }

  isDownloaded(version: string): boolean {
    const release = this.getRelease(version);
    return release?.isDownloaded ?? false;
  }

  getGadgetPath(version: string): string {
    return path.join(this.dataDir, version, 'frida-gadget-arm64.so');
  }

  isGadgetDownloaded(version: string): boolean {
    return fs.existsSync(this.getGadgetPath(version));
  }

  async ensureGadget(version: string): Promise<string> {
    const gadgetPath = this.getGadgetPath(version);
    if (fs.existsSync(gadgetPath)) return gadgetPath;

    // Find or create DB entry
    let release = this.getRelease(version);
    if (!release) {
      await this.ensureVersion(version);
      release = this.getRelease(version);
    }

    if (!release?.gadgetDownloadUrl) {
      // Construct URL from version if not in DB
      const url = `https://github.com/frida/frida/releases/download/${version}/frida-gadget-${version}-android-arm64.so.xz`;
      this.db.update(fridaReleases)
        .set({ gadgetDownloadUrl: url })
        .where(eq(fridaReleases.version, version))
        .run();
      release = this.getRelease(version)!;
    }

    log(`Downloading Frida gadget ${version}...`);
    const response = await fetch(release.gadgetDownloadUrl!);
    if (!response.ok) throw new Error(`Failed to download gadget: ${response.statusText}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    const dir = path.dirname(gadgetPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const xzPath = gadgetPath + '.xz';
    fs.writeFileSync(xzPath, buffer);
    this.decompressXz(xzPath, gadgetPath);
    fs.unlinkSync(xzPath);

    log(`Frida gadget ${version} downloaded to ${gadgetPath}`);
    return gadgetPath;
  }

  deleteVersion(version: string): void {
    const versionDir = path.join(this.dataDir, version);
    if (fs.existsSync(versionDir)) {
      fs.rmSync(versionDir, { recursive: true });
    }
    this.db.update(fridaReleases)
      .set({ isDownloaded: false, fileSize: null })
      .where(eq(fridaReleases.version, version))
      .run();
    log(`Deleted Frida server ${version}`);
  }

  getLastSyncTime(): Date | null {
    const row = this.db.select().from(settings).where(eq(settings.key, 'frida_last_sync')).all()[0];
    return row ? new Date(row.value) : null;
  }

  /** Decompress .xz file using best available tool. */
  private decompressXz(xzPath: string, binPath: string): void {
    const pyScript = 'import lzma,sys;open(sys.argv[2],"wb").write(lzma.open(sys.argv[1]).read())';
    const attempts: Array<{ name: string; fn: () => void }> = [
      {
        name: 'xz',
        fn: () => execSync(`xz -d -f "${xzPath}"`, { timeout: 60000 }),
      },
      {
        name: 'venv python lzma',
        fn: () => {
          execFileSync(venvPython, ['-c', pyScript, xzPath, binPath], { timeout: 60000 });
          fs.unlinkSync(xzPath);
        },
      },
      {
        name: '7z',
        fn: () => {
          execSync(`7z e -y -o"${path.dirname(xzPath)}" "${xzPath}"`, { timeout: 60000 });
          fs.unlinkSync(xzPath);
        },
      },
    ];

    for (const attempt of attempts) {
      try {
        attempt.fn();
        log(`Decompressed .xz using ${attempt.name}`);
        return;
      } catch (err: any) {
        log(`XZ decompression via ${attempt.name} failed: ${err.message?.slice(0, 100)}`);
      }
    }
    throw new Error('Cannot decompress .xz file. Install one of: xz-utils, 7-Zip, or ensure .venv Python has lzma module.');
  }

  private upsertSetting(key: string, value: string): void {
    const existing = this.db.select().from(settings).where(eq(settings.key, key)).all()[0];
    if (existing) {
      this.db.update(settings).set({ value }).where(eq(settings.key, key)).run();
    } else {
      this.db.insert(settings).values({ key, value }).run();
    }
  }
}
