import type { NextConfig } from "next";

// Google Analytics is opt-in: the GA script and its CSP allowances only ship
// when NEXT_PUBLIC_GA_ID is set. Self-hosted instances default to zero analytics.
const gaEnabled = Boolean(process.env.NEXT_PUBLIC_GA_ID);

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
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      gaEnabled
        ? "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com"
        : "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      gaEnabled
        ? "connect-src 'self' wss: https://www.googletagmanager.com https://www.google-analytics.com https://*.google-analytics.com"
        : "connect-src 'self' wss:",
      "worker-src 'self' blob:",
      "manifest-src 'self'",
      "upgrade-insecure-requests",
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
