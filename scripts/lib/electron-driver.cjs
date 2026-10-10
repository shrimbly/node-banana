// Drives the Electron app for the perf runner without a DevTools connection.
// Playwright attaches CDP to every page and enables network events, which
// carry each data: URL in full; restoring a canvas with hundreds of MB of
// media overflows Chromium's 256 MB connection buffer and drops the page, and
// an attached debugger is itself an observer a user's session does not have.
//
// Instead a hook in the main process (electron-driver-hook.cjs) runs
// functions there; page code runs through webContents.executeJavaScript and
// input through sendInputEvent or the OS.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { killTree } = require('./processes.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function launchElectron({ executable, args = [], cwd, env, timeout = 120000 }) {
  const child = spawn(executable, ['-r', path.join(__dirname, 'electron-driver-hook.cjs'), ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  let output = '';
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Electron did not start within ${timeout} ms:\n${output.slice(-4000)}`)), timeout);
    const read = chunk => {
      output += chunk;
      const match = /PERF_DRIVER (\d+) ([a-f0-9]+)/.exec(output);
      if (match) { clearTimeout(timer); resolve({ url: `http://127.0.0.1:${match[1]}/`, token: match[2] }); }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Electron exited ${code} before starting:\n${output.slice(-4000)}`)); });
  });
  // Keep a short tail of the app's own output for errors.
  const keep = chunk => { output = (output + chunk).slice(-20000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);

  // Runs fn(electron, arg, require) in the main process and returns its result.
  async function run(fn, arg) {
    const response = await fetch(endpoint.url, { method: 'POST', headers: { 'x-driver-token': endpoint.token, 'content-type': 'application/json' },
      body: JSON.stringify({ source: fn.toString(), arg }) });
    const reply = await response.json();
    if (!reply.ok) throw new Error(reply.error);
    return reply.value;
  }

  const page = {
    // fn(arg) in the page's main world; a string is evaluated as is.
    evaluate: (fn, arg) => run(({ BrowserWindow }, { source }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(source, true),
      { source: typeof fn === 'string' ? fn : `(${fn})(${JSON.stringify(arg ?? null)})` }),
    async waitFor(fn, arg, { timeout = 30000, interval = 100, message = 'condition' } = {}) {
      const until = Date.now() + timeout;
      for (;;) {
        const value = await page.evaluate(fn, arg).catch(() => undefined);
        if (value) return value;
        if (Date.now() > until) throw new Error(`Timed out after ${timeout} ms waiting for ${message}`);
        await delay(interval);
      }
    },
    // Clicks the element whose accessible name matches: exactly for a string,
    // or a { pattern } regular expression; { contains } matches a substring.
    async click(name, { role = 'button', timeout = 30000, last = false, optional = false } = {}) {
      const query = { name: typeof name === 'string' ? name : undefined, pattern: name?.pattern, contains: name?.contains, role, last };
      const find = ({ name, pattern, contains, role, last }) => {
        const selector = role === 'tab' ? '[role="tab"]' : 'button, [role="button"]';
        const label = element => (element.getAttribute('aria-label') || element.textContent || '').trim();
        const matches = [...document.querySelectorAll(selector)].filter(element => element.getClientRects().length && !element.disabled)
          .filter(element => name !== undefined ? label(element) === name : pattern ? new RegExp(pattern).test(label(element)) : label(element).includes(contains));
        const element = last ? matches.at(-1) : matches[0];
        if (!element) return false;
        // A tab is a container; its first button switches to it.
        (role === 'tab' ? element.querySelector('button') || element : element).click();
        return true;
      };
      try { return await page.waitFor(find, query, { timeout, message: `${role} ${JSON.stringify(name)}` }); }
      catch (error) { if (optional) return false; throw error; }
    },
    // Keys as the OS would send them: 'Escape', 'Control+z', 'Meta+Shift+z'.
    key: combo => run(async ({ BrowserWindow }, combo) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const parts = combo.split('+'), keyCode = parts.pop();
      const modifiers = parts.map(part => part.toLowerCase());
      contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      // A shortcut is a key press, not typing.
      if (keyCode.length === 1 && !modifiers.some(m => ['control', 'ctrl', 'meta', 'cmd', 'command', 'alt'].includes(m))) contents.sendInputEvent({ type: 'char', keyCode, modifiers });
      contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    }, combo),
    mouseMove: (x, y) => run(({ BrowserWindow }, { x, y }) => BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) }), { x, y }),
    screenshot: () => run(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')).then(data => Buffer.from(data, 'base64')),
  };

  return {
    pid: child.pid, run, page, output: () => output,
    // The window exists and has loaded the app.
    async window({ timeout = 120000 } = {}) {
      const until = Date.now() + timeout;
      while (!await run(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; return !!window && !window.webContents.isLoading() && /^https?:/.test(window.webContents.getURL()); }).catch(() => false)) {
        if (Date.now() > until) throw new Error(`No app window within ${timeout} ms:\n${output.slice(-4000)}`);
        await delay(250);
      }
    },
    // A clean quit first; then the whole process tree, so no GPU, renderer or
    // server process outlives the run.
    async close() {
      if (child.exitCode === null) {
        await Promise.race([run(({ app }) => { setTimeout(() => app.quit(), 0); }).catch(() => {}), delay(2000)]);
        await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(15000)]);
      }
      killTree(child.pid);
    },
  };
}

module.exports = { launchElectron };
