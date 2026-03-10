// CORS proxy for OpenClaw Gateway → ngrok
// Handles OPTIONS preflight that the gateway doesn't support
const http = require('http');

const PORT = 18790;
const TARGET = 'http://localhost:18789';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, ngrok-skip-browser-warning',
  'Access-Control-Max-Age': '86400'
};

const server = http.createServer((req, res) => {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const targetUrl = new URL(req.url, TARGET);
  const proxyReq = http.request(targetUrl, {
    method: req.method,
    headers: { ...req.headers, host: targetUrl.host }
  }, (proxyRes) => {
    const headers = { ...proxyRes.headers, ...CORS_HEADERS };
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (e) => {
    res.writeHead(502);
    res.end('Proxy error: ' + e.message);
  });

  req.pipe(proxyReq);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`CORS proxy on :${PORT} → ${TARGET}`);
});
