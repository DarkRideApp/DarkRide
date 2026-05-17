import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import net from 'net';
import { readFileSync, existsSync } from 'fs';
import { createLoggers } from '../logs';
import { getMitmproxyConfdir } from './mitmproxy-manager';

const { log, error } = createLoggers('server-mitmproxy-pool');

interface Instance {
  child: ChildProcess;
  port: number;
}

/**
 * Lazy-spawned pool of mitmproxy instances, one per TLS profile. Each
 * instance runs in regular HTTP forward-proxy mode with `tls_profile`
 * set, so outbound TLS handshakes to destinations use the spoofed
 * fingerprint (chrome / okhttp / etc., per python/mitmproxy_bridge.py).
 *
 * Server-side fetch from HttpAPIImpl routes through these proxies to
 * get JA3 spoofing for deviceless automations — no Python code
 * duplication. The same `tls_start_server` hook that handles device
 * traffic handles these requests too.
 *
 * Singleton scope: one pool per host process, shared across all
 * concurrent automations. Profile selection is per-automation (each
 * HttpAPIImpl sets its own dispatcher to point at this pool's port
 * for its profile), so two automations using different profiles see
 * different outbound TLS without stepping on each other.
 */
export class ServerMitmproxyPool {
  private instances = new Map<string, Promise<Instance>>();
  private bridgeScriptPath: string;

  constructor(bridgeScriptPath: string = 'python/mitmproxy_bridge.py') {
    this.bridgeScriptPath = bridgeScriptPath;
  }

  /**
   * Get the proxy URL (`http://127.0.0.1:<port>`) for the given profile.
   * Spawns mitmproxy on first call per profile; cached thereafter.
   */
  async getProxyUrl(profile: string): Promise<string> {
    if (profile === 'default') {
      throw new Error("getProxyUrl: 'default' profile means no spoofing; caller should clear dispatcher instead of routing through a proxy");
    }
    let pending = this.instances.get(profile);
    if (!pending) {
      pending = this.spawn(profile).catch(err => {
        // Don't keep a failed promise cached — let the next attempt retry.
        this.instances.delete(profile);
        throw err;
      });
      this.instances.set(profile, pending);
    }
    const inst = await pending;
    return `http://127.0.0.1:${inst.port}`;
  }

  /**
   * Read the mitmproxy CA cert that the pool instances serve for MITM'd
   * connections. Returns null if the cert isn't found (mitmproxy hasn't
   * been started yet, or its data dir is misconfigured). HttpAPIImpl
   * trusts this CA so undici's fetch through the proxy validates the
   * intercepted destination certs.
   */
  getCaCert(): string | null {
    const caPath = path.join(getMitmproxyConfdir(), 'mitmproxy-ca-cert.pem');
    if (!existsSync(caPath)) return null;
    try {
      return readFileSync(caPath, 'utf-8');
    } catch {
      return null;
    }
  }

  /** Kill all instances. Called once during host shutdown. */
  async dispose(): Promise<void> {
    const pending = [...this.instances.values()];
    this.instances.clear();
    for (const p of pending) {
      try {
        const inst = await p;
        inst.child.kill('SIGTERM');
      } catch {
        // Instance failed to start — nothing to kill.
      }
    }
  }

  private async spawn(profile: string): Promise<Instance> {
    const port = await this.getEphemeralPort();
    const absoluteScriptPath = path.resolve(this.bridgeScriptPath);
    const confdir = getMitmproxyConfdir();

    // Server-side instance: no WireGuard, no webhook, no intercept config.
    // Just a forward proxy whose `tls_start_server` hook applies the
    // selected fingerprint to outbound TLS.
    const args = [
      '--set', `confdir=${confdir}`,
      '--listen-host', '127.0.0.1',
      '--listen-port', String(port),
      '-s', absoluteScriptPath,
      // Empty webhook — this instance doesn't capture traffic, only
      // relays. The addon tolerates an empty value.
      '--set', 'node_webhook=',
      '--set', `tls_profile=${profile}`,
    ];

    log(`Spawning server mitmproxy for profile=${profile} on 127.0.0.1:${port}`);
    const child = spawn('mitmdump', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    // Wait for the addon's READY sentinel, same as MitmproxyManager.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Server mitmproxy [${profile}] did not become ready within 30s`)),
        30_000,
      );
      const onData = (data: Buffer) => {
        if (data.toString().includes('[DarkRide] READY')) {
          clearTimeout(timeout);
          child.stdout?.off('data', onData);
          resolve();
        }
      };
      child.stdout?.on('data', onData);
      child.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Server mitmproxy [${profile}] exited with code ${code} before becoming ready`));
      });
    });

    // Surface [DarkRide] log lines after ready for observability.
    child.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        const t = line.trim();
        if (t && t.includes('[DarkRide]')) log(`[${profile}] ${t}`);
      }
    });
    child.stderr?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        const t = line.trim();
        if (!t) continue;
        if (t.includes('[DarkRide]')) error(`[mitm-${profile}] ${t}`);
        else log(`[mitm-${profile}] ${t}`);
      }
    });

    child.on('exit', (code) => {
      log(`Server mitmproxy [${profile}] exited with code ${code}`);
      this.instances.delete(profile);
    });

    return { child, port };
  }

  private getEphemeralPort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (addr && typeof addr === 'object') {
          const port = addr.port;
          srv.close(() => resolve(port));
        } else {
          srv.close();
          reject(new Error('Could not allocate ephemeral port'));
        }
      });
      srv.on('error', reject);
    });
  }
}

// Module-level singleton so HttpAPIImpl can reach it without plumbing
// through the AutomationRunner constructor. Initialised by index.ts at
// boot; tests may inject their own via setServerMitmproxyPool().
let _singleton: ServerMitmproxyPool | null = null;

export function getServerMitmproxyPool(): ServerMitmproxyPool | null {
  return _singleton;
}

export function setServerMitmproxyPool(pool: ServerMitmproxyPool | null): void {
  _singleton = pool;
}
