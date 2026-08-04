// HTTP + WebSocket entry point. One port serves both the static client and
// the WS endpoint (Nginx splits these in production, Phase 6). Zero deps.

import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptUpgrade } from './ws.ts';
import { log } from './log.ts';
import * as metrics from './metrics.ts';
import { RoomManager } from './rooms.ts';
import type { GameConfig } from '../src/index.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export interface RunningServer {
  server: Server;
  port: number;
  rooms: RoomManager;
  close(): Promise<void>;
}

export function startServer(
  opts: { port?: number; clientDir?: string; config?: Partial<GameConfig> } = {},
): Promise<RunningServer> {
  const clientDir =
    opts.clientDir ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'client');
  const rooms = new RoomManager(opts.config ?? {});

  const server = createServer(async (req, res) => {
    // Static files only — all gameplay traffic is WebSocket (spec 3.1).
    const url = (req.url ?? '/').split('?')[0]!;
    if (url === '/health') {
      // Rich enough for a load-balancer target check or uptime monitor to
      // reason about ("up and not obviously wedged"), still dependency-free.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          uptimeSeconds: Math.round(process.uptime()),
          rooms: rooms.getRoomCount(),
          memoryRssMb: Math.round(process.memoryUsage().rss / 1e6),
        }),
      );
      return;
    }
    if (url === '/metrics') {
      // Prometheus text format — scrapeable by Prometheus / CloudWatch agent.
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(metrics.toPrometheus());
      return;
    }
    const rel = url === '/' ? 'index.html' : url.slice(1);
    const path = normalize(join(clientDir, rel));
    // Trailing separator so a sibling dir like "client-evil" can't pass the
    // prefix check.
    if (!path.startsWith(normalize(clientDir + sep))) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(path);
      res.writeHead(200, {
        'content-type': MIME[extname(path)] ?? 'application/octet-stream',
        // No build step means no hashed filenames: stop browsers serving a
        // stale app.js after the code changes.
        'cache-control': 'no-cache',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    }
  });

  server.on('upgrade', (req, socket) => {
    const conn = acceptUpgrade(req, socket);
    if (conn) {
      rooms.handleConnection(conn);
    } else {
      metrics.inc('ws_handshake_failures_total');
    }
  });

  return new Promise((resolve) => {
    server.listen(opts.port ?? Number(process.env.PORT ?? 8080), () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        server,
        port,
        rooms,
        close: () =>
          new Promise<void>((done) => {
            rooms.dispose();
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

// Run directly: `node --experimental-strip-types server/server.ts`
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const { port } = await startServer();
  log.info('server_started', { port, url: `http://localhost:${port}` });
}
