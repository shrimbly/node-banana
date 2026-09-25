// Custom Next.js server with extended timeout for video generation
// Node.js default server.requestTimeout is 5 minutes (300,000ms)
// We extend it to 10 minutes for long-running fal.ai video generation
//
// `npm run dev` runs it as the dev server, `npm start` (`--production`) serves
// the `npm run build` output. Both go through here rather than `next dev` /
// `next start`, because only this server can vouch for the agent's requests.

// Set before Next.js loads, like `next start` does; works the same on Windows.
if (process.argv.includes('--production')) process.env.NODE_ENV = 'production';

const { createServer } = require('http');
const { randomBytes } = require('crypto');
const next = require('next');

const dev = process.env.NODE_ENV !== 'production';
const hostname = 'localhost';
const port = process.env.PORT || 3000;

// The agent routes (/api/agent/*) run turns on the user's own Claude or ChatGPT
// subscription, so only this machine may use them. Stamp requests whose socket
// really is loopback with a per-process secret; src/lib/agent/server/sameOrigin.ts
// refuses agent requests without it (unless NB_AGENT_ALLOWED_HOSTS lists the host),
// and refuses the agent altogether on a server that doesn't set the secret.
// Headers can be forged from another machine; the socket address cannot. The
// app's own server-side fetches to 127.0.0.1 are loopback too and get the stamp,
// so sameOrigin also requires a browser page's headers, which Node's fetch never sends.
const AGENT_LOCAL_HEADER = 'x-nb-agent-local';
const agentLocalSecret = randomBytes(32).toString('hex');
process.env.NB_AGENT_LOCAL_SECRET = agentLocalSecret;

function isLoopback(address) {
  if (!address) return false;
  const ip = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return ip === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
}

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    // A client's own copy of the stamp is never passed on.
    delete req.headers[AGENT_LOCAL_HEADER];
    if (isLoopback(req.socket.remoteAddress)) req.headers[AGENT_LOCAL_HEADER] = agentLocalSecret;
    await handle(req, res);
  });

  // Increase timeout to 10 minutes for long-running video generation
  server.requestTimeout = 600000; // 10 minutes
  server.headersTimeout = 610000; // Slightly longer than requestTimeout

  server.listen(port, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
    console.log(`> Server timeout set to ${server.requestTimeout / 1000 / 60} minutes`);
  });
});
