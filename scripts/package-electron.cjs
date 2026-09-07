// Build in isolation: Next must never discover the developer's .env files.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { build } = require('electron-builder');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist-electron');
const run = (command, args, cwd, env) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
});
const filter = source => !/(^|\/)(\.env[^/]*|\.DS_Store|__tests__|__fixtures__|fixtures)(\/|$)|\.(test|spec)\.[^/]+$/.test(source);
async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build this preview on an Apple Silicon Mac.');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'node-banana-release-'));
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { NEXT_TELEMETRY_DISABLED: '1', CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
  try {
    const source = path.join(work, 'source');
    const app = path.join(work, 'app');
    const runtime = path.join(work, 'runtime');
    await fs.mkdir(source);
    await fs.mkdir(runtime);
    for (const entry of ['src', 'public', 'package.json', 'package-lock.json', 'next.config.ts', 'postcss.config.mjs', 'tsconfig.json']) {
      await fs.cp(path.join(root, entry), path.join(source, entry), { recursive: true, filter });
    }
    await run('npm', ['ci', '--no-audit', '--no-fund'], source, env);
    await run(process.execPath, [path.join(source, 'node_modules/next/dist/bin/next'), 'build'], source, { ...env, NODE_ENV: 'production' });
    const pkg = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
    // Install the lockfile's full production dependency closure, including native modules.
    await run('npm', ['prune', '--omit=dev', '--no-audit', '--no-fund'], source, env);
    for (const entry of ['public', 'node_modules']) await fs.cp(path.join(source, entry), path.join(runtime, entry), { recursive: true, filter });
    await fs.cp(path.join(source, '.next'), path.join(runtime, '.next'), { recursive: true,
      filter: file => !['cache', 'diagnostics', 'types', 'dev'].some(part => path.relative(path.join(source, '.next'), file).split(path.sep)[0] === part) && !file.endsWith('.map') });
    const required = JSON.parse(await fs.readFile(path.join(source, '.next/required-server-files.json'), 'utf8'));
    const config = required.config;
    delete config.configFile;
    delete config.configFileName;
    if (config.turbopack) delete config.turbopack.root;
    delete config.outputFileTracingRoot;
    await fs.writeFile(path.join(runtime, 'next.config.js'), `module.exports = ${JSON.stringify(config)};\n`);
    await fs.writeFile(path.join(runtime, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, private: true, dependencies: pkg.dependencies }));
    await fs.cp(path.join(root, 'electron/server.cjs'), path.join(runtime, 'server.cjs'));
    await fs.mkdir(path.join(runtime, 'lib'));
    await fs.cp(path.join(root, 'electron/lib/diagnostics.cjs'), path.join(runtime, 'lib/diagnostics.cjs'));
    await fs.writeFile(path.join(runtime, 'runtime.json'), JSON.stringify({ version: 1, buildId: `${pkg.version}-${randomUUID()}`, arch: 'arm64' }));
    await fs.mkdir(app);
    await fs.cp(path.join(root, 'electron'), path.join(app, 'electron'), { recursive: true, filter });
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
        const bundled = path.join(context.appOutDir, 'Node Banana.app/Contents/Resources/runtime');
        for (const file of ['.next/BUILD_ID', 'node_modules/next/package.json', 'node_modules/sharp/package.json', 'public/banana_icon.png', 'server.cjs']) await fs.access(path.join(bundled, file));
      },
      npmRebuild: false, asar: true,
      mac: { target: [{ target: 'dir', arch: ['arm64'] }, { target: 'dmg', arch: ['arm64'] }, { target: 'zip', arch: ['arm64'] }],
        icon: path.join(root, 'public/banana_icon.png'), identity: null, category: 'public.app-category.graphics-design' },
      dmg: { sign: false, contents: [{ x: 130, y: 220 }, { x: 410, y: 220, type: 'link', path: '/Applications' }] },
      artifactName: '${productName}-${version}-${arch}.${ext}',
    } });
    console.log(`Release artifacts: ${output}`);
  } finally { await fs.rm(work, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
