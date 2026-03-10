import 'dotenv/config';
import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { WebSocketServer } from 'ws';
import { db } from './src/db';
import { companyTokens } from './src/db/schema';
import { eq } from 'drizzle-orm';
import * as crypto from 'crypto';
import { Pool } from 'pg';

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0'; // Bind to all interfaces for VPS
const port = parseInt(process.env.PORT || '3000', 10);
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

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
        const authHeader = request.headers['authorization'];
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }

        const token = authHeader.split(" ")[1];
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

        try {
            const [companyToken] = await db.select().from(companyTokens).where(
                eq(companyTokens.tokenHash, tokenHash)
            ).limit(1);

            if (!companyToken || companyToken.revokedAt) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }

            wss.handleUpgrade(request, socket, head, (ws) => {
                // Attach companyId to the client socket
                (ws as any).companyId = companyToken.companyId;
                wss.emit('connection', ws, request);
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
  
  pool.connect().then(client => {
      console.log('PostgreSQL Pub/Sub linked. Listening for mcp_events...');
      client.query('LISTEN mcp_events');
      client.on('notification', (msg) => {
          if (!msg.payload) return;
          try {
              const data = JSON.parse(msg.payload);
              const targetCompanyId = data.companyId;
              const payload = data.payload;
              
              wss.clients.forEach(client => {
                  if (client.readyState === 1 && (client as any).companyId === targetCompanyId) {
                      client.send(JSON.stringify(payload));
                  }
              });
          } catch(e) {
              console.error("Error parsing NOTIFY payload", e);
          }
      });
  }).catch(console.error);

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
