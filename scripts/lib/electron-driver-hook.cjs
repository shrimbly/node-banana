// Loaded into Electron's main process with -r by electron-driver.cjs. Serves
// one endpoint on loopback, guarded by a random token, that runs a function in
// the main process as fn(electron, arg, require). No DevTools connection is opened,
// so nothing observes the page that a user's session would not.
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const electron = require('electron');

const token = randomBytes(16).toString('hex');
const server = http.createServer((request, response) => {
  if (request.method !== 'POST' || request.headers['x-driver-token'] !== token) { response.writeHead(403).end(); return; }
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', async () => {
    let reply;
    try {
      const { source, arg } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const value = await (0, eval)(`(${source})`)(electron, arg, require);
      reply = { ok: true, value: value === undefined ? null : value };
    } catch (error) { reply = { ok: false, error: String(error?.stack || error) }; }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
  });
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`PERF_DRIVER ${server.address().port} ${token}\n`));
// The runner's own requests must never keep the app from quitting.
server.unref();
