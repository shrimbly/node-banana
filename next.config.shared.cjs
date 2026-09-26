// Public Next options shared by the browser build and packaged custom server.
/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // The agent spawns the Claude Code and Codex CLIs, which these packages locate
  // relative to their own install path; bundling them breaks that lookup.
  serverExternalPackages: ['@anthropic-ai/claude-agent-sdk', '@openai/codex'],
  // Shown in the split dialogs' pane; baked in at build time.
  env: { NEXT_PUBLIC_APP_VERSION: require('./package.json').version },
  experimental: {
    serverActions: { bodySizeLimit: '100mb' },
  },
};

module.exports = config;
