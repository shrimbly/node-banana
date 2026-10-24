// @vitest-environment node
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  atomicWriteFile,
  copyFileVerified,
  isInsideRoot,
  KeyedMutex,
  pathKey,
  streamToPartial,
  sweepStaleTemps,
} from "../fsutil";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nb-assets-fs-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function* chunks(...parts: (string | Buffer)[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield typeof part === "string" ? Buffer.from(part) : part;
}

describe("isInsideRoot", () => {
  it("handles Windows paths, mixed separators and case", () => {
    const win = { platform: "win32" as const };
    expect(isInsideRoot("C:\\Users\\ada\\Pictures\\Node Banana", "C:\\Users\\ada\\Pictures\\Node Banana\\Generations\\a.png", win)).toBe(true);
    expect(isInsideRoot("C:\\Users\\ada\\Pictures\\Node Banana", "c:/users/ADA/pictures/node banana/Generations/a.png", win)).toBe(true);
    expect(isInsideRoot("C:\\lib", "C:\\libx\\a.png", win)).toBe(false);
    expect(isInsideRoot("C:\\lib", "C:\\lib\\..\\other\\a.png", win)).toBe(false);
    expect(isInsideRoot("C:\\lib", "D:\\lib\\a.png", win)).toBe(false);
    expect(isInsideRoot("C:\\lib", "C:\\lib", win)).toBe(false);
    expect(isInsideRoot("C:\\lib", "C:\\LIB\\", { ...win, allowEqual: true })).toBe(true);
    // A segment that merely starts with ".." is still inside.
    expect(isInsideRoot("C:\\lib", "C:\\lib\\..hidden\\a.png", win)).toBe(true);
  });

  it("folds case on macOS but not on Linux", () => {
    expect(isInsideRoot("/Users/ada/Lib", "/users/ada/lib/a.png", { platform: "darwin" })).toBe(true);
    expect(isInsideRoot("/home/ada/Lib", "/home/ada/lib/a.png", { platform: "linux" })).toBe(false);
    expect(isInsideRoot("/home/ada/Lib", "/home/ada/Lib/../../etc/passwd", { platform: "linux" })).toBe(false);
  });

  it("builds case-folded path keys where the filesystem folds case", () => {
    expect(pathKey("C:\\A/b", "win32")).toBe("c:\\a\\b");
    expect(pathKey("/Users/A", "linux")).toBe("/Users/A");
  });
});

describe("atomicWriteFile", () => {
  it("replaces a file and leaves no temp files behind", async () => {
    const file = path.join(dir, "x.json");
    await atomicWriteFile(file, "one", { fsync: true });
    await atomicWriteFile(file, "two", { fsync: false });
    expect(fs.readFileSync(file, "utf8")).toBe("two");
    expect(fs.readdirSync(dir)).toEqual(["x.json"]);
  });

  it("writes through a short temp name in the same folder when asked", async () => {
    const file = path.join(dir, `${"日本語".repeat(26)}.nbedit`);
    const open = vi.spyOn(fs.promises, "open");
    try {
      await atomicWriteFile(file, "one", { fsync: false, shortTemp: true });
      const temp = String(open.mock.calls[0][0]);
      expect(path.dirname(temp)).toBe(dir);
      expect(Buffer.byteLength(path.basename(temp))).toBeLessThan(50);
    } finally {
      open.mockRestore();
    }
    expect(fs.readdirSync(dir)).toEqual([path.basename(file)]);
  });
});

describe("streamToPartial", () => {
  it("hashes while writing and keeps the head for sniffing", async () => {
    const body = Buffer.concat([Buffer.from("hello "), Buffer.alloc(70_000, 1), Buffer.from("world")]);
    const result = await streamToPartial(chunks(body.subarray(0, 6), body.subarray(6, 50_000), body.subarray(50_000)), dir, {
      maxBytes: 1_000_000,
    });
    expect(result.bytes).toBe(body.length);
    expect(result.sha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(result.md5).toBe(createHash("md5").update(body).digest("hex"));
    expect(result.head.length).toBe(64 * 1024);
    expect(result.partialPath.endsWith(".partial")).toBe(true);
    expect(fs.readFileSync(result.partialPath).equals(body)).toBe(true);
  });

  it("accepts a web ReadableStream", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const result = await streamToPartial(stream, dir, { maxBytes: 10 });
    expect(result.bytes).toBe(3);
  });

  it("stops at the cap and removes the partial file", async () => {
    await expect(streamToPartial(chunks("12345", "67890"), dir, { maxBytes: 8 })).rejects.toMatchObject({ code: "too_large" });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("gives up on a stalled source", async () => {
    let aborted = false;
    const stalled: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
        return: async () => ({ done: true, value: undefined }),
      }),
    };
    await expect(
      streamToPartial(stalled, dir, { maxBytes: 10, idleTimeoutMs: 30, onAbort: () => (aborted = true) }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(aborted).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe("streamToPartial on a stalled web stream", () => {
  it("cancels the stream and gives up on the idle timeout, instead of waiting for the read", async () => {
    let cancelled = false;
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      pull: () => new Promise<void>(() => {}),
      cancel: () => {
        cancelled = true;
      },
    });
    const started = Date.now();
    await expect(streamToPartial(stalled, dir, { maxBytes: 100, idleTimeoutMs: 30 })).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - started).toBeLessThan(900);
    expect(cancelled).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  }, 5000);
});

describe("sweepStaleTemps", () => {
  it("removes only old partial and tmp files", async () => {
    const old = path.join(dir, "a.partial");
    const fresh = path.join(dir, "b.partial");
    const media = path.join(dir, "c.png");
    for (const file of [old, fresh, media]) fs.writeFileSync(file, "x");
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(old, past, past);
    fs.utimesSync(media, past, past);
    expect(await sweepStaleTemps(dir, 60 * 60 * 1000)).toBe(1);
    expect(fs.readdirSync(dir).sort()).toEqual(["b.partial", "c.png"]);
  });
});

describe("copyFileVerified", () => {
  it("copies through a partial file and verifies the hash", async () => {
    const source = path.join(dir, "src.bin");
    fs.writeFileSync(source, Buffer.alloc(300_000, 7));
    let counted = 0;
    const digest = await copyFileVerified(source, path.join(dir, "nested", "dst.bin"), { onBytes: (n) => (counted += n) });
    expect(counted).toBe(300_000);
    expect(digest.sha256).toBe(createHash("sha256").update(fs.readFileSync(source)).digest("hex"));
    expect(fs.readFileSync(path.join(dir, "nested", "dst.bin")).equals(fs.readFileSync(source))).toBe(true);
    expect(fs.readdirSync(path.join(dir, "nested"))).toEqual(["dst.bin"]);
  });
});

describe("KeyedMutex", () => {
  it("serialises work per key and runs different keys concurrently", async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    await Promise.all([
      mutex.run("a", async () => {
        order.push("a1 start");
        await wait(20);
        order.push("a1 end");
      }),
      mutex.run("a", async () => {
        order.push("a2");
      }),
      mutex.run("b", async () => {
        order.push("b");
      }),
    ]);
    expect(order.indexOf("a2")).toBeGreaterThan(order.indexOf("a1 end"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("a1 end"));
  });

  it("keeps going after a failure", async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.run("k", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(mutex.run("k", async () => 42)).resolves.toBe(42);
  });
});
