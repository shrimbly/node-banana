// Custom Next.js server with extended timeout for video generation
// Node.js default server.requestTimeout is 5 minutes (300,000ms)
// We extend it to 10 minutes for long-running fal.ai video generation

const { createServer } = require('http');
const next = require('next');

const dev = process.env.NODE_ENV !== 'production';
const hostname = 'localhost';
const port = process.env.PORT || 3000;

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    await handle(req, res);
  });

  // Increase timeout to 10 minutes for long-running video generation
  //server.requestTimeout = 600000; // 10 minutes
  //server.headersTimeout = 610000; // Slightly longer than requestTimeout
  
  // 🟢 修改点：将超时时间从 10 分钟 (600000) 增加到 30 分钟 (1800000)
  // 30 * 60 * 1000 = 1800000 ms
  const TIMEOUT_MS = 1800000; 
  
  server.requestTimeout = TIMEOUT_MS; 
  // headersTimeout 必须稍长于 requestTimeout，否则会有 Bug
  server.headersTimeout = TIMEOUT_MS + 10000; 
  server.keepAliveTimeout = TIMEOUT_MS + 10000;

  // 显式设置 Socket 超时 (双重保险)
  server.setTimeout(TIMEOUT_MS);

  server.listen(port, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
    console.log(`> Server timeout set to ${server.requestTimeout / 1000 / 60} minutes`);
  });
});
