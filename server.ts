import 'dotenv/config';
import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { WebSocket, WebSocketServer } from 'ws';
import { Pool, PoolClient } from 'pg';
import { verifyMcpAuthorizationHeader } from './src/lib/mcp';

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0'; // Bind to all interfaces for VPS
const port = parseInt(process.env.PORT || '3000', 10);
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

type CompanySocket = WebSocket & { companyId?: string };

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url!, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
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
        } else {
          console.warn('PostgreSQL Pub/Sub listener ended. Reconnecting...');
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
        }
      });

      client.once('error', handleDisconnect);
      client.once('end', () => handleDisconnect());
    } catch (error) {
      console.error('Failed to attach PostgreSQL Pub/Sub listener:', error);
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
    process.exit(1);
  });

  server.listen(port, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
    console.log(`> WebSocket attached to /api/mcp/ws`);
  });
});
