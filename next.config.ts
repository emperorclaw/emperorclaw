import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["argon2", "drizzle-orm"],
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
