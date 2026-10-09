import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RecordAssetMeta } from "@/lib/assets/types";
import { __resetAssetLibraryForTests, beginRecord, completeUpload } from "@/lib/assets/server";
import { loadSharp } from "@/lib/assets/server/thumbs";
import { installBridge, makePng, makeWav, meta, streamOf, tempDir } from "@/lib/assets/server/__tests__/helpers";
import { libraryOutputReader } from "../libraryOutputs";

let base: string;
let bridge: ReturnType<typeof installBridge>;

beforeEach(async () => {
  base = tempDir();
  process.env.NODE_BANANA_ASSET_LIBRARY = path.join(base, "Library");
  bridge = installBridge(path.join(base, "OS Trash"));
  await __resetAssetLibraryForTests();
});

afterEach(async () => {
  await __resetAssetLibraryForTests();
  bridge.remove();
  delete process.env.NODE_BANANA_ASSET_LIBRARY;
  fs.rmSync(base, { recursive: true, force: true });
});

async function record(buffer: Buffer, overrides: Partial<RecordAssetMeta>, contentType: string): Promise<string> {
  const started = await beginRecord({ meta: meta(overrides), source: { type: "upload" } });
  const result = "result" in started ? started.result : await completeUpload(started.ticket.uploadId, streamOf(buffer), contentType);
  return result.asset.id;
}

describe("libraryOutputReader", () => {
  it("reads an image result down to 1024px webp, with what made it", async () => {
    const id = await record(makePng(2000, 1500), { batch: { id: "b1", index: 2, count: 3 } }, "image/png");
    const output = await libraryOutputReader().read(id);
    expect(output).toMatchObject({ kind: "image", prompt: "A cat in a hat", model: "Nano Banana", batch: { index: 2, count: 3 } });
    expect(output!.image!.mime).toBe("image/webp");
    const sharp = (await loadSharp())!;
    const size = await sharp(Buffer.from(output!.image!.data, "base64")).metadata();
    expect([size.width, size.height]).toEqual([1024, 768]);
  });

  it("knows audio has no picture, and an unknown id has nothing", async () => {
    const id = await record(makeWav(), { kind: "audio" }, "audio/wav");
    const output = await libraryOutputReader().read(id);
    expect(output).toMatchObject({ kind: "audio" });
    expect(output).not.toHaveProperty("image");
    expect(await libraryOutputReader().read(`a${"0".repeat(20)}`)).toBeNull();
  });
});
