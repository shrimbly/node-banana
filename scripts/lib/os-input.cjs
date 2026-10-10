// Moves the real cursor through the operating system's input stack, so input
// reaches the app the way a mouse's does: through the window system and
// Electron's main process, at the device's rate. webContents.sendInputEvent
// skips both, and main-process timers on Windows only tick every ~15.6 ms.
//
// play() takes a schedule of { t (ms from start), type: move|down|up|wheel,
// x, y (screen pixels on Windows, points on the Mac), dx, dy } and resolves
// with how many events went out and the latest any of them was sent.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// SendInput from a process that sees physical pixels, on a 1 ms timer,
// spinning the last 2 ms before each event so a 1000 Hz schedule holds.
const WINDOWS_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Diagnostics; using System.Globalization; using System.IO; using System.Runtime.InteropServices; using System.Threading;
public static class BananaInput {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public int mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public MOUSEINPUT mi; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint ms);
  [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint ms);
  const uint MOVE = 0x1, LEFTDOWN = 0x2, LEFTUP = 0x4, WHEEL = 0x800, HWHEEL = 0x1000, ABSOLUTE = 0x8000, VIRTUALDESK = 0x4000;
  public static string Play(string file) {
    SetProcessDPIAware(); timeBeginPeriod(1);
    try {
      CultureInfo c = CultureInfo.InvariantCulture;
      int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
      INPUT[] input = new INPUT[1]; int size = Marshal.SizeOf(typeof(INPUT)); Stopwatch clock = Stopwatch.StartNew();
      double worst = 0; int sent = 0;
      foreach (string line in File.ReadAllLines(file)) {
        if (line.Length == 0) continue;
        string[] f = line.Split(',');
        double due = double.Parse(f[0], c);
        while (clock.Elapsed.TotalMilliseconds < due) { if (due - clock.Elapsed.TotalMilliseconds > 2) Thread.Sleep(1); else Thread.SpinWait(20); }
        worst = Math.Max(worst, clock.Elapsed.TotalMilliseconds - due);
        MOUSEINPUT mi = new MOUSEINPUT();
        mi.dx = (int)Math.Round((double.Parse(f[2], c) - vx) * 65535.0 / (vw - 1));
        mi.dy = (int)Math.Round((double.Parse(f[3], c) - vy) * 65535.0 / (vh - 1));
        uint at = MOVE | ABSOLUTE | VIRTUALDESK;
        if (f[1] == "move") mi.dwFlags = at;
        else if (f[1] == "down") mi.dwFlags = at | LEFTDOWN;
        else if (f[1] == "up") mi.dwFlags = at | LEFTUP;
        else { int dx = int.Parse(f[4], c); mi.dwFlags = dx != 0 ? HWHEEL : WHEEL; mi.mouseData = dx != 0 ? dx : -int.Parse(f[5], c); mi.dx = 0; mi.dy = 0; }
        input[0].type = 0; input[0].mi = mi;
        if (SendInput(1, input, size) != 1) throw new Exception("SendInput failed: " + Marshal.GetLastWin32Error());
        sent++;
      }
      return sent + " " + worst.ToString("F2", c);
    } finally { timeEndPeriod(1); }
  }
}
'@
[BananaInput]::Play('__SCHEDULE__')
`;

// CGEventPost from JXA. Needs Accessibility permission for the terminal;
// without it macOS drops the events silently.
const MAC_HELPER = String.raw`
ObjC.import('CoreGraphics'); ObjC.import('Foundation');
function run(argv) {
  const lines = $.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null).js.split('\n').filter(Boolean);
  const start = $.CFAbsoluteTimeGetCurrent();
  let worst = 0, sent = 0, down = false;
  for (const line of lines) {
    const [t, type, x, y, dx, dy] = line.split(',');
    const due = Number(t);
    let now;
    while ((now = ($.CFAbsoluteTimeGetCurrent() - start) * 1000) < due) {}
    worst = Math.max(worst, now - due);
    let event;
    // 0 pixel units; mouse event types 1 down, 2 up, 5 moved, 6 left-dragged.
    if (type === 'wheel') event = $.CGEventCreateScrollWheelEvent2(null, 0, 2, -Number(dy), -Number(dx), 0);
    else {
      if (type === 'down') down = true;
      const kind = type === 'down' ? 1 : type === 'up' ? 2 : down ? 6 : 5;
      if (type === 'up') down = false;
      event = $.CGEventCreateMouseEvent(null, kind, { x: Number(x), y: Number(y) }, 0);
    }
    $.CGEventPost(0, event);
    sent++;
  }
  return sent + ' ' + worst.toFixed(2);
}`;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${command} exited ${code}: ${stderr.trim() || stdout.trim()}`)));
  });
}

function createOsInput(platform = process.platform) {
  if (platform !== 'win32' && platform !== 'darwin') return { available: false };
  return {
    available: true,
    async play(schedule) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'banana-os-input-'));
      try {
        const file = path.join(dir, 'schedule.csv');
        await fs.writeFile(file, schedule.map(e => [e.t.toFixed(3), e.type, (e.x ?? 0).toFixed(1), (e.y ?? 0).toFixed(1), Math.round(e.dx ?? 0), Math.round(e.dy ?? 0)].join(',')).join('\n'));
        let output;
        if (platform === 'win32') {
          const script = WINDOWS_HELPER.replace('__SCHEDULE__', file.replace(/'/g, "''"));
          output = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
        } else {
          const helper = path.join(dir, 'input.js');
          await fs.writeFile(helper, MAC_HELPER);
          output = await run('osascript', ['-l', 'JavaScript', helper, file]);
        }
        const [sent, worstLateMs] = output.split(/\s+/).slice(-2).map(Number);
        return { sent, worstLateMs };
      } finally { await fs.rm(dir, { recursive: true, force: true }); }
    },
  };
}

module.exports = { createOsInput };
