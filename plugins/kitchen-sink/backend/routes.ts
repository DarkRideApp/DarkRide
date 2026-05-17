import type { Router } from 'express';
import type { NamespacedStorage } from '@darkrideapp/plugin-sdk';

export function setupRoutes(router: Router, getFiles?: () => NamespacedStorage | undefined): void {
  router.get('/v1/kitchen-sink/items', (_req, res) => {
    res.json({ success: true, data: [], message: 'Kitchen sink plugin is alive!' });
  });

  router.post('/v1/kitchen-sink/echo', (req, res) => {
    res.json({ success: true, data: req.body });
  });

  router.get('/v1/kitchen-sink/health', (_req, res) => {
    res.json({ success: true, status: 'healthy', plugin: 'kitchen-sink' });
  });

  // File storage test — write a file, return its URL and content
  router.post('/v1/kitchen-sink/file-test', async (_req, res) => {
    const files = getFiles?.();
    if (!files) {
      res.status(503).json({ success: false, error: 'File storage not available' });
      return;
    }
    try {
      const timestamp = new Date().toISOString();
      const content = `Kitchen sink file test @ ${timestamp}`;
      await files.write('test/hello.txt', Buffer.from(content));
      const url = files.url('test/hello.txt');
      const exists = await files.exists('test/hello.txt');
      const readBack = await files.read('test/hello.txt');
      res.json({
        success: true,
        data: {
          written: content,
          readBack: readBack.toString(),
          url,
          exists,
          match: content === readBack.toString(),
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}
