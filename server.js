// Custom Next.js server with extended timeout for video generation
// Node.js default server.requestTimeout is 5 minutes (300,000ms)
// We extend it to 10 minutes for long-running fal.ai video generation

const { createServer } = require('http');
const next = require('next');

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOST || '0.0.0.0';
const port = (process.env.PORT || '3000').trim();

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    await handle(req, res);
  });

  // Increase timeout to 10 minutes for long-running video generation
  server.requestTimeout = 600000; // 10 minutes
  server.headersTimeout = 610000; // Slightly longer than requestTimeout

  server.listen(port, () => {
    console.log(`> Ready on http://${hostname}:${port} (accessible on LAN via your machine's IP)`);
    console.log(`> Server timeout set to ${server.requestTimeout / 1000 / 60} minutes`);
  });
});
