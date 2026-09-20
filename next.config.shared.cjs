// Public Next options shared by the browser build and packaged custom server.
/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Shown in the split dialogs' pane; baked in at build time.
  env: { NEXT_PUBLIC_APP_VERSION: require('./package.json').version },
  experimental: {
    serverActions: { bodySizeLimit: '100mb' },
  },
};

module.exports = config;
