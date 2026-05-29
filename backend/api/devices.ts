import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getDataRoot } from '../config/paths';
import { eq } from 'drizzle-orm';
import { registerEndpoint } from './api-service';
import { DeviceManager } from '../services/device-manager';
import type { IosDeviceManager } from '../services/ios-device-manager';
import { screenshots, devices } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { createLoggers } from '../logs';
import { generateWireGuardQrCode } from '../utils/qr-code';
import { safeJoinInside } from '../utils/safe-path';

const { log, error } = createLoggers('devices-api');

const SCREENSHOT_PATH = process.env.SCREENSHOT_PATH || join(getDataRoot(), 'screenshots');

// Track devices where iOS screenshot is known-unavailable so we log once, not every poll.
const iosScreenshotUnavailable = new Set<string>();

export function registerDeviceEndpoints(deviceManager: DeviceManager, db?: AppDatabase, iosDeviceManager?: IosDeviceManager): void {
  // Helper to look up device platform from DB
  function getDevicePlatform(deviceId: string): 'android' | 'ios' {
    if (!db) return 'android';
    const device = db.select().from(devices).where(eq(devices.id, deviceId)).all()[0];
    return (device?.platform as 'android' | 'ios') ?? 'android';
  }

  // GET /v1/device/list — list all devices with status (merged Android + iOS)
  registerEndpoint('GET', '/v1/device/list', async (_req, res) => {
    try {
      const androidStatuses = await deviceManager.getAllDeviceStatuses();
      const iosStatuses = iosDeviceManager ? await iosDeviceManager.getAllDeviceStatuses() : [];
      res.json({ success: true, data: [...androidStatuses, ...iosStatuses] });
    } catch (err: any) {
      error(`Failed to list devices: ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to list devices' });
    }
  }, { requires: ['core.devices:read'] });

  // GET /v1/device/view/:id — device details including live status
  registerEndpoint('GET', '/v1/device/view/:id', async (req, res) => {
    try {
      const platform = getDevicePlatform(req.params.id);
      const status = platform === 'ios' && iosDeviceManager
        ? await iosDeviceManager.getDeviceStatus(req.params.id)
        : await deviceManager.getDeviceStatus(req.params.id);
      if (!status) {
        res.status(404).json({ success: false, error: 'Device not found' });
        return;
      }
      res.json({ success: true, data: status });
    } catch (err: any) {
      error(`Failed to get device ${req.params.id}: ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to get device details' });
    }
  }, { requires: ['core.devices:read'] });

  // PUT /v1/device/:id — update device fields (e.g. name)
  registerEndpoint('PUT', '/v1/device/:id', async (req, res) => {
    try {
      const deviceId = req.params.id;
      const status = await deviceManager.getDeviceStatus(deviceId);
      if (!status) {
        res.status(404).json({ success: false, error: 'Device not found' });
        return;
      }

      const { name } = req.body;
      if (name !== undefined && typeof name !== 'string') {
        res.status(400).json({ success: false, error: 'name must be a string' });
        return;
      }

      if (!db) {
        res.status(500).json({ success: false, error: 'Database not available' });
        return;
      }

      if (name !== undefined) {
        db.update(devices).set({ name: name || null }).where(eq(devices.id, deviceId)).run();
      }

      const updated = await deviceManager.getDeviceStatus(deviceId);
      res.json({ success: true, data: updated });
    } catch (err: any) {
      error(`Failed to update device ${req.params.id}: ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to update device' });
    }
  }, { requires: ['core.devices:manage'] });

  // DELETE /v1/device/:id — remove the row from the devices table.
  // Used for "Forget" on stale rows (emulators that no longer exist, USB
  // devices that won't be reconnected, etc.). The device-manager will
  // re-add the row on the next adb poll if it actually sees the device,
  // so this only sticks for genuinely-absent devices.
  registerEndpoint('DELETE', '/v1/device/:id', async (req, res) => {
    try {
      const deviceId = req.params.id;
      if (!db) {
        res.status(500).json({ success: false, error: 'Database not available' });
        return;
      }
      const existing = db.select().from(devices).where(eq(devices.id, deviceId)).all()[0];
      if (!existing) {
        res.status(404).json({ success: false, error: 'Device not found' });
        return;
      }
      db.delete(devices).where(eq(devices.id, deviceId)).run();
      log(`Forgot device ${deviceId}`);
      res.json({ success: true });
    } catch (err: any) {
      error(`Failed to forget device ${req.params.id}: ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to forget device' });
    }
  }, { requires: ['core.devices:manage'] });

  // POST /v1/device/setup/:id — trigger device setup flow
  registerEndpoint('POST', '/v1/device/setup/:id', async (req, res) => {
    try {
      const deviceId = req.params.id;
      const platform = getDevicePlatform(deviceId);
      if (platform === 'ios') {
        res.json({ success: true, data: { message: 'No setup needed for iOS devices' } });
        return;
      }
      const status = await deviceManager.getDeviceStatus(deviceId);
      if (!status) {
        res.status(404).json({ success: false, error: 'Device not found' });
        return;
      }
      if (!status.isOnline) {
        res.status(400).json({ success: false, error: 'Device is offline' });
        return;
      }
      await deviceManager.performSetup(deviceId);
      const updated = await deviceManager.getDeviceStatus(deviceId);
      res.json({ success: true, data: updated });
    } catch (err: any) {
      error(`Failed to setup device ${req.params.id}: ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to setup device' });
    }
  }, { requires: ['core.devices:manage'] });

  // POST /v1/device/pair/:id — initiate iOS pairing
  registerEndpoint('POST', '/v1/device/pair/:id', async (req, res) => {
    try {
      const deviceId = req.params.id;
      if (!iosDeviceManager) {
        res.status(400).json({ success: false, error: 'iOS support not available' });
        return;
      }
      const result = await iosDeviceManager.pair(deviceId);
      res.json({ success: true, data: result });
    } catch (err: any) {
      error(`Failed to pair iOS device ${req.params.id}: ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to pair iOS device' });
    }
  }, { requires: ['core.devices:manage'] });

  // POST /v1/device/wda/install/:id — install WDA on iOS device
  registerEndpoint('POST', '/v1/device/wda/install/:id', async (req, res) => {
    try {
      const deviceId = req.params.id;
      if (!iosDeviceManager) {
        res.status(400).json({ success: false, error: 'iOS support not available' });
        return;
      }
      const result = await iosDeviceManager.installWda(deviceId);
      res.json({ success: true, data: result });
    } catch (err: any) {
      error(`Failed to install WDA on ${req.params.id}: ${err.message}`);
      res.status(500).json({ success: false, error: 'WDA installation failed' });
    }
  }, { requires: ['core.devices:manage'] });

  // POST /v1/device/wda/launch/:id — launch WDA on iOS device
  registerEndpoint('POST', '/v1/device/wda/launch/:id', async (req, res) => {
    try {
      const deviceId = req.params.id;
      if (!iosDeviceManager) {
        res.status(400).json({ success: false, error: 'iOS support not available' });
        return;
      }
      const result = await iosDeviceManager.launchWda(deviceId);
      res.json({ success: true, data: result });
    } catch (err: any) {
      error(`Failed to launch WDA on ${req.params.id}: ${err.message}`);
      res.status(500).json({ success: false, error: 'WDA launch failed' });
    }
  }, { requires: ['core.devices:manage'] });

  // POST /v1/device/wda/stop/:id — stop WDA on iOS device
  registerEndpoint('POST', '/v1/device/wda/stop/:id', async (req, res) => {
    try {
      const deviceId = req.params.id;
      if (!iosDeviceManager) {
        res.status(400).json({ success: false, error: 'iOS support not available' });
        return;
      }
      const result = await iosDeviceManager.stopWda(deviceId);
      res.json({ success: true, data: result });
    } catch (err: any) {
      error(`Failed to stop WDA on ${req.params.id}: ${err.message}`);
      res.status(500).json({ success: false, error: 'WDA stop failed' });
    }
  }, { requires: ['core.devices:manage'] });

  // GET /v1/device/wda/status/:id — get WDA status on iOS device
  registerEndpoint('GET', '/v1/device/wda/status/:id', async (req, res) => {
    try {
      const deviceId = req.params.id;
      if (!iosDeviceManager) {
        res.status(400).json({ success: false, error: 'iOS support not available' });
        return;
      }
      const result = await iosDeviceManager.wdaStatus(deviceId);
      res.json({ success: true, data: result });
    } catch (err: any) {
      error(`Failed to get WDA status on ${req.params.id}: ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to get WDA status' });
    }
  }, { requires: ['core.devices:read'] });

  // GET /v1/device/wg-qr/:id — WireGuard config QR code for iOS
  registerEndpoint('GET', '/v1/device/wg-qr/:id', async (req, res) => {
    try {
      const deviceId = req.params.id;
      const qrBase64 = await generateWireGuardQrCode(deviceId);
      res.json({ success: true, data: { qrCode: qrBase64 } });
    } catch (err: any) {
      error(`Failed to generate WG QR for device ${req.params.id}: ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to generate WireGuard QR code' });
    }
  }, { requires: ['core.devices:read'] });

  // POST /v1/device/command/:id — run device command (restart, sleep, wake)
  registerEndpoint('POST', '/v1/device/command/:id', async (req, res) => {
    try {
      const deviceId = req.params.id;
      const { command } = req.body;

      // iOS device commands — route to iOS bridge
      if (getDevicePlatform(deviceId) === 'ios') {
        if (!iosDeviceManager) {
          res.status(400).json({ success: false, error: 'iOS support not available' });
          return;
        }
        if (!['reboot', 'shutdown', 'sleep'].includes(command || '')) {
          res.status(400).json({ success: false, error: 'Invalid iOS command. Must be reboot, shutdown, or sleep.' });
          return;
        }
        if (command === 'reboot') await iosDeviceManager.restartDevice(deviceId);
        else if (command === 'shutdown') await iosDeviceManager.shutdownDevice(deviceId);
        else if (command === 'sleep') await iosDeviceManager.sleepDevice(deviceId);
        res.json({ success: true, data: { deviceId, command } });
        return;
      }

      if (!command || !['restart', 'sleep', 'wake', 'unlock', 'stopall'].includes(command)) {
        res.status(400).json({ success: false, error: 'Invalid command. Must be restart, sleep, wake, unlock, or stopall.' });
        return;
      }

      const status = await deviceManager.getDeviceStatus(deviceId);
      if (!status) {
        res.status(404).json({ success: false, error: 'Device not found' });
        return;
      }
      if (!status.isOnline) {
        res.status(400).json({ success: false, error: 'Device is offline' });
        return;
      }

      await deviceManager.runDeviceCommand(deviceId, command);
      res.json({ success: true, data: { deviceId, command } });
    } catch (err: any) {
      error(`Failed to run command on device ${req.params.id}: ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to run device command' });
    }
  }, { requires: ['core.devices:manage'] });

  // GET /v1/device/screenshot/:id — take screenshot, return as base64
  registerEndpoint('GET', '/v1/device/screenshot/:id', async (req, res) => {
    try {
      const deviceId = req.params.id;
      if (getDevicePlatform(deviceId) === 'ios') {
        if (!iosDeviceManager) {
          res.status(400).json({ success: false, error: 'iOS support not available' });
          return;
        }
        try {
          const { image, format } = await iosDeviceManager.screenshotWithFallback(deviceId);
          res.json({ success: true, data: { deviceId, image, format } });
        } catch (err: any) {
          const msg = err.message ?? String(err);
          // Suppress repeated logging for persistent failures (tunneld not running,
          // DDI unavailable, all methods exhausted). These won't resolve without
          // user action, so log once per device then go quiet.
          const isPersistent = msg.includes('unavailable')
            || msg.includes('tunneld')
            || msg.includes('All screenshot methods failed')
            || msg.includes('Screenshot failed for iOS');
          if (isPersistent) {
            if (!iosScreenshotUnavailable.has(deviceId)) {
              iosScreenshotUnavailable.add(deviceId);
              log(`iOS screenshot unavailable for ${deviceId}: ${msg}`);
            }
          } else {
            // Clear the suppression flag — a different error means state may have changed
            iosScreenshotUnavailable.delete(deviceId);
            error(`iOS screenshot failed for ${deviceId}: ${msg}`);
          }
          res.status(400).json({ success: false, error: msg });
        }
        return;
      }
      const status = await deviceManager.getDeviceStatus(deviceId);
      if (!status) {
        res.status(404).json({ success: false, error: 'Device not found' });
        return;
      }
      if (!status.isOnline) {
        res.status(400).json({ success: false, error: 'Device is offline' });
        return;
      }

      const imageBuffer = await deviceManager.takeScreenshot(deviceId);
      const base64 = imageBuffer.toString('base64');
      res.json({ success: true, data: { deviceId, image: base64 } });
    } catch (err: any) {
      error(`Failed to take screenshot for device ${req.params.id}: ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to take screenshot' });
    }
  }, { requires: ['core.devices:read'] });

  // POST /v1/device/screenshot/:id — take screenshot and save to session
  registerEndpoint('POST', '/v1/device/screenshot/:id', async (req, res) => {
    try {
      const deviceId = req.params.id;
      const { sessionId } = req.body;

      if (!sessionId || typeof sessionId !== 'number') {
        res.status(400).json({ success: false, error: 'sessionId (number) is required' });
        return;
      }

      if (!db) {
        res.status(500).json({ success: false, error: 'Database not available' });
        return;
      }

      const status = await deviceManager.getDeviceStatus(deviceId);
      if (!status) {
        res.status(404).json({ success: false, error: 'Device not found' });
        return;
      }
      if (!status.isOnline) {
        res.status(400).json({ success: false, error: 'Device is offline' });
        return;
      }

      const imageBuffer = await deviceManager.takeScreenshot(deviceId);
      const base64 = imageBuffer.toString('base64');

      const timestamp = Date.now();
      const filename = `${sessionId}_${timestamp}_capture.png`;
      mkdirSync(SCREENSHOT_PATH, { recursive: true });
      writeFileSync(safeJoinInside(SCREENSHOT_PATH, filename), imageBuffer);

      db.insert(screenshots)
        .values({
          sessionId,
          filename,
          name: 'Capture Screenshot',
          capturedAt: new Date(),
        })
        .run();

      res.json({ success: true, data: { deviceId, image: base64, filename } });
    } catch (err: any) {
      error(`Failed to save screenshot for device ${req.params.id}: ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to save screenshot' });
    }
  }, { requires: ['core.devices:manage'] });

  // POST /v1/device/shell/:id — execute arbitrary ADB shell command
  registerEndpoint('POST', '/v1/device/shell/:id', async (req, res) => {
    try {
      const deviceId = req.params.id;
      if (getDevicePlatform(deviceId) === 'ios') {
        res.status(400).json({ success: false, error: 'Shell commands not available for iOS devices' });
        return;
      }
      const { command } = req.body;

      if (!command || typeof command !== 'string') {
        res.status(400).json({ success: false, error: 'Missing or invalid command' });
        return;
      }

      const status = await deviceManager.getDeviceStatus(deviceId);
      if (!status) {
        res.status(404).json({ success: false, error: 'Device not found' });
        return;
      }
      if (!status.isOnline) {
        res.status(400).json({ success: false, error: 'Device is offline' });
        return;
      }

      const output = await deviceManager.executeShellCommand(deviceId, command);
      res.json({ success: true, data: { deviceId, command, output } });
    } catch (err: any) {
      error(`Failed to run shell command on device ${req.params.id}: ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to run shell command' });
    }
  }, { requires: ['core.devices:shell'] });

  // GET /v1/device/dom/:id — capture UI hierarchy via direct ADB uiautomator dump
  // Uses direct ADB (not the Python bridge) because u2's ATX agent degrades
  // uiautomator dump output, especially for WebView content.
  registerEndpoint('GET', '/v1/device/dom/:id', async (req, res) => {
    try {
      const deviceId = req.params.id;
      if (getDevicePlatform(deviceId) === 'ios') {
        if (!iosDeviceManager) {
          res.status(400).json({ success: false, error: 'iOS support not available' });
          return;
        }
        try {
          const format = req.query.format as string | undefined;
          if (format === 'xml') {
            // Raw XML source (backwards compat)
            const { source } = await iosDeviceManager.wdaDom(deviceId);
            res.json({ success: true, data: { deviceId, dom: source, format: 'xml' } });
          } else {
            // Default: parsed DOMNode JSON (with 3s caching)
            const dom = await iosDeviceManager.wdaDomParsed(deviceId);
            res.json({ success: true, data: { deviceId, dom, format: 'json' } });
          }
        } catch (err: any) {
          error(`iOS DOM capture failed for ${req.params.id}: ${err.message}`);
          res.status(400).json({ success: false, error: 'iOS DOM capture failed' });
        }
        return;
      }
      const status = await deviceManager.getDeviceStatus(deviceId);
      if (!status) {
        res.status(404).json({ success: false, error: 'Device not found' });
        return;
      }
      if (!status.isOnline) {
        res.status(400).json({ success: false, error: 'Device is offline' });
        return;
      }

      // Use unique temp file to avoid conflicts with concurrent captures
      const tmpPath = `/sdcard/darkride_dom_${Date.now()}.xml`;
      const maxRetries = 3;
      let lastError: string = '';

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const dumpOutput = await deviceManager.executeShellCommand(deviceId, `uiautomator dump ${tmpPath}`, 15000);

          // uiautomator dump can return 0 exit code but print an error
          if (dumpOutput.toLowerCase().includes('error')) {
            lastError = `uiautomator dump returned error: ${dumpOutput}`;
            if (attempt < maxRetries) {
              await new Promise(r => setTimeout(r, 1000));
              continue;
            }
            throw new Error(lastError);
          }

          const dom = await deviceManager.executeShellCommand(deviceId, `cat ${tmpPath}`, 10000);
          deviceManager.executeShellCommand(deviceId, `rm -f ${tmpPath}`).catch(() => {});

          if (!dom || (!dom.includes('<?xml') && !dom.includes('<hierarchy'))) {
            lastError = 'Empty or invalid XML output from uiautomator dump';
            if (attempt < maxRetries) {
              await new Promise(r => setTimeout(r, 1000));
              continue;
            }
            throw new Error(lastError);
          }

          res.json({ success: true, data: { deviceId, dom } });
          return;
        } catch (err: any) {
          lastError = err.message;
          // Clean up temp file on failure
          deviceManager.executeShellCommand(deviceId, `rm -f ${tmpPath}`).catch(() => {});
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }
        }
      }

      throw new Error(lastError || 'Failed to capture DOM after retries');
    } catch (err: any) {
      error(`Failed to capture DOM for device ${req.params.id}: ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to capture DOM' });
    }
  }, { requires: ['core.devices:read'] });

  // POST /v1/device/find-element/:id — find element on iOS device via WDA
  registerEndpoint('POST', '/v1/device/find-element/:id', async (req, res) => {
    try {
      const deviceId = req.params.id;
      if (getDevicePlatform(deviceId) !== 'ios') {
        res.status(400).json({ success: false, error: 'Element finding via this endpoint is only available for iOS devices' });
        return;
      }
      if (!iosDeviceManager) {
        res.status(400).json({ success: false, error: 'iOS support not available' });
        return;
      }
      const { selector } = req.body;
      if (!selector || typeof selector !== 'object') {
        res.status(400).json({ success: false, error: 'selector object is required' });
        return;
      }
      const element = await iosDeviceManager.wdaFindElement(deviceId, selector);
      res.json({ success: true, data: element });
    } catch (err: any) {
      error(`Failed to find element on ${req.params.id}: ${err.message}`);
      res.status(400).json({ success: false, error: 'Element not found' });
    }
  }, { requires: ['core.devices:read'] });

  // POST /v1/device/find-elements/:id — find multiple elements on iOS device via WDA
  registerEndpoint('POST', '/v1/device/find-elements/:id', async (req, res) => {
    try {
      const deviceId = req.params.id;
      if (getDevicePlatform(deviceId) !== 'ios') {
        res.status(400).json({ success: false, error: 'Element finding via this endpoint is only available for iOS devices' });
        return;
      }
      if (!iosDeviceManager) {
        res.status(400).json({ success: false, error: 'iOS support not available' });
        return;
      }
      const { selector } = req.body;
      if (!selector || typeof selector !== 'object') {
        res.status(400).json({ success: false, error: 'selector object is required' });
        return;
      }
      const elements = await iosDeviceManager.wdaFindElements(deviceId, selector);
      res.json({ success: true, data: elements });
    } catch (err: any) {
      error(`Failed to find elements on ${req.params.id}: ${err.message}`);
      res.status(400).json({ success: false, error: 'Element search failed' });
    }
  }, { requires: ['core.devices:read'] });

  // POST /v1/device/reprobe/:id — re-collect device properties and root status
  registerEndpoint('POST', '/v1/device/reprobe/:id', async (req, res) => {
    try {
      const deviceId = req.params.id;
      const status = await deviceManager.getDeviceStatus(deviceId);
      if (!status) {
        res.status(404).json({ success: false, error: 'Device not found' });
        return;
      }
      if (!status.isOnline) {
        res.status(400).json({ success: false, error: 'Device is offline' });
        return;
      }
      await deviceManager.collectDeviceProperties(deviceId);
      const isRooted = await deviceManager.checkRooted(deviceId);
      if (db) {
        db.update(devices).set({ isRooted }).where(eq(devices.id, deviceId)).run();
      }
      const updated = await deviceManager.getDeviceStatus(deviceId);
      res.json({ success: true, data: updated });
    } catch (err: any) {
      error(`Failed to reprobe device ${req.params.id}: ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to reprobe device' });
    }
  }, { requires: ['core.devices:manage'] });

  // GET /v1/device/ios-crashes/:id — list crash reports on iOS device
  registerEndpoint('GET', '/v1/device/ios-crashes/:id', async (req, res) => {
    try {
      const deviceId = req.params.id;
      if (getDevicePlatform(deviceId) !== 'ios') {
        res.status(400).json({ success: false, error: 'iOS device required' });
        return;
      }
      if (!iosDeviceManager) {
        res.status(400).json({ success: false, error: 'iOS support not available' });
        return;
      }
      const crashes = await iosDeviceManager.listCrashLogs(deviceId);
      res.json({ success: true, data: crashes });
    } catch (err: any) {
      error(`Failed to list crash logs for ${req.params.id}: ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to list crash logs' });
    }
  }, { requires: ['core.devices:read'] });

  // GET /v1/device/ios-crash/:id — read a crash log from iOS device (path in query param)
  registerEndpoint('GET', '/v1/device/ios-crash/:id', async (req, res) => {
    try {
      const deviceId = req.params.id;
      const logPath = (req.query.path as string) || '';
      if (!logPath) {
        res.status(400).json({ success: false, error: 'path is required' });
        return;
      }
      if (getDevicePlatform(deviceId) !== 'ios') {
        res.status(400).json({ success: false, error: 'iOS device required' });
        return;
      }
      if (!iosDeviceManager) {
        res.status(400).json({ success: false, error: 'iOS support not available' });
        return;
      }
      const result = await iosDeviceManager.getCrashLog(deviceId, logPath);
      res.json({ success: true, data: result });
    } catch (err: any) {
      error(`Failed to read crash log for ${req.params.id}: ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to read crash log' });
    }
  }, { requires: ['core.devices:read'] });

  // GET /v1/device/ios-processes/:id — list running processes on iOS device
  registerEndpoint('GET', '/v1/device/ios-processes/:id', async (req, res) => {
    try {
      const deviceId = req.params.id;
      if (getDevicePlatform(deviceId) !== 'ios') {
        res.status(400).json({ success: false, error: 'iOS device required' });
        return;
      }
      if (!iosDeviceManager) {
        res.status(400).json({ success: false, error: 'iOS support not available' });
        return;
      }
      const processes = await iosDeviceManager.listProcesses(deviceId);
      res.json({ success: true, data: processes });
    } catch (err: any) {
      error(`Failed to list processes for ${req.params.id}: ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to list processes' });
    }
  }, { requires: ['core.devices:read'] });

  log('Device API endpoints registered');
}
