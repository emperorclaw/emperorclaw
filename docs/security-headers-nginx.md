# Nginx Security Headers

The app sets security headers through Next.js, but the public nginx proxy should
also set them with `always` so nginx-owned redirects and error responses are
hardened too.

Add this inside the HTTPS `server` block for `emperorclaw.malecu.eu`:

```nginx
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "accelerometer=(), autoplay=(), camera=(), clipboard-read=(), clipboard-write=(self), display-capture=(), encrypted-media=(), fullscreen=(self), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), usb=(), web-share=(), xr-spatial-tracking=()" always;
add_header Content-Security-Policy "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline' https://www.googletagmanager.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' wss: https://www.googletagmanager.com https://www.google-analytics.com https://*.google-analytics.com; worker-src 'self' blob:; manifest-src 'self'; upgrade-insecure-requests" always;
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
