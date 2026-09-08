// A single owner for the utility process. A retry waits for the previous child
// to exit; an old exit event can never clear or kill a replacement process.
function createBackend({ fork, options, entry, onMessage, onDisconnected, diagnostics, timeoutMs = 120000 }) {
  let child, launch, stopPromise;
  let online = false, stopping = false;
  async function stop() {
    if (stopPromise) return stopPromise;
    if (!child) return;
    stopping = true;
    const current = child;
    stopPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The previous local server has not stopped. Quit Node Banana before retrying.')), 5000);
      current.once('exit', () => { clearTimeout(timer); resolve(); });
      current.kill();
    });
    try { await stopPromise; } finally { stopPromise = undefined; }
  }
  function start() {
    if (launch) return launch;
    if (online) return Promise.resolve();
    launch = (async () => {
      await stop();
      stopping = false;
      await new Promise((resolve, reject) => {
        let ready = false, settled = false;
        const finish = error => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          error ? reject(error) : resolve();
        };
        const timer = setTimeout(() => finish(new Error('The local server did not start within 120 seconds. Open Logs for details, then retry.')), timeoutMs);
        try { child = fork(entry, [], options()); }
        catch (error) { finish(error); return; }
        const current = child;
        current.once('spawn', () => {
          diagnostics.pipe(current.stdout, 'backend');
          diagnostics.pipe(current.stderr, 'backend');
        });
        current.on('message', message => {
          if (current !== child || stopping) return;
          if (message.type === 'ready' && !settled) { ready = online = true; finish(); }
          else if (message.type === 'error' && !ready) finish(Object.assign(new Error(message.message), { code: message.code }));
          else onMessage(message, current);
        });
        current.once('exit', code => {
          if (child === current) child = undefined;
          online = false;
          finish(new Error(`The local server stopped during startup (exit ${code}). Open Logs for details.`));
          if (ready && !stopping) onDisconnected(code);
        });
      });
    })().catch(async error => { await stop(); throw error; }).finally(() => { launch = undefined; });
    return launch;
  }
  return { start, stop, online: () => online, post: message => child?.postMessage(message), kill: () => { stopping = true; child?.kill(); } };
}
module.exports = { createBackend };
