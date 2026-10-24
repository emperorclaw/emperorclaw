import 'dotenv/config';
import { createServer, type IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { parse } from 'url';
import next from 'next';
import { WebSocket, WebSocketServer } from 'ws';
import { Pool, PoolClient } from 'pg';
import { UTC_SESSION_OPTIONS } from "./src/db/pg-utc";
import { verifyMcpAuthorizationHeader } from './src/lib/mcp';
import { recordOpsError, recordOpsEvent } from './src/lib/ops-events';
import { humanSocketReceives, originMatchesHost, parseRealtimeNotification, socketReceives, socketsOverCap, type HumanViewer } from './src/lib/realtime-delivery';
import { eventTopicsFor } from './src/lib/realtime-topics';
import { CLOSE_SESSION_INVALID, CLOSE_TOO_MANY_SOCKETS } from './src/lib/realtime-client';
import { getValidatedSessionFromNodeRequest, isBrowserSessionActive } from './src/lib/auth';
import { resolveHumanRealtimeContext } from './src/lib/realtime-human';
import { loadAgentScopeContext } from './src/lib/agent-scope';

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

// agentId: the agent the token is bound to (null for a company-wide token).
// allowedProjectIds/allowedCustomerIds: that agent's data scope (null = unrestricted),
// refreshed periodically so an owner's scope edit reaches open sockets.
type CompanySocket = WebSocket & {
  isAlive?: boolean;
  companyId?: string;
  agentId?: string | null;
  allowedProjectIds?: Set<string> | null;
  allowedCustomerIds?: Set<string> | null;
  allowedAgentIds?: Set<string> | null;
};
const SOCKET_SCOPE_REFRESH_MS = 60_000;
/** Protocol ping cadence; a socket that missed the previous pong is terminated. */
const SOCKET_HEARTBEAT_MS = 25_000;
/** Agents only ever send "ping" frames; anything larger is not a client we serve. */
const AGENT_MAX_PAYLOAD = 64 * 1024;
/** Browsers only send "ping". */
const HUMAN_MAX_PAYLOAD = 1024;
/** Open browser sockets per user; the oldest is closed when one more connects. */
const MAX_HUMAN_SOCKETS_PER_USER = 10;

// A signed-in person's browser socket (/api/ws). Carries the same allow-sets as
// an agent socket but resolved from the member scope, plus the user id so a
// private direct thread only ever reaches its owner.
type HumanSocket = WebSocket & HumanViewer & { isHuman?: boolean; isAlive?: boolean; sessionId?: string };
/** Coalesce invalidation bursts per human socket into one message. */
const HUMAN_INVALIDATE_COALESCE_MS = 250;

type PendingTopics = { topics: Set<string>; timer: NodeJS.Timeout | null };
const pendingBySocket = new WeakMap<HumanSocket, PendingTopics>();

function flushHumanInvalidation(sock: HumanSocket) {
    const pending = pendingBySocket.get(sock);
    if (!pending || pending.topics.size === 0) return;
    const topics = [...pending.topics];
    pending.topics.clear();
    pending.timer = null;
    if (sock.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify({ type: "invalidate", topics }));
    }
}

function enqueueHumanInvalidation(sock: HumanSocket, topics: readonly string[]) {
    let pending = pendingBySocket.get(sock);
    if (!pending) {
        pending = { topics: new Set(), timer: null };
        pendingBySocket.set(sock, pending);
    }
    for (const topic of topics) pending.topics.add(topic);
    if (!pending.timer) {
        pending.timer = setTimeout(() => flushHumanInvalidation(sock), HUMAN_INVALIDATE_COALESCE_MS);
        pending.timer.unref?.();
    }
}

/** Refuse an upgrade on the raw socket (which may already be gone). */
function rejectUpgrade(socket: Duplex, status: number, reason: string) {
    if (!socket.destroyed) {
        try {
            socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
        } catch {
            // The client already went away.
        }
    }
    socket.destroy();
}

