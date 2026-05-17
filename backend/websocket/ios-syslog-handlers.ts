import { registerWebsocketEndpoint } from './handlers';
import { broadcastToAll } from './index';
import { createLoggers } from '../logs';
import type { IosDeviceManager } from '../services/ios-device-manager';

const { log, error } = createLoggers('ios-syslog');

// Map of deviceId -> { timer, nextIndex, subscriberCount }
const syslogPollers = new Map<string, {
  timer: ReturnType<typeof setInterval>;
  nextIndex: number;
  subscriberCount: number;
}>();

function startSyslogRelay(deviceId: string, iosDeviceManager: IosDeviceManager): void {
  const existing = syslogPollers.get(deviceId);
  if (existing) {
    existing.subscriberCount++;
    return;
  }

  let nextIndex = 0;

  const timer = setInterval(async () => {
    try {
      const result = await iosDeviceManager.pollSyslog(deviceId, nextIndex);
      if (result.entries.length > 0) {
        nextIndex = result.nextIndex;
        broadcastToAll({
          type: 'ios-syslog',
          deviceId,
          entries: result.entries,
        });
      } else if (result.nextIndex > nextIndex) {
        // Advance index even if no new entries in this window (shouldn't happen, but defensive)
        nextIndex = result.nextIndex;
      }
      if (!result.running) {
        log(`Syslog stream ended for device ${deviceId}`);
        broadcastToAll({ type: 'ios-syslog-stopped', deviceId });
        stopSyslogRelay(deviceId);
      }
    } catch (err: any) {
      // Bridge might be temporarily unavailable — keep polling
      error(`Syslog poll error for ${deviceId}: ${err.message}`);
    }
  }, 500);

  syslogPollers.set(deviceId, { timer, nextIndex, subscriberCount: 1 });
  log(`Started syslog relay for device ${deviceId}`);
}

function stopSyslogRelay(deviceId: string): void {
  const poller = syslogPollers.get(deviceId);
  if (!poller) return;
  clearInterval(poller.timer);
  syslogPollers.delete(deviceId);
  log(`Stopped syslog relay for device ${deviceId}`);
}

export function registerIosSyslogHandlers(iosDeviceManager: IosDeviceManager): void {
  registerWebsocketEndpoint('ios-syslog/start', async (message, socket) => {
    const { deviceId } = message;
    if (!deviceId) {
      socket.send(JSON.stringify({ type: 'error', error: 'Missing deviceId' }));
      return;
    }
    try {
      await iosDeviceManager.startSyslog(deviceId);
      startSyslogRelay(deviceId, iosDeviceManager);
      socket.send(JSON.stringify({ type: 'ios-syslog-started', deviceId }));
    } catch (err: any) {
      error(`Failed to start syslog for ${deviceId}: ${err.message}`);
      socket.send(JSON.stringify({ type: 'error', error: `Failed to start syslog: ${err.message}` }));
    }
  }, { requires: ['core.devices:read'] });

  registerWebsocketEndpoint('ios-syslog/stop', async (message, socket) => {
    const { deviceId } = message;
    if (!deviceId) {
      socket.send(JSON.stringify({ type: 'error', error: 'Missing deviceId' }));
      return;
    }
    try {
      await iosDeviceManager.stopSyslog(deviceId);
      stopSyslogRelay(deviceId);
      socket.send(JSON.stringify({ type: 'ios-syslog-stopped', deviceId }));
    } catch (err: any) {
      error(`Failed to stop syslog for ${deviceId}: ${err.message}`);
      socket.send(JSON.stringify({ type: 'error', error: `Failed to stop syslog: ${err.message}` }));
    }
  }, { requires: ['core.devices:read'] });
}

export function stopAllSyslogRelays(): void {
  for (const [deviceId] of syslogPollers) {
    stopSyslogRelay(deviceId);
  }
}
