import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["otoserve10", "otoserve10:3000", "otoserve10:3001"],
  reactStrictMode: true,
  experimental: {
    serverActions: {
      bodySizeLimit: "50mb",
    },
  },
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