/** The host names this request may legitimately come from (forwarded host only via a trusted proxy). */
function upgradeHosts(req: IncomingMessage): string[] {
    const hosts = [req.headers.host].filter((value): value is string => typeof value === 'string');
    if (TRUSTED_PROXY_IPS.has(normalizeIp(req.socket?.remoteAddress))) {
        const forwarded = req.headers['x-forwarded-host'];
        const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
        const first = raw?.split(',')[0]?.trim();
        if (first) hosts.push(first);
    }
    return hosts;
}

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

  // Two servers so each kind of client gets its own frame-size limit.
  const agentWss = new WebSocketServer({ noServer: true, maxPayload: AGENT_MAX_PAYLOAD });
  const humanWss = new WebSocketServer({ noServer: true, maxPayload: HUMAN_MAX_PAYLOAD });
  /** Each user's open browser sockets, oldest first (Set keeps insertion order). */
  const humanSocketsByUser = new Map<string, Set<HumanSocket>>();

  server.on('upgrade', async (request, socket, head) => {
    const { pathname } = parse(request.url || '');

    if (pathname === '/api/mcp/ws' || pathname === '/api/ws') {
        // Registered before any await: a client that resets mid-handshake must
        // not surface as an unhandled 'error' event and crash the process.
        socket.on('error', () => {
            socket.destroy();
        });
    }

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
                rejectUpgrade(socket, auth.status, auth.status === 403 ? 'Forbidden' : 'Unauthorized');
                return;
            }

            // A scoped agent's socket only receives events about its own
            // projects/customers. Loaded before the upgrade completes so no
            // event is delivered unfiltered.
            const companyId = auth.companyToken.companyId;
            const agentId = auth.companyToken.agentId ?? null;
            const initialScope = await loadAgentScopeContext(companyId, agentId);
            if (socket.destroyed) return;
            agentWss.handleUpgrade(request, socket, head, (ws) => {
                const companySocket = ws as CompanySocket;
                companySocket.companyId = companyId;
                companySocket.agentId = agentId;
                companySocket.allowedProjectIds = initialScope.allowedProjectIds;
                companySocket.allowedCustomerIds = initialScope.allowedCustomerIds;
                companySocket.allowedAgentIds = initialScope.allowedAgentIds;
                if (agentId) {
                    const refresh = setInterval(() => {
                        loadAgentScopeContext(companyId, agentId).then((scope) => {
                            companySocket.allowedProjectIds = scope.allowedProjectIds;
                            companySocket.allowedCustomerIds = scope.allowedCustomerIds;
                            companySocket.allowedAgentIds = scope.allowedAgentIds;
                        }).catch(() => {
                            // Fail closed: if the scope cannot be read, deliver nothing scoped.
                            companySocket.allowedProjectIds = new Set();
                            companySocket.allowedCustomerIds = new Set();
                            companySocket.allowedAgentIds = new Set([agentId]);
                        });
                    }, SOCKET_SCOPE_REFRESH_MS);
                    companySocket.on('close', () => clearInterval(refresh));
                }
                agentWss.emit('connection', companySocket, request);
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
            rejectUpgrade(socket, 500, 'Internal Server Error');
        }
    } else if (pathname === '/api/ws') {
        try {
            // The session cookie rides along on any cross-site upgrade, so a
            // browser socket must come from a page on this server.
            if (!originMatchesHost(request.headers.origin, upgradeHosts(request))) {
                void recordOpsEvent({
                    level: 'warn',
                    category: 'auth',
                    source: 'server.ws-upgrade',
                    message: 'Browser websocket upgrade from a foreign or missing Origin',
                    route: pathname,
                    method: 'WS',
                    metadata: {
                        origin: typeof request.headers.origin === 'string' ? request.headers.origin.slice(0, 200) : null,
                    },
                });
                rejectUpgrade(socket, 403, 'Forbidden');
                return;
            }
            // Browser sockets authenticate with the NextAuth session cookie on
            // upgrade (no token header). Reject when there is no valid session.
            const session = await getValidatedSessionFromNodeRequest(request);
            if (!session?.user?.id || !session.sessionId) {
                rejectUpgrade(socket, 401, 'Unauthorized');
                return;
            }
            const userId = session.user.id;
            const sessionId = session.sessionId;
            const initial = await resolveHumanRealtimeContext(userId);
            if (!initial) {
                rejectUpgrade(socket, 403, 'Forbidden');
                return;
            }
            if (socket.destroyed) return;
            humanWss.handleUpgrade(request, socket, head, (ws) => {
                const humanSocket = ws as HumanSocket;
                humanSocket.isHuman = true;
                humanSocket.sessionId = sessionId;
                humanSocket.companyId = initial.companyId;
                humanSocket.userId = initial.userId;
                humanSocket.role = initial.role;
                humanSocket.allowedAgentIds = initial.allowedAgentIds;
                humanSocket.allowedCustomerIds = initial.allowedCustomerIds;
                humanSocket.allowedProjectIds = initial.allowedProjectIds;
                // Permission changes (sign-out, removal, role or scope edits)
                // reach an open socket on this refresh, so for up to
                // SOCKET_SCOPE_REFRESH_MS (60 s) it may still receive
                // invalidations under the old rights. Invalidations carry only
                // topic names; the data itself is always re-read through the
                // permission-checked REST routes.
                const refresh = setInterval(() => {
                    Promise.all([
                        isBrowserSessionActive(sessionId, userId),
                        resolveHumanRealtimeContext(userId),
                    ]).then(([sessionActive, ctx]) => {
                        if (!sessionActive || !ctx) {
                            // Signed out, session expired, or membership gone.
                            humanSocket.close(CLOSE_SESSION_INVALID, 'session ended');
                            return;
                        }
                        humanSocket.companyId = ctx.companyId;
                        humanSocket.role = ctx.role;
                        humanSocket.allowedAgentIds = ctx.allowedAgentIds;
                        humanSocket.allowedCustomerIds = ctx.allowedCustomerIds;
                        humanSocket.allowedProjectIds = ctx.allowedProjectIds;
                    }).catch(() => {
                        // Fail closed: if the scope cannot be read, deliver nothing scoped.
                        humanSocket.allowedAgentIds = new Set();
                        humanSocket.allowedCustomerIds = new Set();
                        humanSocket.allowedProjectIds = new Set();
                    });
                }, SOCKET_SCOPE_REFRESH_MS);

                let userSockets = humanSocketsByUser.get(userId);
                if (!userSockets) {
                    userSockets = new Set();
                    humanSocketsByUser.set(userId, userSockets);
                }
                userSockets.add(humanSocket);
                for (const oldest of socketsOverCap([...userSockets], MAX_HUMAN_SOCKETS_PER_USER)) {
                    userSockets.delete(oldest);
                    oldest.close(CLOSE_TOO_MANY_SOCKETS, 'too many open sockets');
                }

                humanSocket.on('close', () => {
                    clearInterval(refresh);
                    const pending = pendingBySocket.get(humanSocket);
                    if (pending?.timer) clearTimeout(pending.timer);
                    pendingBySocket.delete(humanSocket);
                    const sockets = humanSocketsByUser.get(userId);
                    if (sockets) {
                        sockets.delete(humanSocket);
                        if (sockets.size === 0) humanSocketsByUser.delete(userId);
                    }
                });
                humanWss.emit('connection', humanSocket, request);
            });
        } catch (e) {
            console.error("Session verification error during WS upgrade:", e);
            void recordOpsError({
                category: 'auth',
                source: 'server.ws-upgrade',
                fallbackMessage: 'Websocket upgrade session verification failed',
                error: e,
                route: pathname,
                method: 'WS',
            });
            rejectUpgrade(socket, 500, 'Internal Server Error');
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
  // keepAlive: the LISTEN connection is idle for long stretches; TCP keepalive
  // lets a silently dropped connection surface as an error instead of hanging.
  const pool = new Pool({ connectionString: process.env.POSTGRES_CONNECTION_STRING, options: UTC_SESSION_OPTIONS, keepAlive: true });
  let listenerClient: PoolClient | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  /** After the first attach, every re-attach means NOTIFYs may have been lost. */
  let listenerAttachedBefore = false;

  const scheduleListenerReconnect = () => {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void attachPubsubListener();
    }, 5000);
  };

  const attachPubsubListener = async () => {
    let client: PoolClient | null = null;
    try {
      client = await pool.connect();
      const listener = client;
      listenerClient = listener;

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

        if (listenerClient === listener) {
          listenerClient = null;
        }

        listener.removeAllListeners('notification');
        listener.removeAllListeners('error');
        listener.removeAllListeners('end');
        // A broken LISTEN connection must never go back to the pool.
        try {
          listener.release(true);
        } catch {
          // Already released.
        }
        scheduleListenerReconnect();
      };

      listener.on('notification', (msg) => {
        if (!msg.payload) return;
        try {
          const notification = parseRealtimeNotification(msg.payload);
          if (!notification) return;

          // Events about a private direct thread carry an audience (its agent):
          // only sockets bound to that agent receive them, never the company.
          // Human sockets get a compact invalidation instead of record contents.
          const topics = eventTopicsFor(notification.payload, notification.subject);
          humanWss.clients.forEach((ws) => {
            const socket = ws as HumanSocket;
            if (socket.readyState !== WebSocket.OPEN) return;
            if (humanSocketReceives(notification, socket)) {
              enqueueHumanInvalidation(socket, topics);
            }
          });
          agentWss.clients.forEach((ws) => {
            const socket = ws as CompanySocket;
            if (socket.readyState !== WebSocket.OPEN) return;
            if (socketReceives(notification, socket)) {
              socket.send(notification.message);
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

      listener.once('error', handleDisconnect);
      listener.once('end', () => handleDisconnect());

      await listener.query('LISTEN mcp_events');
      console.log('PostgreSQL Pub/Sub linked. Listening for mcp_events...');
      if (listenerAttachedBefore) {
        // NOTIFYs sent while the listener was down are gone: tell every
        // browser to refetch what it shows.
        const resync = JSON.stringify({ type: 'resync' });
        humanWss.clients.forEach((ws) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(resync);
        });
      }
      listenerAttachedBefore = true;
    } catch (error) {
      if (client && listenerClient === client) {
        // Connected but LISTEN failed: drop the connection instead of leaking it.
        listenerClient = null;
        client.removeAllListeners('notification');
        client.removeAllListeners('error');
        client.removeAllListeners('end');
        try {
          client.release(true);
        } catch {
          // Already released by the disconnect handler.
        }
      }
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

  // Liveness: every socket answers protocol pings (browsers and ws clients do so
  // automatically). One that missed the previous round is a zombie (sleeping
  // laptop, dropped NAT) and is terminated so it stops holding memory.
  const trackLiveness = (ws: WebSocket & { isAlive?: boolean }) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
  };
  const heartbeat = setInterval(() => {
      for (const wss of [agentWss, humanWss]) {
          wss.clients.forEach((client) => {
              const ws = client as WebSocket & { isAlive?: boolean };
              if (ws.isAlive === false) {
                  ws.terminate();
                  return;
              }
              ws.isAlive = false;
              try {
                  ws.ping();
              } catch {
                  ws.terminate();
              }
          });
      }
  }, SOCKET_HEARTBEAT_MS);
  heartbeat.unref();
  server.once('close', () => clearInterval(heartbeat));

  agentWss.on('connection', (ws: CompanySocket) => {
      trackLiveness(ws);
      // A socket error (reset, oversized frame) closes the socket; it must not crash the process.
      ws.on('error', (error) => {
          console.warn('Agent websocket error:', error.message);
      });
      // Send an initial connected ping payload
      ws.send(JSON.stringify({ type: 'connected', message: 'WebSocket tunnel established' }));

      ws.on('message', (message) => {
          ws.isAlive = true;
          if (message.toString() === 'ping') {
             ws.send('pong');
          }
      });
  });

  humanWss.on('connection', (ws: HumanSocket) => {
      trackLiveness(ws);
      ws.on('error', (error) => {
          console.warn('Browser websocket error:', error.message);
      });
      ws.send(JSON.stringify({ type: 'connected' }));

      ws.on('message', (message) => {
          ws.isAlive = true;
          // The browser heartbeat: the reply is its proof the socket is alive.
          if (message.toString() === 'ping') {
             ws.send(JSON.stringify({ type: 'pong' }));
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
    console.log(`> WebSocket attached to /api/mcp/ws and /api/ws`);
  });
});
