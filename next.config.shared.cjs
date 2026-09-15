// Public Next options shared by the browser build and packaged custom server.
/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  experimental: {
    serverActions: { bodySizeLimit: '100mb' },
  },
};

module.exports = config;
