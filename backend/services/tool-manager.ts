import { execSync, execFileSync } from 'child_process';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { createLoggers } from '../logs';

const { log, error } = createLoggers('tool-manager');

const isWindows = process.platform === 'win32';
const venvPython = isWindows
  ? path.resolve(process.cwd(), '.venv', 'Scripts', 'python.exe')
  : path.resolve(process.cwd(), '.venv', 'bin', 'python3');

// Pinned versions -- update manually when new releases are desired
const TOOL_VERSIONS = {
  jadx: '1.5.1',
  apktool: '2.10.0',
} as const;

// GitHub repo info for each tool
const GITHUB_REPOS = {
  jadx: 'skylot/jadx',
  apktool: 'iBotPeaches/Apktool',
} as const;

export type ToolName = 'jadx' | 'apktool' | 'mobsfscan' | 'blutter';

export interface ToolStatus {
  name: ToolName;
  installed: boolean;
  version: string | null;
  path: string | null;
}

export interface ToolPaths {
  jadx: string | null;
  apktool: string | null;
  mobsfscan: string | null;
  java: string | null;
  blutter: string | null;
}

const TOOLS_DIR = path.resolve('data/tools');

export class ToolManager {
  private javaPath: string | null = null;
  private installLocks = new Map<ToolName, Promise<void>>();

  /** Check if java is available on PATH */
  hasJava(): boolean {
    if (this.javaPath !== null) return true;
    try {
      execSync('java -version 2>&1', { encoding: 'utf8', timeout: 5000 });
      this.javaPath = 'java';
      return true;
    } catch {
      return false;
    }
  }

  /** Get installation status for all tools */
  async getStatus(): Promise<{ tools: ToolStatus[]; java: boolean }> {
    const tools: ToolStatus[] = [];
    for (const name of ['jadx', 'apktool', 'mobsfscan', 'blutter'] as ToolName[]) {
      const p = this.getToolPath(name);
      const installed = p !== null;
      tools.push({
        name,
        installed,
        version: installed ? this.getInstalledVersion(name) : null,
        path: p,
      });
    }
    return { tools, java: this.hasJava() };
  }

  /** Get absolute path to a tool binary, or null if not installed */
  getToolPath(name: ToolName): string | null {
    switch (name) {
      case 'jadx': {
        const v = TOOL_VERSIONS.jadx;
        const bin = path.join(TOOLS_DIR, 'jadx', v, 'bin', isWindows ? 'jadx.bat' : 'jadx');
        return fs.existsSync(bin) ? bin : null;
      }
      case 'apktool': {
        const v = TOOL_VERSIONS.apktool;
        const jar = path.join(TOOLS_DIR, 'apktool', v, 'apktool.jar');
        return fs.existsSync(jar) ? jar : null;
      }
      case 'mobsfscan': {
        const p = path.resolve(isWindows
          ? '.venv/Scripts/mobsfscan.exe'
          : '.venv/bin/mobsfscan');
        return fs.existsSync(p) ? p : null;
      }
      case 'blutter': {
        const p = path.join(TOOLS_DIR, 'blutter', 'blutter.py');
        return fs.existsSync(p) ? p : null;
      }
    }
  }

  /** Get all tool paths */
  getToolPaths(): ToolPaths {
    return {
      jadx: this.getToolPath('jadx'),
      apktool: this.getToolPath('apktool'),
      mobsfscan: this.getToolPath('mobsfscan'),
      java: this.hasJava() ? 'java' : null,
      blutter: this.getToolPath('blutter'),
    };
  }

  /** Get the installed version for a tool. Returns pinned version for Java tools, pip version for pip tools. */
  getInstalledVersion(name: ToolName): string | null {
    switch (name) {
      case 'jadx':
        return TOOL_VERSIONS.jadx;
      case 'apktool':
        return TOOL_VERSIONS.apktool;
      case 'mobsfscan':
        return this.getPipVersion('mobsfscan');
      case 'blutter':
        return this.getToolPath('blutter') ? 'git' : null;
    }
  }

  /** Download and install a specific tool (serialized per tool) */
  async downloadTool(name: ToolName): Promise<void> {
    const existing = this.installLocks.get(name);
    if (existing) return existing;

    const promise = this._doDownload(name).finally(() => {
      this.installLocks.delete(name);
    });
    this.installLocks.set(name, promise);
    return promise;
  }

