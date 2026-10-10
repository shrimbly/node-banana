// Electron leaves GPU, renderer and server processes behind when only its
// main process is killed, and any that are still running compete with the
// next measurement for the CPU and GPU. The runner checks for strays before
// it starts and takes down the whole tree when it ends.
const { execFileSync } = require('node:child_process');

// Electron processes started from a Node Banana checkout (not the installed app).
function strayElectron(platform = process.platform) {
  try {
    if (platform === 'win32') {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.ExecutablePath -match 'node-banana' } | ForEach-Object { \"$($_.ProcessId) $($_.ExecutablePath)\" }"],
      { encoding: 'utf8', windowsHide: true });
      return out.split(/\r?\n/).filter(Boolean).map(line => ({ pid: Number(line.split(' ')[0]), path: line.slice(line.indexOf(' ') + 1) }));
    }
    const out = execFileSync('pgrep', ['-fl', 'node-banana.*[Ee]lectron'], { encoding: 'utf8' });
    return out.split('\n').filter(Boolean).map(line => ({ pid: Number(line.split(' ')[0]), path: line.slice(line.indexOf(' ') + 1) }));
  } catch { return []; }
}

function killTree(pid, platform = process.platform) {
  if (!pid) return;
  try {
    if (platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, 'SIGKILL');
  } catch {}
}

module.exports = { strayElectron, killTree };
