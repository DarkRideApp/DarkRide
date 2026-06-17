import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { randomBytes } from 'crypto';
import { getDataRoot } from '../config/paths';
import type { DockerLike } from './providers/docker-helpers';
import { createLoggers } from '../logs';

const { log, error: logError } = createLoggers('coturn-manager');

const COTURN_IMAGE = 'coturn/coturn:latest';
const COTURN_NAME = 'darkride-coturn';
const COTURN_LABEL = 'darkride.coturn';
const COTURN_LANIP_LABEL = 'darkride.coturn.lanip';
const DEFAULT_MIN_PORT = 49160;
const DEFAULT_MAX_PORT = 49200;

export interface CoturnCreds {
  username: string;
  password: string;
}

/**
 * Read the persisted coturn long-term credentials, creating them on first
 * use. Credentials must be stable across restarts: the turncfg script handed
 * to the emulator and the `--user` baked into the running coturn container
 * have to agree, and the browser caches the iceServers from JSEP. A fresh
 * random password every boot would break in-flight sessions.
 */
export function loadOrCreateCoturnCreds(): CoturnCreds {
  const file = resolve(getDataRoot(), 'coturn-creds.json');
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<CoturnCreds>;
      if (parsed && typeof parsed.username === 'string' && typeof parsed.password === 'string') {
        return { username: parsed.username, password: parsed.password };
      }
      logError(`coturn-creds.json malformed at ${file} — regenerating`);
    } catch (e: any) {
      logError(`coturn-creds.json unreadable at ${file} (${e?.message ?? e}) — regenerating`);
    }
  }
  const creds: CoturnCreds = {
    username: 'darkride',
    // 24 bytes of hex = 48 chars; comfortably past the 24-char floor.
    password: randomBytes(24).toString('hex'),
  };
  mkdirSync(dirname(file), { recursive: true });
  // 0600: the long-term TURN secret, host-only (read by this Node process,
  // never the container). Owner-only so other local users can't lift it.
  writeFileSync(file, JSON.stringify(creds, null, 2), { mode: 0o600 });
  log(`Generated coturn credentials at ${file}`);
  return creds;
}

/**
 * Build the `-turncfg` script the emulator runs in-container. It must print
 * the iceServers JSON to stdout and return in under a second, so it's a plain
 * printf — no network, no env lookups (the file is mounted read-only, the
 * container has no coturn env). Values are baked in directly.
 *
 * DUAL-URL: both peers receive the same urls array (android-emulator-webrtc
 * has no browser-side iceServers hook). The browser reaches coturn via the
 * host LAN IP; the in-container emulator reaches it via host.docker.internal
 * (which resolves only inside containers). Listing both lets each peer use the
 * one that works and fail the other candidate fast.
 */
export function buildTurncfgScript(lanIp: string, creds: CoturnCreds): string {
  return [
    '#!/bin/sh',
    `printf '{"iceServers":[{"urls":["turn:%s:3478?transport=udp","turn:host.docker.internal:3478?transport=udp"],"username":"%s","credential":"%s"}]}' "${lanIp}" "${creds.username}" "${creds.password}"`,
    '',
  ].join('\n');
}

export interface CoturnContainerSpec {
  Image: string;
  name: string;
  Labels: Record<string, string>;
  Cmd: string[];
  ExposedPorts: Record<string, Record<string, never>>;
  HostConfig: {
    PortBindings: Record<string, Array<{ HostPort: string }>>;
    RestartPolicy: { Name: string };
  };
}

/**
 * Build the dockerode createContainer spec for coturn. Pure — no Docker calls.
 *
 * coturn runs with `-n` semantics (all config via CLI flags, no config file):
 * long-term credential auth, a single static user, the host LAN IP as the
 * advertised external relay address, TLS/DTLS/CLI disabled (we only need plain
 * UDP/TCP relay on the LAN), and a bounded relay port range that we publish
 * 1:1 so the relayed media actually reaches the host.
 */