  private async _doDownload(name: ToolName): Promise<void> {
    switch (name) {
      case 'jadx': return this.downloadJadx();
      case 'apktool': return this.downloadApktool();
      case 'mobsfscan': return this.installMobsfscan();
      case 'blutter': return this.installBlutter();
    }
  }

  /** Download all missing tools. Continues on failure per tool. */
  async ensureTools(): Promise<ToolPaths> {
    const names: ToolName[] = ['jadx', 'apktool', 'mobsfscan', 'blutter'];
    for (const name of names) {
      if (!this.getToolPath(name)) {
        try {
          await this.downloadTool(name);
          log(`Installed ${name}`);
        } catch (err: any) {
          error(`Failed to install ${name}: ${err.message}`);
        }
      }
    }
    // Always patch blutter (even if already installed) to fix upstream bugs
    this.patchBlutter();
    return this.getToolPaths();
  }

  // ---- Private download methods ----

  private async downloadJadx(): Promise<void> {
    const v = TOOL_VERSIONS.jadx;
    const destDir = path.join(TOOLS_DIR, 'jadx', v);

    const release = await this.fetchGitHubRelease('jadx', v);
    const asset = release.assets.find((a: any) =>
      a.name.match(/jadx-[\d.]+\.zip$/i) && !a.name.includes('gui') && !a.name.includes('no-jre'),
    ) ?? release.assets.find((a: any) => a.name.endsWith('.zip'));

    if (!asset) {
      throw new Error(`No zip asset found in jadx v${v} release`);
    }

    const buffer = await this.downloadAsset(asset.browser_download_url);
    fs.mkdirSync(destDir, { recursive: true });

    // Write zip to temp, extract, remove temp
    const zipPath = path.join(destDir, 'jadx.zip');
    fs.writeFileSync(zipPath, buffer);

    const zip = new AdmZip(zipPath);
    zip.extractAllTo(destDir, true);

    // Clean up zip
    try { fs.unlinkSync(zipPath); } catch { /* best effort */ }

    // Make bin/jadx executable on Unix
    if (!isWindows) {
      const binPath = path.join(destDir, 'bin', 'jadx');
      try { fs.chmodSync(binPath, 0o755); } catch { /* best effort */ }
    }

    log(`Downloaded jadx v${v}`);
  }

