import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { getApiRouter } from './api/api-service';

const app = express();

// Trust reverse proxy (Traefik, nginx, etc.) so req.secure / req.hostname /
// req.ip reflect the real client. Set TRUST_PROXY to a hop count ("1"),
// "loopback", "linklocal", "uniquelocal", or a comma-separated list of IPs.
if (process.env.TRUST_PROXY) {
  const value = process.env.TRUST_PROXY;
  const asNumber = Number(value);
  app.set('trust proxy', Number.isInteger(asNumber) ? asNumber : value);
}

// JSON body parsing — intercept hooks send full request/response bodies which can be large
app.use(express.json({ limit: '250mb' }));

// URL-encoded body parsing — required for OAuth endpoints (/oauth/token, /oauth/authorize/consent)
// which accept application/x-www-form-urlencoded as per RFC 6749.
app.use(express.urlencoded({ extended: false }));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// /data/screenshots and /data/apks used to be public express.static mounts
// here. They predated initAuth() in the middleware stack, so they were
// world-readable to anyone who could reach the host. Removed because the
// frontend never used them — screenshots are served via the auth-gated
// /v1/screenshots/:filename route and APKs via /v1/apps/download/:versionId.
// Database backup similarly moved to backend/api/utils.ts behind core.system:backup.

/**
 * Mount the API router. Called from index.ts AFTER initAuth() so that auth
 * middleware is registered before route handlers in the Express stack.
 * Tests that build their own Express app do not call this — they mount the
 * router directly via getApiRouter().
 */
export function mountApiRouter(): void {
  app.use(getApiRouter());
}

// Serve frontend static files in production
if (process.env.NODE_ENV === 'production') {
  const frontendPath = path.resolve(__dirname, '../frontend');
  app.use('/ui', express.static(frontendPath));
  // SPA fallback for client-side routing
  app.get('/ui/*', (_req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
  });
}

// Redirect root to /ui
app.get('/', (_req, res) => {
  res.redirect('/ui');
});

// Error handling middleware
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err.status || 500;
  res.status(status).json({
    success: false,
    error: err.message || 'Internal Server Error',
  });
});

const httpServer = createServer(app);

export { app, httpServer };
