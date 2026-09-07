import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Keep the Electron dev server independent of an ordinary browser dev server.
  distDir: process.env.NODE_BANANA_ELECTRON === "1" && process.env.NODE_ENV === "development"
    ? ".next-electron"
    : ".next",
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
