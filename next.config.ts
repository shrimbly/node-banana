import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: {
      bodySizeLimit: "50mb",
    },
  },
  // turbopack disabled temporarily for stability
  // turbopack: {
  //   root: __dirname,
  // },
};

export default nextConfig;
