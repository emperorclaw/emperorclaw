# Nginx Security Headers

The app sets security headers through Next.js, but the public nginx proxy should
also set them with `always` so nginx-owned redirects and error responses are
hardened too.

Add this inside the HTTPS `server` block for `emperorclaw.acme.eu`:

```nginx
server_tokens off;
client_max_body_size 100m;

add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "accelerometer=(), autoplay=(), camera=(), clipboard-read=(), clipboard-write=(self), display-capture=(), encrypted-media=(), fullscreen=(self), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), usb=(), web-share=(), xr-spatial-tracking=()" always;
add_header Content-Security-Policy "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline' https://www.googletagmanager.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' wss: https://www.googletagmanager.com https://www.google-analytics.com https://*.google-analytics.com; worker-src 'self' blob:; manifest-src 'self'; upgrade-insecure-requests" always;
```

Add this once in `/etc/nginx/conf.d/emperorclaw-connection-upgrade.conf`:

```nginx
map $http_upgrade $emperorclaw_connection_upgrade {
    default upgrade;
    '' close;
}
```

Use these proxy settings in the Emperor `location /` block:

```nginx
proxy_hide_header Strict-Transport-Security;
proxy_hide_header Content-Security-Policy;
proxy_hide_header X-Frame-Options;
proxy_hide_header X-Content-Type-Options;
proxy_hide_header Referrer-Policy;
proxy_hide_header Permissions-Policy;
proxy_hide_header X-Powered-By;

proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $emperorclaw_connection_upgrade;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host $host;
proxy_set_header X-Forwarded-Port $server_port;
proxy_cache_bypass $http_upgrade;
proxy_redirect off;
proxy_connect_timeout 30s;
proxy_send_timeout 3600s;
proxy_read_timeout 3600s;
```

Keep the HTTP `server` block as a redirect-only host:

```nginx
return 301 https://$host$request_uri;
```

After editing:

```bash
sudo nginx -t
sudo systemctl reload nginx
```
