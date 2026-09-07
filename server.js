// Custom Next.js server with extended timeout for video generation
// Node.js default server.requestTimeout is 5 minutes (300,000ms)
// We extend it to 10 minutes for long-running fal.ai video generation

const { createServer } = require('http');
const next = require('next');

const dev = process.env.NODE_ENV !== 'production';
// Local file APIs are unauthenticated: expose them to the network only when
// the operator explicitly chooses a listening address.
const hostname = process.env.HOST || '127.0.0.1';
const port = process.env.PORT || 3000;

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    if (!process.env.HOST) {
      // Loopback binding alone does not prevent DNS rebinding: a hostile name
      // can resolve to 127.0.0.1 and carry a matching hostile Origin.
      let requestHost;
      try {
        requestHost = new URL(`http://${req.headers.host}`).hostname;
      } catch {
        requestHost = '';
      }
      if (!['localhost', '127.0.0.1', '[::1]'].includes(requestHost)) {
        res.writeHead(403);
        res.end('Forbidden host');
        return;
      }
    }
    await handle(req, res);
  });

  // Increase timeout to 10 minutes for long-running video generation
  server.requestTimeout = 600000; // 10 minutes
  server.headersTimeout = 610000; // Slightly longer than requestTimeout

  server.listen(port, hostname, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
    console.log(`> Server timeout set to ${server.requestTimeout / 1000 / 60} minutes`);
  });
});
