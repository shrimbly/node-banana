import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Media is served directly; the unused optimizer must not relay headerless
  // internal requests around the browser-origin checks on local file APIs.
  images: { unoptimized: true },
  experimental: {
    serverActions: {
      bodySizeLimit: "100mb", // Increased for large media files
    },
  },
  // Note: For route handlers (.../route.ts files), body size is controlled by
  // the underlying server. For large payloads, consider using streaming or
  // increase Node.js max HTTP header size if needed.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
