import net from 'net';
import type { Duplex } from 'stream';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import { SocksClient } from 'socks';
import { createLoggers } from '../logs';

const { log, error } = createLoggers('socks-proxy-server');

export interface SocksProxyConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

/**
 * A local HTTP proxy that tunnels all connections through a SOCKS5 proxy.
 *
 * mitmproxy does NOT support SOCKS5 upstream proxies natively.
 * This bridges the gap: mitmproxy → HTTP proxy (localhost) → SOCKS5 (NordVPN).
 *
 * Handles both CONNECT (HTTPS tunneling) and regular HTTP forwarding.
 * Cross-platform — works on Linux and Windows with no external binaries.
 */
export class SocksProxyServer {
  private server: http.Server | null = null;
  private port: number = 0;

  constructor(private config: SocksProxyConfig) {}

  /**
   * Start the proxy server on a random available port.
   * Returns the port number once listening.
   */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleHttp(req, res);
      });

      server.on('connect', (req, clientSocket, head) => {
        this.handleConnect(req, clientSocket, head);
      });

      server.on('error', (err) => {
        error(`Proxy server error: ${err.message}`);
        reject(err);
      });

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        this.port = addr.port;
        this.server = server;
        log(`SOCKS5-to-HTTP proxy listening on 127.0.0.1:${this.port}`);
        resolve(this.port);
      });
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      log(`SOCKS5-to-HTTP proxy stopped (was port ${this.port})`);
    }
  }

  getPort(): number {
    return this.port;
  }

  /**
   * Make a test HTTPS request through the SOCKS5 proxy to verify connectivity.
   * Fetches ifconfig.co/ip to get the proxy's external IP address.
   */
  async testConnection(): Promise<string | null> {
    try {
      const { socket } = await SocksClient.createConnection({
        proxy: {
          host: this.config.host,
          port: this.config.port,
          type: 5,
          userId: this.config.username,
          password: this.config.password,
        },
        command: 'connect',
        destination: { host: 'ifconfig.co', port: 443 },
        timeout: 10000,
      });

      return new Promise((resolve) => {
        const req = https.request({
          host: 'ifconfig.co',
          path: '/ip',
          method: 'GET',
          socket,
          headers: { 'User-Agent': 'curl/8.0' },
        } as any, (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            const ip = data.trim();
            log(`SOCKS5 proxy test: external IP is ${ip}`);
            resolve(ip);
          });
        });
        req.on('error', (err) => {
          error(`SOCKS5 proxy test request failed: ${err.message}`);
          resolve(null);
        });
        req.setTimeout(10000, () => {
          error('SOCKS5 proxy test timed out');
          req.destroy();
          resolve(null);
        });
        req.end();
      });
    } catch (err: any) {
      error(`SOCKS5 proxy test connection failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Handle CONNECT requests (HTTPS tunneling).
   * mitmproxy sends CONNECT for all TLS connections when using upstream_proxy.
   */
  private async handleConnect(
    req: http.IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const [host, portStr] = (req.url || '').split(':');
    const port = parseInt(portStr, 10) || 443;

    log(`CONNECT ${host}:${port} via SOCKS5 ${this.config.host}:${this.config.port}`);

    try {
      const { socket: socksSocket } = await SocksClient.createConnection({
        proxy: {
          host: this.config.host,
          port: this.config.port,
          type: 5,
          userId: this.config.username,
          password: this.config.password,
        },
        command: 'connect',
        destination: { host, port },
      });

      log(`CONNECT ${host}:${port} established`);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) socksSocket.write(head);

      socksSocket.pipe(clientSocket);
      clientSocket.pipe(socksSocket);

      socksSocket.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => socksSocket.destroy());
    } catch (err: any) {
      error(`CONNECT to ${host}:${port} failed: ${err.message}`);
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
    }
  }

  /**
   * Handle regular HTTP requests (non-CONNECT).
   * mitmproxy sends these with absolute URLs for plain HTTP traffic.
   */
  private async handleHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let targetHost: string;
    let targetPort: number;
    let path: string;

    try {
      const parsed = new URL(req.url || '');
      targetHost = parsed.hostname;
      targetPort = parseInt(parsed.port, 10) || 80;
      path = parsed.pathname + parsed.search;
    } catch {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }

    log(`HTTP ${req.method} ${targetHost}:${targetPort}${path} via SOCKS5`);

    try {
      const { socket: socksSocket } = await SocksClient.createConnection({
        proxy: {
          host: this.config.host,
          port: this.config.port,
          type: 5,
          userId: this.config.username,
          password: this.config.password,
        },
        command: 'connect',
        destination: { host: targetHost, port: targetPort },
      });

      // Re-send the HTTP request with a relative path to the target server
      let rawRequest = `${req.method} ${path} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        rawRequest += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      }
      rawRequest += '\r\n';

      socksSocket.write(rawRequest);
      req.pipe(socksSocket);
      socksSocket.pipe(res.socket!);

      socksSocket.on('error', () => res.socket?.destroy());
      res.socket?.on('error', () => socksSocket.destroy());
    } catch (err: any) {
      error(`HTTP request to ${targetHost}:${targetPort} failed: ${err.message}`);
      res.writeHead(502);
      res.end('Bad Gateway');
    }
  }
}
