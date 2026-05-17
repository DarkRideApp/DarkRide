import { registerEndpoint } from './api-service';
import type { FileStorageService } from '../services/file-storage';
import type { CloudStorageService } from '../services/cloud-storage';
import { createLoggers } from '../logs';

const { log, error } = createLoggers('cloud-api');

export function registerCloudEndpoints(
  fileSync: FileStorageService,
  cloudStorage: CloudStorageService,
  onReconfigure?: () => void,
): void {
  // GET /v1/cloud/status
  registerEndpoint('GET', '/v1/cloud/status', (_req, res) => {
    try {
      const status = fileSync.getStatus();
      res.json({ success: true, data: status });
    } catch (err: any) {
      error(`Status error: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /v1/cloud/test — validate bucket connectivity
  registerEndpoint('POST', '/v1/cloud/test', async (_req, res) => {
    try {
      await cloudStorage.headBucket();
      res.json({ success: true, message: 'Connection successful' });
    } catch (err: any) {
      res.json({ success: false, error: err.message });
    }
  });

  // GET /v1/cloud/browse — list objects with prefix/delimiter navigation
  registerEndpoint('GET', '/v1/cloud/browse', async (req, res) => {
    const prefix = (req.query.prefix as string) || '';
    const delimiter = (req.query.delimiter as string) || '/';
    try {
      const result = await cloudStorage.listObjects(prefix, delimiter);
      res.json({ success: true, data: result });
    } catch (err: any) {
      error(`Browse error: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /v1/cloud/configure — reload cloud settings from DB
  if (onReconfigure) {
    registerEndpoint('POST', '/v1/cloud/configure', (_req, res) => {
      try {
        onReconfigure();
        res.json({ success: true, message: 'Cloud storage reconfigured' });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    });
  }

  // POST /v1/cloud/sync-sessions — trigger pinned session sync and return diagnostics
  registerEndpoint('POST', '/v1/cloud/sync-sessions', async (_req, res) => {
    try {
      const result = await fileSync.syncPinnedSessions();
      res.json({ success: true, data: result });
    } catch (err: any) {
      error(`Session sync error: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /v1/cloud/retry/* — clear sync error so the upload queue will re-attempt
  registerEndpoint('POST', '/v1/cloud/retry/*', (req, res) => {
    const cloudKey = (req.params as any)[0];
    if (!cloudKey) {
      res.status(400).json({ success: false, error: 'cloudKey is required' });
      return;
    }
    try {
      fileSync.retryUpload(cloudKey);
      res.json({ success: true });
    } catch (err: any) {
      error(`Retry error: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // The delete and download endpoints use wildcard to capture the full cloud key path
  // (cloud keys contain slashes like "apks/com.example/100_1.0.apk")

  // POST /v1/cloud/delete/* — delete a file from cloud + local + DB
  registerEndpoint('POST', '/v1/cloud/delete/*', async (req, res) => {
    // Express stores wildcard captures in req.params[0]
    const cloudKey = (req.params as any)[0];
    if (!cloudKey) {
      res.status(400).json({ success: false, error: 'cloudKey is required' });
      return;
    }
    try {
      await fileSync.removeFile(cloudKey);
      res.json({ success: true });
    } catch (err: any) {
      error(`Delete error: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /v1/cloud/download/* — get presigned download URL
  registerEndpoint('GET', '/v1/cloud/download/*', async (req, res) => {
    const cloudKey = (req.params as any)[0];
    if (!cloudKey) {
      res.status(400).json({ success: false, error: 'cloudKey is required' });
      return;
    }
    try {
      const url = await fileSync.getDirectUrl(cloudKey);
      if (!url) {
        res.status(404).json({ success: false, error: 'File not available or cloud not configured' });
        return;
      }
      res.json({ success: true, data: { url } });
    } catch (err: any) {
      error(`Download URL error: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  });
}
