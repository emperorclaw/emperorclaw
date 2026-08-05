import type { NextConfig } from "next";

// Google Analytics is opt-in: the GA script and its CSP allowances only ship
// when NEXT_PUBLIC_GA_ID is set. Self-hosted instances default to zero analytics.
const gaEnabled = Boolean(process.env.NEXT_PUBLIC_GA_ID);

const isDev = process.env.NODE_ENV === "development";

const securityHeaders = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'self' blob:",
      "frame-ancestors 'none'",
      "frame-src 'self' blob:",
      "form-action 'self'",
      gaEnabled
        ? `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""} https://www.googletagmanager.com`
        : `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      gaEnabled
        ? "connect-src 'self' wss: https://api.github.com https://www.googletagmanager.com https://www.google-analytics.com https://*.google-analytics.com"
        : "connect-src 'self' wss: https://api.github.com",
      "worker-src 'self' blob:",
      "manifest-src 'self'",
      // Deliberately NOT including `upgrade-insecure-requests`: it applies
      // regardless of the delivering response's own scheme, so on a
      // self-hosted plain-HTTP install (e.g. a NAS reached at
      // http://192.168.x.x:3000, the default docker-compose.yml setup) it
      // silently force-upgrades every CSS/JS subresource fetch to https://,
      // which fails outright and leaves the page rendering as unstyled bare
      // HTML. EmperorClaw's own assets are all same-origin relative URLs
      // (standard Next.js output), so a real HTTPS deployment behind a
      // reverse proxy never needed this directive to avoid mixed content in
      // the first place — there's no http:// asset link to force-upgrade.
    ].join("; "),
  },
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "Permissions-Policy",
    value: [
      "accelerometer=()",
      "autoplay=()",
      "camera=()",
      "clipboard-read=()",
      "clipboard-write=(self)",
      "display-capture=()",
      "encrypted-media=()",
      "fullscreen=(self)",
      "geolocation=()",
      "gyroscope=()",
      "magnetometer=()",
      "microphone=(self)",
      "midi=()",
      "payment=()",
      "picture-in-picture=()",
      "publickey-credentials-get=()",
      "screen-wake-lock=()",
      "usb=()",
      "web-share=()",
      "xr-spatial-tracking=()",
    ].join(", "),
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["argon2", "drizzle-orm"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: '/content/docs/:version/:file',
        destination: '/api/docs/:version/:file',
      },
    ];
  },
};

export default nextConfig;
