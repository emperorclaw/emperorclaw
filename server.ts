import 'dotenv/config';
import { createServer, type IncomingMessage } from 'http';
import { parse } from 'url';
import next from 'next';
import { WebSocket, WebSocketServer } from 'ws';
import { Pool, PoolClient } from 'pg';
import { verifyMcpAuthorizationHeader } from './src/lib/mcp';
import { recordOpsError, recordOpsEvent } from './src/lib/ops-events';

const dev = process.env.NODE_ENV === 'development';
const hostname = '0.0.0.0'; // Bind to all interfaces for VPS
const port = parseInt(process.env.PORT || '3000', 10);
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// Reverse proxies whose forwarded headers we may trust. Empty by default, so a
// directly-exposed instance ignores spoofable X-Forwarded-For / CF-Connecting-IP
// and rate-limits on the real socket peer instead.
const TRUSTED_PROXY_IPS = new Set(
  (process.env.TRUSTED_PROXY_IPS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

function normalizeIp(value: string | undefined | null): string {
  if (!value) return 'unknown';
  // Unwrap IPv6-mapped IPv4 ("::ffff:1.2.3.4") and brackets.
  return value.replace(/^::ffff:/, '').replace(/^\[|\]$/g, '');
}

function resolveClientIp(req: IncomingMessage): string {
  const peer = normalizeIp(req.socket?.remoteAddress);
  if (!TRUSTED_PROXY_IPS.has(peer)) {
    // The peer is not a known proxy, so forwarded headers are client-controlled
    // and must be ignored.
    return peer;
  }
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = raw?.split(',')[0]?.trim();
  return first ? normalizeIp(first) : peer;
}

type CompanySocket = WebSocket & { companyId?: string };

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url!, true);
      // Overwrite any client-supplied value with the IP we actually trust, so
      // downstream rate limiting can never be bypassed by a forged header.
      req.headers['x-real-ip'] = resolveClientIp(req);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      void recordOpsError({
        category: 'http',
        source: 'server.request',
        fallbackMessage: 'Unhandled request error',
        error: err,
        route: req.url || null,
        method: req.method || null,
      });
      res.statusCode = 500;
      res.end('internal server error');
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (request, socket, head) => {
    const { pathname } = parse(request.url || '');

    if (pathname === '/api/mcp/ws') {
        try {
            const auth = await verifyMcpAuthorizationHeader(request.headers['authorization']);
            if (auth.error || !auth.companyToken) {
                void recordOpsEvent({
                    level: 'warn',
                    category: 'auth',
                    source: 'server.ws-upgrade',
                    message: auth.error || 'Unauthorized websocket upgrade',
                    route: pathname,
                    method: 'WS',
                    metadata: {
                        status: auth.status,
                    },
                });
                socket.write(`HTTP/1.1 ${auth.status} ${auth.status === 403 ? 'Forbidden' : 'Unauthorized'}\r\n\r\n`);
                socket.destroy();
                return;
            }

            wss.handleUpgrade(request, socket, head, (ws) => {
                const companySocket = ws as CompanySocket;
                companySocket.companyId = auth.companyToken.companyId;
                wss.emit('connection', companySocket, request);
            });
        } catch(e) {
            console.error("Token verification error during WS upgrade:", e);
            void recordOpsError({
                category: 'auth',
                source: 'server.ws-upgrade',
                fallbackMessage: 'Websocket upgrade token verification failed',
                error: e,
                route: pathname,
                method: 'WS',
            });
            socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
            socket.destroy();
        }
    } else {
        // Let Next.js handle other upgrades (e.g. HMR)
        // Actually, if we destroy here, we break HMR (_next/webpack-hmr)
        // But HMR uses /_next/webpack-hmr pathname.
        // We should skip our logic and do nothing, allowing other upgrade listeners to fire.
        // But Next.js built-in server handles upgrades itself if we don't destroy.
        // Wait, if we DO NOTHING, the socket hangs if no one else handles it.
        // Generally for Next.js custom server, we just return and don't destroy.
    }
  });
  
  // Setup Postgres LISTEN/NOTIFY for ws broadcasts
  const pool = new Pool({ connectionString: process.env.POSTGRES_CONNECTION_STRING });
  let listenerClient: PoolClient | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const scheduleListenerReconnect = () => {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void attachPubsubListener();
    }, 5000);
  };

  const attachPubsubListener = async () => {
    try {
      const client = await pool.connect();
      listenerClient = client;
      console.log('PostgreSQL Pub/Sub linked. Listening for mcp_events...');
      await client.query('LISTEN mcp_events');

      const handleDisconnect = (error?: unknown) => {
        if (error) {
          console.error('PostgreSQL Pub/Sub listener dropped:', error);
          void recordOpsError({
            category: 'runtime',
            source: 'server.pubsub-listener',
            fallbackMessage: 'PostgreSQL Pub/Sub listener dropped',
            error,
            metadata: {
              phase: 'listener-drop',
            },
          });
        } else {
          console.warn('PostgreSQL Pub/Sub listener ended. Reconnecting...');
          void recordOpsEvent({
            level: 'warn',
            category: 'runtime',
            source: 'server.pubsub-listener',
            message: 'PostgreSQL Pub/Sub listener ended and will reconnect.',
            metadata: {
              phase: 'listener-end',
            },
          });
        }

        if (listenerClient === client) {
          listenerClient = null;
        }

        client.removeAllListeners('notification');
        client.removeAllListeners('error');
        client.removeAllListeners('end');
        client.release();
        scheduleListenerReconnect();
      };

      client.on('notification', (msg) => {
        if (!msg.payload) return;
        try {
          const data = JSON.parse(msg.payload);
          const targetCompanyId = data.companyId;
          const payload = data.payload;

          wss.clients.forEach((client) => {
            const companySocket = client as CompanySocket;
            if (companySocket.readyState === WebSocket.OPEN && companySocket.companyId === targetCompanyId) {
              companySocket.send(JSON.stringify(payload));
            }
          });
        } catch (e) {
          console.error("Error parsing NOTIFY payload", e);
          void recordOpsError({
            category: 'runtime',
            source: 'server.pubsub-listener',
            fallbackMessage: 'Failed to parse Postgres NOTIFY payload',
            error: e,
            metadata: {
              channel: 'mcp_events',
            },
          });
        }
      });

      client.once('error', handleDisconnect);
      client.once('end', () => handleDisconnect());
    } catch (error) {
      console.error('Failed to attach PostgreSQL Pub/Sub listener:', error);
      void recordOpsError({
        category: 'runtime',
        source: 'server.pubsub-listener',
        fallbackMessage: 'Failed to attach PostgreSQL Pub/Sub listener',
        error,
        metadata: {
          phase: 'attach',
        },
      });
      scheduleListenerReconnect();
    }
  };

  void attachPubsubListener();

  wss.on('connection', (ws) => {
      // Send an initial connected ping payload
      ws.send(JSON.stringify({ type: 'connected', message: 'WebSocket tunnel established' }));
      
      ws.on('message', (message) => {
          if (message.toString() === 'ping') {
             ws.send('pong');
          }
      });
  });

  server.once('error', (err) => {
    console.error(err);
    void recordOpsError({
      category: 'runtime',
      source: 'server.bootstrap',
      fallbackMessage: 'HTTP server failed',
      error: err,
    });
    process.exit(1);
  });

  server.listen(port, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
    console.log(`> WebSocket attached to /api/mcp/ws`);
  });
});
