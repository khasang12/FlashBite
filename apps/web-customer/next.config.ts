import type { NextConfig } from "next";

const WRITE_API = process.env.WRITE_API_ORIGIN ?? "http://localhost:3001";
const READ_API = process.env.READ_API_ORIGIN ?? "http://localhost:3002";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: "/api/write/:path*", destination: `${WRITE_API}/:path*` },
      { source: "/api/read/:path*", destination: `${READ_API}/:path*` },
    ];
  },
};

export default nextConfig;
