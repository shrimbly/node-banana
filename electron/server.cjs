// Runs in Electron's Node utility process, never in the renderer.
const { createServer } = require('node:http');
const { existsSync } = require('node:fs');
const path = require('node:path');
const next = require('next');

const dev = process.env.NODE_ENV !== 'production';
const hostname = '127.0.0.1';
const port = Number(process.env.NODE_BANANA_ELECTRON_PORT);
const token = process.env.NODE_BANANA_ELECTRON_TOKEN;
delete process.env.NODE_BANANA_ELECTRON_TOKEN;
const origin = `http://${hostname}:${port}`;
const directoryRequests = new Map();
let requestId = 0;

process.parentPort.on('message', ({ data }) => {
  const resolve = directoryRequests.get(data.id);
  if (resolve) {
    directoryRequests.delete(data.id);
    resolve(data.result);
  }
});

function authorized(req) {
  return req.headers.host === `${hostname}:${port}` && req.headers['x-node-banana-desktop'] === token;
}

async function start() {
  if (!dev && !existsSync(path.join(process.cwd(), '.next', 'BUILD_ID'))) {
    throw new Error('No production build found. Run npm run build first, or use npm run electron:dev.');
  }
  const nextApp = next({ dev, hostname, port, dir: process.cwd() });
  const handle = nextApp.getRequestHandler();
  await nextApp.prepare();
  const server = createServer(async (req, res) => {
    if (!authorized(req)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    delete req.headers['x-node-banana-desktop'];
    try {
      if (req.method === 'GET' && new URL(req.url, origin).pathname === '/api/browse-directory') {
        const id = ++requestId;
        const result = await new Promise((resolve) => {
          directoryRequests.set(id, resolve);
          res.on('close', () => {
            directoryRequests.delete(id);
            resolve({ success: true, cancelled: true, path: null });
          });
          process.parentPort.postMessage({ type: 'choose-directory', id });
        });
        if (!res.destroyed) {
          res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        }
        return;
      }
      await handle(req, res);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.writeHead(500);
      res.end('Internal server error');
    }
  });
  // Next's request handler installs its own HMR upgrade listener on this server.
  // Register the authentication guard first; do not install a second handler.
  server.on('upgrade', (req, socket) => {
    if (!authorized(req)) {
      socket.destroy();
      return;
    }
    delete req.headers['x-node-banana-desktop'];
  });
  server.requestTimeout = 600_000;
  server.headersTimeout = 610_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, resolve);
  });
  process.parentPort.postMessage({ type: 'ready', origin });
  console.log(`[electron] Local server ready at ${origin}`);
}

start().catch((error) => {
  console.error(error);
  process.parentPort.postMessage({ type: 'error', message: error.code === 'EADDRINUSE'
    ? `Port ${port} is already in use. Close the other process or set NODE_BANANA_ELECTRON_PORT to another port.`
    : error.message });
  process.exitCode = 1;
});
