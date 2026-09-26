/**
 * Finding and running the vendor CLIs. Server-only.
 *
 * Lookup order for each CLI:
 *   1. an explicit override (`NB_CLAUDE_BIN`, `NB_CODEX_BIN`),
 *   2. the native binary Node Banana ships in node_modules (the version the
 *      harness was built and tested against),
 *   3. the CLI on PATH — native executables first, then npm's node launchers.
 *      Shell wrappers (e.g. ~/.superset/bin/claude) are skipped: they are not
 *      the real binary and may change its environment or arguments.
 *
 * Package files are found by walking up from the working directory and this
 * module's own location rather than through `require.resolve`, so the
 * bundler never sees (and never tries to trace) a 200+ MB binary.
 */

import {
  execFile,
  type ExecFileException,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";
import { accessSync, closeSync, constants, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type BinarySource = "env" | "bundled" | "path";

/** The C library of a Linux host; null elsewhere or when it can't be told. */
export type HostLibc = "glibc" | "musl" | null;

export type BinaryLookup =
  | { path: string; source: BinarySource }
  | { path: null; problem: string };

/** File-system and process facts the lookup depends on; injectable for tests. */
export interface BinaryLookupDeps {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  arch: string;
  /** Picks the musl or glibc Claude Code build on Linux, as the Agent SDK does. */
  libc: HostLibc;
  /** Directories to search (with their parents) for node_modules. */
  searchRoots: string[];
  isExecutableFile(filePath: string): boolean;
  /** The first bytes of a file, or null when it cannot be read. */
  readHead(filePath: string, length: number): Buffer | null;
}

function moduleDirectory(): string | null {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
}

function isExecutableFile(filePath: string): boolean {
  try {
    if (!statSync(filePath).isFile()) return false;
    if (process.platform !== "win32") accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readHead(filePath: string, length: number): Buffer | null {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** What {@link detectLibc} looks at; injectable for tests. */
export interface LibcProbe {
  platform: NodeJS.Platform;
  /** The first bytes of a file, or null when it cannot be read. */
  readHead(filePath: string, length: number): Buffer | null;
  /** Whether a musl dynamic loader (`/lib/ld-musl-*`) is installed. */
  hasMuslLoader(): boolean;
  /** `header.glibcVersionRuntime` from Node's diagnostic report (undefined on musl). */
  glibcVersionRuntime(): string | undefined | null;
}

/**
 * The host's C library, the way npm (npm-install-checks) and the Agent SDK
 * tell: `ldd` mentioning musl or a musl loader means musl; otherwise Node's
 * report says whether it runs on glibc.
 */
export function detectLibc(probe: LibcProbe): HostLibc {
  if (probe.platform !== "linux") return null;
  const ldd = probe.readHead("/usr/bin/ldd", 4_096)?.toString("utf8");
  if (ldd) {
    if (/musl/i.test(ldd)) return "musl";
    if (/GNU C Library|GNU libc|GLIBC/.test(ldd)) return "glibc";
  }
  if (probe.hasMuslLoader()) return "musl";
  const runtime = probe.glibcVersionRuntime();
  if (runtime === null) return null;
  return runtime ? "glibc" : "musl";
}

function hasMuslLoader(): boolean {
  try {
    return readdirSync("/lib").some((name) => name.startsWith("ld-musl-"));
  } catch {
    return false;
  }
}

function glibcVersionRuntime(): string | undefined | null {
  try {
    const report = process.report;
    if (!report) return null;
    // Keep the report cheap: no network interfaces lookup (Node ≥ 22).
    if ("excludeNetwork" in report) (report as { excludeNetwork: boolean }).excludeNetwork = true;
    const header = (report.getReport() as { header?: { glibcVersionRuntime?: string } }).header;
    return header?.glibcVersionRuntime;
  } catch {
    return null;
  }
}

let hostLibc: HostLibc | undefined;

/** The host's C library, worked out once per process (the lookup runs on every status read and turn). */
export function currentLibc(): HostLibc {
  hostLibc ??= detectLibc({
    platform: process.platform,
    readHead: (file, length) => (existsSync(file) ? readHead(file, length) : null),
    hasMuslLoader,
    glibcVersionRuntime,
  });
  return hostLibc;
}

export function defaultLookupDeps(): BinaryLookupDeps {
  const moduleDir = moduleDirectory();
  return {
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    libc: currentLibc(),
    searchRoots: moduleDir ? [process.cwd(), moduleDir] : [process.cwd()],
    isExecutableFile,
    readHead,
  };
}

/** `<root>/node_modules/<relative>` for the first root (or ancestor) that has it. */
function findInNodeModules(relative: string, deps: BinaryLookupDeps): string | null {
  const seen = new Set<string>();
  for (const root of deps.searchRoots) {
    let dir = path.resolve(root);
    for (;;) {
      if (seen.has(dir)) break;
      seen.add(dir);
      const candidate = path.join(dir, "node_modules", relative);
      if (deps.isExecutableFile(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

type ExecutableKind = "native" | "node-script" | "other";

/** Mach-O, ELF or PE is native; `#!…node` is an npm launcher; anything else is a wrapper. */
export function classifyExecutable(head: Buffer | null): ExecutableKind {
  if (!head || head.length < 2) return "other";
  if (head[0] === 0x4d && head[1] === 0x5a) return "native"; // MZ (PE)
  if (head.length >= 4) {
    const magic = head.readUInt32BE(0);
    const machO = [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe];
    if (machO.includes(magic)) return "native";
    if (magic === 0x7f454c46) return "native"; // \x7fELF
  }
  if (head[0] === 0x23 && head[1] === 0x21) {
    const shebang = head.toString("utf8").split("\n")[0];
    return /\bnode\b/.test(shebang) ? "node-script" : "other";
  }
  return "other";
}

/** The CLI on PATH, preferring a native binary over an npm launcher; wrappers never. */
function findOnPath(name: string, deps: BinaryLookupDeps): string | null {
  const pathValue = deps.env.PATH ?? deps.env.Path ?? "";
  const delimiter = deps.platform === "win32" ? ";" : ":";
  const names = deps.platform === "win32" ? [`${name}.exe`, name] : [name];
  let launcher: string | null = null;
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const fileName of names) {
      const candidate = path.join(dir, fileName);
      if (!deps.isExecutableFile(candidate)) continue;
      const kind = classifyExecutable(deps.readHead(candidate, 128));
      if (kind === "native") return candidate;
      if (kind === "node-script" && !launcher) launcher = candidate;
    }
  }
  return launcher;
}

function fromOverride(variable: string, deps: BinaryLookupDeps): BinaryLookup | null {
  const override = deps.env[variable]?.trim();
  if (!override) return null;
  if (deps.isExecutableFile(override)) return { path: override, source: "env" };
  return { path: null, problem: `${variable} is set to "${override}", which isn't an executable file.` };
}

/**
 * The Claude Code binary: `NB_CLAUDE_BIN`, then the Agent SDK's bundled
 * native binary (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`), then
 * `claude` on PATH.
 *
 * On Linux both the glibc and the `-musl` package can be installed (npm's
 * lockfile doesn't record `libc`), so the order follows the host like the
 * SDK's own resolver: musl first on a musl host, glibc first otherwise.
 */
export function resolveClaudeBinary(deps: BinaryLookupDeps = defaultLookupDeps()): BinaryLookup {
  const override = fromOverride("NB_CLAUDE_BIN", deps);
  if (override) return override;

  const exe = deps.platform === "win32" ? "claude.exe" : "claude";
  const glibc = `linux-${deps.arch}`;
  const musl = `linux-${deps.arch}-musl`;
  const variants =
    deps.platform === "linux"
      ? deps.libc === "musl"
        ? [musl, glibc]
        : [glibc, musl]
      : [`${deps.platform}-${deps.arch}`];
  for (const variant of variants) {
    const bundled = findInNodeModules(`@anthropic-ai/claude-agent-sdk-${variant}/${exe}`, deps);
    if (bundled) return { path: bundled, source: "bundled" };
  }

  const onPath = findOnPath("claude", deps);
  if (onPath) return { path: onPath, source: "path" };
  return {
    path: null,
    problem:
      "Claude Code wasn't found. Reinstall Node Banana's dependencies (npm install), " +
      "install Claude Code so `claude` is on your PATH, or set NB_CLAUDE_BIN.",
  };
}

/** Rust target triples by platform/arch, as `@openai/codex/bin/codex.js` maps them. */
function codexTargetTriple(platform: NodeJS.Platform, arch: string): string | null {
  const triples: Record<string, Record<string, string>> = {
    linux: { x64: "x86_64-unknown-linux-musl", arm64: "aarch64-unknown-linux-musl" },
    android: { x64: "x86_64-unknown-linux-musl", arm64: "aarch64-unknown-linux-musl" },
    darwin: { x64: "x86_64-apple-darwin", arm64: "aarch64-apple-darwin" },
    win32: { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" },
  };
  return triples[platform]?.[arch] ?? null;
}

/**
 * The Codex binary: `NB_CODEX_BIN`, then the native binary from
 * `@openai/codex-<platform>-<arch>` (the package the `codex` launcher runs),
 * then `codex` on PATH.
 */
export function resolveCodexBinary(deps: BinaryLookupDeps = defaultLookupDeps()): BinaryLookup {
  const override = fromOverride("NB_CODEX_BIN", deps);
  if (override) return override;

  const triple = codexTargetTriple(deps.platform, deps.arch);
  if (triple) {
    const platformName = deps.platform === "android" ? "linux" : deps.platform;
    const exe = deps.platform === "win32" ? "codex.exe" : "codex";
    const vendorPath = `vendor/${triple}/bin/${exe}`;
    const bundled =
      findInNodeModules(`@openai/codex-${platformName}-${deps.arch}/${vendorPath}`, deps) ??
      findInNodeModules(`@openai/codex/${vendorPath}`, deps);
    if (bundled) return { path: bundled, source: "bundled" };
  }

  const onPath = findOnPath("codex", deps);
  if (onPath) return { path: onPath, source: "path" };
  return {
    path: null,
    problem:
      "Codex wasn't found. Reinstall Node Banana's dependencies (npm install), " +
      "install the Codex CLI so `codex` is on your PATH, or set NB_CODEX_BIN.",
  };
}

/* ── running a CLI command ─────────────────────────────────────── */

export interface CommandResult {
  /** Exit code, or null when the process was killed or never started. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not be started or timed out. */
  error?: string;
}

/** Run a short CLI command to completion. Never throws. */
export function runCommand(
  bin: string,
  args: string[],
  options: { env: Record<string, string>; cwd?: string; timeoutMs?: number },
): Promise<CommandResult> {
  const execOptions: ExecFileOptionsWithStringEncoding = {
    // Next's typings make NODE_ENV required on ProcessEnv; the child needs none of it.
    env: options.env as NodeJS.ProcessEnv,
    timeout: options.timeoutMs ?? 20_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    encoding: "utf8",
    ...(options.cwd ? { cwd: options.cwd } : {}),
  };
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      execOptions,
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        if (typeof error.code === "number" && !error.killed) {
          resolve({ code: error.code, stdout, stderr });
          return;
        }
        const reason = error.killed ? "timed out" : error.message;
        resolve({ code: null, stdout, stderr, error: `${path.basename(bin)} ${args.join(" ")}: ${reason}` });
      },
    );
  });
}
