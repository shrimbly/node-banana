// Build in isolation: Next must never discover the developer's .env files.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { build } = require('electron-builder');
const { pickHostEnvironment } = require('../electron/lib/env.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist-electron');
const run = (command, args, cwd, env) => new Promise((resolve, reject) => {
  // On Windows npm is a .cmd shim and Node refuses to spawn .cmd/.bat without a
  // shell (EINVAL). Only npm needs it; node.exe and magick.exe spawn directly.
  const shell = process.platform === 'win32' && command === 'npm';
  const child = spawn(command, args, { cwd, env, stdio: 'inherit', shell });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
});
// fs.cp hands over native paths, so normalise the separator before matching or
// none of these exclusions apply on Windows.
const filter = source => !/(^|\/)(\.env[^/]*|\.DS_Store|__tests__|__fixtures__|__mocks__|fixtures|tests?|coverage)(\/|$)|\.(test|spec)\.[^/]+$/.test(source.split(path.sep).join('/'));
async function main() {
  const isMac = process.platform === 'darwin' && process.arch === 'arm64';
  const isWin = process.platform === 'win32' && process.arch === 'x64';
  if (!isMac && !isWin) throw new Error('Build this preview on an Apple Silicon Mac (darwin/arm64) or a Windows x64 machine (win32/x64).');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'node-banana-release-'));
  // The same OS allowlist the packaged backend gets, so a developer key can
  // never reach npm, the Next build or electron-builder by any name. Windows
  // tools additionally resolve program and profile directories.
  const env = pickHostEnvironment(isWin ? ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'CommonProgramFiles', 'ALLUSERSPROFILE', 'PUBLIC'] : []);
  Object.assign(env, { NEXT_TELEMETRY_DISABLED: '1', CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
  try {
    const source = path.join(work, 'source');
    const app = path.join(work, 'app');
    const runtime = path.join(work, 'runtime');
    // Use Apple's ICNS encoder on macOS: the automatic PNG conversion can corrupt
    // the legacy small representations. Generate every standard size from the
    // artwork. On Windows, build a multi-resolution .ico from the same source
    // artwork with ImageMagick; electron-builder embeds it in the exe/installer.
    let icon;
    if (isMac) {
      const iconset = path.join(work, 'NodeBanana.iconset');
      icon = path.join(work, 'NodeBanana.icns');
      await fs.mkdir(iconset);
      for (const size of [16, 32, 128, 256, 512]) {
        for (const scale of [1, 2]) {
          await require('sharp')(path.join(root, 'electron/icon.png'))
            .resize(size * scale, size * scale)
            .png().toFile(path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`));
        }
      }
      await run('/usr/bin/iconutil', ['--convert', 'icns', '--output', icon, iconset], work, env);
    } else {
      icon = path.join(work, 'icon.ico');
      await run('magick', [path.join(root, 'electron/icon.png'), '-define', 'icon:auto-resize=256,128,64,48,32,16', icon], work, env);
    }
    await fs.mkdir(source);
    await fs.mkdir(runtime);
    for (const entry of ['src', 'public', 'package.json', 'package-lock.json', 'next.config.ts', 'next.config.shared.cjs', 'postcss.config.mjs', 'tsconfig.json']) {
      await fs.cp(path.join(root, entry), path.join(source, entry), { recursive: true, verbatimSymlinks: true, filter });
    }
    await run('npm', ['ci', '--no-audit', '--no-fund'], source, env);
    await run(process.execPath, [path.join(source, 'node_modules/next/dist/bin/next'), 'build'], source, { ...env, NODE_ENV: 'production' });
    const pkg = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
    // Install the lockfile's full production dependency closure, including native modules.
    await run('npm', ['prune', '--omit=dev', '--no-audit', '--no-fund'], source, env);
    for (const entry of ['public', 'node_modules']) await fs.cp(path.join(source, entry), path.join(runtime, entry), { recursive: true, verbatimSymlinks: true, filter });
    await fs.cp(path.join(source, '.next'), path.join(runtime, '.next'), { recursive: true,
      filter: file => !['cache', 'diagnostics', 'types', 'dev'].some(part => path.relative(path.join(source, '.next'), file).split(path.sep)[0] === part) && !file.endsWith('.map') });
    // Use public configuration, not Next's normalized internal manifest options.
    const config = { ...require(path.join(root, 'next.config.shared.cjs')), distDir: '.next' };
    await fs.writeFile(path.join(runtime, 'next.config.js'), `module.exports = ${JSON.stringify(config)};\n`);
    await fs.writeFile(path.join(runtime, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, private: true, dependencies: pkg.dependencies }));
    await fs.cp(path.join(root, 'electron/server.cjs'), path.join(runtime, 'server.cjs'));
    await fs.mkdir(path.join(runtime, 'lib'));
    await fs.cp(path.join(root, 'electron/lib/diagnostics.cjs'), path.join(runtime, 'lib/diagnostics.cjs'));
    await fs.writeFile(path.join(runtime, 'runtime.json'), JSON.stringify({ version: 1, buildId: `${pkg.version}-${randomUUID()}`, arch: process.arch }));
    await fs.mkdir(app);
    await fs.cp(path.join(root, 'electron'), path.join(app, 'electron'), { recursive: true, verbatimSymlinks: true, filter });
    await fs.writeFile(path.join(app, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, main: 'electron/main.cjs', description: 'Node Banana desktop workflow editor', author: 'Node Banana' }));
    await build({ projectDir: app, config: {
      appId: 'com.nodebanana.desktop', productName: 'Node Banana', electronVersion: require('electron/package.json').version,
      directories: { output }, files: ['package.json', 'electron/**/*.cjs'],
      // electron-builder deliberately excludes a root node_modules from each FileSet.
      // Copy its contents with their own explicit FileSet.
      extraResources: [
        { from: runtime, to: 'runtime', filter: ['**/*', '**/.*', '!**/.env*'] },
        { from: path.join(runtime, 'node_modules'), to: 'runtime/node_modules', filter: ['**/*', '!**/.env*'] },
      ],
      afterPack: async context => {
        // The bundled runtime lives inside the .app on macOS and directly under
        // resources/ on Windows and Linux.
        const bundled = context.electronPlatformName === 'darwin'
          ? path.join(context.appOutDir, 'Node Banana.app/Contents/Resources/runtime')
          : path.join(context.appOutDir, 'resources', 'runtime');
        for (const file of ['.next/BUILD_ID', 'node_modules/next/package.json', 'node_modules/sharp/package.json', 'public/banana_icon.png', 'server.cjs']) await fs.access(path.join(bundled, file));
      },
      npmRebuild: false, asar: true,
      mac: { target: process.argv.includes('--dir') ? [{ target: 'dir', arch: ['arm64'] }] : [{ target: 'dir', arch: ['arm64'] }, { target: 'dmg', arch: ['arm64'] }, { target: 'zip', arch: ['arm64'] }],
        icon, identity: null, category: 'public.app-category.graphics-design' },
      dmg: { sign: false, contents: [{ x: 130, y: 220 }, { x: 410, y: 220, type: 'link', path: '/Applications' }] },
      // Windows x64: unpacked dir for --dir, otherwise a per-user NSIS installer
      // and a zip. No certificate on this machine, so signing is left disabled
      // (electron-builder simply skips it); do not set forceCodeSigning.
      win: { target: process.argv.includes('--dir') ? [{ target: 'dir', arch: ['x64'] }] : [{ target: 'nsis', arch: ['x64'] }, { target: 'zip', arch: ['x64'] }],
        icon },
      nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true },
      artifactName: '${productName}-${version}-${arch}.${ext}',
    } });
    console.log(`Release artifacts: ${output}`);
  } finally { await fs.rm(work, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
