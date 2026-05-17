import path from 'path';
import type { Express } from 'express';
import type { FileStorageService } from '../services/file-storage';
import { createLoggers } from '../logs';

const { error: logError } = createLoggers('file-serving');

// Simple mime type lookup — avoids adding a dependency
const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.txt': 'text/plain', '.html': 'text/html',
  '.css': 'text/css', '.js': 'application/javascript',
  '.db': 'application/octet-stream', '.bin': 'application/octet-stream',
  '.apk': 'application/vnd.android.package-archive',
  '.pdf': 'application/pdf', '.zip': 'application/zip',
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

export function mountFileServing(app: Express, fileStorage: FileStorageService): void {
  app.get('/v1/files/:namespace/*', async (req, res) => {
    const namespace = req.params.namespace;
    const filePath = (req.params as Record<string, string>)[0];

    if (!filePath) {
      res.status(400).json({ success: false, error: 'File path required' });
      return;
    }

    // Reject suspicious namespace values
    if (namespace.includes('..') || namespace.includes('/') || namespace.includes('\\') || !namespace) {
      res.status(400).json({ success: false, error: 'Invalid namespace' });
      return;
    }

    // Plugin namespaces live under data/plugins/{name}/
    // Use forPlugin — the NamespacedStorage.safePath() handles traversal protection internally
    const storage = fileStorage.forPlugin(namespace);

    try {
      const localPath = await storage.getFilePath(filePath);
      res.type(getMimeType(localPath)).sendFile(localPath);
    } catch (err: any) {
      if (err.message?.includes('Path traversal')) {
        logError(`Path traversal attempt: namespace=${namespace} path=${filePath}`);
        res.status(400).json({ success: false, error: 'Invalid file path' });
      } else if (err.message?.includes('Cloud download failed')) {
        logError(`Cloud download error: ${err.message}`);
        res.status(502).json({ success: false, error: 'File retrieval failed' });
      } else {
        res.status(404).json({ success: false, error: 'File not found' });
      }
    }
  });
}