  private async downloadApktool(): Promise<void> {
    const v = TOOL_VERSIONS.apktool;
    const destDir = path.join(TOOLS_DIR, 'apktool', v);

    const release = await this.fetchGitHubRelease('apktool', v);
    const asset = release.assets.find((a: any) =>
      a.name.match(/apktool_[\d.]+\.jar$/i),
    ) ?? release.assets.find((a: any) => a.name.endsWith('.jar'));

    if (!asset) {
      throw new Error(`No jar asset found in apktool v${v} release`);
    }

    const buffer = await this.downloadAsset(asset.browser_download_url);
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, 'apktool.jar'), buffer);

    log(`Downloaded apktool v${v}`);
  }

  private async installMobsfscan(): Promise<void> {
    log('Installing mobsfscan via pip...');
    try {
      execFileSync(venvPython, ['-m', 'pip', 'install', 'mobsfscan'], {
        timeout: 300000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      log('mobsfscan installed successfully');
    } catch (err: any) {
      throw new Error(`Failed to install mobsfscan via pip: ${err.message}`);
    }
  }

  private async installBlutter(): Promise<void> {
    const destDir = path.join(TOOLS_DIR, 'blutter');
    if (fs.existsSync(path.join(destDir, 'blutter.py'))) {
      log('blutter already installed');
      this.patchBlutter();
      return;
    }

    log('Cloning blutter from GitHub...');
    try {
      execSync(
        `git clone --depth 1 https://github.com/worawit/blutter.git ${destDir}`,
        { timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      // Install Python dependencies into venv
      execFileSync(venvPython, ['-m', 'pip', 'install', 'pyelftools', 'requests'], {
        timeout: 300000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.patchBlutter();
      log('blutter installed successfully');
    } catch (err: any) {
      throw new Error(`Failed to install blutter: ${err.message}`);
    }
  }

  /**
   * Patch blutter's extract_dart_info.py to handle Flutter apps where
   * _kDartVmSnapshotData has st_size=0 in the ELF symbol table.
   * Upstream issue: https://github.com/worawit/blutter/issues/154
   *
   * Instead of fragile regex replacement (fails on \r\n), we detect
   * the broken assertion and overwrite the entire function.
   */
  private patchBlutter(): void {
    const filePath = path.join(TOOLS_DIR, 'blutter', 'extract_dart_info.py');
    if (!fs.existsSync(filePath)) return;

    try {
      const content = fs.readFileSync(filePath, 'utf8');

      // Already patched (our marker comment is present)
      if (content.includes('newer Flutter strips symbol sizes')) return;

      // Only patch if the broken assertion exists
      if (!content.includes("assert sym['st_size'] > 128")) return;

      // Replace the entire extract_snapshot_hash_flags function.
      // Find the function start and the next top-level def to delimit it.
      const funcStart = content.indexOf('def extract_snapshot_hash_flags(');
      if (funcStart === -1) return;

      // Find the next top-level function (line starting with "def ")
      const afterFunc = content.indexOf('\ndef ', funcStart + 1);
      const funcEnd = afterFunc !== -1 ? afterFunc : content.indexOf('\r\ndef ', funcStart + 1);
      if (funcEnd === -1) return;

      const patchedFunc = [
        'def extract_snapshot_hash_flags(libapp_file):',
        '    with open(libapp_file, \'rb\') as f:',
        '        elf = ELFFile(f)',
        '        # find "_kDartVmSnapshotData" symbol',
        '        dynsym = elf.get_section_by_name(\'.dynsym\')',
        '        sym = dynsym.get_symbol_by_name(\'_kDartVmSnapshotData\')[0]',
        '        #section = elf.get_section(sym[\'st_shndx\'])',
        '        # Note: newer Flutter strips symbol sizes; use address directly',
        '        assert sym[\'st_value\'] > 0, f"_kDartVmSnapshotData has no address"',
        '        f.seek(sym[\'st_value\']+20)',
        '        hash_bytes = f.read(32)',
        '        # Dart >=3.9 stores hash as raw binary; older versions as ASCII hex',
        '        try:',
        '            snapshot_hash = hash_bytes.decode(\'ascii\')',
        '            if not all(c in \'0123456789abcdef\' for c in snapshot_hash):',
        '                raise ValueError(\'not hex\')',
        '        except (UnicodeDecodeError, ValueError):',
        '            snapshot_hash = hash_bytes.hex()',
        '        data = f.read(256) # should be enough',
        '        # Dart >=3.9 may have binary data before flags; scan for printable text',
        '        try:',
        '            flags = data[:data.index(b\'\\0\')].decode().strip().split(\' \')',
        '        except (UnicodeDecodeError, ValueError):',
        '            flags = []',
        '    ',
        '    return snapshot_hash, flags',
      ].join('\n');

      const patched = content.slice(0, funcStart) + patchedFunc + content.slice(funcEnd);

      fs.writeFileSync(filePath, patched, 'utf8');
      log('Patched blutter extract_dart_info.py (st_size assertion + Dart >=3.9 hash)');
    } catch (err: any) {
      // Non-fatal: blutter will still work for most apps
      error(`Failed to patch blutter: ${err.message}`);
    }
  }

  // ---- Helper methods ----

  /** Fetch a specific GitHub release by tag */
  private async fetchGitHubRelease(tool: 'jadx' | 'apktool', version: string): Promise<any> {
    const repo = GITHUB_REPOS[tool];
    const url = `https://api.github.com/repos/${repo}/releases/tags/v${version}`;

    const response = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json' },
    });

    if (!response.ok) {
      throw new Error(`GitHub API returned ${response.status} for ${tool} v${version}: ${response.statusText}`);
    }

    return response.json();
  }

  /** Download a binary asset from a URL */
  private async downloadAsset(url: string): Promise<Buffer> {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  /** Get version of a pip-installed package */
  private getPipVersion(packageName: string): string | null {
    try {
      const result = execFileSync(
        venvPython,
        ['-c', `import importlib.metadata; print(importlib.metadata.version("${packageName}"))`],
        { timeout: 10000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      return result.trim() || null;
    } catch {
      return null;
    }
  }
}
