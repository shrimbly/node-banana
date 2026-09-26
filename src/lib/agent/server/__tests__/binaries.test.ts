// @vitest-environment node
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyExecutable,
  detectLibc,
  resolveClaudeBinary,
  resolveCodexBinary,
  runCommand,
  type BinaryLookupDeps,
} from "../binaries";

const MACH_O = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00]);
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02]);
const NODE_LAUNCHER = Buffer.from("#!/usr/bin/env node\n// Unified entry point");
const BASH_WRAPPER = Buffer.from("#!/bin/bash\n# Superset agent-wrapper v5\n");

/** A fake file system: path → first bytes (executables only). */
function deps(files: Record<string, Buffer>, overrides: Partial<BinaryLookupDeps> = {}): BinaryLookupDeps {
  return {
    env: { PATH: "/home/u/.superset/bin:/home/u/.local/bin:/usr/bin" },
    platform: "darwin",
    arch: "arm64",
    libc: null,
    searchRoots: ["/app/.next/server/chunks", "/app"],
    isExecutableFile: (file) => file in files,
    readHead: (file) => files[file] ?? null,
    ...overrides,
  };
}

const BUNDLED_CLAUDE = "/app/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude";
const BUNDLED_CODEX = "/app/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex";

describe("resolveClaudeBinary", () => {
  it("prefers NB_CLAUDE_BIN", () => {
    const lookup = resolveClaudeBinary(
      deps({ "/custom/claude": MACH_O, [BUNDLED_CLAUDE]: MACH_O }, { env: { NB_CLAUDE_BIN: "/custom/claude" } }),
    );
    expect(lookup).toEqual({ path: "/custom/claude", source: "env" });
  });

  it("reports an NB_CLAUDE_BIN that isn't executable instead of falling back", () => {
    const lookup = resolveClaudeBinary(deps({ [BUNDLED_CLAUDE]: MACH_O }, { env: { NB_CLAUDE_BIN: "/missing/claude" } }));
    expect(lookup.path).toBeNull();
    expect("problem" in lookup && lookup.problem).toMatch(/NB_CLAUDE_BIN/);
  });

  it("finds the SDK's bundled native binary by walking up from the search roots", () => {
    expect(resolveClaudeBinary(deps({ [BUNDLED_CLAUDE]: MACH_O }))).toEqual({ path: BUNDLED_CLAUDE, source: "bundled" });
  });

  it("finds the musl package on Linux when it's the only one, and claude.exe on Windows", () => {
    const musl = "/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude";
    expect(resolveClaudeBinary(deps({ [musl]: ELF }, { platform: "linux", arch: "x64", libc: "glibc" }))).toEqual({
      path: musl,
      source: "bundled",
    });
    const windows = path.join("/app/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64", "claude.exe");
    expect(resolveClaudeBinary(deps({ [windows]: Buffer.from("MZ") }, { platform: "win32", arch: "x64" }))).toEqual({
      path: windows,
      source: "bundled",
    });
  });

  it.each(["x64", "arm64"])("picks the build for the host's libc when both Linux packages are installed (%s)", (arch) => {
    const glibc = `/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-${arch}/claude`;
    const musl = `/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-${arch}-musl/claude`;
    // npm's lockfile has no libc field, so `npm ci` on Alpine installs both.
    const files = { [glibc]: ELF, [musl]: ELF, "/usr/bin/claude": ELF };
    const on = (libc: "glibc" | "musl" | null) => resolveClaudeBinary(deps(files, { platform: "linux", arch, libc })).path;
    expect(on("musl")).toBe(musl);
    expect(on("glibc")).toBe(glibc);
    // Unknown: the Agent SDK's default order.
    expect(on(null)).toBe(glibc);
  });

  it("falls back to PATH, skipping shell wrappers for the real binary", () => {
    const lookup = resolveClaudeBinary(
      deps({ "/home/u/.superset/bin/claude": BASH_WRAPPER, "/home/u/.local/bin/claude": MACH_O }),
    );
    expect(lookup).toEqual({ path: "/home/u/.local/bin/claude", source: "path" });
  });

  it("accepts an npm node launcher on PATH when there's no native binary", () => {
    const lookup = resolveClaudeBinary(deps({ "/home/u/.superset/bin/claude": BASH_WRAPPER, "/usr/bin/claude": NODE_LAUNCHER }));
    expect(lookup).toEqual({ path: "/usr/bin/claude", source: "path" });
  });

  it("explains when nothing is found (a wrapper alone doesn't count)", () => {
    const lookup = resolveClaudeBinary(deps({ "/home/u/.superset/bin/claude": BASH_WRAPPER }));
    expect(lookup.path).toBeNull();
    expect("problem" in lookup && lookup.problem).toMatch(/Claude Code wasn't found/);
  });
});

describe("detectLibc", () => {
  const probe = (overrides: Partial<Parameters<typeof detectLibc>[0]> = {}) => ({
    platform: "linux" as NodeJS.Platform,
    readHead: () => null,
    hasMuslLoader: () => false,
    glibcVersionRuntime: () => null,
    ...overrides,
  });

  it("reads musl from ldd (Alpine's ldd execs the musl loader)", () => {
    const ldd = Buffer.from('#!/bin/sh\nexec /lib/ld-musl-x86_64.so.1 --list "$@"\n');
    expect(detectLibc(probe({ readHead: () => ldd, glibcVersionRuntime: () => "2.39" }))).toBe("musl");
  });

  it("reads glibc from ldd", () => {
    const ldd = Buffer.from("#! /bin/bash\n# This file is part of the GNU C Library.\n");
    expect(detectLibc(probe({ readHead: () => ldd }))).toBe("glibc");
  });

  it("falls back to a musl loader, then to Node's report", () => {
    expect(detectLibc(probe({ hasMuslLoader: () => true }))).toBe("musl");
    expect(detectLibc(probe({ glibcVersionRuntime: () => "2.39" }))).toBe("glibc");
    expect(detectLibc(probe({ glibcVersionRuntime: () => undefined }))).toBe("musl");
    expect(detectLibc(probe())).toBeNull();
  });

  it("is null off Linux", () => {
    expect(detectLibc(probe({ platform: "darwin", hasMuslLoader: () => true }))).toBeNull();
  });
});

describe("resolveCodexBinary", () => {
  it("prefers NB_CODEX_BIN", () => {
    expect(resolveCodexBinary(deps({ "/x/codex": MACH_O }, { env: { NB_CODEX_BIN: "/x/codex" } }))).toEqual({
      path: "/x/codex",
      source: "env",
    });
  });

  it("finds the platform package's vendored binary, like the codex launcher does", () => {
    expect(resolveCodexBinary(deps({ [BUNDLED_CODEX]: MACH_O }))).toEqual({ path: BUNDLED_CODEX, source: "bundled" });
    const linux = "/app/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex";
    expect(resolveCodexBinary(deps({ [linux]: ELF }, { platform: "linux", arch: "arm64" }))).toEqual({ path: linux, source: "bundled" });
  });

  it("falls back to codex on PATH", () => {
    expect(resolveCodexBinary(deps({ "/usr/bin/codex": MACH_O }))).toEqual({ path: "/usr/bin/codex", source: "path" });
  });

  it("explains when nothing is found", () => {
    const lookup = resolveCodexBinary(deps({}, { platform: "freebsd" }));
    expect("problem" in lookup && lookup.problem).toMatch(/Codex wasn't found/);
  });
});

describe("classifyExecutable", () => {
  it.each([
    [MACH_O, "native"],
    [Buffer.from([0xca, 0xfe, 0xba, 0xbe]), "native"],
    [ELF, "native"],
    [Buffer.from("MZ\x90\x00"), "native"],
    [NODE_LAUNCHER, "node-script"],
    [Buffer.from("#!/usr/bin/node\n"), "node-script"],
    [BASH_WRAPPER, "other"],
    [Buffer.from("#!/bin/sh\nexec node x\n"), "other"],
    [null, "other"],
  ])("%s → %s", (head, kind) => {
    expect(classifyExecutable(head)).toBe(kind);
  });
});

describe("runCommand", () => {
  it("returns stdout and exit code 0", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write('ok')"], { env: {} });
    expect(result).toEqual({ code: 0, stdout: "ok", stderr: "" });
  });

  it("returns non-zero exit codes with their output instead of throwing", async () => {
    const result = await runCommand(process.execPath, ["-e", "console.log('{\"loggedIn\":false}'); process.exit(1)"], { env: {} });
    expect(result.code).toBe(1);
    expect(result.stdout.trim()).toBe('{"loggedIn":false}');
  });

  it("passes exactly the given environment", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env).filter(k => k.startsWith('NB_T'))))"], {
      env: { NB_TEST_ONLY: "1" },
    });
    expect(JSON.parse(result.stdout)).toEqual(["NB_TEST_ONLY"]);
  });

  it("reports a missing binary and a timeout", async () => {
    const missing = await runCommand("/definitely/not/here", [], { env: {} });
    expect(missing).toMatchObject({ code: null, error: expect.stringMatching(/ENOENT/) });
    const slow = await runCommand(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { env: {}, timeoutMs: 50 });
    expect(slow).toMatchObject({ code: null, error: expect.stringMatching(/timed out/) });
  });
});