export function buildCoturnContainerSpec(
  lanIp: string,
  creds: CoturnCreds,
  opts: { minPort?: number; maxPort?: number } = {},
): CoturnContainerSpec {
  const minPort = opts.minPort ?? DEFAULT_MIN_PORT;
  const maxPort = opts.maxPort ?? DEFAULT_MAX_PORT;

  const Cmd = [
    '--listening-ip=0.0.0.0',
    '--listening-port=3478',
    `--external-ip=${lanIp}`,
    '--realm=darkride.local',
    '--lt-cred-mech',
    `--user=${creds.username}:${creds.password}`,
    `--min-port=${minPort}`,
    `--max-port=${maxPort}`,
    '--fingerprint',
    '--no-tls',
    '--no-dtls',
    '--no-cli',
  ];

  const ExposedPorts: Record<string, Record<string, never>> = {
    '3478/tcp': {},
    '3478/udp': {},
  };
  // 3478 is published on 0.0.0.0 (no HostIp), DELIBERATELY — unlike the
  // emulator's adb/gRPC ports which are loopback-only. Both WebRTC peers must
  // reach coturn: the host browser via the LAN IP, and the in-container
  // emulator via host.docker.internal (the Docker gateway), which only routes
  // to a 0.0.0.0-published port, not a 127.0.0.1-bound one. The trade is a
  // LAN-reachable TURN relay guarded by a 96-bit static credential; acceptable
  // for a single-host dev tool on a trusted LAN.
  const PortBindings: Record<string, Array<{ HostPort: string }>> = {
    '3478/tcp': [{ HostPort: '3478' }],
    '3478/udp': [{ HostPort: '3478' }],
  };
  // Publish every relay port 1:1 (HostPort == container port). coturn hands
  // out these ports as the relay candidate; without a matching host binding
  // the relayed UDP can't cross Docker NAT back to the browser.
  for (let port = minPort; port <= maxPort; port++) {
    ExposedPorts[`${port}/udp`] = {};
    PortBindings[`${port}/udp`] = [{ HostPort: String(port) }];
  }

  return {
    Image: COTURN_IMAGE,
    name: COTURN_NAME,
    Labels: {
      [COTURN_LABEL]: 'true',
      [COTURN_LANIP_LABEL]: lanIp,
    },
    Cmd,
    ExposedPorts,
    HostConfig: {
      PortBindings,
      RestartPolicy: { Name: 'unless-stopped' },
    },
  };
}

/** Pull coturn if it isn't already local. Mirrors docker-android's check. */
async function ensureCoturnImageLocal(d: DockerLike): Promise<void> {
  const dAny = d as any;
  try {
    if (typeof dAny.getImage === 'function') {
      await dAny.getImage(COTURN_IMAGE).inspect();
      return; // already local
    }
  } catch {
    // fall through to pull
  }
  log(`Pulling ${COTURN_IMAGE} (small, ~20 MB)`);
  const stream: any = await d.pull(COTURN_IMAGE);
  await new Promise<void>((res, rej) => {
    // dockerode's followProgress isn't on our DockerLike surface; drain the
    // raw stream to completion. Errors surface via the stream's 'error' event.
    stream.on('data', () => { /* ignore per-layer chunks */ });
    stream.on('end', () => res());
    stream.on('error', (err: Error) => rej(err));
  });
  log(`Pulled ${COTURN_IMAGE}`);
}

/**
 * Idempotently ensure a coturn relay is running for `lanIp`.
 *
 * - If `darkride-coturn` exists, is running, and was launched for the same
 *   LAN IP (compared via the darkride.coturn.lanip label), do nothing.
 * - If it exists but is stale (different lanIp) or not running, remove and
 *   recreate it.
 * - If it's absent, pull the image (when needed) and create + start it.
 *
 * A coturn failure must never abort emulator creation. WebRTC simply falls
 * back to the PNG screenshot stream — the same behavior as before this relay
 * existed — so every Docker call here is wrapped and a failure only logs.
 */
export async function ensureCoturn(d: DockerLike, lanIp: string, creds: CoturnCreds): Promise<void> {
  try {
    const existing = await findCoturnContainer(d);
    if (existing) {
      const info = await existing.inspect().catch(() => null);
      const running = info?.State?.Running === true;
      const labelIp = info?.Config?.Labels?.[COTURN_LANIP_LABEL];
      if (running && labelIp === lanIp) {
        log(`coturn already running for ${lanIp} — reusing ${COTURN_NAME}`);
        return;
      }
      log(
        `coturn ${COTURN_NAME} is stale (running=${running}, lanIp=${labelIp ?? 'unknown'} ` +
        `wanted=${lanIp}) — removing and recreating`,
      );
      await existing.remove({ force: true }).catch((e: any) => {
        logError(`Failed to remove stale coturn container: ${e?.message ?? e}`);
      });
    }

    await ensureCoturnImageLocal(d);

    const spec = buildCoturnContainerSpec(lanIp, creds);
    log(`Starting coturn relay ${COTURN_NAME} external-ip=${lanIp} (TURN on 3478, relay ${DEFAULT_MIN_PORT}-${DEFAULT_MAX_PORT})`);
    const container = await d.createContainer(spec as any);
    await container.start();
    log(`coturn relay ${COTURN_NAME} started`);
  } catch (e: any) {
    // Graceful degradation: log and continue. The emulator still gets a
    // turncfg pointing at this LAN IP; if coturn isn't up, WebRTC media
    // can't relay and the client falls back to png — same as before.
    logError(`ensureCoturn failed (WebRTC will fall back to png): ${e?.message ?? e}`);
  }
}

/** Find the darkride-coturn container by its label, if any. */
async function findCoturnContainer(d: DockerLike): Promise<any | null> {
  const list = await d.listContainers({
    all: true,
    filters: { label: [`${COTURN_LABEL}=true`] },
  });
  if (!list || list.length === 0) return null;
  return d.getContainer(list[0].Id);
}
