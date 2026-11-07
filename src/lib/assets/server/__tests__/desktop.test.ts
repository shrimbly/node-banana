// @vitest-environment node
import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopServerBridge } from "../../types";
import { openFolder, revealFile, trashFile, trashFiles, type ExecRunner } from "../desktop";
import { tempDir } from "./helpers";

let dir: string;

beforeEach(() => {
  dir = tempDir("nb-assets-desktop-");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function recorder(behaviour: (command: string, args: string[]) => void = () => {}) {
  const calls: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
  const exec: ExecRunner = async (command, args, options) => {
    calls.push({ command, args, options: options as Record<string, unknown> });
    behaviour(command, args);
  };
  return { calls, exec };
}

describe("revealFile", () => {
  const file = "C:\\Users\\ada\\Pictures\\Node Banana\\Generations\\a b.png";

  it("selects the file in Explorer with one verbatim argument", async () => {
    const { calls, exec } = recorder();
    await revealFile(file, { platform: "win32", exec, bridge: null });
    // Never hidden: Explorer would hand SW_HIDE on to the window it opens.
    expect(calls).toEqual([
      { command: "explorer.exe", args: [`/select,"${file}"`], options: { windowsVerbatimArguments: true, windowsHide: false } },
    ]);
  });

  it("ignores Explorer's non-zero exit code", async () => {
    const exec: ExecRunner = async () => {
      throw Object.assign(new Error("exit 1"), { code: 1 });
    };
    await expect(revealFile(file, { platform: "win32", exec, bridge: null })).resolves.toBeUndefined();
  });

  it("uses open -R on macOS and the folder on Linux", async () => {
    const mac = recorder();
    await revealFile("/Users/ada/x.png", { platform: "darwin", exec: mac.exec, bridge: null });
    expect(mac.calls[0]).toMatchObject({ command: "open", args: ["-R", "/Users/ada/x.png"] });
    const linux = recorder();
    await revealFile("/home/ada/x.png", { platform: "linux", exec: linux.exec, bridge: null });
    expect(linux.calls[0]).toMatchObject({ command: "xdg-open", args: ["/home/ada"] });
  });

  it("goes through the desktop bridge when there is one", async () => {
    const bridge: DesktopServerBridge = { request: vi.fn(async () => ({ ok: true as const })) };
    const { calls, exec } = recorder();
    await revealFile("/x.png", { platform: "darwin", exec, bridge });
    expect(bridge.request).toHaveBeenCalledWith("reveal", { path: "/x.png" });
    expect(calls).toEqual([]);
  });

  it("opens a folder", async () => {
    const { calls, exec } = recorder();
    await openFolder("D:\\Lib", { platform: "win32", exec, bridge: null });
    expect(calls[0]).toMatchObject({ command: "explorer.exe", args: ["D:\\Lib"], options: { windowsHide: false } });
  });
});

describe("trashFile", () => {
  it("passes the path to PowerShell through an env var, never the command line", async () => {
    const file = path.join(dir, "x'; Remove-Item -Recurse C:\\ ; '.png");
    fs.writeFileSync(file, "x");
    const { calls, exec } = recorder(() => fs.unlinkSync(file));
    expect(await trashFile(file, { platform: "win32", exec, bridge: null })).toBe("os");
    expect(calls[0].command).toBe("powershell.exe");
    expect(calls[0].args.join(" ")).not.toContain(file);
    expect((calls[0].options.env as Record<string, string>).NB_TRASH_PATHS).toBe(file);
  });

  describe("many files", () => {
    function files(count: number): string[] {
      return Array.from({ length: count }, (_, i) => {
        const file = path.join(dir, `f${i}.png`);
        fs.writeFileSync(file, "x");
        return file;
      });
    }
    const removeAll = (list: string[]) => () => list.forEach((file) => fs.rmSync(file, { force: true }));

    it("sends them to the Recycle Bin in one PowerShell run", async () => {
      const list = files(3);
      const { calls, exec } = recorder(removeAll(list));
      const results = await trashFiles(list, { platform: "win32", exec, bridge: null });
      expect(calls).toHaveLength(1);
      expect((calls[0].options.env as Record<string, string>).NB_TRASH_PATHS.split("\n")).toEqual(list);
      expect([...results.values()]).toEqual(["os", "os", "os"]);
    });

    it("passes them all to one /usr/bin/trash, or one Finder delete", async () => {
      const list = files(3);
      const trash = recorder(removeAll(list));
      await trashFiles(list, { platform: "darwin", exec: trash.exec, bridge: null });
      expect(trash.calls).toEqual([expect.objectContaining({ command: "/usr/bin/trash", args: list })]);

      const older = files(3);
      const finder = recorder((command) => {
        if (command === "/usr/bin/trash") throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
        removeAll(older)();
      });
      await trashFiles(older, { platform: "darwin", exec: finder.exec, bridge: null });
      expect(finder.calls.map((call) => call.command)).toEqual(["/usr/bin/trash", "osascript"]);
      expect(finder.calls[1].args.slice(-3)).toEqual(older);
    });

    it("passes them all to one gio call", async () => {
      const list = files(3);
      const { calls, exec } = recorder(removeAll(list));
      await trashFiles(list, { platform: "linux", exec, bridge: null });
      expect(calls).toEqual([expect.objectContaining({ command: "gio", args: ["trash", ...list] })]);
    });

    it("tries Finder once, not once per file, when macOS won't let it be asked", async () => {
      const refusals = [
        Object.assign(new Error("Command failed: osascript\nexecution error: Not authorized to send Apple events to Finder. (-1743)"), { code: 1 }),
        // A prompt nobody answered, until the exec timeout.
        Object.assign(new Error("Command failed: osascript"), { killed: true, signal: "SIGTERM", code: null }),
      ];
      for (const refusal of refusals) {
        const list = files(50);
        const { calls, exec } = recorder((command) => {
          if (command === "/usr/bin/trash") throw Object.assign(new Error("spawn /usr/bin/trash ENOENT"), { code: "ENOENT" });
          throw refusal;
        });
        const results = await trashFiles(list, { platform: "darwin", exec, bridge: null });
        expect(calls.map((call) => call.command)).toEqual(["/usr/bin/trash", "osascript"]);
        expect(new Set(results.values())).toEqual(new Set(["unlink"]));
        expect(list.some((file) => fs.existsSync(file))).toBe(false);
      }
    });

    it("stops retrying file by file once a single file shows the route itself is down", async () => {
      const list = files(5);
      const { calls, exec } = recorder((_command, args) => {
        if (args.length > 2) throw Object.assign(new Error("one bad path"), { code: 1 });
        throw Object.assign(new Error("Command failed: gio"), { killed: true, signal: "SIGTERM" });
      });
      await trashFiles(list, { platform: "linux", exec, bridge: null });
      expect(calls).toHaveLength(2);
    });

    it("keeps recycling after a batch that timed out part-way, and gives up only on a route that moved nothing", async () => {
      const killed = () => Object.assign(new Error("Command failed: powershell.exe"), { killed: true, signal: "SIGTERM", code: null });
      const paths = (options: Record<string, unknown>) => (options.env as Record<string, string>).NB_TRASH_PATHS.split("\n");

      // A slow Recycle Bin: each run gets through 150 files before the exec timeout stops it.
      const slow = files(450);
      const slowRuns: string[][] = [];
      const results = await trashFiles(slow, {
        platform: "win32",
        bridge: null,
        exec: async (_command, _args, options) => {
          const list = paths(options as Record<string, unknown>);
          slowRuns.push(list);
          list.slice(0, 150).forEach((file) => fs.rmSync(file, { force: true }));
          if (list.length > 150) throw killed();
        },
      });
      expect(new Set(results.values())).toEqual(new Set(["os"]));
      expect(results.size).toBe(450);
      // Each timed-out batch's leftovers go one by one, and the next batch still goes to the route.
      expect(slowRuns.filter((list) => list.length > 1).map((list) => list.length)).toEqual([200, 200, 50]);

      // One locked file whose error dialog holds PowerShell up, in the first batch.
      const withLocked = files(250);
      const locked = withLocked[3];
      const lockedResults = await trashFiles(withLocked, {
        platform: "win32",
        bridge: null,
        exec: async (_command, _args, options) => {
          const list = paths(options as Record<string, unknown>);
          list.filter((file) => file !== locked).forEach((file) => fs.rmSync(file, { force: true }));
          if (list.includes(locked)) throw killed();
        },
      });
      expect(lockedResults.get(locked)).toBe("unlink");
      expect([...lockedResults.values()].filter((method) => method === "os")).toHaveLength(249);

      // A PowerShell that hangs before it moves anything: tried once, not once per batch or per file.
      const hung = files(450);
      const hungRuns: string[][] = [];
      const hungResults = await trashFiles(hung, {
        platform: "win32",
        bridge: null,
        exec: async (_command, _args, options) => {
          hungRuns.push(paths(options as Record<string, unknown>));
          throw killed();
        },
      });
      expect(hungRuns).toHaveLength(1);
      expect(new Set(hungResults.values())).toEqual(new Set(["unlink"]));
    });

    it("skips only the route that could prompt when nobody asked just now", async () => {
      const unattended = files(2);
      const noTrashTool = recorder((command) => {
        if (command === "/usr/bin/trash") throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
        removeAll(unattended)();
      });
      const results = await trashFiles(unattended, { platform: "darwin", exec: noTrashTool.exec, bridge: null, interactive: false });
      expect(noTrashTool.calls.map((call) => call.command)).toEqual(["/usr/bin/trash"]);
      expect([...results.values()]).toEqual(["unlink", "unlink"]);

      const withTool = files(2);
      const trash = recorder(removeAll(withTool));
      expect([...(await trashFiles(withTool, { platform: "darwin", exec: trash.exec, bridge: null, interactive: false })).values()]).toEqual(["os", "os"]);

      const bridge: DesktopServerBridge = { request: vi.fn(async () => ({ ok: true as const })) };
      expect(await trashFile("/x.png", { platform: "darwin", exec: trash.exec, bridge, interactive: false })).toBe("bridge");
    });

    it("retries a failed batch file by file, then unlinks only what is left", async () => {
      const list = files(3);
      const { calls, exec } = recorder((_command, args) => {
        if (args.length > 2) throw Object.assign(new Error("one bad path"), { code: 1 });
        if (args[1] !== list[1]) fs.rmSync(args[1]);
      });
      const results = await trashFiles(list, { platform: "linux", exec, bridge: null });
      expect(calls).toHaveLength(4);
      expect(results.get(list[0])).toBe("os");
      expect(results.get(list[1])).toBe("unlink");
      expect(results.get(list[2])).toBe("os");
      expect(list.some((file) => fs.existsSync(file))).toBe(false);
    });
  });

  it("passes the path to osascript as an argument when /usr/bin/trash is missing", async () => {
    const file = path.join(dir, 'quote " and \\ backslash.png');
    fs.writeFileSync(file, "x");
    const { calls, exec } = recorder((command) => {
      if (command === "/usr/bin/trash") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      fs.unlinkSync(file);
    });
    expect(await trashFile(file, { platform: "darwin", exec, bridge: null })).toBe("os");
    const osascript = calls.find((call) => call.command === "osascript")!;
    expect(osascript.args[osascript.args.length - 1]).toBe(file);
    expect(osascript.args.slice(0, -1).join(" ")).not.toContain(file);
  });

  it("uses gio on Linux", async () => {
    const file = path.join(dir, "x.png");
    fs.writeFileSync(file, "x");
    const { calls, exec } = recorder(() => fs.unlinkSync(file));
    await trashFile(file, { platform: "linux", exec, bridge: null });
    expect(calls[0]).toMatchObject({ command: "gio", args: ["trash", file] });
  });

  it("unlinks only when every trash route fails (or leaves the file behind)", async () => {
    const file = path.join(dir, "x.png");
    fs.writeFileSync(file, "x");
    const { exec } = recorder(); // "succeeds" but moves nothing
    expect(await trashFile(file, { platform: "linux", exec, bridge: null })).toBe("unlink");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("keeps a file no route moved when unlinkFallback is false", async () => {
    const file = path.join(dir, "x.nbedit");
    fs.writeFileSync(file, "x");
    const { exec } = recorder(); // "succeeds" but moves nothing
    const results = await trashFiles([file], { platform: "linux", exec, bridge: null, unlinkFallback: false });
    expect(results.has(file)).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
    await expect(trashFile(file, { platform: "linux", exec, bridge: null, unlinkFallback: false })).rejects.toMatchObject({
      code: "trash_failed",
    });
  });

  it("prefers the desktop bridge", async () => {
    const bridge: DesktopServerBridge = { request: vi.fn(async () => ({ ok: true as const })) };
    const { calls, exec } = recorder();
    expect(await trashFile("/x.png", { platform: "darwin", exec, bridge })).toBe("bridge");
    expect(bridge.request).toHaveBeenCalledWith("trash", { path: "/x.png" });
    expect(calls).toEqual([]);
  });
});
